#!/usr/bin/env bash
# Install goblin as a systemd user service. Idempotent — safe to re-run.
# Not a wizard: it refuses to enable a service that would crash-loop
# (missing config or auth) and tells you what to copy first.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
goblin_home="${GOBLIN_HOME:-$HOME/goblin}"
unit_dir="$HOME/.config/systemd/user"
bun_bin="$(command -v bun || true)"

fail() { echo "install: $*" >&2; exit 1; }
[ -n "$bun_bin" ] || fail "bun not found in PATH — install it first"

# Pre-flight: the service restarts forever, so enabling it half-configured
# means a crash loop nobody is watching. Stop before that.
[ -f "$goblin_home/goblin.json5" ] ||
	fail "no config at $goblin_home/goblin.json5 — copy goblin.json5.example from the repo and fill it in"
[ -f "$goblin_home/auth.jsonl" ] ||
	fail "no auth at $goblin_home/auth.jsonl — one record per line, mode 0600 (see DESIGN.md: Auth)"
# The process refuses any group/world-readable auth.jsonl at boot — the
# same rule here, or a lax mode passes install and boot-loops the service
# with restart-on-failure. Mirrors auth.ts: only the group/world bits
# matter (0600, 0400, … all fine).
auth_mode="$(stat -c '%a' "$goblin_home/auth.jsonl")"
if [ "$(( 8#$auth_mode & 8#077 ))" -ne 0 ]; then
	fail "auth.jsonl mode is $auth_mode — tighten it first: chmod 600 $goblin_home/auth.jsonl"
fi
# A `!` record that invokes pass-cli directly resolves as the OWNER
# session — full account, no audit (DESIGN.md: Proton Pass). The loader
# only poisons such records (boot must never crash-loop), so install is
# where they get refused. check-auth prints names only, never values,
# and reserves exit 2 for "offenders found" — any other nonzero means
# the check itself failed (its stderr already showed why), which is a
# different failure than a refused record.
offenders=""
check_exit=0
offenders="$(GOBLIN_HOME="$goblin_home" "$bun_bin" "$repo_root/scripts/check-auth.ts")" || check_exit=$?
if [ "$check_exit" -eq 2 ]; then
	fail "auth.jsonl records invoke pass-cli directly (${offenders//$'\n'/, }) — route them through pass-keys (DESIGN.md: Proton Pass)"
elif [ "$check_exit" -ne 0 ]; then
	fail "auth check failed (check-auth.ts exit $check_exit) — see the error above"
fi

# Dependencies — node_modules, not the world. Always sync: a new dep
# (mcporter for the mcp skill, …) must land on re-run, not just on a
# fresh checkout — frozen-lockfile keeps it deterministic.
(cd "$repo_root" && bun install --frozen-lockfile)

# ffmpeg powers TTS's WebM→Ogg remux and over-cap transcription.
# Comment lines are stripped first so commented-out examples don't count.
if grep -vE '^[[:space:]]*//' "$goblin_home/goblin.json5" | grep -Eq '(^|[[:space:]])(tts|transcription)[[:space:]]*:' &&
	! command -v ffmpeg >/dev/null; then
	echo "install: warning — speech is configured but ffmpeg is not in PATH; TTS or oversized transcription may fail" >&2
fi

# Unit generation: substitute the paths baked into the committed unit so
# the same file works on any box. No-ops where the defaults already match.
# PATH is per-account too (Environment=PATH=/home/daniel/bin:…): rewrite
# the operator's home there like the other baked paths. Specific (binary)
# substitutions run first so the generic PATH rules never eat their
# prefixes.
mkdir -p "$unit_dir"
sed \
	-e "s|/home/daniel/build/goblin-v2|$repo_root|g" \
	-e "s|/home/daniel/goblin|$goblin_home|g" \
	-e "s|/usr/bin/bun|$bun_bin|g" \
	-e "s|/home/daniel/bin|$HOME/bin|g" \
	-e "s|/home/daniel/.local/bin|$HOME/.local/bin|g" \
	"$repo_root/deploy/goblin.service" > "$unit_dir/goblin.service"

# The herdr session is a sibling unit (DESIGN.md, "Delegation") — its
# panes outlive goblin restarts. goblin.service's Wants= tolerates it
# being absent, so a missing herdr is a warning, not a failed install.
# The own local session is delegation's default target regardless of
# any machines config (design/delegation.md, "Targets") — whenever
# herdr is installed here, this box hosts its unit.
herdr_bin="$(command -v herdr || true)"
if [ -n "$herdr_bin" ]; then
	sed \
		-e "s|/home/daniel/.local/bin/herdr|$herdr_bin|g" \
		-e "s|/home/daniel/bin|$HOME/bin|g" \
		-e "s|/home/daniel/.local/bin|$HOME/.local/bin|g" \
		"$repo_root/deploy/goblin-herdr.service" > "$unit_dir/goblin-herdr.service"
else
	if [ -z "$herdr_bin" ]; then
		echo "install: warning — herdr not found in PATH; delegation will be unavailable" >&2
	fi
fi

# Key warming (DESIGN.md, "Proton Pass"): a cold pass-cli login runs
# ~100s of retries, past auth's 15s resolve bound, so goblin.service
# Wants= a oneshot warmer + a twice-daily timer that keep the pass-keys
# tmpfs cache hot. Only installed when an auth record's command routes
# through pass-keys — and then pass-keys must exist, or the records
# could never resolve at all.
passkeys_bin=""
if grep -Eq '"value"[[:space:]]*:[[:space:]]*"!.*pass-keys' "$goblin_home/auth.jsonl"; then
	passkeys_bin="$(command -v pass-keys || true)"
	[ -n "$passkeys_bin" ] ||
		fail "auth.jsonl routes keys through pass-keys but pass-keys is not in PATH — install it first (~/build/pass-keys)"
	sed \
		-e "s|/home/daniel/.local/bin/pass-keys|$passkeys_bin|g" \
		-e "s|/home/daniel/bin|$HOME/bin|g" \
		-e "s|/home/daniel/.local/bin|$HOME/.local/bin|g" \
		"$repo_root/deploy/goblin-keys.service" > "$unit_dir/goblin-keys.service"
	cp "$repo_root/deploy/goblin-keys.timer" "$unit_dir/goblin-keys.timer"
fi
systemctl --user daemon-reload

# User units need linger to run without a login session.
if [ "$(loginctl show-user "$USER" -p Linger 2>/dev/null)" != "Linger=yes" ]; then
	loginctl enable-linger "$USER" 2>/dev/null ||
		echo "install: could not enable linger — run: loginctl enable-linger $USER" >&2
fi

if [ -n "$herdr_bin" ]; then
	systemctl --user enable --now goblin-herdr
fi
if [ -n "$passkeys_bin" ]; then
	# The service is a oneshot warmer: enable puts it in default.target's
	# wants for boot; the timer --now schedules the twice-daily refresh.
	systemctl --user enable goblin-keys.service
	systemctl --user enable --now goblin-keys.timer
fi
systemctl --user enable --now goblin
sleep 1
systemctl --user --no-pager --full status goblin | head -6 || true
echo
echo "logs:  journalctl --user -u goblin -f   (durable copy: $goblin_home/state/goblin.log)"

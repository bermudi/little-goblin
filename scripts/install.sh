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

# Dependencies — node_modules, not the world.
if [ ! -d "$repo_root/node_modules" ]; then
	(cd "$repo_root" && bun install --frozen-lockfile)
fi

# Unit generation: substitute the paths baked into the committed unit so
# the same file works on any box. No-ops where the defaults already match.
mkdir -p "$unit_dir"
sed \
	-e "s|/home/daniel/build/goblin-v2|$repo_root|g" \
	-e "s|/home/daniel/goblin|$goblin_home|g" \
	-e "s|/usr/bin/bun|$bun_bin|g" \
	"$repo_root/deploy/goblin.service" > "$unit_dir/goblin.service"
systemctl --user daemon-reload

# User units need linger to run without a login session.
if [ "$(loginctl show-user "$USER" -p Linger 2>/dev/null)" != "Linger=yes" ]; then
	loginctl enable-linger "$USER" 2>/dev/null ||
		echo "install: could not enable linger — run: loginctl enable-linger $USER" >&2
fi

systemctl --user enable --now goblin
sleep 1
systemctl --user --no-pager --full status goblin | head -6 || true
echo
echo "logs:  journalctl --user -u goblin -f   (durable copy: $goblin_home/state/goblin.log)"

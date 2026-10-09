#!/usr/bin/env bash
# Deploy this tree to the prod box. One command, run from the dev tree
# (g7): gate here, push, pull+rebuild+restart there, verify. It is also
# the push discipline — a deploy pushes exactly what it ships.
#
#   scripts/deploy.sh [host]        # host defaults to lithium
#
# Steps, in order:
#   1. refuse a dirty tree or a detached HEAD — deploys are commits
#   2. gate on THIS box: bun run typecheck && bun test
#   3. git push origin HEAD   (GitHub is the transport to the box)
#   4. on the box: git pull --ff-only, bun install when the dependency
#      manifests moved, bun run app:build when app/ or the manifests
#      moved (the client is served from disk, so client and backend
#      restart as one rollout), systemctl --user restart goblin
#   5. verify the unit is active and scan the post-restart journal for
#      error lines; print old→new hashes and a one-line rollback
#
# If deploy/memory/ changed, a note is printed — the podman stack is
# installed from that directory and never auto-applied (see
# docs/operations.md, Deploying).
#
# Rollback is manual and printed at the end: on the box, reset to the
# old hash, reinstall, rebuild, restart — app/dist and node_modules are
# gitignored, so a bare reset would leave the new client/deps running
# beside the old backend.
set -euo pipefail

remote_host="${1:-lithium}"

fail() { echo "deploy: $*" >&2; exit 1; }
step() { echo "deploy: $*"; }

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

# --- 1. What gets deployed is a commit, on a branch ----------------------
[ -z "$(git status --porcelain)" ] ||
	fail "working tree dirty — commit or stash first; deploys are commits"
branch="$(git symbolic-ref -q --short HEAD)" ||
	fail "detached HEAD — check out the branch to deploy"
new_rev="$(git rev-parse HEAD)"
step "deploying $branch @ $(git log -1 --format='%h %s' "$new_rev")"

# --- 2. Gate on this box ---------------------------------------------------
step "gate: bun run typecheck && bun test"
bun run typecheck
bun test

# --- 3. Push (the transport) ----------------------------------------------
step "pushing $new_rev to origin"
git push origin HEAD

# --- 4-5. Remote: pull, rebuild, restart, verify ---------------------------
# One ssh session, bash -s with the new rev as $1. Every remote failure
# aborts with its own output; the journal tail rides along on a failed
# start so the reason is in this terminal, not only on the box.
step "updating $remote_host"
ssh -o BatchMode=yes "$remote_host" bash -s -- "$new_rev" <<'REMOTE'
set -euo pipefail
fail() { echo "deploy: $*" >&2; exit 1; }
cd "$HOME/build/little-goblin"
[ -z "$(git status --porcelain)" ] ||
	fail "remote tree dirty — hand-edited prod checkout; resolve by hand"
command -v bun >/dev/null || fail "bun not found in PATH on $(hostname)"
old_rev="$(git rev-parse HEAD)"
git fetch --quiet origin
git pull --ff-only --quiet
[ "$(git rev-parse HEAD)" = "$1" ] ||
	fail "remote HEAD $(git rev-parse HEAD) != pushed $1 — upstream drift?"
changed="$(git diff --name-only "$old_rev" "$1")"
if printf '%s\n' "$changed" | grep -qE '^(bun\.lock|package\.json)$'; then
	bun install --frozen-lockfile
fi
if printf '%s\n' "$changed" | grep -qE '^(app/|package\.json$|bun\.lock$)'; then
	# The bundle inlines dependency code — a react/ai/vite bump lands in
	# package.json/bun.lock with no app/ path touched and must rebuild too
	# (the vite config itself lives under app/).
	bun run app:build
fi
if printf '%s\n' "$changed" | grep -qE '^deploy/memory/'; then
	echo "deploy: NOTE — deploy/memory/ changed; the podman stack is installed"
	echo "deploy: from that dir and never auto-applied. If quadlets or env flow"
	echo "deploy: changed: python3 deploy/memory/install.py (asset refresh),"
	echo "deploy: hand-apply quadlet changes, podman rm -f goblin-memory-api,"
	echo "deploy: systemctl --user restart goblin-memory-api — see"
	echo "deploy: docs/operations.md, Deploying."
fi
restart_epoch="$(date +%s)"
systemctl --user restart goblin
for _ in $(seq 1 20); do
	sleep 1
	[ "$(systemctl --user is-active goblin)" = active ] && break
done
if [ "$(systemctl --user is-active goblin)" != active ]; then
	journalctl --user -u goblin -n 40 --no-pager >&2 || true
	fail "goblin not active after restart"
fi
sleep 3
errors="$(journalctl --user -u goblin --since "@$restart_epoch" --no-pager \
	| grep '"level":"error"' || true)"
if [ -n "$errors" ]; then
	echo "deploy: WARNING — error lines in the fresh journal:" >&2
	printf '%s\n' "$errors" | tail -5 >&2
fi
echo "deploy: lithium now $(git log -1 --format='%h %s')"
echo "deploy: was $old_rev"
# Ignored app/dist and node_modules survive a reset — reinstall and
# rebuild the rolled-back revision or the old backend runs beside the
# new client/deps.
echo "deploy: rollback: cd ~/build/little-goblin && git reset --hard $old_rev && bun install --frozen-lockfile && bun run app:build && systemctl --user restart goblin"
REMOTE

step "memory stack on $remote_host (if installed):"
ssh -o BatchMode=yes "$remote_host" \
	'podman inspect goblin-memory-api --format "  goblin-memory-api: {{.State.Health.Status}} (streak {{.State.Health.FailingStreak}})"' \
	2>/dev/null || echo "  not installed / podman unavailable"

step "done: $remote_host @ $(git log -1 --format='%h' "$new_rev")"

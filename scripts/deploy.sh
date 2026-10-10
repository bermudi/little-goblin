#!/usr/bin/env bash
# Deploy this tree locally on g7: gate → refresh → restart → verify.
# Git publication is separate so origin/main remains a review baseline.
#
#   scripts/deploy.sh
#
# Steps, in order:
#   1. refuse a dirty tree or a detached HEAD — deploys are commits
#   2. gate: bun run typecheck && bun test
#   3. refresh what the gate can't cover, judged against the last
#      deployed revision (marker in .git/GOBLIN_DEPLOYED_REV; first
#      run refreshes unconditionally): bun install --frozen-lockfile
#      when dependency manifests moved, bun run app:build when app/
#      or the manifests moved — dist is served from disk, so the gate
#      tests the tree while the service serves the bundle
#   4. systemctl --user restart goblin; verify the unit came back and
#      scan the fresh journal for error lines; probe the memory API
#
# If deploy/memory/ changed, a note is printed — the podman stack is
# installed from that directory and never auto-applied (see
# docs/operations.md, Deploying).
#
# Rollback is manual and printed on success: reset to the old hash,
# reinstall, rebuild, restart — dist and node_modules are gitignored,
# so the old revision needs its own deps and client.
set -euo pipefail

fail() { echo "deploy: $*" >&2; exit 1; }
step() { echo "deploy: $*"; }

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"
marker="$repo_root/.git/GOBLIN_DEPLOYED_REV"

# --- 1. What gets deployed is a commit, on a branch ----------------------
[ -z "$(git status --porcelain)" ] ||
	fail "working tree dirty — commit or stash first; deploys are commits"
branch="$(git symbolic-ref -q --short HEAD)" ||
	fail "detached HEAD — check out the branch to deploy"
new_rev="$(git rev-parse HEAD)"
old_rev="$(cat "$marker" 2>/dev/null || true)"
step "deploying $branch @ $(git log -1 --format='%h %s' "$new_rev")${old_rev:+ (was ${old_rev:0:7})}"

# --- 2. Gate ---------------------------------------------------------------
step "gate: bun run typecheck && bun test"
bun run typecheck
bun test

# --- 3. Refresh deps and the served bundle ---------------------------------
# What the refresh steps judge. No marker (first run) or a marker that no
# longer resolves (history rewrite) means "everything": the diff can't
# prove any path is fresh, so none may be skipped. The sentinel names hit
# every grep below — deps, client, and the memory note.
changed() {
	if [ -z "$old_rev" ] || ! git rev-parse -q --verify "$old_rev" >/dev/null; then
		printf 'bun.lock\npackage.json\napp/src/x.ts\ndeploy/memory/env\n'
	else
		git diff --name-only "$old_rev" "$new_rev"
	fi
}
if changed | grep -qE '^(bun\.lock|package\.json)$'; then
	bun install --frozen-lockfile
fi
if changed | grep -qE '^(app/|package\.json$|bun\.lock$)'; then
	# The bundle inlines dependency code — a react/ai/vite bump lands in
	# package.json/bun.lock with no app/ path touched and must rebuild too
	# (the vite config itself lives under app/).
	bun run app:build
fi
if changed | grep -qE '^deploy/memory/'; then
	echo "deploy: NOTE — deploy/memory/ changed; the podman stack is installed"
	echo "deploy: from that dir and never auto-applied. If quadlets or env flow"
	echo "deploy: changed: python3 deploy/memory/install.py (asset refresh),"
	echo "deploy: hand-apply quadlet changes, podman rm -f goblin-memory-api,"
	echo "deploy: systemctl --user restart goblin-memory-api — see"
	echo "deploy: docs/operations.md, Deploying."
fi

# --- 4. Restart, verify -----------------------------------------------------
restart_epoch="$(date +%s)"
systemctl --user restart goblin
for _ in $(seq 1 20); do
	sleep 1
	[ "$(systemctl --user is-active goblin)" = active ] && break
done
if [ "$(systemctl --user is-active goblin)" != active ]; then
	journalctl --user -u goblin -n 40 --no-pager >&2
	fail "goblin not active after restart"
fi
sleep 3
journal="$(journalctl --user -u goblin --since "@$restart_epoch" --no-pager)"
# grep's 1 means no error lines, not a failed journal read.
errors="$(printf '%s\n' "$journal" | grep '"level":"error"' || [ "$?" -eq 1 ])"
if [ -n "$errors" ]; then
	echo "deploy: WARNING — error lines in the fresh journal:" >&2
	printf '%s\n' "$errors" | tail -5 >&2
fi

# Memory API on the same box — probe local, no ssh.
if command -v podman >/dev/null; then
	if podman container exists goblin-memory-api; then
		health="$(podman inspect goblin-memory-api --format '{{.State.Health.Status}}')"
		echo "  goblin-memory-api: $health"
		[ "$health" = healthy ] || fail "memory API is not healthy ($health)"
	else
		status=$?
		# Podman's exists contract: 1 means absent; other codes are failures.
		[ "$status" -eq 1 ] || fail "podman container exists failed (exit $status)"
		load_state="$(systemctl --user show --property=LoadState --value goblin-memory-api.service)"
		if [ "$load_state" = not-found ]; then
			echo "  memory stack not installed"
		else
			fail "memory API unit is $load_state but its container is absent; inspect systemctl --user status goblin-memory-api"
		fi
	fi
fi

echo "$new_rev" > "$marker"
step "done: g7 @ ${new_rev:0:7}"
if [ -n "$old_rev" ]; then
	step "rollback: git reset --hard $old_rev && bun install --frozen-lockfile && bun run app:build && systemctl --user restart goblin && echo $old_rev > $marker"
fi

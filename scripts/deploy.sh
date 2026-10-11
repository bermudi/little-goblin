#!/usr/bin/env bash
# Local deployment: gate → refresh deps/client → restart → verify.
# Never push, fetch or pull: origin/main remains the separate review baseline.
# The client is served from disk, so building it and restarting the backend
# are one approved rollout. Memory assets are never auto-applied.
# Rollback must restore ignored deps/client as well as the tracked revision.
set -euo pipefail

fail() { echo "deploy: $*" >&2; exit 1; }
step() { echo "deploy: $*"; }

repo_root="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$repo_root"
# A branch clone or linked worktree must not restart a different checkout.
service_root="$(systemctl --user show --property=WorkingDirectory --value goblin.service)" ||
	fail "cannot read goblin.service WorkingDirectory"
[[ "$service_root" = /* ]] || fail "goblin.service has no absolute WorkingDirectory"
service_root="$(cd "$service_root" && pwd -P)" ||
	fail "cannot resolve goblin.service WorkingDirectory"
[ "$service_root" = "$repo_root" ] ||
	fail "goblin.service WorkingDirectory ($service_root) does not match checkout ($repo_root)"

# Git owns this location: .git is a file in a linked worktree.
marker="$(git rev-parse --git-path GOBLIN_DEPLOYED_REV)" || fail "cannot resolve deployment marker"
marker_dir="$(dirname "$marker")"
[ -d "$marker_dir" ] && [ -w "$marker_dir" ] && [ -x "$marker_dir" ] ||
	fail "deployment marker directory is not writable: $marker_dir"
old_rev=""
refresh_all=true
if [ -e "$marker" ] || [ -L "$marker" ]; then
	[ -f "$marker" ] || fail "deployment marker is not a regular file: $marker"
	[ -r "$marker" ] || fail "cannot read deployment marker: $marker"
	old_rev="$(cat "$marker")" || fail "cannot read deployment marker: $marker"
	[ -w "$marker" ] || fail "deployment marker is not writable: $marker"
	[[ "$old_rev" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] ||
		fail "invalid commit in deployment marker: $marker"
	# Missing history is a stale marker, not proof that any installed path is fresh.
	# Git can report corrupt objects as "missing" with exit zero. Include
	# diagnostics so only a clean missing-object response permits fallback.
	marker_type="$(printf '%s\n' "$old_rev" | git cat-file --batch-check='%(objecttype)' 2>&1)" ||
		fail "cannot inspect deployment marker commit: $marker"
	case "$marker_type" in
		commit)
			old_rev="$(git rev-parse --verify "$old_rev^{commit}")" ||
				fail "cannot resolve deployment marker commit: $marker"
			refresh_all=false ;;
		"$old_rev missing")
			step "deployment marker history is missing; refreshing everything" ;;
		*) fail "invalid commit in deployment marker: $marker ($marker_type)" ;;
	esac
fi

# --- 1. What gets deployed is a commit, on a branch ----------------------
tree_status="$(git status --porcelain)" || fail "cannot read working tree status"
[ -z "$tree_status" ] ||
	fail "working tree dirty — commit or stash first; deploys are commits"
branch="$(git symbolic-ref -q --short HEAD)" ||
	fail "detached HEAD — check out the branch to deploy"
new_rev="$(git rev-parse --verify HEAD^{commit})" || fail "cannot resolve deployment commit"
# A missing/stale marker refreshes deps, client and the memory runbook.
# Otherwise, resolve the diff once before builds/restart and never hide failures.
if [ "$refresh_all" = true ]; then
	changed_paths=$'bun.lock\npackage.json\napp/src/x.ts\ndeploy/memory/env'
else
	changed_paths="$(git diff --name-only "$old_rev" "$new_rev")" ||
		fail "cannot compare deployment revisions"
fi
revision_summary="$(git log -1 --format='%h %s' "$new_rev")" || fail "cannot read deployment commit"
step "deploying $branch @ $revision_summary${old_rev:+ (was ${old_rev:0:7})}"

# --- 2. Gate ---------------------------------------------------------------
# Tests gate merges, not deploys: re-running the suite here re-executed work
# every merge already proved, adding ~90s before each restart.
step "gate: bun run typecheck"
bun run typecheck

# --- 3. Refresh deps and the served bundle ---------------------------------
if grep -qE '^(bun\.lock|package\.json)$' <<< "$changed_paths"; then
	bun install --frozen-lockfile
fi
if grep -qE '^(app/|package\.json$|bun\.lock$|src/agent/tools/ui-schema\.ts$)' <<< "$changed_paths"; then
	# The bundle inlines dependencies and the shared UI schema, not just app/.
	bun run app:build
fi
if grep -qE '^deploy/memory/' <<< "$changed_paths"; then
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
# Deliberate tolerance: error-level lines are reported, not fatal — a
# long-lived agent logs nonfatal subsystem errors without stopping the
# unit. The hard gates are the is-active check above and the memory
# probe below; this print exists so a recurring boot error ships
# visibly with the deploy that introduced it.
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
else
	echo "  memory probe skipped: podman unavailable"
fi

# Durable like every other state write: tmp + fsync + rename + directory
# fsync — atomic *naming* alone is not durability: a crash can persist the
# rename with unflushed data, leaving a short/empty line the next deploy
# rejects as an invalid commit (wedging deploys until hand-repaired).
marker_tmp="$(mktemp "$marker_dir/.GOBLIN_DEPLOYED_REV.XXXXXX")" || fail "cannot create deployment marker temp file"
printf '%s\n' "$new_rev" >"$marker_tmp" || { rm -f "$marker_tmp"; fail "cannot write deployment marker"; }
sync -d "$marker_tmp" || fail "cannot flush deployment marker temp file"
mv -f "$marker_tmp" "$marker" || { rm -f "$marker_tmp"; fail "cannot update deployment marker: $marker"; }
sync -d "$marker_dir" || true
step "done: g7 @ ${new_rev:0:7}"
if [ -n "$old_rev" ]; then
	printf -v rollback_marker '%q' "$marker"
	step "rollback: git reset --hard $old_rev && bun install --frozen-lockfile && bun run app:build && systemctl --user restart goblin && echo $old_rev > $rollback_marker"
fi

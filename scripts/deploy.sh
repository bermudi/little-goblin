#!/usr/bin/env bash
# Never push, fetch or pull: origin/main remains the separate review
# baseline. The client is served from disk per request: the build only
# stages into app/dist.next and the publish step flips the app/dist
# symlink atomically, so the served tree is never half-written.
# Publishing the client and restarting the backend are one approved
# rollout. Memory assets are never auto-applied.
# Rollback must restore ignored deps/client as well as the tracked
# revision; when the previous revision is known, its recipe prints on
# success and on any failure after the attempt marker — otherwise
# failures print manual recovery steps, since no automated recipe can
# exist.
set -euo pipefail

fail() { echo "deploy: $*" >&2; exit 1; }
step() { echo "deploy: $*"; }

# goblin.log annotation: a deploy-initiated restart must be distinguishable
# from a spontaneous one — an unexplained "shutting down" reads as an
# incident. Lines match src/log.ts's JSONL shape. Diagnostics, not gating:
# every failure here warns on stderr and continues.
annotate_log() {
	[ -n "$goblin_log" ] || return 0
	local msg="$1" was="${2-}"
	local line
	if [ -n "$was" ]; then
		line="$(jq -cn --arg ts "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" \
			--arg msg "deploy $msg" --arg rev "$new_rev" --arg was "$was" \
			'{ts:$ts,level:"info",msg:$msg,rev:$rev,was:$was}')" || {
			echo "deploy: WARNING — goblin.log annotation build failed" >&2
			return 0
		}
	else
		line="$(jq -cn --arg ts "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" \
			--arg msg "deploy $msg" --arg rev "$new_rev" \
			'{ts:$ts,level:"info",msg:$msg,rev:$rev}')" || {
			echo "deploy: WARNING — goblin.log annotation build failed" >&2
			return 0
		}
	fi
	printf '%s\n' "$line" >>"$goblin_log" 2>/dev/null ||
		echo "deploy: WARNING — could not append goblin.log annotation" >&2
}

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
# One deploy at a time: a slow acceptance must not let a finishing
# sibling regress a newer marker, and a rollback-vs-forward race can
# leave node_modules/app/dist stale against the running rev. Block —
# the wait is bounded by the holder's own run.
exec 9>"$marker_dir/.deploy-lock" || fail "cannot open deploy lock: $marker_dir"
if ! flock -n 9; then
	step "deploy lock held by a sibling run — waiting (15m budget)"
	flock -w 900 9 ||
		fail "deploy lock still held after 15m — a sibling deploy is hung; inspect $marker_dir/.deploy-lock"
fi
old_rev=""
refresh_all=true
rollback_available=false
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
			refresh_all=false
			rollback_available=true ;;
		"$old_rev missing")
			# No local object — the printed rollback line would name a
			# commit git can't check out.
			old_rev=""
			step "deployment marker history is missing; refreshing everything" ;;
		*) fail "invalid commit in deployment marker: $marker ($marker_type)" ;;
	esac
fi

# A leftover attempt marker means the last deploy died after publishing
# its revision — gate, build, restart or verification. Its diff against
# the successful marker is untrustworthy (the refresh may have
# half-landed), so it forces dependency install and client rebuild on
# this run. Same per-worktree location and file-shape contract as the
# successful marker: anything else fails loudly rather than being
# cleared.
incomplete="$(git rev-parse --git-path GOBLIN_DEPLOY_INCOMPLETE)" ||
	fail "cannot resolve deployment attempt marker"
interrupted=false
if [ -e "$incomplete" ] || [ -L "$incomplete" ]; then
	[ -L "$incomplete" ] &&
		fail "deployment attempt marker is not a regular file (symlink): $incomplete"
	[ -f "$incomplete" ] ||
		fail "deployment attempt marker is not a regular file: $incomplete"
	[ -r "$incomplete" ] && [ -w "$incomplete" ] ||
		fail "deployment attempt marker is not readable/writable: $incomplete"
	interrupted=true
fi

# --- 1. What gets deployed is a commit, on a branch ----------------------
# The server is TypeScript run in place, so a modified tracked file means
# the process would run something other than HEAD and the deployment
# marker (and its rollback) would lie. Untracked files are in no commit:
# they are surfaced, never fatal.
tree_status="$(git status --porcelain)" || fail "cannot read working tree status"
untracked_files=""
while IFS= read -r line; do
	case "$line" in
		"") ;;
		"?? "*) untracked_files+="${line#\?\? }"$'\n' ;;
		*) fail "tracked files modified — commit or stash first; deploys are commits" ;;
	esac
done <<<"$tree_status"
if [ -n "$untracked_files" ]; then
	step "untracked files present — not in HEAD, so not deployed:"
	while IFS= read -r file; do
		[ -n "$file" ] && step "  $file"
	done <<<"$untracked_files"
fi
branch="$(git symbolic-ref -q --short HEAD)" ||
	fail "detached HEAD — check out the branch to deploy"
new_rev="$(git rev-parse --verify HEAD^{commit})" || fail "cannot resolve deployment commit"
# A missing/stale marker refreshes deps, client and the memory runbook.
# Otherwise, resolve the diff once before builds/restart and never hide
# failures.
if [ "$refresh_all" = true ]; then
	changed_paths=$'bun.lock\npackage.json\napp/src/x.ts\ndeploy/memory/env'
else
	changed_paths="$(git diff --name-only "$old_rev" "$new_rev")" ||
		fail "cannot compare deployment revisions"
fi
revision_summary="$(git log -1 --format='%h %s' "$new_rev")" || fail "cannot read deployment commit"
step "deploying $branch @ $revision_summary${old_rev:+ (was ${old_rev:0:7})}"
if [ "$interrupted" = true ]; then
	step "incomplete previous deploy attempt — forcing dependency and client refresh"
fi

# Publish this attempt BEFORE any mutation, durably like the successful
# marker. Any failure after this point — gate, build, restart,
# verification — leaves the marker, forcing the next run's refresh; it
# is never cleared by a trap and only unlinked after full verification
# below.
incomplete_tmp="$(mktemp "$marker_dir/.GOBLIN_DEPLOY_INCOMPLETE.XXXXXX")" ||
	fail "cannot create deployment attempt marker temp file"
printf '%s\n' "$new_rev" >"$incomplete_tmp" ||
	{ rm -f "$incomplete_tmp"; fail "cannot write deployment attempt marker"; }
sync "$incomplete_tmp" || fail "cannot flush deployment attempt marker temp file"
mv -f "$incomplete_tmp" "$incomplete" ||
	{ rm -f "$incomplete_tmp"; fail "cannot update deployment attempt marker: $incomplete"; }
sync "$marker_dir" || fail "cannot flush deployment attempt marker directory"

# From here a failure can leave ignored dependencies, the served bundle, or
# the unit mid-rollout — every nonzero exit prints recovery: the automated
# recipe when the previous revision is known, the manual steps otherwise.
# Never roll back automatically and never clear the attempt marker from the
# trap: its presence is what forces the next run's refresh.
rollback_cmd=""
if [ "$rollback_available" = true ]; then
	printf -v rollback_marker '%q' "$marker"
	rollback_cmd="git reset --hard $old_rev && bun install --frozen-lockfile && bun run app:build && bash scripts/publish-app.sh && systemctl --user restart goblin && echo $old_rev > $rollback_marker && sync $rollback_marker"
fi
on_exit() {
	rc=$?
	if [ "$rc" -ne 0 ]; then
		if [ -e "$incomplete" ]; then
			echo "deploy: FAILED — the attempt marker stays, so the next run refreshes dependencies and client" >&2
		else
			echo "deploy: FAILED" >&2
		fi
		if [ -n "$rollback_cmd" ]; then
			echo "deploy: rollback: $rollback_cmd" >&2
		else
			# No known previous revision (first deploy or stale marker): the
			# automated recipe is impossible, so leave the manual recovery
			# instead of nothing while prod may run unverified code.
			echo "deploy: recovery: previous deployed revision unknown — manual steps:" >&2
			echo "deploy:   check $marker (last verified rev) and $incomplete (this attempt)" >&2
			echo "deploy:   verify the running service: systemctl --user status goblin" >&2
			echo "deploy:   redeploy from the origin/main baseline" >&2
		fi
	fi
	exit "$rc"
}
trap on_exit EXIT

# --- 2. Refresh deps --------------------------------------------------------
# Before the gate: the typecheck must read new_rev's dependency tree —
# a merge that adds or upgrades a dependency would otherwise gate on
# missing/stale modules. The rollback line restores ignored
# dependencies, so syncing them here adds no new recovery requirement.
if [ "$interrupted" = true ] || grep -qE '^(bun\.lock|package\.json)$' <<< "$changed_paths"; then
	bun install --frozen-lockfile
fi

# --- 3. Gate ----------------------------------------------------------------
# Tests gate merges, not deploys — re-running the suite here re-executes
# what every merge already proved (~90s before each restart).
step "gate: bun run typecheck"
bun run typecheck

# --- 4. Refresh the served bundle -------------------------------------------
if [ "$interrupted" = true ] ||
	grep -qE '^(app/|package\.json$|bun\.lock$|src/agent/tools/ui-schema\.ts$)' <<< "$changed_paths"; then
	# The bundle inlines dependencies and the shared UI schema, not just
	# app/. Build stages into app/dist.next; publish flips the app/dist
	# symlink.
	bun run app:build
	bash scripts/publish-app.sh
fi
if grep -qE '^deploy/memory/' <<< "$changed_paths"; then
	echo "deploy: NOTE — deploy/memory/ changed; the podman stack is installed"
	echo "deploy: from that dir and never auto-applied. If quadlets or env flow"
	echo "deploy: changed: python3 deploy/memory/install.py (asset refresh),"
	echo "deploy: hand-apply quadlet changes, podman rm -f goblin-memory-api,"
	echo "deploy: systemctl --user restart goblin-memory-api — see"
	echo "deploy: docs/operations.md, Deploying."
fi

# --- 5. Restart, verify -----------------------------------------------------
# The gate ran minutes ago against new_rev's tree; a sibling session's
# commit in between leaves the tree clean (the status check can't see
# it) and would restart into code the gate never saw, with the marker
# recording the wrong rev. An *uncommitted* sibling edit is the same
# hole — the status gate ran before the build, so re-check the tree
# too.
[ "$(git rev-parse --verify "HEAD^{commit}")" = "$new_rev" ] ||
	fail "HEAD moved during the gate — commit it and redeploy"
tree_status="$(git status --porcelain --untracked-files=no)" ||
	fail "cannot re-read working tree status"
[ -z "$tree_status" ] ||
	fail "tracked files changed during the gate — inspect and redeploy"
restart_epoch="$(date +%s)"
# The watcher's floor: the invocation this restart must replace, read
# BEFORE the restart — a crash/restart that lands ahead of the watch can
# never be adopted as the accepted one.
pre_restart="$(systemctl --user show goblin.service --property=InvocationID,ExecMainStartTimestampMonotonic --value)" ||
	fail "cannot read goblin.service pre-restart identity"
mapfile -t watch_floor <<< "$pre_restart"
if [ "${#watch_floor[@]}" -ne 2 ]; then
	fail "unreadable goblin.service pre-restart identity"
fi
# The log the unit's goblin writes: GOBLIN_HOME rides the unit Environment,
# not this shell. Absent home, missing file, or no jq → warn, deploy anyway.
goblin_log=""
unit_env="$(systemctl --user show goblin.service --property=Environment --value 2>/dev/null || true)"
goblin_home="$(printf '%s\n' "$unit_env" | grep -o 'GOBLIN_HOME=[^ ]*' | head -1 | cut -d= -f2- || true)"
if ! command -v jq >/dev/null 2>&1; then
	echo "deploy: WARNING — jq unavailable; goblin.log will not carry deploy context" >&2
elif [ -n "$goblin_home" ] && [ -f "$goblin_home/state/goblin.log" ]; then
	goblin_log="$goblin_home/state/goblin.log"
else
	echo "deploy: WARNING — goblin.log not resolvable (GOBLIN_HOME='${goblin_home:-unset}'); restart will read unexplained" >&2
fi
annotate_log "restarting goblin" "${old_rev:-none}"
systemctl --user restart goblin
step "verify: startup acceptance"
# Installer grammar; 75s because slow boot failures (a timed-out provider
# handshake) land long after an is-active poll turns green.
if ! bun scripts/check-startup.ts --watch 0 75000 "${watch_floor[0]}" "${watch_floor[1]}" >&2; then
	# Failure diagnostics under the same allowlist the watcher enforces —
	# raw journal bodies carry private runtime fields.
	bun scripts/check-startup.ts --brief 40 >&2 || true
	fail "goblin failed startup acceptance after restart"
fi
annotate_log "restart accepted — goblin live at deployed rev"
sleep 3
# The journal read and the grep are reported, not fatal — a rotation
# race or a grep miss must not abort between the restart and the marker
# write. The hard gates are the startup-acceptance probe above and the
# memory probe below; this print exists so a recurring boot error ships
# visibly with the deploy that introduced it.
if ! journal="$(journalctl --user -u goblin --since "@$restart_epoch" --no-pager)"; then
	journal=""
	echo "deploy: WARNING — could not read the fresh journal; error scan skipped" >&2
fi
errors="$(printf '%s\n' "$journal" | grep '"level":"error"' || true)"
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
# Plain sync FILE fsyncs it — `sync -d` is write-range only and skips a
# fresh file's size metadata; on a directory it does nothing at all.
sync "$marker_tmp" || fail "cannot flush deployment marker temp file"
mv -f "$marker_tmp" "$marker" || { rm -f "$marker_tmp"; fail "cannot update deployment marker: $marker"; }
sync "$marker_dir" || fail "cannot flush deployment marker directory — the rename may not survive a crash"
# Verification passed and the successful marker landed durably — only
# now does the attempt marker go away. A failure here reports failure
# even though the restart succeeded; the stale marker just makes the
# next run refresh again.
rm -f "$incomplete" || fail "cannot clear deployment attempt marker: $incomplete"
sync "$marker_dir" || fail "cannot flush deployment attempt marker removal"
step "done: g7 @ ${new_rev:0:7}"
if [ -n "$rollback_cmd" ]; then
	step "rollback: $rollback_cmd"
fi

#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Error: update.sh must be run as root." >&2
  exit 1
fi

for cmd in git systemctl bun awk; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "Error: ${cmd} is required but not installed." >&2
    exit 1
  fi
done

# Defaults are production paths. The explicit deployment overrides keep the
# ordering contract testable in an isolated temporary tree.
repo_dir="${GOBLIN_DEPLOY_REPO_DIR:-/opt/little-goblin}"
goblin_home="${GOBLIN_DEPLOY_HOME:-/var/lib/goblin}"
user="${GOBLIN_DEPLOY_USER:-goblin}"

MIN_RAM_MB="${GOBLIN_UPDATE_MIN_RAM_MB:-512}"

available_kb=$(awk '
  /^MemAvailable:/ { mem = $2; found_avail = 1 }
  /^MemFree:/ { free = $2 }
  /^Buffers:/ { buffers = $2 }
  /^Cached:/ { cached = $2 }
  /^SwapFree:/ { swap = $2 }
  END {
    if (found_avail) {
      print mem + swap
    } else {
      print free + buffers + cached + swap
    }
  }
' /proc/meminfo)

available_mb=$((available_kb / 1024))

if ((available_mb < MIN_RAM_MB)); then
  echo "Error: update.sh requires at least ${MIN_RAM_MB} MB of available memory+swap, but only ${available_mb} MB is available." >&2
  echo "Add swap or set GOBLIN_UPDATE_MIN_RAM_MB and re-run." >&2
  exit 1
fi

if [[ ! -d "${repo_dir}/.git" ]] || ! su -s /bin/bash "${user}" -c "git -C ${repo_dir} rev-parse --git-dir" >/dev/null 2>&1; then
  echo "Error: ${repo_dir} is not a valid git repository." >&2
  exit 1
fi

if [[ -n "$(su -s /bin/bash "${user}" -c "git -C ${repo_dir} status --porcelain")" ]]; then
  echo "Error: ${repo_dir} has uncommitted changes; commit or stash them before updating." >&2
  exit 1
fi

old_head="$(su -s /bin/bash "${user}" -c "git -C ${repo_dir} rev-parse HEAD")"

echo "Pulling latest code..."
su -s /bin/bash "${user}" -c "cd ${repo_dir} && git pull"

new_head="$(su -s /bin/bash "${user}" -c "git -C ${repo_dir} rev-parse HEAD")"

if [[ "${old_head}" == "${new_head}" ]]; then
  echo "No code changes; verifying state migration and service health."
else
  echo "Installing dependencies..."
  su -s /bin/bash "${user}" -c "cd ${repo_dir} && bun install"

  # git pull may replace this file while the current Bash process is still
  # executing the old revision. Never run post-pull deployment steps from that
  # stale control flow: hand off to a fresh interpreter reading the pulled
  # file. The fresh invocation sees equal heads and continues below.
  echo "Code changed; handing off to the pulled updater revision..."
  exec "${BASH:-bash}" "${repo_dir}/scripts/update.sh"
fi

# This must precede the service stop even with no code change: migrate loads
# the config too, but a config failure after stopping would leave a previously
# healthy service down without a migration backup to restore.
echo "Running validate-config..."
su -s /bin/bash "${user}" -c "cd ${repo_dir} && GOBLIN_HOME=${goblin_home} bun run validate-config"

echo "Stopping goblin service before offline migration..."
systemctl stop goblin

echo "Running offline migration (the migration command owns the recovery backup)..."
if ! su -s /bin/bash "${user}" -c "cd ${repo_dir} && GOBLIN_HOME=${goblin_home} bun run migrate"; then
  echo "Error: offline migration failed; goblin service remains stopped." >&2
  echo "Restore the migration backup reported above before retrying." >&2
  exit 1
fi

echo "Starting goblin service..."
systemctl start goblin

echo "Update complete."

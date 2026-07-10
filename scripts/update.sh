#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Error: update.sh must be run as root." >&2
  exit 1
fi

for cmd in git systemctl bun; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "Error: ${cmd} is required but not installed." >&2
    exit 1
  fi
done

repo_dir="/opt/little-goblin"
goblin_home="/var/lib/goblin"
user="goblin"

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
  echo "No code changes; update complete."
  exit 0
fi

echo "Installing dependencies..."
su -s /bin/bash "${user}" -c "cd ${repo_dir} && bun install"

echo "Running typecheck..."
su -s /bin/bash "${user}" -c "cd ${repo_dir} && bun run typecheck"

echo "Running validate-config..."
su -s /bin/bash "${user}" -c "cd ${repo_dir} && GOBLIN_HOME=${goblin_home} bun run validate-config"

echo "Restarting goblin service..."
systemctl restart goblin

echo "Update complete."

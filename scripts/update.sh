#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Error: update.sh must be run as root." >&2
  exit 1
fi

repo_dir="/opt/little-goblin"
goblin_home="/var/lib/goblin"
user="goblin"

if [[ ! -d "${repo_dir}/.git" ]]; then
  echo "Error: ${repo_dir} is not a git repository." >&2
  exit 1
fi

echo "Pulling latest code..."
su -s /bin/bash "${user}" -c "cd ${repo_dir} && git pull"

echo "Installing dependencies..."
su -s /bin/bash "${user}" -c "cd ${repo_dir} && bun install"

echo "Running typecheck..."
su -s /bin/bash "${user}" -c "cd ${repo_dir} && bun run typecheck"

echo "Running validate-config..."
su -s /bin/bash "${user}" -c "cd ${repo_dir} && GOBLIN_HOME=${goblin_home} bun run validate-config"

echo "Restarting goblin service..."
systemctl restart goblin

echo "Update complete."

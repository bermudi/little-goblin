#!/usr/bin/env bash
set -euo pipefail

goblin_home="${GOBLIN_HOME:-/var/lib/goblin}"
user="goblin"

current_user="$(id -un)"
if [[ "${current_user}" != "root" && "${current_user}" != "${user}" ]]; then
  echo "Error: backup.sh must be run as root or the ${user} user." >&2
  exit 1
fi

backups_dir="${goblin_home}/backups"
mkdir -p "${backups_dir}"

if [[ "${current_user}" == "root" ]]; then
  chown "${user}:${user}" "${backups_dir}"
fi

timestamp="$(date +%Y%m%d-%H%M%S)"
archive="${backups_dir}/goblin-home-${timestamp}.tar.gz"

tar -czf "${archive}" \
  -C "${goblin_home}" \
  --exclude='backups' \
  --exclude='scratch' \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='*.tmp' \
  workspace state goblin.json5

if [[ "${current_user}" == "root" ]]; then
  chown "${user}:${user}" "${archive}"
fi

echo "Backup created: ${archive}"

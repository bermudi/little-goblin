#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Error: install-service.sh must be run as root." >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "${script_dir}/.." && pwd)"
unit_src="${repo_dir}/scripts/goblin.service"
unit_dst="/etc/systemd/system/goblin.service"

if [[ ! -f "${unit_src}" ]]; then
  echo "Error: service unit not found at ${unit_src}" >&2
  exit 1
fi

cp "${unit_src}" "${unit_dst}"
chmod 644 "${unit_dst}"

systemctl daemon-reload
systemctl enable goblin

if [[ "${1:-}" == "--start" ]]; then
  systemctl start goblin
  echo "Installed and started goblin.service."
else
  echo "Installed and enabled goblin.service. Run 'systemctl start goblin' to start it."
fi

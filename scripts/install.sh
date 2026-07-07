#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Error: install.sh must be run as root." >&2
  exit 1
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Error: install.sh is intended for Linux hosts only." >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="/opt/little-goblin"
goblin_home="/var/lib/goblin"
user="goblin"
group="goblin"

repo_url="${1:-}"
if [[ -z "${repo_url}" ]]; then
  repo_url="$(git -C "${script_dir}" remote get-url origin 2>/dev/null || true)"
fi
if [[ -z "${repo_url}" ]]; then
  repo_url="https://github.com/bermudi/little-goblin.git"
fi

if ! id -u "${user}" >/dev/null 2>&1; then
  echo "Creating ${user} system user..."
  useradd -r -m -d "${goblin_home}" -s /usr/sbin/nologin "${user}"
fi

mkdir -p "${goblin_home}"
chown "${user}:${group}" "${goblin_home}"

if [[ -x /usr/local/bin/bun ]]; then
  : # service unit path is already satisfied
elif command -v bun >/dev/null 2>&1; then
  bun_path="$(command -v bun)"
  echo "Linking bun from ${bun_path} to /usr/local/bin/bun..."
  ln -sf "${bun_path}" /usr/local/bin/bun
else
  echo "Installing bun..."
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash
fi

repo_existed=0
old_head=""
new_head=""

if [[ ! -d "${repo_dir}/.git" ]]; then
  echo "Cloning repository into ${repo_dir}..."
  mkdir -p "${repo_dir}"
  git clone "${repo_url}" "${repo_dir}"
else
  repo_existed=1
  old_head="$(su -s /bin/bash "${user}" -c "git -C ${repo_dir} rev-parse HEAD")"
  echo "Updating existing repository at ${repo_dir}..."
  su -s /bin/bash "${user}" -c "git -C ${repo_dir} fetch origin"
  su -s /bin/bash "${user}" -c "git -C ${repo_dir} checkout main"
  su -s /bin/bash "${user}" -c "git -C ${repo_dir} pull origin main"
  new_head="$(su -s /bin/bash "${user}" -c "git -C ${repo_dir} rev-parse HEAD")"
fi

chown -R "${user}:${group}" "${repo_dir}"

echo "Installing dependencies..."
su -s /bin/bash "${user}" -c "cd ${repo_dir} && bun install"

if [[ ! -f "${goblin_home}/goblin.json5" ]]; then
  echo "No goblin.json5 found; running onboard wizard..."
  su -s /bin/bash "${user}" -c "cd ${repo_dir} && GOBLIN_HOME=${goblin_home} bun run onboard"
fi

echo "Validating configuration..."
su -s /bin/bash "${user}" -c "cd ${repo_dir} && GOBLIN_HOME=${goblin_home} bun run validate-config"

echo "Installing systemd service..."
"${repo_dir}/scripts/install-service.sh"

if [[ "${repo_existed}" -eq 0 ]]; then
  echo "Starting goblin service..."
  systemctl start goblin
  echo "Goblin installed and started."
elif [[ "${old_head}" != "${new_head}" ]]; then
  echo "Code changed; restarting goblin service..."
  systemctl restart goblin
  echo "Goblin updated and restarted."
else
  echo "Code unchanged; goblin service left running."
fi

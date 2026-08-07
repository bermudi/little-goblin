#!/usr/bin/env bash
# Exercises update/install ordering with fake binaries and an isolated temp tree.
# It never invokes a real service, user, repository, or GOBLIN_HOME.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT
fake_bin="${tmp}/bin"
order="${tmp}/order.log"
mkdir -p "${fake_bin}"
: >"${order}"

write_fake() {
  local name="$1"
  shift
  cat >"${fake_bin}/${name}"
  chmod +x "${fake_bin}/${name}"
}

write_fake id <<'EOF'
#!/usr/bin/env bash
echo 0
EOF
write_fake uname <<'EOF'
#!/usr/bin/env bash
echo Linux
EOF
write_fake awk <<'EOF'
#!/usr/bin/env bash
echo 1048576
EOF
write_fake git <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
write_fake bun <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
write_fake curl <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
write_fake useradd <<'EOF'
#!/usr/bin/env bash
printf 'useradd %s\n' "$*" >>"${FAKE_ORDER}"
EOF
write_fake chown <<'EOF'
#!/usr/bin/env bash
printf 'chown %s\n' "$*" >>"${FAKE_ORDER}"
EOF
write_fake ln <<'EOF'
#!/usr/bin/env bash
printf 'ln %s\n' "$*" >>"${FAKE_ORDER}"
EOF
write_fake systemctl <<'EOF'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >>"${FAKE_ORDER}"
if [[ "$1" == "is-active" ]]; then
  if [[ "${FAKE_SERVICE_ACTIVE:-1}" == "1" ]]; then
    exit 0
  fi
  exit 1
fi
EOF
write_fake su <<'EOF'
#!/usr/bin/env bash
cmd="${!#}"
printf 'su %s\n' "${cmd}" >>"${FAKE_ORDER}"
case "${cmd}" in
  *"status --porcelain"*) exit 0 ;;
  *"rev-parse --git-dir"*) printf '.git\n'; exit 0 ;;
  *"rev-parse HEAD"*)
    count_file="${FAKE_ROOT}/head-count"
    count=0
    [[ -f "${count_file}" ]] && count="$(cat "${count_file}")"
    if [[ "${FAKE_HEAD_CHANGES:-0}" == "1" && "${count}" -gt 0 ]]; then
      printf 'new-head\n'
    else
      printf 'old-head\n'
    fi
    printf '%s' "$((count + 1))" >"${count_file}"
    exit 0
    ;;
  *pull*)
    replacement_target="${FAKE_UPDATE_SCRIPT:-${FAKE_INSTALL_SCRIPT:-}}"
    replacement_source="${FAKE_REPLACEMENT_SCRIPT:-${FAKE_INSTALL_REPLACEMENT_SCRIPT:-}}"
    if [[ -n "${replacement_target}" && -n "${replacement_source}" ]]; then
      replacement_tmp="${replacement_target}.replacement"
      cp "${replacement_source}" "${replacement_tmp}"
      mv -f "${replacement_tmp}" "${replacement_target}"
    fi
    exit 0
    ;;
  *"bun run validate-config"*)
    if [[ "${FAKE_VALIDATE_FAIL:-0}" == "1" ]]; then
      exit 1
    fi
    exit 0
    ;;
  *"bun run migrate"*)
    if [[ "${FAKE_MIGRATE_FAIL:-0}" == "1" ]]; then
      exit 1
    fi
    exit 0
    ;;
esac
EOF

line_number() {
  local pattern="$1"
  local line
  line="$(grep -n -m1 -- "${pattern}" "${order}" | cut -d: -f1)"
  if [[ -z "${line}" ]]; then
    echo "missing order event: ${pattern}" >&2
    cat "${order}" >&2
    exit 1
  fi
  printf '%s' "${line}"
}

assert_before() {
  local first="$1"
  local second="$2"
  if (( $(line_number "${first}") >= $(line_number "${second}") )); then
    echo "expected '${first}' before '${second}'" >&2
    cat "${order}" >&2
    exit 1
  fi
}

assert_absent() {
  local pattern="$1"
  if grep -q -- "${pattern}" "${order}"; then
    echo "unexpected order event: ${pattern}" >&2
    cat "${order}" >&2
    exit 1
  fi
}

run_with_fakes() {
  local repo="$1"
  local home="$2"
  shift 2
  PATH="${fake_bin}:${PATH}" \
    FAKE_ORDER="${order}" \
    FAKE_ROOT="${tmp}" \
    GOBLIN_DEPLOY_REPO_DIR="${repo}" \
    GOBLIN_DEPLOY_HOME="${home}" \
    GOBLIN_DEPLOY_USER="goblin-test" \
    GOBLIN_DEPLOY_GROUP="goblin-test" \
    "$@"
}

make_existing_repo() {
  local root="$1"
  mkdir -p "${root}/.git" "${root}/scripts"
  cat >"${root}/scripts/install-service.sh" <<'EOF'
#!/usr/bin/env bash
printf 'install-service\n' >>"${FAKE_ORDER}"
EOF
  chmod +x "${root}/scripts/install-service.sh"
}

# update success: validate happens before stop; stop happens before migration;
# migration success is required before start.
update_repo="${tmp}/update-repo"
update_home="${tmp}/update-home"
make_existing_repo "${update_repo}"
mkdir -p "${update_home}"
: >"${order}"
run_with_fakes "${update_repo}" "${update_home}" bash "${repo_root}/scripts/update.sh"
assert_before 'bun run validate-config' 'systemctl stop goblin'
assert_before 'systemctl stop goblin' 'bun run migrate'
assert_before 'bun run migrate' 'systemctl start goblin'

# A pull can replace update.sh itself. The updater must execute the pulled
# revision rather than continue the pre-pull control flow.
handoff_repo="${tmp}/handoff-repo"
make_existing_repo "${handoff_repo}"
cp "${repo_root}/scripts/update.sh" "${handoff_repo}/scripts/update.sh"
handoff_replacement="${tmp}/pulled-update.sh"
{
  head -n 2 "${repo_root}/scripts/update.sh"
  cat <<'EOF'
printf 'pulled updater revision\n' >>"${FAKE_ORDER}"
EOF
  tail -n +3 "${repo_root}/scripts/update.sh"
} >"${handoff_replacement}"
chmod +x "${handoff_repo}/scripts/update.sh" "${handoff_replacement}"
printf '0' >"${tmp}/head-count"
: >"${order}"
FAKE_HEAD_CHANGES=1 \
FAKE_UPDATE_SCRIPT="${handoff_repo}/scripts/update.sh" \
FAKE_REPLACEMENT_SCRIPT="${handoff_replacement}" \
run_with_fakes "${handoff_repo}" "${update_home}" bash "${handoff_repo}/scripts/update.sh"
if [[ "$(grep -c '^pulled updater revision$' "${order}")" -ne 1 ]]; then
  echo "update.sh did not hand off exactly once to the pulled revision" >&2
  cat "${order}" >&2
  exit 1
fi
assert_before 'pulled updater revision' 'systemctl stop goblin'
assert_before 'systemctl stop goblin' 'bun run migrate'
assert_before 'bun run migrate' 'systemctl start goblin'

# The existing-repository install path has the same self-replacement hazard.
install_handoff_repo="${tmp}/install-handoff-repo"
install_handoff_home="${tmp}/install-handoff-home"
make_existing_repo "${install_handoff_repo}"
cp "${repo_root}/scripts/install.sh" "${install_handoff_repo}/scripts/install.sh"
mkdir -p "${install_handoff_home}"
touch "${install_handoff_home}/goblin.json5"
install_handoff_replacement="${tmp}/pulled-install.sh"
{
  head -n 2 "${repo_root}/scripts/install.sh"
  cat <<'EOF'
printf 'pulled installer revision\n' >>"${FAKE_ORDER}"
EOF
  tail -n +3 "${repo_root}/scripts/install.sh"
} >"${install_handoff_replacement}"
chmod +x "${install_handoff_repo}/scripts/install.sh" "${install_handoff_replacement}"
printf '0' >"${tmp}/head-count"
: >"${order}"
FAKE_HEAD_CHANGES=1 \
FAKE_INSTALL_SCRIPT="${install_handoff_repo}/scripts/install.sh" \
FAKE_INSTALL_REPLACEMENT_SCRIPT="${install_handoff_replacement}" \
run_with_fakes "${install_handoff_repo}" "${install_handoff_home}" bash "${repo_root}/scripts/install.sh" https://example.invalid/goblin.git
if [[ "$(grep -c '^pulled installer revision$' "${order}")" -ne 1 ]]; then
  echo "install.sh did not hand off exactly once to the pulled revision" >&2
  cat "${order}" >&2
  exit 1
fi
assert_before 'pulled installer revision' 'systemctl stop goblin'
assert_before 'systemctl stop goblin' 'bun run migrate'
assert_before 'bun run migrate' 'install-service'
assert_before 'install-service' 'systemctl start goblin'

# The handoff must also start the service when the existing service was
# initially stopped; otherwise the changed-head restart is lost.
install_inactive_handoff_repo="${tmp}/install-inactive-handoff-repo"
install_inactive_handoff_home="${tmp}/install-inactive-handoff-home"
make_existing_repo "${install_inactive_handoff_repo}"
cp "${repo_root}/scripts/install.sh" "${install_inactive_handoff_repo}/scripts/install.sh"
mkdir -p "${install_inactive_handoff_home}"
touch "${install_inactive_handoff_home}/goblin.json5"
printf '0' >"${tmp}/head-count"
: >"${order}"
FAKE_HEAD_CHANGES=1 \
FAKE_SERVICE_ACTIVE=0 \
FAKE_INSTALL_SCRIPT="${install_inactive_handoff_repo}/scripts/install.sh" \
FAKE_INSTALL_REPLACEMENT_SCRIPT="${install_handoff_replacement}" \
run_with_fakes "${install_inactive_handoff_repo}" "${install_inactive_handoff_home}" bash "${repo_root}/scripts/install.sh" https://example.invalid/goblin.git
if [[ "$(grep -c '^pulled installer revision$' "${order}")" -ne 1 ]]; then
  echo "install.sh did not hand off exactly once to the pulled revision (inactive service)" >&2
  cat "${order}" >&2
  exit 1
fi
assert_absent 'systemctl stop goblin'
assert_before 'pulled installer revision' 'bun run migrate'
assert_before 'bun run migrate' 'install-service'
assert_before 'install-service' 'systemctl start goblin'

# update config failure: validation happens while the prior service is intact.
: >"${order}"
if FAKE_VALIDATE_FAIL=1 run_with_fakes "${update_repo}" "${update_home}" bash "${repo_root}/scripts/update.sh"; then
  echo "update.sh unexpectedly succeeded after fake config validation failure" >&2
  exit 1
fi
assert_absent 'systemctl stop goblin'
assert_absent 'bun run migrate'

# update migration failure: migration has already stopped the service and no restart runs.
: >"${order}"
if FAKE_MIGRATE_FAIL=1 run_with_fakes "${update_repo}" "${update_home}" bash "${repo_root}/scripts/update.sh"; then
  echo "update.sh unexpectedly succeeded after fake migration failure" >&2
  exit 1
fi
assert_before 'systemctl stop goblin' 'bun run migrate'
assert_absent 'systemctl start goblin'

# install/update success: an active existing service stops before migration and
# starts only after migration and service-unit installation succeed.
install_repo="${tmp}/install-repo"
install_home="${tmp}/install-home"
make_existing_repo "${install_repo}"
mkdir -p "${install_home}"
touch "${install_home}/goblin.json5"
: >"${order}"
FAKE_HEAD_CHANGES=1 run_with_fakes "${install_repo}" "${install_home}" bash "${repo_root}/scripts/install.sh" https://example.invalid/goblin.git
assert_before 'systemctl stop goblin' 'bun run migrate'
assert_before 'bun run migrate' 'install-service'
assert_before 'install-service' 'systemctl start goblin'

# existing-install config failure: validation happens before service stop.
: >"${order}"
if FAKE_HEAD_CHANGES=1 FAKE_VALIDATE_FAIL=1 run_with_fakes "${install_repo}" "${install_home}" bash "${repo_root}/scripts/install.sh" https://example.invalid/goblin.git; then
  echo "install.sh unexpectedly succeeded after fake config validation failure" >&2
  exit 1
fi
assert_absent 'systemctl stop goblin'
assert_absent 'bun run migrate'
assert_absent 'install-service'
assert_absent 'systemctl start goblin'

# install/update migration failure: no unit install or restart is attempted.
: >"${order}"
if FAKE_HEAD_CHANGES=1 FAKE_MIGRATE_FAIL=1 run_with_fakes "${install_repo}" "${install_home}" bash "${repo_root}/scripts/install.sh" https://example.invalid/goblin.git; then
  echo "install.sh unexpectedly succeeded after fake migration failure" >&2
  exit 1
fi
assert_before 'systemctl stop goblin' 'bun run migrate'
assert_absent 'install-service'
assert_absent 'systemctl start goblin'

echo "deployment ordering checks passed"

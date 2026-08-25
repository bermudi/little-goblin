#!/usr/bin/env bash
set -euo pipefail

readonly BASE_SHA="9d57a5ce1cd410e552ad9cbc2f9df6cd5ccf4a87"
readonly EXPECTED_LITESPEC_VERSION="litespec v2.0.0-beta.8"

fail() {
  printf 'litespec adoption verification failed: %s\n' "$*" >&2
  exit 1
}

[[ "$(litespec --version)" == "$EXPECTED_LITESPEC_VERSION" ]] || fail "expected $EXPECTED_LITESPEC_VERSION"
[[ -f specs/product.md ]] || fail "specs/product.md is missing"
[[ -f specs/glossary.md ]] || fail "specs/glossary.md is missing"
[[ ! -e glossary.md ]] || fail "root glossary.md still exists"
[[ ! -e decisions ]] || fail "root decisions/ still exists"
[[ ! -e BACKLOG.md ]] || fail "BACKLOG.md still claims queue authority"
[[ -f PARKED.md ]] || fail "PARKED.md is missing"
[[ ! -e skills-lock.json ]] || fail "Nospec skills lock still exists"

mapfile -t current_decisions < <(find specs/decisions -maxdepth 1 -type f -name '*.md' -print | sort)
[[ ${#current_decisions[@]} -eq 39 ]] || fail "expected 39 current decisions, found ${#current_decisions[@]}"
mapfile -t frozen_decisions < <(find specs/v1-decisions -maxdepth 1 -type f -name '*.md' -print | sort)
[[ ${#frozen_decisions[@]} -eq 8 ]] || fail "expected 8 frozen v1 decisions, found ${#frozen_decisions[@]}"

for decision in "${current_decisions[@]}"; do
  [[ "$(grep -c '^## Status$' "$decision")" -eq 1 ]] || fail "$decision does not contain exactly one Status section"
  grep -q '^accepted$' "$decision" || fail "$decision is not accepted"
  grep -q '^id:' "$decision" || fail "$decision lost its id metadata"
  grep -q '^date:' "$decision" || fail "$decision lost its date metadata"
  grep -q '^spine:' "$decision" || fail "$decision lost its spine metadata"
done

if find .agents/skills -mindepth 1 -maxdepth 1 -type d -name 'nospec-*' -print -quit | grep -q .; then
  fail "Nospec skill directories remain"
fi
for skill in litespec-plan litespec-build litespec-review; do
  [[ -f ".agents/skills/$skill/SKILL.md" ]] || fail "generated $skill is missing"
done
[[ "$(find .agents/skills -mindepth 1 -maxdepth 1 -type d -name 'litespec-*' | wc -l)" -eq 3 ]] || fail "expected exactly three Litespec skills"

if rg -n 'nospec: true|nospec-|Nospec' AGENTS.md ARCHITECTURE.md README.md PARKED.md specs/product.md specs/glossary.md specs/decisions .agents/skills; then
  fail "active authority still refers to Nospec"
fi

evidence_dir="$(mktemp -d)"
trap 'trash "$evidence_dir"' EXIT
validation_json="$evidence_dir/validation.json"
litespec validate --all --strict --json >"$validation_json"
jq -e '
  .valid == true
  and .summary.decisions == 39
  and .summary.capabilities == 0
  and .summary.requirements == 0
' "$validation_json" >/dev/null || fail "strict validation summary is not 39 decisions and zero translated specs"

litespec view --json | jq -e '
  .product.exists == true
  and .summary.decisions.active == 39
  and .summary.decisions.total == 39
  and .summary.specs == 0
  and .summary.requirements == 0
' >/dev/null || fail "Litespec view does not discover the intended authority"

if git diff --name-only "$BASE_SHA"..HEAD -- src e2e package.json bun.lock tsconfig.json | grep -q .; then
  fail "runtime, tests, or dependencies changed during workflow migration"
fi

# beta.8's generator intentionally reproduces its embedded templates byte-for-byte,
# including their existing terminal blank line. Check every hand-maintained path.
git diff --check "$BASE_SHA"..HEAD -- . ':(exclude).agents/skills/litespec-*'

run_checked() {
  local label="$1"
  shift
  local output="$evidence_dir/${label// /-}.out"
  if ! "$@" >"$output" 2>&1; then
    cat "$output"
    fail "$label failed"
  fi
  printf '%s passed; output tail:\n' "$label"
  tail -n 4 "$output"
}

run_checked typecheck bun run typecheck
run_checked tests bun test
run_checked deployment-order bash scripts/deployment-order.test.sh

printf 'Litespec adoption verified: 39 decisions, 0 translated specs, runtime unchanged.\n'

#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

fail() {
  printf 'nospec authority check: %s\n' "$*" >&2
  exit 1
}

frontmatter_adopted() {
  awk '
    NR == 1 && $0 != "---" { exit 1 }
    NR > 1 && /^---$/ { exit found ? 0 : 1 }
    NR > 1 && $0 == "nospec: true" { found = 1 }
    END { if (NR == 0) exit 1 }
  ' "$1"
}

expected_docs=$'AGENTS.md\nARCHITECTURE.md\nBACKLOG.md\nREADME.md\nglossary.md'
actual_docs=$(
  while IFS= read -r file; do
    frontmatter_adopted "$file" && printf '%s\n' "${file#./}"
  done < <(find . -type f -name '*.md' \
    ! -path './.git/*' ! -path './.loop/*' ! -path './.agents/skills/*' \
    ! -path './decisions/*' | sort)
  true
)
if [[ "$actual_docs" != "$expected_docs" ]]; then
  diff -u <(printf '%s\n' "$expected_docs") <(printf '%s\n' "$actual_docs") || true
  fail "adopted durable-document inventory drifted"
fi

expected_decisions=$'0002-topic-ui-is-user-owned.md\n0003-main-goblin-prompt-ownership.md\n0004-one-assistant-capabilities-not-products.md\n0005-pi-routed-stack-cannot-carry-pdfs-or-video.md\n0007-config-startup-filesystem-mutation.md\n0008-path-helper-only-path-construction.md\n0009-workspace-prompt-file-reads.md\n0010-optional-prompt-files-skip-preflight.md\n0014-metrics-file-location.md\n0015-memory-sqlite-canonical.md\n0016-transcript-search-scope.md\n0018-memory-database-guardrail-carveout.md\n0020-memory-bun-sqlite.md\n0021-memory-openai-embedding-direct.md\n0022-memory-frozen-summary.md\n0023-memory-two-tools.md\n0024-memory-hybrid-weights.md\n0025-dream-cross-session-promotion-rule.md\n0026-general-scope-shared-across-dms-and-no-topic-chats.md\n0027-dreaming-model-driven-promotion.md\n0028-memory-scopes-table.md\n0029-dreaming-internal-session-dispatch.md\n0031-telegram-surface-is-routing-identity.md\n0032-conversation-execution-environment-is-immutable.md\n0033-surface-and-conversation-lifetimes-are-separate.md\n0034-explicit-skill-catalog-authority.md\n0035-bounded-inner-life-authority.md\n0036-delegated-work-ownership.md\n0037-memory-context-is-surface-derived.md\n0038-state-migration-is-offline-and-versioned.md\n0039-prompt-files-are-agent-owned.md\n0040-separate-pi-and-external-agent-execution-hosts.md\n0041-external-agents-are-fully-trusted-same-user-delegates.md\n0042-mcporter-is-the-mcp-gateway.md'
actual_decision_files=$(find decisions -maxdepth 1 -type f -name '*.md' -exec basename {} \; | sort)
if [[ "$actual_decision_files" != "$expected_decisions" ]]; then
  diff -u <(printf '%s\n' "$expected_decisions") <(printf '%s\n' "$actual_decision_files") || true
  fail "root decision-file inventory drifted"
fi

actual_accepted_decisions=$(
  for file in decisions/*.md; do
    if frontmatter_adopted "$file" \
      && [[ $(awk -F ': *' '$1 == "status" { print $2; exit }' "$file") == "accepted" ]]; then
      basename "$file"
    fi
  done | sort
)
if [[ "$actual_accepted_decisions" != "$expected_decisions" ]]; then
  diff -u <(printf '%s\n' "$expected_decisions") <(printf '%s\n' "$actual_accepted_decisions") || true
  fail "adopted accepted-decision inventory drifted"
fi

expected_legacy_decisions=$'0001-defer-subagent-cross-talk.md\n0006-schedule-store-location.md\n0011-external-agent-runner-separation.md\n0012-external-agent-process-security-policy.md\n0013-external-agent-scratch-lifecycle.md\n0017-mcporter-gateway.md\n0019-pty-run-adoption.md\n0030-acp-external-agent-boundary.md'
actual_legacy_decisions=$(find specs/decisions -maxdepth 1 -type f -name '*.md' -exec basename {} \; | sort)
if [[ "$actual_legacy_decisions" != "$expected_legacy_decisions" ]]; then
  diff -u <(printf '%s\n' "$expected_legacy_decisions") <(printf '%s\n' "$actual_legacy_decisions") || true
  fail "quarantined legacy-decision inventory drifted"
fi

expected_skills=$'nospec\nnospec-carve\nnospec-curator\nnospec-lexicon\nnospec-mend\nnospec-rule\nnospec-scout\nnospec-shape\nnospec-trial'
actual_skills=$(find .agents/skills -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort)
if [[ "$actual_skills" != "$expected_skills" ]]; then
  diff -u <(printf '%s\n' "$expected_skills") <(printf '%s\n' "$actual_skills") || true
  fail "active workflow-skill inventory drifted"
fi

pin=df7382341836647f10aba32e9bea877300443fef
grep -Fq "$pin" AGENTS.md || fail "AGENTS.md does not record the audited Nospec pin"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum --check scripts/nospec-skills.sha256
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 --check scripts/nospec-skills.sha256
else
  fail "sha256sum or shasum is required"
fi

runner=.agents/skills/nospec/scripts/nospec
[[ -x "$runner" ]] || fail "vendored Nospec runner is missing or not executable"
"$runner" check

printf 'nospec authority check: 5 documents, 34 accepted decisions, 8 quarantined decisions, 9 pinned skills\n'

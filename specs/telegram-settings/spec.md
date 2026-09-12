---
role: contract
owns: telegram-deployment-settings
---

# Telegram Settings

## Purpose

Status: target contract. The first usable release (Devin model selection,
catalog, persistence, API, page, launch integration) was delivered through
issue #59. The full deployment-config surface — every whitelisted non-secret
section, MCP through McpSelectionStore, and self-restart — is delivered
through issue #66.

## Requirements

### Requirement: Deployment Settings Inside Telegram

WHEN the operator opens Settings, THE SYSTEM SHALL present a Telegram Mini App
for explicitly supported non-secret deployment settings. Surface-owned chat
preferences SHALL retain their existing ownership and command paths. The first
usable release includes exact Devin model selection; an empty page is not that
release.

#### Scenario: Deployment default, not a chat preference

- WHEN the operator saves a Devin model
- THEN the deployment default changes, without changing any chat's main model.

#### Scenario: Every whitelisted section, no secrets

- WHEN the operator opens Settings
- THEN every whitelisted non-secret deployment section is editable, while
  secret fields are surfaced only as presence and are never writable through
  the Mini App.

### Requirement: Live Validated Model Catalog

WHEN Settings discovers Devin models, THE SYSTEM SHALL execute
`devin models list --format json` with the allowlist child environment and
validate the returned families and exact variant identities. Available labels,
aliases, context/output limits, cost descriptions, and new/beta flags SHALL be
preserved; absent optional data SHALL remain absent.

Discovery SHALL be request-owned, independently cancellable, bounded to 15
seconds and 2 MiB per output stream, and terminate on failure or cancellation.
Malformed, duplicate, empty, unavailable, and failed results SHALL fail visibly,
without raw subprocess output in diagnostics or a hardcoded fallback catalog.
These bounds apply to discovery, not to agent execution.

#### Scenario: Discovery is not inference

- WHEN a catalog request succeeds
- THEN the caller receives validated model metadata and no model is selected
  or invoked.

### Requirement: One Durable Settings Authority

WHEN a supported setting changes, THE SYSTEM SHALL validate and durably commit
it through one settings mutation interface, coordinate with existing config
writers, preserve unrelated fields and file permissions, and reject stale
updates. Canonical deployment persistence remains `goblin.json5`; Settings
SHALL NOT maintain a second durable copy. Reads SHALL expose only an explicit
non-secret projection. The UI SHALL identify when a saved setting takes effect.

#### Scenario: Save without stale runtime state

- WHEN an exact model is saved and Settings is reopened or Goblin restarted
- THEN the committed model remains selected; failed saves never publish it.

#### Scenario: Section-scoped writes stay valid

- WHEN a section is saved through Settings
- THEN only that section's whitelisted keys change, unrelated fields and file
  permissions are preserved, the resulting file still parses as a valid
  config, and a stale revision is rejected without partial state.

#### Scenario: Secrets are not a settings surface

- WHEN a read or write touches a secret field
- THEN the read returns presence only and the write is rejected with an
  actionable error before any filesystem effect.

### Requirement: Verified Operator Access

WHEN the Mini App calls the Settings API, THE SYSTEM SHALL verify Telegram
initData integrity, freshness, and authorized operator identity server-side
before accessing settings or spawning catalog discovery. Writes SHALL also
enforce the configured origin. The optional API SHALL bind to loopback in the
Goblin process; operator-managed Tailscale Serve supplies private HTTPS.
Authentication material and full configuration SHALL never be returned or logged.

#### Scenario: Forged identity has no effects

- WHEN identity is invalid, expired, or unauthorized
- THEN the request fails without a subprocess or configuration mutation.

#### Scenario: The operator cannot lock themselves out

- WHEN an `allowedUsers` change would remove the requesting operator
- THEN the change is rejected and nothing is written.

### Requirement: Operator Selection Controls New Runs

WHEN a new Devin run is admitted, THE SYSTEM SHALL capture the operator's saved
exact model selection through the canonical ACP/delegated-work path. The AI
SHALL NOT override it. A default change SHALL NOT mutate an admitted run.
Unavailable selections SHALL fail rather than silently substitute a model.
Integration is gated on the relevant ACP launch work in issue #58; legacy
runner, Session, or scratch seams SHALL NOT be extended.

#### Scenario: New default affects only new work

- WHEN the default changes while a run is active
- THEN the active run retains its model and the next admitted run captures the
  new selection without a Goblin restart.

### Requirement: Operator Restart Without SSH

WHEN the operator confirms a restart from Settings, THE SYSTEM SHALL verify
operator identity, acknowledge before shutdown begins, stop accepting new
requests, drain in-flight requests within a bounded deadline, and exit
cleanly for the service manager to revive the process. A restart SHALL be
refused while the on-disk config fails schema validation. Revival is the
operator-deployed service manager's job (`Restart=on-success`), not the
process's.

#### Scenario: Bad config never boot-loops

- WHEN a restart is requested but the on-disk config is invalid
- THEN the restart is refused with an actionable error and the process keeps
  serving.

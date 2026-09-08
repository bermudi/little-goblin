---
role: contract
owns: telegram-deployment-settings
---

# Telegram Settings

## Purpose

Status: target contract, delivered through issue #59. This is not a claim that
the Mini App is already available.

Implemented so far: request-owned live Devin catalog discovery and validation.
Persistence, API, page, and launch integration remain target requirements.

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

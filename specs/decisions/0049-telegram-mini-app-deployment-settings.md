---
id: 0049
date: 2026-09-08
status: accepted
spine: true
amends: [0041]
---

# 0049: Telegram Mini Apps Manage Deployment Settings

## Status

accepted

## Context

Accepted by the operator during shaping of Telegram Settings.

Editing server configuration over SSH is not an acceptable routine model
selection workflow. A catalog with many families and variants does not fit a
wall of Telegram buttons. Telegram remains the product UI; its Mini Apps are
part of that UI, not a separate dashboard.

## Decision

Goblin SHALL support a Telegram Mini App for explicitly supported non-secret
deployment settings. The first usable slice is searchable Devin model
selection, persistent saving, and application to the next admitted external
run without a restart. Chat-specific preferences remain Surface-owned and
continue through their existing command paths. Credential editing and a raw
configuration editor are out of scope.

The operator, not the main model, SHALL choose the deployment default for
Devin. This narrows decision 0041's model-selected invocation inputs only for
model selection. Each admitted run captures the exact selected model; changing
the default does not mutate admitted work. Missing or unavailable selection
does not authorize an automatic substitute.

One settings mutation interface SHALL own validation, durable persistence,
conflict handling, and application timing. Canonical deployment configuration
remains in `goblin.json5`. Existing section owners, including MCP selection,
must not acquire competing writers. Extending shared write coordination must
migrate existing callers atomically.

The Mini App API SHALL verify Telegram identity and the authorized operator
server-side before reading configuration or discovering models. Network
reachability is not identity. Tailscale Serve is the intended operator-managed
private HTTPS path to an optional loopback listener in the Goblin process.
This decision does not authorize changing tailnet or server configuration.

## Consequences

The config startup snapshot cannot remain the live authority for new external
launches. The UI must distinguish persistence from application timing.
Settings integration must use the accepted ACP and delegated-work seams;
unfinished issue-58 prerequisites are not permission to extend the legacy
runner. Catalog discovery is independently implementable without those seams.

Automated loopback/browser tests do not establish that a real Telegram
webview can reach the private URL; that release check remains explicit.

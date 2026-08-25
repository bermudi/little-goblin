---
id: 0042
date: 2026-07-28
status: accepted
spine: false
---

# 0042: `mcporter` Is the MCP Gateway

## Status

accepted

## Context

Goblin needs MCP tools but does not need to own MCP transport, OAuth, server configuration, or server lifecycle. The deployed `mcporter` gateway already owns those concerns. Implementing direct stdio, HTTP, or SSE clients in Goblin would duplicate protocol and credential authority while leaving the model-facing tool surface essentially unchanged.

The current `McpRunner` invokes `mcporter`, normalizes its output, and exposes a compact catalog plus generic call and describe tools. The exact executable invocation and installation mechanism are operational details, not an architectural reason to duplicate MCP.

## Decision

All Goblin MCP interactions SHALL go through the operator-managed `mcporter` gateway. Goblin SHALL NOT implement a direct MCP client or connect through another MCP gateway unless a later decision supersedes this ruling.

`mcporter` owns MCP transports, OAuth, server configuration, and server lifecycle. Goblin MAY wrap gateway commands, select configured servers, cache and describe the catalog, normalize and bound results, enforce timeouts, and expose Goblin-native model tools over that gateway.

This ruling does not freeze `bunx`, a filesystem installation path, or a particular `mcporter` version. Invocation, installation, version pinning, and preflight are deployment and implementation concerns so long as the gateway boundary remains intact.

## Consequences

Goblin avoids a second MCP configuration and authentication authority and keeps transport churn behind one subprocess boundary. MCP availability depends on the operator's `mcporter` installation and configuration, and each uncached subprocess invocation may add latency.

Direct streaming transports, alternate gateways, and an in-process MCP client require an explicit superseding decision rather than arriving as an incidental feature. Binary/media normalization, catalog refresh UX, and result presentation can evolve without changing this boundary.

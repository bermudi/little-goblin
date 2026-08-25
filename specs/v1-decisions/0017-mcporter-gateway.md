# MCP gateway is `mcporter` only

## Status

proposed

## Context

Goblin needs access to the MCP ecosystem. `mcporter` is already installed and configured; it handles OAuth, daemon keep-alive, stdio transports, config discovery, and server-side validation. The alternative is to implement one or more direct MCP clients (stdio, HTTP, or SSE) inside Goblin, which would duplicate `mcporter`'s surface and create a second source of truth for server configuration and OAuth.

## Decision

`McpRunner` SHALL invoke `mcporter` as a subprocess (`bunx --silent mcporter ...`) for all MCP interactions. Goblin SHALL NOT implement a direct MCP client and SHALL NOT connect to non-`mcporter` MCP gateways. The `McpRunner` may wrap `mcporter` commands, transform output, cache the catalog, and normalize results, but it SHALL NOT reimplement transport, OAuth, or MCP server lifecycle management.

## Consequences

- **Easier:** Goblin avoids OAuth, transport, and config-discovery logic. Server configuration and credentials remain owned by `mcporter`, which the operator manages independently.
- **Harder:** Every call pays the `bunx` startup cost if `mcporter` is not in the global cache, and Goblin depends on `mcporter` being installed and reachable.
- **Must not change:** No future MCP integration may bypass `mcporter` and speak MCP directly unless a new decision explicitly supersedes this one.

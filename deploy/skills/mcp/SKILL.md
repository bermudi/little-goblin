---
name: mcp
description: >
  Reach MCP servers — external tools and services — through goblin's own
  isolated mcporter: its own config, its own keys, never the operator's
  editor setups. Discover servers, read tool schemas, call tools via bash.
license: Apache-2.0
metadata:
  version: "1.0"
  topic: external-tools
compatibility: Requires the pinned mcporter dep plus goblin's agent token (the goblin-mcp-dev pass-keys profile); if the entry point reports a missing piece, its error names the fix
allowed-tools:
  - Bash($GOBLIN_HOME/mcp:*)
---

# mcp — external tools through goblin's own mcporter

One entry point, always through bash — never bare `mcporter` (that's the
host's, with the operator's servers):

```bash
GOBLIN_HOME="${GOBLIN_HOME:-$HOME/goblin}"
"$GOBLIN_HOME/mcp" list                  # goblin's servers, nothing else
"$GOBLIN_HOME/mcp" list <server> --schema  # tool docs before the first call
"$GOBLIN_HOME/mcp" call <server>.<tool> key=value --timeout 120000
```

The shim pins everything: goblin's config (`$GOBLIN_HOME/mcporter.json`),
goblin's keys (the `goblin-mcp-dev` pass-keys profile, resolved into
mcporter's child env only), no editor imports, no keep-alive daemon, and
OAuth/schema caches under `$GOBLIN_HOME/state/mcporter` instead of the
host's. A widened or missing config fails loud before anything runs.

## Two timeouts

Every non-trivial call has two, and the outer one must win:

- `mcp call --timeout <ms>` — how long mcporter waits for the server.
- The `bash` tool's own timeout (seconds) — the shell around it.

**Bash seconds must be strictly greater than mcporter ms ÷ 1000.**
mcporter's own timeout returns a readable error; the outer kill is
SIGKILL — no result, no error, just silence. The default 60 s is too
short for most remote/AI tools: local/fast ~15 s, single call ~120 s,
video or deep research ~300 s.

## Surfaces shift

Some servers change their tool list with session state. `tool not found`
means the surface moved — re-run `mcp list <server> --schema` and retry
with the current names, don't assume an earlier listing still holds.

## Never the daemon

No `daemon`, no `serve` — keep-alive is off by design, and per-call
spawn is the accepted cost. If a server genuinely needs a persistent
connection, that's a design conversation with the operator, not a flag.

## The server set is config

`$GOBLIN_HOME/mcporter.json` is yours to edit when the operator asks for
a server: standard `mcpServers` shape, `${VAR}` placeholders for secrets
only — never an inline key (values ride the `goblin-mcp-dev` profile, and a
key in this file is a key in the model context). New keys need the
operator (`pass-keys add goblin-mcp-dev NAME …` grants under goblin's token —
an owner action): ask, don't work around. A call naming an unset variable
fails loud with its name; that's the prompt to ask.

Never touch `"imports"` — it stays `[]`. Without it mcporter merges the
operator's editor servers, and the call-time gate refuses anything else.

## If the entry point complains

Each prerequisite names its own fix: a missing pinned mcporter means the
deploy needs `bun install`; missing pass-keys/bun is a box problem for
the operator; a missing config means goblin hasn't booted since the
feature landed. Report the line, don't route around it.

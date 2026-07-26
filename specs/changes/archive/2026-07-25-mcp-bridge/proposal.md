## Motivation

Goblin has no first-class way to reach the MCP ecosystem. Today the only path is bash: the user runs `bunx mcporter ...` in a terminal, copies the JSON result, and pastes it into Telegram. That works for one-shot lookups but breaks down when an answer depends on chaining several MCP calls, when the agent should pick the right server from context, or when a scheduled/subagent turn needs the same access.

`mcporter` is already installed and configured with nine servers (tavily, grep, deepwiki, context7, poe-research, zai-vision, gemini-media, next-devtools, colab-mcp). It handles OAuth, daemon keep-alive, stdio transports, and config discovery. Goblin should not reinvent any of that. It should call `mcporter` as a subprocess and expose the result to the agent.

The design constraint that shapes this proposal is **prompt economy**. Registering one `ToolDefinition` per MCP tool (32+ tools with full `inputSchema`) would bloat the system prompt and defeat the main reason `mcporter` exists as a CLI: lazy, on-demand access. The proposal therefore registers **two** tools total — `mcp_call` and `mcp_describe` — and carries a compact server/tool catalog in the `mcp_call` description. The model never sees a schema unless it asks.

## Scope

### Affected capabilities

- **`mcp`** (new) — owns `McpRunner` (subprocess wrapper around `bunx mcporter`), tool catalog discovery, the `mcp_call` and `mcp_describe` tool definitions, and result normalization.
- **`config`** (modified) — adds an optional `mcp` block to `goblin.json5` (`enabled`, `configPath`, `defaultTimeoutMs`, `maxResultChars`).
- **`agent`** (modified) — `AgentRunnerOptions` accepts an optional `mcpRunner`; `buildCustomTools()` appends the two MCP tools when the runner is present and `cfg.mcp` is defined.
- **`orchestration`** (modified) — `TurnDispatcherOptions` and `createRunner()` thread `mcpRunner` through to `AgentRunner`. `TelegramIntakeOptions` threads it through to the dispatcher. `src/bot.ts` constructs the runner from config and wires it.

### Behavior changes

- The agent gets two new tools (`mcp_call`, `mcp_describe`) whenever the MCP config block is present in `goblin.json5` and an `McpRunner` is constructed. The tools are registered even when the `enabled` list is empty or `mcporter` is unreachable, so the agent can surface the failure in-turn; the catalog content (and therefore the `mcp_call` description) will simply be empty. When the `mcp` block is absent, no MCP tools are added.
- `mcp_call` invokes `bunx --silent mcporter --log-level error --config <path> call <server>.<tool> --args <json> --output json --timeout <ms>` via `Bun.spawn` with an `AbortSignal`. The outer spawn timeout is `defaultTimeoutMs + 5000`; the inner `mcporter --timeout` is `defaultTimeoutMs`. Non-zero exit, timeout, or abort produces a short error string the model can react to.
- `mcp_describe` invokes `bunx --silent mcporter --log-level error --config <path> list <server> --schema --json --timeout <ms>` and returns the `inputSchema` for the requested tool as text. This is the lazy schema fetch the model uses when it is unsure of a tool's parameters.
- The `mcp_call` description embeds a compact catalog built once at `McpRunner` construction from `mcporter list --json` (no `--schema`). The catalog lists each enabled server and its tool names + one-line descriptions. It is ~15 lines for the current nine servers, not ~32 full JSON Schemas.
- MCP tool results are normalized to a single text string capped at `maxResultChars` (default 16000). Image content entries from vision servers are represented as `[image: <mimeType>]` placeholders in the text result; binary passthrough is a non-goal for this change.
- The `McpRunner` caches the catalog in memory for the lifetime of the process. Per-server tool schemas are fetched lazily by `mcp_describe` and are not cached. Catalog refresh is a manual concern: the runner exposes a `refreshCatalog()` method used by a future `/mcp refresh` command, not by this change.

### New functionality

- `src/mcp/runner.ts` — `McpRunner` class.
- `src/mcp/tool.ts` — `createMcpTools(runner): ToolDefinition[]` returning `[mcp_call, mcp_describe]`.
- `src/mcp/mod.ts` — barrel.
- `src/mcp/paths.ts` — path helper for the resolved mcporter config (expands `~`, resolves relatives against `goblinHome`).

## Non-Goals

- **No per-MCP-tool `ToolDefinition`s.** The whole point is to keep the prompt lean. One `mcp_call` tool, one `mcp_describe` tool, period.
- **No MCP server lifecycle management.** Goblin does not start, stop, or restart `mcporter daemon`. The operator owns the daemon. If a stdio server is offline, `mcp_call` returns an error string and the model decides what to do.
- **No binary/image passthrough.** Vision servers (`zai-vision`, `gemini-media`) may return image content. This change renders those as text placeholders. A future change can map image entries to `ImageContent` when the active model supports images.
- **No streaming.** `mcp_call` waits for the full result and returns it. Long-running tools (e.g. `tavily_research`) block the turn until they complete or time out. Streaming results to the Telegram buffer is a future concern.
- **No new `/mcp` command.** A future change may add `/mcp refresh`, `/mcp list`, etc. This change only wires the tools.
- **No dynamic tool surface for `colab-mcp`-style servers that change names after `open_colab_browser_connection`.** The catalog is built once at startup. If a server changes its tools mid-process, `mcp_call` against a vanished tool returns the mcporter error and the model can ask `mcp_describe` to see the current surface.
- **No gateway to non-mcporter MCP servers.** Goblin talks to `mcporter` only. Direct MCP client implementation (stdio/HTTP/SSE) is out of scope.
- **No persistence of MCP results to memory.** The agent may use `memory_write` to save interesting findings, but the runner does not auto-persist.

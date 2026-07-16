## Architecture

The MCP bridge is a thin subprocess wrapper around `bunx mcporter`, modeled on the `external-agents` capability but simpler. Where `ExternalAgentRunner` owns long-lived streaming runs with adapters per backend, `McpRunner` owns short-lived one-shot calls and lazy schema fetches. There is no adapter seam because `mcporter` already normalizes every server's transport.

```
                ┌──────────────────────────────────────────────────┐
                │ src/bot.ts (composition root)                    │
                │                                                  │
                │  cfg.mcp? ──→ new McpRunner(cfg.mcp, goblinHome) │
                │                  │                               │
                │  createTelegramIntake({ ..., mcpRunner })        │
                └──────────────────┬───────────────────────────────┘
                                   │
                ┌──────────────────▼───────────────────────────────┐
                │ src/tg/intake.ts                                 │
                │  TurnDispatcherOptions.mcpRunner                 │
                └──────────────────┬───────────────────────────────┘
                                   │
                ┌──────────────────▼───────────────────────────────┐
                │ src/orchestration/dispatcher.ts                  │
                │  createRunner() → AgentRunnerOptions.mcpRunner   │
                └──────────────────┬───────────────────────────────┘
                                   │
                ┌──────────────────▼───────────────────────────────┐
                │ src/agent/mod.ts                                 │
                │  buildCustomTools() → createMcpTools(mcpRunner)  │
                └──────────────────┬───────────────────────────────┘
                                   │
                ┌──────────────────▼───────────────────────────────┐
                │ src/mcp/tool.ts                                  │
                │  mcp_call, mcp_describe                          │
                └──────────────────┬───────────────────────────────┘
                                   │
                ┌──────────────────▼───────────────────────────────┐
                │ src/mcp/runner.ts                                │
                │  McpRunner.callTool / describeTool               │
                │  Bun.spawn(["bunx", "--silent", "mcporter", …])  │
                └──────────────────────────────────────────────────┘
```

The data flow for a single `mcp_call` invocation:

1. The agent emits a tool call for `mcp_call` with `{ server, tool, args }`.
2. `createMcpTools`'s `execute` narrows `params` to a record, extracts the three fields, and calls `runner.callTool(server, tool, args, signal)`.
3. `McpRunner.callTool` coerces `args` to a plain object, JSON-stringifies it, and spawns `bunx --silent mcporter --log-level error [--config <path>] call <server>.<tool> --args <json> --output json --timeout <innerMs>`.
4. The runner builds a composite `AbortSignal`: an outer `AbortSignal.timeout(defaultTimeoutMs + 5000)` guard is merged with the optional caller `AbortSignal` so whichever fires first kills the child. `Bun.spawn` receives this composite signal.
5. `await proc.exited` resolves when the child exits. The runner inspects the composite signal's `reason` to map a timeout (`TimeoutError`) to `kind: "timed_out"`, a caller abort (non-`TimeoutError`) to `kind: "aborted"`, a non-zero exit to `kind: "error"` with trimmed stderr, and a clean exit to `kind: "ok"` after parsing and normalizing stdout to a single text string capped at `maxResultChars`.
6. The tool's `execute` returns `{ content: [{ type: "text", text: result.text }], details: result.text }`.

The data flow for `mcp_describe` is the same but invokes `mcporter list <server> --schema --json --timeout <innerMs>`, finds the named tool's `inputSchema`, pretty-prints it, and caps it at `maxResultChars` (appending `… [truncated]` when needed).

State management is minimal: `McpRunner` starts an asynchronous `discoverCatalog()` in its constructor and stores the resulting promise. Public methods (`callTool` and `describeTool`) `await` this promise, so the catalog is available before any tool interaction while construction itself remains synchronous and non-throwing. The runner caches the resolved catalog, the resolved config path, and the resolved timeout/caps. No state is persisted to disk; the catalog is in-memory only.

### Timeout and cancellation handling

`McpRunner` uses a composite `AbortSignal` to enforce the outer timeout and respect caller cancellation. For each invocation, the runner creates a local `AbortController` and wires the caller's optional `AbortSignal` and an `AbortSignal.timeout(defaultTimeoutMs + 5000)` outer guard to abort the controller. The controller's signal is passed to `Bun.spawn`. A timeout and a caller abort both kill the child, but the `reason` preserved on the controller's signal (`TimeoutError` vs anything else) lets `callTool`/`describeTool` resolve with `timed_out` or `aborted` respectively. The runner never throws for these outcomes.

## Decisions

### Decision: Two tools, not one per MCP tool

**Chosen:** Register `mcp_call` and `mcp_describe` only — two `ToolDefinition`s total.

**Why over alternatives:** Registering one `ToolDefinition` per MCP tool (32+ for the current nine servers) would inject ~32 full JSON Schemas into the system prompt. That defeats the main reason `mcporter` exists as a CLI: lazy, on-demand access. The two-tool approach keeps the prompt overhead to ~15 lines of catalog text embedded in the `mcp_call` description, plus one more tool definition for `mcp_describe`.

**Constraints introduced:** The model can mis-guess args on the first try. It either calls `mcp_describe` to fetch the schema, or relies on the server-side validation error from `mcporter` and retries. This is the same feedback loop `mcporter`'s own `--brief` mode assumes. We accept the round-trip cost in exchange for the prompt economy.

### Decision: `bunx mcporter` as subprocess, not direct MCP client

**Chosen:** Spawn `bunx --silent mcporter ...` for every call. Do not implement a direct MCP client (stdio/HTTP/SSE) in Goblin. This architectural boundary is recorded as decision `0017-mcporter-gateway`.

**Why over alternatives:** `mcporter` already handles OAuth, daemon keep-alive, stdio transports, config discovery, and server-side validation. Reimplementing any of that in Goblin would duplicate `mcporter`'s surface and create a second source of truth for server configuration. The subprocess overhead is ~100ms per call, dwarfed by MCP tool latency (typically 1–30s).

**Constraints introduced:** Every call pays the `bunx` cold-start cost if `mcporter` is not in the global cache. The `--silent` flag suppresses bunx's install output. If `bunx` is unavailable, `McpRunner` construction logs a warning and all calls return `kind: "error"`. The bot still starts.

### Decision: `Bun.spawn` for subprocess invocation

**Chosen:** Use `Bun.spawn({ cmd, env, signal, stdout: "pipe", stderr: "pipe" })` with a composite `AbortSignal` and `await proc.exited`, then read stdout/stderr via `new Response(proc.stdout).text()`.

**Why over alternatives:** `src/external-agents/preflight.ts` already uses `Bun.spawn` for one-shot subprocess calls. The `ProcessHost` abstraction in `src/external-agents/process.ts` is designed for streaming line-reads, which MCP calls do not need. Using `Bun.spawn` directly matches the existing preflight pattern and keeps the runner simple.

**Constraints introduced:** The runner depends on Bun's spawn API. This is acceptable because Goblin already requires Bun (`bun install`, `bun run`, `bun test`). The composite `AbortSignal` requires `AbortSignal.timeout` and `AbortController`, both available in Bun.

### Decision: Two-tier timeout (inner `mcporter --timeout`, outer `AbortSignal` timeout)

**Chosen:** Pass `--timeout <defaultTimeoutMs>` to `mcporter` and enforce the outer timeout with an `AbortSignal` that aborts after `defaultTimeoutMs + 5000`, merged with any caller-supplied `AbortSignal` and passed to `Bun.spawn`.

**Why over alternatives:** A single timeout at either layer leaves a gap. If only the inner `mcporter --timeout` fires but `mcporter` hangs during cleanup, the outer spawn reaps the child. If only the outer spawn timeout fires, `mcporter` has no chance to clean up gracefully. The two-tier approach guarantees the child is reaped while giving `mcporter` a head start on graceful cleanup.

**Constraints introduced:** The outer timeout must always be greater than the inner. The 5000ms gap is fixed; it is not configurable. If `mcporter`'s cleanup takes longer than 5s, the spawn kills it. This is acceptable for a CLI that should exit promptly on timeout.

### Decision: Image content as text placeholders, not `ImageContent`

**Chosen:** Render MCP `content` entries with `type: "image"` as `[image: <mimeType>]` in the result text. Do not map them to pi's `ImageContent` type.

**Why over alternatives:** Mapping image entries to `ImageContent` requires checking the active model's `input` capabilities, deciding whether to inject the image into the tool result or the next user message, and handling base64 decoding. That is a meaningful feature on its own and is not needed for the first cut. The placeholder lets the agent know an image was returned and describe it via `mcp_describe` or a follow-up call if needed.

**Constraints introduced:** Vision servers (`zai-vision`, `gemini-media`) return image results that the agent cannot directly see. The agent can still use their text-returning tools (`ocr`, `analyze_image` returns text descriptions). A future change can add image passthrough.

### Decision: Catalog built once at construction, cached for process lifetime

**Chosen:** `McpRunner` starts `mcporter list --json` once in its constructor and caches the resulting promise (and eventually the resolved catalog). `refreshCatalog()` exists for manual re-discovery but is not called automatically.

**Why over alternatives:** Per-call discovery would add ~1s latency to every `mcp_call` invocation. Per-turn discovery would add it to every prompt. The catalog changes rarely (only when the operator edits `mcporter.json` or starts/stops the daemon), so a process-lifetime cache is the right granularity. `refreshCatalog()` is the escape hatch for a future `/mcp refresh` command.

**Constraints introduced:** If the operator adds a new server to `mcporter.json` while Goblin is running, the agent will not see it until `refreshCatalog()` is called or Goblin restarts. This is the same constraint `mcporter`'s own daemon mode has.

### Decision: `McpRunner` construction does not throw

**Chosen:** If the catalog discovery started at construction fails (non-zero exit, timeout, or JSON parse error), log a warning, store an empty catalog, and continue. The tools are still registered; calls return clear error strings.

**Why over alternatives:** Throwing would prevent the bot from starting if `mcporter` is temporarily unavailable (e.g. daemon not started, network issue). The bot should start and let the agent discover the failure at call time. This mirrors the `external-agents` preflight pattern: missing `groqApiKey` does not block startup; the failure surfaces at use time.

**Constraints introduced:** The agent may call `mcp_call` and get an error string instead of a result. The agent can relay this to the user. This is acceptable for a personal bot.

### Decision: `mcp_call` description embeds the catalog text

**Chosen:** The `mcp_call` tool's `description` field includes `runner.buildCatalogText()` output, so the model sees the available servers and tool names without a separate call.

**Why over alternatives:** Requiring a `mcp_list` tool call before every `mcp_call` would add a round-trip to every turn that uses MCP. Embedding the catalog in the description is ~15 lines for nine servers and gives the model enough context to pick a server and tool name. The model calls `mcp_describe` only when it needs the actual schema.

**Constraints introduced:** The `mcp_call` description is built once at `createMcpTools(runner)` time. If the catalog changes mid-process, the description does not update until the runner is reconstructed. This is consistent with the catalog caching decision.

## File Changes

### New files

- **`src/mcp/paths.ts`** — `resolveMcporterConfigPath(configPath: string | undefined, goblinHome: string): string | undefined`. Expands `~` to `os.homedir()`, resolves relatives against `goblinHome`, returns `undefined` when `configPath` is `undefined`. Satisfies "McpRunner wraps the mcporter CLI as a subprocess".

- **`src/mcp/runner.ts`** — `McpRunner` class and `McpToolResult` type. The constructor starts `discoverCatalog()` asynchronously and stores the promise; `callTool` and `describeTool` await it before using the catalog. Holds the resolved config path, timeout, and max-result-chars. Methods: `callTool`, `describeTool`, `refreshCatalog`, `buildCatalogText`. Uses `Bun.spawn` with a composite `AbortSignal` for subprocess invocation. Satisfies "McpRunner wraps the mcporter CLI as a subprocess", "McpRunner builds a compact tool catalog at construction", "McpRunner exposes callTool for tool invocation", "McpRunner normalizes MCP content to a capped text string", "McpRunner exposes describeTool for lazy schema fetch", "McpRunner exposes refreshCatalog for manual re-discovery", "McpRunner exposes buildCatalogText for tool descriptions", "McpRunner construction does not throw on mcporter failure".

- **`src/mcp/tool.ts`** — `createMcpTools(runner: McpRunner): ToolDefinition[]`. Returns `[mcp_call, mcp_describe]`. Uses `Type` from `@sinclair/typebox` and `defineTool` from `@earendil-works/pi-coding-agent`, matching the pattern in `src/external-agents/tool.ts`. Satisfies "mcp_call tool definition", "mcp_describe tool definition", "createMcpTools returns both tools in a stable order".

- **`src/mcp/mod.ts`** — barrel re-exporting `McpRunner`, `McpToolResult`, `createMcpTools`. Satisfies "MCP module structure follows goblin conventions".

- **`src/mcp/runner.test.ts`** — colocated tests for `McpRunner`. Tests cover: catalog building from `mcporter list --json` output, `enabled` filtering, unknown-server warning, `callTool` success/error/abort/timeout, content normalization (text + image placeholder + truncation), `describeTool` success/unknown-server/unknown-tool, `refreshCatalog`, `buildCatalogText` format, construction-does-not-throw on mcporter failure.

- **`src/mcp/tool.test.ts`** — colocated tests for `createMcpTools`. Tests cover: both tools present in stable order, `mcp_call` description contains catalog text, `mcp_call` execute returns text content on ok/error/aborted/timed_out, `mcp_describe` execute returns schema text, parameter narrowing rejects non-object args.

- **`src/mcp/paths.test.ts`** — colocated tests for `resolveMcporterConfigPath`. Tests cover: `undefined` returns `undefined`, `~` expansion, relative path resolution against `goblinHome`, absolute path passthrough.

### Modified files

- **`src/schema.ts`** — Add `McpConfigSchema` (Zod object with `enabled`, `configPath`, `defaultTimeoutMs`, `maxResultChars` per the config spec). Add `mcp: McpConfigSchema.optional()` to `ConfigFileSchema`. Export `McpConfig` type. Satisfies "MCP configuration block".

- **`src/config.ts`** — Add `mcp?: McpConfig` to the `Config` interface. In `loadConfig()`, set `config.mcp = cfg.mcp` and `Object.freeze(config.mcp)` when present (matching the `externalAgents` freeze pattern). Satisfies "MCP configuration block".

- **`src/agent/mod.ts`** — Import `McpRunner` and `createMcpTools` from `../mcp/mod.ts`. Add `mcpRunner?: McpRunner` to `AgentRunnerOptions` (after `externalAgentRunner`). Add `private mcpRunner: McpRunner | null` field. In `buildCustomTools()`, after the `externalAgentRunner` block, add: `if (this.mcpRunner && this.cfg.mcp) { tools.push(...createMcpTools(this.mcpRunner)); }`. Satisfies "AgentRunner conditionally registers MCP tools".

- **`src/orchestration/dispatcher.ts`** — Import `McpRunner` type. Add `mcpRunner?: McpRunner` to `TurnDispatcherOptions` (after `externalAgentRunner`). Add `private readonly mcpRunner: McpRunner | undefined` field. In `createRunner()`, add `mcpRunner: this.mcpRunner` to the `AgentRunnerOptions` object passed to `new AgentRunner()`. Satisfies "MCP runner is threaded through to AgentRunner".

- **`src/tg/intake.ts`** — Import `McpRunner` type. Add `mcpRunner?: McpRunner` to `TelegramIntakeOptions` (after `externalAgentRunner`). Pass `mcpRunner: options.mcpRunner` to the `TurnDispatcher` constructor. Satisfies "MCP runner is threaded through to AgentRunner".

- **`src/bot.ts`** — Import `McpRunner` from `./mcp/mod.ts`. After the `externalAgentRunner` construction, add: `const mcpRunner = cfg.mcp ? new McpRunner(cfg.mcp, cfg.goblinHome) : undefined;`. Pass `mcpRunner` to `createTelegramIntake({ ..., mcpRunner })` after `externalAgentRunner`. Add `mcpRunner` to the `buildBot` return type and return statement. The runner is returned primarily so tests can inspect it; `src/index.ts` does not consume it. Satisfies "MCP runner is threaded through to AgentRunner".

### Unchanged files

- `src/index.ts` — No changes needed. `buildBot` constructs the runner and threads it through; `index.ts` does not need to know about MCP.

- `src/external-agents/` — No changes. The MCP bridge is a separate capability.

- `src/scheduler/` — No changes. Scheduled turns use the same `AgentRunner` and inherit MCP tools automatically.

- `src/subagents/` — No changes. Subagents get their own `AgentRunner` and inherit MCP tools automatically if wired. (Note: subagent runner construction is separate from the main runner; whether subagents get MCP tools depends on how `SubagentRunner` constructs its `AgentRunner`. This is out of scope for this change — subagent MCP access can be a follow-up.)

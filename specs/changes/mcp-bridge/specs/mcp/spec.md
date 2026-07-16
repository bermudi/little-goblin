# mcp

## ADDED Requirements

### Requirement: McpRunner wraps the mcporter CLI as a subprocess

The system SHALL provide an `McpRunner` class that invokes the `mcporter` CLI via `bunx --silent mcporter` for catalog discovery and tool calls. The runner SHALL NOT implement its own MCP client (stdio, HTTP, or SSE); all transport, OAuth, and daemon concerns SHALL remain owned by `mcporter`. The runner SHALL be constructed from the resolved `mcp` config block and the Goblin `goblinHome`.

The runner SHALL resolve the `mcporter` config path by expanding a leading `~` to `os.homedir()` and resolving relative paths against `goblinHome`. When `configPath` is omitted, the runner SHALL pass no `--config` flag and let `mcporter` use its own default discovery.

#### Scenario: Constructed from config

- **WHEN** `McpRunner` is constructed with `configPath: "~/.mcporter/mcporter.json"` and `goblinHome: "/home/user/.goblin"`
- **THEN** the resolved config path SHALL be `/home/<user>/.mcporter/mcporter.json`
- **AND** subprocess invocations SHALL include `--config /home/<user>/.mcporter/mcporter.json`

#### Scenario: Default config path omitted

- **WHEN** `McpRunner` is constructed without a `configPath`
- **THEN** subprocess invocations SHALL NOT include a `--config` flag
- **AND** `mcporter` SHALL use its own default config discovery

### Requirement: McpRunner builds a compact tool catalog at construction

The `McpRunner` SHALL build an in-memory catalog of enabled servers and their tools by starting an asynchronous `mcporter list --json` invocation at construction (`bunx --silent mcporter --log-level error [--config <path>] list --json`) and storing the resulting promise. The expected JSON output is a record mapping server names to arrays of `{ name: string; description: string }` tool entries. The catalog SHALL contain, per enabled server, the server name and a list of `{ name, description }` entries for each tool. The catalog SHALL NOT include `inputSchema` — the basic `list --json` output is sufficient.

When `enabled` is omitted from config, the catalog SHALL include every server `mcporter list` reports. When `enabled` is a non-empty array, the catalog SHALL include only the named servers; servers in `enabled` that `mcporter list` does not report SHALL be skipped with a `log.warn` and SHALL NOT appear in the catalog.

The catalog SHALL be cached for the lifetime of the `McpRunner` instance. Re-discovery SHALL require a new `McpRunner` or an explicit call to `refreshCatalog()`.

#### Scenario: All servers catalogued when enabled omitted

- **WHEN** `McpRunner` is constructed without an `enabled` list
- **AND** `mcporter list --json` reports servers `tavily`, `grep`, `deepwiki`
- **THEN** the catalog SHALL contain all three servers
- **AND** each entry SHALL include tool names and one-line descriptions only

#### Scenario: Enabled list filters the catalog

- **WHEN** `McpRunner` is constructed with `enabled: ["tavily", "deepwiki"]`
- **AND** `mcporter list --json` reports `tavily`, `grep`, `deepwiki`
- **THEN** the catalog SHALL contain `tavily` and `deepwiki` only
- **AND** `grep` SHALL NOT appear in the catalog

#### Scenario: Unknown enabled server is skipped with a warning

- **WHEN** `enabled` contains `"ghost-server"` that `mcporter list` does not report
- **THEN** the runner SHALL log a warning naming the missing server
- **AND** the catalog SHALL omit `ghost-server`
- **AND** construction SHALL NOT throw

#### Scenario: Catalog excludes inputSchema

- **WHEN** the catalog is built from `mcporter list --json`
- **THEN** no entry SHALL include an `inputSchema` field
- **AND** the runner SHALL NOT have invoked `list --schema` at construction time

#### Scenario: Catalog parses the server-record JSON shape

- **WHEN** `mcporter list --json` outputs `{"tavily": [{"name": "tavily_search", "description": "Search the web."}]}`
- **THEN** the catalog SHALL contain server `tavily` with tool `tavily_search`
- **AND** the tool entry SHALL have description `Search the web.`
- **AND** the catalog SHALL NOT include an `inputSchema` field from the source output

### Requirement: McpRunner exposes callTool for tool invocation

The `McpRunner` SHALL expose `callTool(server: string, tool: string, args: unknown, signal?: AbortSignal): Promise<McpToolResult>` that invokes `bunx --silent mcporter --log-level error [--config <path>] call <server>.<tool> --args <json> --output json --timeout <innerMs>` via `Bun.spawn`.

The `args` value SHALL be JSON-stringified and passed via the `--args` flag. When `args` is not a plain object (including `null`, `undefined`, a primitive, or an array), the runner SHALL coerce it to `{}` before stringification.

The runner SHALL enforce an outer timeout of `defaultTimeoutMs + 5000` by constructing an `AbortSignal` that aborts after that duration (e.g. `AbortSignal.timeout(defaultTimeoutMs + 5000)`). The runner SHALL accept an optional `AbortSignal` from the caller. The runner SHALL merge the caller signal and the outer timeout signal into a composite `AbortSignal` so that whichever fires first kills the child via `Bun.spawn({ signal })`. The inner `--timeout` flag passed to `mcporter` SHALL be `defaultTimeoutMs`, so `mcporter` attempts graceful cleanup before the outer signal reaps the child.

After `await proc.exited`, the runner SHALL inspect the composite signal's `reason` to determine the outcome: a `TimeoutError` (`reason.name === "TimeoutError"`) SHALL resolve with `kind: "timed_out"`; any other abort reason SHALL be treated as a caller abort and resolve with `kind: "aborted"`; a non-zero exit code SHALL resolve with `kind: "error"` carrying the trimmed stderr; a successful exit SHALL parse stdout as JSON and normalize it to the `McpToolResult` shape.

The runner SHALL NOT throw for tool failures, timeouts, or aborts; it SHALL resolve with the appropriate result variant so the agent can react in-turn.

#### Scenario: Successful call returns normalized result

- **WHEN** `callTool("tavily", "tavily_search", { query: "hello" })` is invoked
- **AND** `mcporter call` exits 0 with JSON output containing a `content` array
- **THEN** the resolved `McpToolResult` SHALL have `kind: "ok"`
- **AND** the `text` field SHALL contain the concatenated text content, capped at `maxResultChars`

#### Scenario: Non-object args coerced to empty object

- **WHEN** `callTool("deepwiki", "read_wiki_structure", undefined)` is invoked
- **THEN** the `--args` flag SHALL receive the JSON string `{}`
- **AND** the call SHALL proceed normally

#### Scenario: Array or primitive args coerced to empty object

- **WHEN** `callTool("deepwiki", "read_wiki_structure", ["not", "an", "object"])` is invoked
- **OR** `callTool("deepwiki", "read_wiki_structure", "string")` is invoked
- **THEN** the `--args` flag SHALL receive the JSON string `{}`
- **AND** the call SHALL proceed normally

#### Scenario: null args coerced to empty object

- **WHEN** `callTool("deepwiki", "read_wiki_structure", null)` is invoked
- **THEN** the `--args` flag SHALL receive the JSON string `{}`
- **AND** the call SHALL proceed normally

#### Scenario: Non-zero exit resolves with error result

- **WHEN** `mcporter call` exits non-zero with stderr `"Unknown tool: foo"`
- **THEN** the resolved `McpToolResult` SHALL have `kind: "error"`
- **AND** the `text` field SHALL contain the trimmed stderr
- **AND** the runner SHALL NOT throw

#### Scenario: Abort signal kills the child

- **WHEN** `callTool(...)` is invoked with an `AbortSignal` that aborts mid-call
- **THEN** the runner SHALL kill the child process
- **AND** the resolved `McpToolResult` SHALL have `kind: "aborted"`

#### Scenario: Outer timeout fires before mcporter timeout

- **GIVEN** `defaultTimeoutMs: 1000`
- **WHEN** `mcporter` hangs past `1500ms` (outer `AbortSignal` timeout)
- **THEN** the runner SHALL kill the child
- **AND** the resolved `McpToolResult` SHALL have `kind: "timed_out"`

#### Scenario: Inner mcporter timeout is less than outer timeout

- **GIVEN** `defaultTimeoutMs: 1000`
- **WHEN** the runner constructs the spawn invocation
- **THEN** the `--timeout` flag passed to `mcporter` SHALL be `1000`
- **AND** the outer `AbortSignal` timeout SHALL fire at `1500`

### Requirement: McpRunner normalizes MCP content to a capped text string

The `McpToolResult` SHALL have shape `{ kind: "ok" | "error" | "aborted" | "timed_out"; text: string }`. The `text` field SHALL be a single string suitable for returning to the agent as a tool result.

For `kind: "ok"`, the runner SHALL parse the `mcporter call --output json` stdout. The JSON output may be:
- An MCP `CallToolResult` with a `content` array of `{ type: "text", text }` and `{ type: "image", data, mimeType }` entries.
- A bare string (rare; treated as the entire text).
- Any other JSON shape (stringified with `JSON.stringify` and capped).

Text entries SHALL be concatenated with `\n`. Image entries SHALL be rendered as the placeholder `[image: <mimeType>]`. The concatenated text SHALL be truncated to `maxResultChars` (default 16000) with a trailing `… [truncated]` marker when truncation occurs. The kept prefix length SHALL be `maxResultChars - 13`, because the marker ` … [truncated]` is exactly 13 characters long.

For `kind: "error"`, `text` SHALL be the trimmed stderr (or stdout if stderr is empty), capped at `maxResultChars`.

For `kind: "aborted"`, `text` SHALL be `"MCP call aborted."`.

For `kind: "timed_out"`, `text` SHALL be `"MCP call timed out after ${defaultTimeoutMs}ms."`, where `defaultTimeoutMs` is the configured per-call timeout.

#### Scenario: Text content concatenated

- **WHEN** `mcporter call` returns `content: [{ type: "text", text: "a" }, { type: "text", text: "b" }]`
- **THEN** the `text` field SHALL be `"a\nb"`

#### Scenario: Image content rendered as placeholder

- **WHEN** `mcporter call` returns `content: [{ type: "image", data: "...", mimeType: "image/png" }]`
- **THEN** the `text` field SHALL contain `[image: image/png]`
- **AND** no binary data SHALL appear in the result

#### Scenario: Long result truncated

- **WHEN** the concatenated text exceeds `maxResultChars`
- **THEN** the `text` field SHALL be exactly `maxResultChars` characters long
- **AND** it SHALL end with `… [truncated]`

#### Scenario: Aborted result text

- **WHEN** the call was aborted
- **THEN** `text` SHALL be `"MCP call aborted."`

### Requirement: McpRunner exposes describeTool for lazy schema fetch

The `McpRunner` SHALL expose `describeTool(server: string, tool: string, signal?: AbortSignal): Promise<string>` that invokes `bunx --silent mcporter --log-level error [--config <path>] list <server> --schema --json --timeout <innerMs>` and returns the `inputSchema` of the named tool as a pretty-printed JSON string.

When the server is not in the catalog, the method SHALL resolve with `"<server> not in catalog"`. When the tool is not found in the server's schema output, the method SHALL resolve with `"<tool> not found on <server>"`. Errors from `mcporter list` SHALL resolve with a short error string; the method SHALL NOT throw.

The runner SHALL apply the same composite `AbortSignal` outer timeout and caller-abort handling used by `callTool`. If the outer timeout fires first, the method SHALL resolve with `"MCP describe timed out after ${defaultTimeoutMs}ms."`. If the caller aborts first, the method SHALL resolve with `"MCP describe aborted."`.

The result SHALL be capped at `maxResultChars`. When truncation is required, the trailing characters SHALL be replaced with `… [truncated]` so the final string length is exactly `maxResultChars`. The kept prefix length SHALL be `maxResultChars - 13`, because the marker ` … [truncated]` is exactly 13 characters long.

#### Scenario: Schema returned for a known tool

- **WHEN** `describeTool("tavily", "tavily_search")` is invoked
- **THEN** the resolved string SHALL be a pretty-printed JSON object
- **AND** the object SHALL match the `inputSchema` mcporter reports for `tavily_search`

#### Scenario: Unknown server

- **WHEN** `describeTool("ghost", "foo")` is invoked and `"ghost"` is not in the catalog
- **THEN** the resolved string SHALL be `"ghost not in catalog"`

#### Scenario: Unknown tool on known server

- **WHEN** `describeTool("tavily", "ghost_tool")` is invoked
- **AND** `tavily` is in the catalog but `ghost_tool` is not in its schema output
- **THEN** the resolved string SHALL be `"ghost_tool not found on tavily"`

#### Scenario: Long schema description is truncated

- **WHEN** `describeTool("tavily", "tavily_search")` returns a JSON string longer than `maxResultChars`
- **THEN** the resolved string SHALL be exactly `maxResultChars` characters long
- **AND** it SHALL end with `… [truncated]`

#### Scenario: describeTool times out

- **GIVEN** `defaultTimeoutMs: 1000`
- **WHEN** `describeTool("tavily", "tavily_search")` is invoked and the outer `AbortSignal` timeout fires before `mcporter` returns
- **THEN** the resolved string SHALL be `"MCP describe timed out after 1000ms."`

#### Scenario: describeTool aborts

- **WHEN** `describeTool("tavily", "tavily_search")` is invoked with an `AbortSignal` that aborts mid-call
- **THEN** the resolved string SHALL be `"MCP describe aborted."`

### Requirement: McpRunner exposes refreshCatalog for manual re-discovery

The `McpRunner` SHALL expose `refreshCatalog(): Promise<void>` that re-runs the catalog discovery command and replaces the in-memory catalog. The method SHALL NOT be called automatically; it exists for a future `/mcp refresh` command.

#### Scenario: Refresh replaces the catalog

- **GIVEN** a runner whose catalog was built at construction
- **WHEN** `refreshCatalog()` is called
- **THEN** the runner SHALL re-invoke `mcporter list --json`
- **AND** subsequent `callTool` catalog lookups SHALL reflect the new state

### Requirement: McpRunner exposes buildCatalogText for tool descriptions

The `McpRunner` SHALL expose `buildCatalogText(): string` that renders the cached catalog as a compact text block suitable for embedding in the `mcp_call` tool description. The format SHALL be:

```
Available MCP servers (use mcp_call to invoke):
- <server>: <tool1>, <tool2>, <tool3>
- <server>: <tool1>, ...
```

Each server SHALL appear on one line. Tool descriptions SHALL NOT appear in the catalog text — the model can call `mcp_describe` for those.

#### Scenario: Catalog text for two servers

- **GIVEN** a catalog containing `tavily` with tools `tavily_search`, `tavily_extract` and `grep` with tool `searchGitHub`
- **WHEN** `buildCatalogText()` is called
- **THEN** the result SHALL contain a line `- tavily: tavily_search, tavily_extract`
- **AND** the result SHALL contain a line `- grep: searchGitHub`
- **AND** the result SHALL NOT contain any `inputSchema` content

### Requirement: McpRunner construction does not throw on mcporter failure

If `mcporter list --json` fails during the catalog discovery started at construction (non-zero exit, timeout, or JSON parse error), the `McpRunner` SHALL log a warning, store an empty catalog, and continue. The constructor itself is synchronous and non-throwing. The `mcp_call` and `mcp_describe` tools SHALL still be registered; calls will return a clear error string. The bot SHALL start normally.

#### Scenario: mcporter unavailable at startup

- **WHEN** `McpRunner` is constructed and `bunx mcporter list --json` exits non-zero
- **THEN** the runner SHALL log a warning
- **AND** the catalog SHALL be empty
- **AND** the runner SHALL NOT throw
- **AND** subsequent `callTool` calls SHALL resolve with `kind: "error"` and a descriptive `text`

### Requirement: mcp_call tool definition

The system SHALL expose a single `ToolDefinition` named `mcp_call` that invokes `McpRunner.callTool`. The tool's `parameters` SHALL be a TypeBox object with three fields:

- `server` (required string) — the MCP server name from the catalog.
- `tool` (required string) — the tool name on that server.
- `args` (optional object) — the arguments object passed through to the MCP tool. If omitted or not a plain object, `McpRunner.callTool` coerces the value to `{}` before invocation.

The tool's `description` SHALL embed the `McpRunner.buildCatalogText()` output so the model can discover available servers and tool names without a separate call. The tool's `promptSnippet` SHALL be `"mcp_call: invoke a tool on an MCP server (tavily, grep, deepwiki, …)."`. The tool's `promptGuidelines` SHALL include:

- "Use `mcp_call` to invoke a tool on an MCP server. The catalog of available servers and tools is in this tool's description."
- "If you are unsure of a tool's parameters, call `mcp_describe` first to see its schema."
- "If a call returns an error, the server may be offline or the tool name may have changed. Call `mcp_describe` to see the current surface."

The `execute` function SHALL narrow `params` to a record, extract `server`, `tool`, and `args`, pass them to `runner.callTool(server, tool, args, signal)`, and return `{ content: [{ type: "text", text: result.text }], details: result.text }`.

#### Scenario: Tool registered with catalog in description

- **WHEN** `createMcpTools(runner)` is called
- **THEN** the returned array SHALL contain a `ToolDefinition` with `name: "mcp_call"`
- **AND** its `description` SHALL contain the catalog text produced by `runner.buildCatalogText()`
- **AND** its `parameters` SHALL accept `server`, `tool`, and `args`

#### Scenario: Successful call returns text content

- **WHEN** the agent invokes `mcp_call` with `{ server: "tavily", tool: "tavily_search", args: { query: "hello" } }`
- **AND** `runner.callTool` resolves with `{ kind: "ok", text: "result text" }`
- **THEN** the tool result `content` SHALL be `[{ type: "text", text: "result text" }]`
- **AND** `details` SHALL be `"result text"`

#### Scenario: Error result returned as text, not thrown

- **WHEN** `runner.callTool` resolves with `{ kind: "error", text: "Unknown tool: foo" }`
- **THEN** the tool result `content` SHALL be `[{ type: "text", text: "Unknown tool: foo" }]`
- **AND** the tool SHALL NOT throw

### Requirement: mcp_describe tool definition

The system SHALL expose a single `ToolDefinition` named `mcp_describe` that invokes `McpRunner.describeTool`. The tool's `parameters` SHALL be a TypeBox object with two required string fields: `server` and `tool`.

The tool's `description` SHALL explain that it returns the `inputSchema` of an MCP tool as JSON text, to be used when the model is unsure of a tool's parameters. The tool's `promptSnippet` SHALL be `"mcp_describe: fetch the parameter schema for an MCP tool."`.

The `execute` function SHALL narrow `params`, call `runner.describeTool(server, tool, signal)`, and return `{ content: [{ type: "text", text }], details: text }`.

#### Scenario: Tool registered

- **WHEN** `createMcpTools(runner)` is called
- **THEN** the returned array SHALL contain a `ToolDefinition` with `name: "mcp_describe"`
- **AND** its `parameters` SHALL accept `server` and `tool`

#### Scenario: Schema returned as text

- **WHEN** the agent invokes `mcp_describe` with `{ server: "tavily", tool: "tavily_search" }`
- **AND** `runner.describeTool` resolves with a JSON string
- **THEN** the tool result `content` SHALL be `[{ type: "text", text: <json string> }]`

### Requirement: createMcpTools returns both tools in a stable order

`createMcpTools(runner)` SHALL return `[mcp_call, mcp_describe]` in that order. The order SHALL be stable across calls so downstream tool registries do not reorder unpredictably.

#### Scenario: Stable order

- **WHEN** `createMcpTools(runner)` is called multiple times
- **THEN** the first element SHALL always be the `mcp_call` tool
- **AND** the second element SHALL always be the `mcp_describe` tool

### Requirement: MCP module structure follows goblin conventions

The MCP capability SHALL live under `src/mcp/` with the following files:

- `src/mcp/runner.ts` — `McpRunner` class and `McpToolResult` type.
- `src/mcp/tool.ts` — `createMcpTools(runner): ToolDefinition[]`.
- `src/mcp/paths.ts` — `resolveMcporterConfigPath(configPath, goblinHome): string | undefined`.
- `src/mcp/mod.ts` — barrel re-exporting `McpRunner`, `McpToolResult`, `createMcpTools`.

The module SHALL NOT import from `src/tg/` (Telegram layer). The module SHALL use `log` from `src/log.ts` for all diagnostic output. The module SHALL NOT use `any`; all subprocess output SHALL be typed as `unknown` and narrowed.

#### Scenario: No telegram imports

- **WHEN** the TypeScript project is compiled
- **THEN** no file under `src/mcp/` SHALL have an import path starting with `../tg/` or `grammy`

#### Scenario: Uses log, not console

- **WHEN** any file under `src/mcp/` logs a warning, error, or debug message
- **THEN** it SHALL call `log.warn`, `log.error`, or `log.debug` from `src/log.ts`
- **AND** it SHALL NOT call `console.log` or `console.error`

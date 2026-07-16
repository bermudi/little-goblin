## Phase 1: Config schema and path helper

- [ ] Add `McpConfigSchema` to `src/schema.ts` with `enabled` (optional string array), `configPath` (optional string), `defaultTimeoutMs` (optional number, default 120000, min 5000, max 1800000), `maxResultChars` (optional number, default 16000, min 1000, max 100000). Export `McpConfig` type.
- [ ] Add `mcp: McpConfigSchema.optional()` to `ConfigFileSchema` in `src/schema.ts`.
- [ ] Add `mcp?: McpConfig` to the `Config` interface in `src/config.ts`. Set `config.mcp = cfg.mcp` in `loadConfig()` and `Object.freeze(config.mcp)` when present, matching the `externalAgents` freeze pattern.
- [ ] Create `src/mcp/paths.ts` with `resolveMcporterConfigPath(configPath, goblinHome)`: expands `~` to `os.homedir()`, resolves relatives against `goblinHome`, returns `undefined` when input is `undefined`.
- [ ] Create `src/mcp/paths.test.ts` covering: `undefined` → `undefined`, `~` expansion, relative resolution, absolute passthrough.
- [ ] Create `src/mcp/mod.ts` barrel placeholder. Final re-exports (`McpRunner`, `McpToolResult`, `createMcpTools`) are added in Phases 2 and 3.
- [ ] Run `bun test src/mcp/paths.test.ts` and `bun run validate-config` (or typecheck) to verify.

## Phase 2: McpRunner

- [ ] Create `src/mcp/runner.ts` with the `McpToolResult` type (`{ kind: "ok" | "error" | "aborted" | "timed_out"; text: string }`) and the `McpRunner` class.
- [ ] Implement constructor: resolves config path via `resolveMcporterConfigPath`, stores timeout/caps, triggers catalog discovery asynchronously and stores the promise. `callTool` and `describeTool` await the discovery promise. Construction itself does not throw — log a warning on failure and store an empty catalog.
- [ ] Implement `discoverCatalog()`: spawns `bunx --silent mcporter --log-level error [--config <path>] list --json`, parses JSON, filters by `enabled`, logs warning for unknown enabled servers, returns `Map<string, { name: string; description: string }[]>`.
- [ ] Implement `buildCatalogText()`: renders the cached catalog as `- <server>: <tool1>, <tool2>, ...` lines with the `Available MCP servers (use mcp_call to invoke):` header.
- [ ] Implement `callTool(server, tool, args, signal)`: coerces non-object `args` (including `null`, `undefined`, primitives, arrays, and other non-plain objects) to `{}`, JSON-stringifies, spawns `bunx --silent mcporter --log-level error [--config <path>] call <server>.<tool> --args <json> --output json --timeout <innerMs>`. Constructs a composite `AbortSignal` from the caller `signal` and an `AbortSignal.timeout(defaultTimeoutMs + 5000)` outer guard; `Bun.spawn` receives the composite signal. After `await proc.exited`, inspects the signal `reason` to map `TimeoutError` to `timed_out`, any other abort reason to `aborted`, non-zero exit to `error` with trimmed stderr, and exit 0 to `ok` with normalized content.
- [ ] Implement `normalizeContent(json)`: concatenates `content[].text` entries with `\n`, renders `content[].image` entries as `[image: <mimeType>]`, truncates to `maxResultChars` with `… [truncated]` marker so the final string is exactly `maxResultChars` characters. The kept prefix length is `maxResultChars - 13`. Handles bare-string and other-JSON shapes.
- [ ] Implement `describeTool(server, tool, signal)`: returns `"<server> not in catalog"` for unknown servers, spawns `bunx --silent mcporter --log-level error [--config <path>] list <server> --schema --json --timeout <innerMs>`, finds the tool's `inputSchema`, returns pretty-printed JSON or `"<tool> not found on <server>"`. Uses the same composite `AbortSignal` timeout/abort handling as `callTool`. Caps at `maxResultChars` with the `… [truncated]` marker so the final string is exactly `maxResultChars` characters.
- [ ] Implement `refreshCatalog()`: re-runs `discoverCatalog()` and replaces the cached catalog.
- [ ] Create `src/mcp/runner.test.ts` covering: catalog building from sample `mcporter list --json` output, `enabled` filtering, unknown-server warning, `callTool` success/error/abort/timeout (use a fake spawn helper or mock `Bun.spawn`), content normalization (text + image + truncation), `describeTool` success/unknown-server/unknown-tool, `refreshCatalog`, `buildCatalogText` format, construction-does-not-throw.
- [ ] Update `src/mcp/mod.ts` to re-export `McpRunner` and `McpToolResult`.
- [ ] Run `bun test src/mcp/` to verify.

## Phase 3: Tool definitions

- [ ] Create `src/mcp/tool.ts` with `createMcpTools(runner: McpRunner): ToolDefinition[]`.
- [ ] Implement `mcp_call` tool: `Type.Object({ server: Type.String(), tool: Type.String(), args: Type.Optional(Type.Object({}, { additionalProperties: true })) })` parameters. Description embeds `runner.buildCatalogText()`. `promptSnippet` and `promptGuidelines` per spec. `execute` narrows params, calls `runner.callTool`, returns `{ content: [{ type: "text", text: result.text }], details: result.text }`.
- [ ] Implement `mcp_describe` tool: `Type.Object({ server: Type.String(), tool: Type.String() })` parameters. Description explains lazy schema fetch. `execute` calls `runner.describeTool`, returns text content.
- [ ] Return `[mcp_call, mcp_describe]` in stable order.
- [ ] Create `src/mcp/tool.test.ts` covering: both tools present in order, `mcp_call` description contains catalog text, `mcp_call` execute returns text on ok/error/aborted/timed_out (inject a fake runner), `mcp_describe` execute returns schema text, parameter narrowing rejects non-object args.
- [ ] Update `src/mcp/mod.ts` to re-export `createMcpTools`.
- [ ] Run `bun test src/mcp/` to verify.

## Phase 4: Wire into AgentRunner and dispatcher

- [ ] Add `mcpRunner?: McpRunner` to `AgentRunnerOptions` in `src/agent/mod.ts` (after `externalAgentRunner`). Add `private mcpRunner: McpRunner | null` field. Assign in constructor.
- [ ] In `buildCustomTools()` in `src/agent/mod.ts`, after the `externalAgentRunner` block, add: `if (this.mcpRunner && this.cfg.mcp) { tools.push(...createMcpTools(this.mcpRunner)); }`.
- [ ] Add `mcpRunner?: McpRunner` to `TurnDispatcherOptions` in `src/orchestration/dispatcher.ts`. Add `private readonly mcpRunner` field. Assign in constructor. In `createRunner()`, add `mcpRunner: this.mcpRunner` to `runnerOpts`.
- [ ] Add `mcpRunner?: McpRunner` to `TelegramIntakeOptions` in `src/tg/intake.ts`. Pass it to the `TurnDispatcher` constructor.
- [ ] In `src/bot.ts`, import `McpRunner`. After `externalAgentRunner` construction, add `const mcpRunner = cfg.mcp ? new McpRunner(cfg.mcp, cfg.goblinHome) : undefined;`. Pass `mcpRunner` to `createTelegramIntake`. Add `mcpRunner` to the return type and return statement so tests can inspect it; `src/index.ts` does not consume it.
- [ ] Run `bun test` (full suite) to verify no regressions.
- [ ] Run typecheck (`bun run tsc --noEmit` or the project's equivalent) to verify the wiring compiles.

## Phase 5: End-to-end verification

- [ ] Add an integration test that constructs `McpRunner` with a mock `mcporter` (or a real one if available in the test env), creates an `AgentRunner` with `mcpRunner`, and verifies `buildCustomTools()` includes `mcp_call` and `mcp_describe`.
- [ ] Add an integration test that verifies `mcp_call` is absent when `cfg.mcp` is `undefined`.
- [ ] Add an integration test that verifies `mcp_call` is absent when `mcpRunner` is absent even if `cfg.mcp` is defined.
- [ ] Run `bun test` to verify all tests pass.
- [ ] Manually verify against a real `mcporter` install: start Goblin with `mcp: { enabled: ["tavily"] }` in `goblin.json5`, send a message that should trigger `mcp_call`, and confirm the agent invokes the tool and returns a result.

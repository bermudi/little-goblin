# Subagent Runtime — Tasks

## Phase 1: SubagentRunner skeleton

- [x] Create `src/subagents/mod.ts` with `SubagentRunner` class:
  - Constructor accepts `cfg: Config`.
  - Internal state: `activeSubagents: Map<string, SubagentInstance>`.
  - Methods stubbed: `spawn()`, `revive()`, `list()`, `cancel()`.
- [x] Create `src/subagents/types.ts` with interfaces:
  - `SpawnOptions`, `SubagentHandle`, `SubagentInstance`, `SubagentInfo`, `NamedAgentDefinition`.
- [x] Add `src/subagents/mod.test.ts` with basic instantiation test.
- [x] Verify `bun run typecheck` passes.

Commit: `phase 1: SubagentRunner skeleton and types`

## Phase 2: Generic subagent spawning

- [ ] Implement `spawn(options: SpawnOptions)`:
  - Check depth limit (≤3).
  - Generate UUID for subagent ID.
  - Create directory `~/goblin/subagents/<id>/`.
  - Create `meta.json` with `{spawnedBy, role: 'generic', createdAt}`.
  - Create pi `SessionManager` at that path (persisted session).
  - Build system prompt from `options.prompt`.
  - Load skills from parent (inherit `~/goblin/skills/` via pi's resource loader).
  - Start session with prompt, return `{id, status: 'running'}`.
- [ ] Track subagent in `activeSubagents` map.
- [ ] Unit test: verify spawn creates directory, session file, meta.json.
- [ ] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 2: generic subagent spawning with depth check`

## Phase 3: Named subagent loading

- [ ] Implement named agent discovery: load `~/goblin/agents/<name>/AGENTS.md`.
- [ ] If not found, throw error.
- [ ] If found: use `AGENTS.md` content as system prompt (not the generic prompt).
- [ ] Set skill search path to `~/goblin/agents/<name>/skills/` only (strict isolation).
- [ ] Create directory `~/goblin/agents/<name>/instances/<id>/` for persistence.
- [ ] Update `spawn()` to handle `options.name` for named agents.
- [ ] Unit test: verify named agent loads AGENTS.md, verify isolation (no parent skills).
- [ ] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 3: named subagents with strict skill isolation`

## Phase 4: Subagent execution and result return

- [ ] Implement subagent turn execution:
  - Subagent processes prompt using pi's `AgentSession` with `customTools: []` (no β tools).
  - Stream events (status updates) to parent via callback.
  - On completion, capture final response.
- [ ] Implement result return:
  - When subagent finishes, return result to spawner.
  - Update `meta.json` with `completedAt`, `status: 'completed'`.
- [ ] Handle subagent errors: return error to spawner, update status.
- [ ] Unit test: verify execution flow, verify result return, verify status updates.
- [ ] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 4: subagent execution and result propagation`

## Phase 5: Subagent revival

- [ ] Implement `revive(id: string, prompt: string): Promise<string>`:
  - Load `meta.json` to find session path.
  - Call pi `SessionManager.open()` on the existing session.jsonl.
  - Resume conversation history.
  - Send new prompt to subagent.
  - Return the subagent's response as a string.
- [ ] Handle missing session: throw error "Subagent not found".
- [ ] Update `activeSubagents` map with revived subagent.
- [ ] Unit test: verify revival loads history, verify new prompt processes.
- [ ] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 5: subagent revival from persisted sessions`

## Phase 6: List and cancel operations

- [ ] Implement `list(): SubagentInfo[]`:
  - Return all entries from `activeSubagents`.
  - Include: id, name/type, status (running/idle/completed), spawnedAt.
- [ ] Implement `cancel(id: string)`:
  - Find subagent in `activeSubagents`.
  - Call `subagent.session.abort()`.
  - Update status to 'cancelled'.
- [ ] Handle not found: throw error "Subagent not found".
- [ ] Unit test: verify list returns correct info, verify cancel aborts session.
- [ ] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 6: list and cancel subagent operations`

## Phase 7: Status callback propagation

- [ ] Implement status reporting from subagent to parent:
  - Subagent's `AgentSession` events → parent's callback.
  - Prefix status with subagent name: "🧠 Researcher thinking..."
- [ ] Ensure this flows through to goblin's `MessageBuffer` for display.
- [ ] Unit test: verify status events propagate with correct prefix.
- [ ] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 7: subagent status callback propagation`

## Phase 8: spawn_subagent tool registration

- [ ] In `src/agent/mod.ts`, register `spawn_subagent` tool with pi:
  - Tool name: `spawn_subagent`.
  - Parameters: `{prompt: string, name?: string}` (name for named agents).
  - Handler: delegate to `SubagentRunner.spawn()`.
  - Return subagent ID to LLM.
- [ ] Pass depth tracking: goblin depth = 0, subagent spawns at depth + 1.
- [ ] Ensure subagents also get `spawn_subagent` tool (recursion).
- [ ] Unit test: verify tool registration, verify spawn returns ID.
- [ ] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 8: spawn_subagent tool wired to SubagentRunner`

## Phase 9: Wire into bot.ts and config

- [ ] In `src/bot.ts`, instantiate `SubagentRunner` alongside `AgentRunner`.
- [ ] Pass `SubagentRunner` to `AgentRunner` so spawn tool can use it.
- [ ] In `src/config.ts`, ensure `~/goblin/agents/` and `~/goblin/subagents/` directories exist.
- [ ] Smoke test: verify spawn_subagent tool appears in LLM context.
- [ ] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 9: integrate SubagentRunner into bot.ts`

## Phase 10: Validate and archive

- [ ] `litespec validate subagent-runtime` (strict).
- [ ] Review spec deltas vs implementation.
- [ ] `litespec preview subagent-runtime`.
- [ ] `litespec archive subagent-runtime` when satisfied.

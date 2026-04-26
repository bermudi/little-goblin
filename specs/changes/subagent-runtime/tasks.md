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

- [x] Implement `spawn(options: SpawnOptions)`:
  - Check depth limit (≤3).
  - Generate UUID for subagent ID.
  - Create directory `~/goblin/subagents/<id>/`.
  - Create `meta.json` with `{spawnedBy, role: 'generic', createdAt}`.
  - Create pi `SessionManager` at that path (persisted session).
  - Build system prompt from `options.prompt`. _(deferred to phase 4 — needs `createAgentSession`)_
  - Load skills from parent (inherit `~/goblin/skills/` via pi's resource loader). _(deferred to phase 4)_
  - Start session with prompt, return `{id, status: 'running'}`. _(handle returned; LLM kick-off lands in phase 4)_
- [x] Track subagent in `activeSubagents` map.
- [x] Unit test: verify spawn creates directory, session file, meta.json.
- [x] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 2: generic subagent spawning with depth check`

## Phase 3: Named subagent loading

- [x] Implement named agent discovery: load `~/goblin/agents/<name>/AGENTS.md`.
- [x] If not found, throw error.
- [x] If found: use `AGENTS.md` content as system prompt (not the generic prompt). _(definition.agentsMd is loaded and recorded on the instance; system-prompt construction itself lands in phase 4 with `createAgentSession`)_
- [x] Set skill search path to `~/goblin/agents/<name>/skills/` only (strict isolation). _(definition.skillsDir is recorded for phase 4 to pin pi's resource loader)_
- [x] Create directory `~/goblin/agents/<name>/instances/<id>/` for persistence.
- [x] Update `spawn()` to handle `options.name` for named agents.
- [x] Unit test: verify named agent loads AGENTS.md, verify isolation (skillsDir is the named-agent's own, never goblin's).
- [x] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 3: named subagents with strict skill isolation`

## Phase 4: Subagent execution and result return

- [x] Implement subagent turn execution:
  - Subagent processes prompt using pi's `AgentSession` with `customTools: []` (no β tools).
  - Stream events (status updates) to parent via callback. _(agent_start + tool start/end propagate via `onStatusUpdate`; rich prefixing lands in phase 7)_
  - On completion, capture final response.
- [x] Implement result return:
  - When subagent finishes, return result to spawner via `handle.result: Promise<string>`.
  - Update `meta.json` with `completedAt`, `status: 'completed'`.
- [x] Handle subagent errors: `handle.result` rejects, `meta.json` records `status: 'error'` + `completedAt` + `errorMessage`.
- [x] System-prompt construction for named subagents: `DefaultResourceLoader` with `systemPrompt = AGENTS.md`, `noContextFiles`, `noSkills`, and `additionalSkillPaths` pinned to the agent's `skills/` (carried over from phase 3 deferral).
- [x] Unit tests in `mod.test.ts` (24 total): verify execution wiring (createAgentSession options, customTools=[], cwd), prompt dispatch, text-delta accumulation + result resolution, status callbacks, completed-meta persistence, error propagation + error-meta persistence, named-agent resource-loader isolation.
- [x] Verify `bun run typecheck` + `bun test` pass (only pre-existing `onboard > exits when config already exists` fails — unrelated).

Commit: `phase 4: subagent execution and result propagation`

## Phase 5: Subagent revival

- [x] Implement `revive(id: string, prompt: string): Promise<string>`:
  - Load `meta.json` to find session path.
  - Call pi `SessionManager.open()` on the existing session.jsonl.
  - Resume conversation history.
  - Send new prompt to subagent.
  - Return the subagent's response as a string.
- [x] Handle missing session: throw error "Subagent not found".
- [x] Update `activeSubagents` map with revived subagent.
- [x] Unit test: verify revival loads history, verify new prompt processes.
- [x] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 5: subagent revival from persisted sessions`

## Phase 6: List and cancel operations

- [x] Implement `list(): SubagentInfo[]`:
  - Return all entries from `activeSubagents`.
  - Include: id, name/type, status (running/idle/completed), spawnedAt.
- [x] Implement `cancel(id: string)`:
  - Find subagent in `activeSubagents`.
  - Call `subagent.session.abort()`.
  - Update status to 'cancelled'.
- [x] Handle not found: throw error "Subagent not found".
- [x] Unit test: verify list returns correct info, verify cancel aborts session.
- [x] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 6: list and cancel subagent operations`

## Phase 7: Status callback propagation

- [x] Implement status reporting from subagent to parent:
  - Subagent's `AgentSession` events → parent's callback.
  - Prefix status with subagent name: "🧠 Researcher thinking..."
- [x] Ensure this flows through to goblin's `MessageBuffer` for display.
- [x] Unit test: verify status events propagate with correct prefix.
- [x] Verify `bun run typecheck` + `bun test` pass.

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

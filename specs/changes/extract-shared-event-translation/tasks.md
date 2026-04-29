## Phase 1: Extract shared event dispatch and wire both runners

- [x] Move `TurnCallbacks` interface from `src/agent/mod.ts` to `src/agent/events.ts`. Add `export { TurnCallbacks }` re-export in `mod.ts`.
- [x] Add `dispatchAgentEvent(event: AgentSessionEvent, callbacks: TurnCallbacks): void` to `src/agent/events.ts` with the switch on `agent_start`, `message_update`, `tool_execution_start`, `tool_execution_end`, `agent_end`. Ignore all other event types. Import `AgentSessionEvent` from `@mariozechner/pi-coding-agent`.
- [x] Replace the inline switch in `AgentRunner.handleEvent()` with a call to `dispatchAgentEvent(event, this.callbacks)`. Keep `appendEvent`, the `if (!this.callbacks) return` guard, and `accumulatedText` tracking in `handleEvent` before the dispatch call. Import `dispatchAgentEvent` from `./events.ts`.
- [x] Replace the inline switch in `SubagentRunner.handleEvent()` with a local `TurnCallbacks` adapter object and a call to `dispatchAgentEvent(event, adapter)`. The adapter maps: `onTextDelta` → `hooks.onText`, `onToolStart` → `instance.onStatusUpdate`, `onToolEnd` → `instance.onStatusUpdate`, `onStatusUpdate` → `instance.onStatusUpdate`, `onAgentEnd` → `hooks.onEnd`. Import `dispatchAgentEvent` and `TurnCallbacks` from `../agent/events.ts`.
- [x] Run `bun test` to verify all existing tests pass without modification.
- [x] Run `bun run src/index.ts --help` (or equivalent) to verify the module graph resolves cleanly.

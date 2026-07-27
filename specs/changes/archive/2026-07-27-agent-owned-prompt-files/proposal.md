# agent-owned-prompt-files

## Motivation

Decision 0039 settled that `$GOBLIN_HOME/workspace/SOUL.md`, `AGENTS.md`, and `HEARTBEAT.md` are agent-owned: Goblin may rewrite them with ordinary file tools during a user-facing turn, with no reserved-path write guard. That authority needs three runtime companions to be safe and observable:

1. Canon and source labels must stop calling these files "deployment-owned".
2. Every rewrite of a reserved prompt file must surface a bounded, content-free notice to the Telegram Surface whose runtime performed it.
3. Subagents must not receive these deployment prompt files in their bootstrap; named agents already keep their own `AGENTS.md`, but generic subagents inherit pi's default context discovery and could pick them up.

This change materializes decision 0039 and documents the operator recovery path (git in `$GOBLIN_HOME/workspace`).

## Scope

### Canon and glossary amendments

- Update `specs/glossary.md` so `SOUL.md` is described as "agent-owned" rather than "deployment-owned".
- Update `specs/canon/agent/spec.md` so the main `AgentRunner` prompt sections are "Agent Identity and Voice" and "Agent Operating Rules".
- Update `src/agent/system-prompt.ts` labels to match.
- Update `ARCHITECTURE.md` and `AGENTS.md` guardrails to reflect agent ownership and git recovery.

### Bounded Surface notice on reserved prompt-file writes

- Extend `TurnCallbacks` with an optional `sendNotice(text: string): Promise<void>`.
- Implement `MessageBuffer.sendNotice` by reusing `sendSystemReply` with the "info" tag, silent delivery, and metric recording in the `system` channel.
- In `AgentRunner`, track `tool_execution_start`/`tool_execution_end` pairs by `toolCallId`.
- On a successful `write` or `edit` whose resolved path matches `workspace/SOUL.md`, `workspace/AGENTS.md`, `workspace/HEARTBEAT.md`, or the session-scoped `HEARTBEAT.md`, call `sendNotice` with a bounded summary that names the file and states line/character or edit counts but never includes file contents.
- Notice delivery is best-effort and non-blocking; a failure must not fail the tool call.

### Subagent bootstrap filter

- In `src/subagents/named-agents.ts`, keep named-agent isolation (`noContextFiles: true`, own `AGENTS.md` as system prompt).
- For generic subagents, pass `agentsFilesOverride` to `DefaultResourceLoader` that filters out the resolved paths of `SOUL.md`, `AGENTS.md`, and `HEARTBEAT.md` while leaving other discovered context files (e.g. project `AGENTS.md`) intact.

### Recovery documentation

- Add the `git-in-workspace/` recovery path to `AGENTS.md` and `ARCHITECTURE.md`: keep `$GOBLIN_HOME/workspace` under git and revert agent rewrites as needed. Goblin builds no snapshot or undo store.

## Non-Goals

- No reserved-path write guard in source code. Decision 0039 explicitly rejects one; real isolation is OS-level under decision 0012.
- No inner-life or autonomous reflection path to rewrite prompt files. That boundary remains governed by decision 0035's capability profile, not a file guard.
- No backup, snapshot, or rollback store inside Goblin. Recovery is entirely the operator's git responsibility.
- No change to which files `src/agent/system-prompt.ts` reads or to the system-prompt assembly order beyond label renames.

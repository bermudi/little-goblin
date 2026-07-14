# Workspace Prompt File Reads

## Status

accepted

## Context

The AGENTS.md guardrail states: "Don't touch `$GOBLIN_HOME` from the code tree except through `SessionManager`, `MemoryStore`, and `paths.ts`." This guardrail is concerned with state mutation — preventing scattered code from directly reading or writing session bindings, memory, and other machine-managed state outside the centralized modules.

However, the codebase already has a precedent of reading user-authored workspace prompt files directly outside these modules: `src/agent/system-prompt.ts` reads `SOUL.md` and `AGENTS.md` via `readFile` (using path helpers from `src/workspace/paths.ts`). The `workspace-files` change adds a third prompt file read: `src/scheduler/loop.ts` reads `HEARTBEAT.md` via `readFileSync` (using the `heartbeatMdPath` helper from `src/workspace/paths.ts`).

These reads are fundamentally different from the state access the guardrail restricts:
- They are read-only (no mutation of `$GOBLIN_HOME` state).
- They target user-authored workspace files (`workspace/SOUL.md`, `workspace/AGENTS.md`, `workspace/HEARTBEAT.md`), not machine-managed state.
- Path construction is already centralized in `src/workspace/paths.ts` (path helpers); only the `readFile` call lives in the consuming module.

The guardrail tension is real but narrow: without an explicit exception, the HEARTBEAT.md read in `src/scheduler/loop.ts` (and the existing SOUL.md/AGENTS.md reads in `src/agent/system-prompt.ts`) technically violate the letter of the guardrail.

## Decision

Read-only access to user-authored workspace prompt files (`workspace/SOUL.md`, `workspace/AGENTS.md`, `workspace/HEARTBEAT.md`, and future workspace prompt files) is exempted from the AGENTS.md "Don't touch `$GOBLIN_HOME`" guardrail, subject to these constraints:

1. **Path construction MUST go through path-helper modules** (e.g. `soulMdPath`, `agentsMdPath`, `heartbeatMdPath` from `src/workspace/paths.ts`). Inline `join(home, ...)` construction for prompt file paths is prohibited (per decision `path-helper-only-path-construction`, 0008).
2. **Access is read-only.** No module outside `SessionManager`, `MemoryStore`, `paths.ts`, and `config.ts` (per decision `config-startup-filesystem-mutation`, 0007) may write to or delete workspace prompt files. Onboarding writes (`src/onboard.ts`) are a separate startup concern.
3. **Errors propagate per AGENTS.md "fail loud."** ENOENT on optional files (HEARTBEAT.md) returns a fallback; ENOENT on required files (SOUL.md) throws; non-ENOENT errors always propagate.
4. **This exemption covers only `workspace/` prompt files.** It does not extend to `state/` or `scratch/` paths, which remain restricted to `SessionManager`, `MemoryStore`, `paths.ts`, and `config.ts`.

This exemption SHALL be documented in AGENTS.md alongside the guardrail.

## Consequences

- Easier: `src/agent/system-prompt.ts` and `src/scheduler/loop.ts` can read prompt files directly without routing through a wrapper module, matching the existing code pattern.
- Easier: adding future workspace prompt files (e.g. `MEMORY.md`, `IDENTITY.md`) does not require a new guardrail exception each time.
- Harder: the AGENTS.md guardrail gains a second exception category (read-only workspace prompt files). The boundary between "workspace prompt file" and "other `$GOBLIN_HOME` file" must be kept clear — this decision covers only `workspace/` prompt files, not state or scratch.
- Must change: AGENTS.md guardrail section must note that read-only access to `workspace/` prompt files via path helpers is permitted, alongside the existing `config.ts` exception.

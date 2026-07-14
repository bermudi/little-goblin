# Session Commands & Cancel

## Motivation

Users need control over goblin's execution. If goblin is running a long bash script, the user should be able to stop it. If they want to start a fresh conversation, `/new` should work immediately, not queue behind a streaming response.

This change wires the slash commands that affect session state and defines the interrupt semantics for cancel operations.

## Scope

### In scope
- `/cancel` command: abort goblin's current turn immediately (not queued). Cascades to all live subagents.
- `/new` command: cancel current turn (with cascade), create new DM session, switch to it.
- `/archive` command: cancel current turn (with cascade), archive current session.
- `/debug` command: cancel current turn (with cascade), dump session diagnostics.
- `/help` command: list all available commands.
- Interrupt semantics: commands cancel the active stream and all live subagents before executing.
- Subagent command surface: `/subagents`, `/cancel_subagent <id>`, `/revive <id>` (definitions only; implementation in `subagent-runtime`).

### Out of scope
- Subagent lifecycle implementation (spawning, revival, persistence — separate `subagent-runtime` change).
- Approval prompts or confirmation flows (YOLO mode per `progress.md`).
- Message history navigation (fork, navigate tree — pi features, not goblin commands).

## Non-Goals
- **No graceful degradation.** If `abort()` hangs, we don't have a kill-9 fallback in v1.
- **No partial output preservation.** Cancel drops the in-flight turn; whatever was streamed is what the user sees.
- **No command queuing.** `/new` while streaming means cancel-then-new, not queue-new-for-later.
- **No selective cancel flag.** `/cancel --main` (kill parent only, spare subagents) could be added later if needed, but cascade is the default.

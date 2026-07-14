# Optional Prompt Files Skip Preflight

## Status

accepted

## Context

Goblin's startup preflight checks that required prompt files exist before the agent starts. Today, `SOUL.md` is required — goblin cannot start without it, so the orchestration spec mandates a startup preflight that throws `MissingSoulError` if the file is absent. `AGENTS.md` is optional (goblin starts without it; the system prompt layer handles its absence gracefully).

The `workspace-files` change introduces `HEARTBEAT.md`, another optional prompt file. The design decision "No preflight check for HEARTBEAT.md" establishes that HEARTBEAT.md has no preflight check because it is optional and has a constant fallback. This pattern is generalizable: required prompt files get preflight checks; optional prompt files do not.

Without a standing ruling, each future optional prompt file (`MEMORY.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, etc.) would need to re-litigate whether it needs a preflight check, and the answer would always be "no, because it's optional."

## Decision

Optional workspace prompt files SHALL NOT have a startup preflight check. Only required workspace prompt files (files without which goblin cannot start) SHALL have a preflight check that throws on absence.

An optional prompt file is one that has a fallback behavior when absent (constant fallback, empty-string default, or feature-disabled). A required prompt file is one whose absence prevents goblin from functioning.

Current classification:
- `SOUL.md` — required (preflight throws `MissingSoulError` on absence).
- `AGENTS.md` — optional (no preflight; system prompt layer handles absence).
- `HEARTBEAT.md` — optional (no preflight; constant fallback used when absent, empty, or whitespace-only).

Future workspace prompt files default to optional unless explicitly designated required in their introducing change.

## Consequences

- Easier: adding a new optional prompt file does not require a preflight check or a design decision justifying its absence — the ruling covers it.
- Easier: startup preflight stays focused on truly required files; optional files don't add noise to every install that doesn't use them.
- Harder: a future prompt file that is "optional but recommended" needs an explicit decision about whether to warn. This ruling covers only the binary required/optional case.
- Must change: when a new prompt file is introduced, its change MUST state whether it is required or optional. If required, add a preflight; if optional, no preflight is needed (this ruling applies).

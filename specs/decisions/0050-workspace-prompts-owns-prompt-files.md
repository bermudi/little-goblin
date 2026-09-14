---
id: 0050
date: 2026-09-13
status: accepted
spine: false
amends: [0009]
---

# 0050: WorkspacePrompts Owns Prompt-File Semantics

> Amends decision 0009, which blessed direct prompt-file reads in each
> consuming module.

## Status

accepted

## Context

Decision 0009 exempted read-only access to `workspace/` prompt files from the
`$GOBLIN_HOME` guardrail, letting each consuming module call `readFile` /
`access` through the path helpers directly. The result is that prompt-file
knowledge is re-derived in at least seven places: `agent/system-prompt.ts`
re-implements the required/optional read policy and owns preflight;
`scheduler/loop.ts` re-implements the heartbeat fallback chain and
whitespace/prefix policy; `agent/event-handler.ts` and `subagents/host.ts`
each re-enumerate the prompt-file set (write notices, bootstrap exclusion);
`doctor.ts` re-derives presence policy; `onboard.ts` owns template
materialization. Adding or reclassifying a prompt file means editing all of
them, and the set projections can silently drift from the set the system
prompt actually loads.

Decision 0009's text also covers only `workspace/` prompt files. The runtime
additionally reads the Surface-scoped `state/surfaces/<SurfaceId>/HEARTBEAT.md`
— a prompt file stored under `state/` that the 0009 exemption does not name.

## Decision

`WorkspacePrompts` (`src/workspace/prompts.ts`, surfaced through
`src/workspace/mod.ts`) is the single authority for deployment prompt
files. It owns:

- the prompt-file catalog — deployment files `workspace/SOUL.md` (required),
  `workspace/AGENTS.md` and `workspace/HEARTBEAT.md` (optional, per decision
  0010), plus the Surface-scoped `state/surfaces/<SurfaceId>/HEARTBEAT.md`;
- read policy — required-file ENOENT throws `MissingSoulError`, optional-file
  ENOENT yields absent, non-ENOENT errors propagate unwrapped;
- the heartbeat first-non-empty-wins resolution chain;
- startup preflight derived from the catalog;
- presence inspection for doctor;
- the reserved-file and deployment-file set projections consumed by write
  notices and subagent bootstrap;
- create-missing materialization from templates (exclusive `wx` creation,
  never overwrite), per decision 0039's onboarding ruling.

The decision 0009 read-only exemption is rewritten accordingly: source code
reads deployment prompt files only through `WorkspacePrompts`, never
through direct `readFile`/`access` calls in consuming modules. The
exemption now explicitly covers the Surface-scoped
`state/surfaces/<SurfaceId>/HEARTBEAT.md` as a prompt file, alongside the
`workspace/` files.

Two prompt-file-adjacent paths remain outside the module by design:
named-agent persona files (`workspace/agents/<name>/AGENTS.md`) are
subagent-owned and stay with `named-agents.ts`, and `onboard.ts`'s
`existsSync` probes for wizard flow are existence checks, not content
reads.

Path construction is unchanged: all `$GOBLIN_HOME` prompt-file paths still
come from the path-helper modules (decision 0008); `WorkspacePrompts`
consumes them rather than replacing them.

Agent-runtime writes during user-facing turns remain governed by decision
0039; this decision covers source-code access only.

## Consequences

- Easier: one module holds the catalog and policy, so the write-notice set,
  the subagent-exclusion set, and the system-prompt load set cannot drift
  apart; reclassifying a prompt file is one edit.
- Easier: the Surface-scoped heartbeat read is now covered by an explicit
  exemption instead of living in a guardrail gray area.
- Harder: consuming modules lose the ability to read a prompt file directly —
  new prompt-file behavior is added in `WorkspacePrompts`, not at the call
  site.
- Must change: the AGENTS.md guardrail exception names `WorkspacePrompts` as
  the reader of deployment prompt files — both `workspace/` prompt files
  and the Surface-scoped `state/surfaces/<SurfaceId>/HEARTBEAT.md`; the
  glossary records the term; `ARCHITECTURE.md` prompt-read references are
  updated.

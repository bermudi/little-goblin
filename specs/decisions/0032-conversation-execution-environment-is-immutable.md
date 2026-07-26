# Conversation Execution Environment Is Immutable

## Status

accepted

## Context

`/project` currently changes a surface’s `projectDir`, disposes its runner, and reopens the same pi history with a new CWD. One conversation can begin in Goblin’s scratch directory, continue in project A, and later continue in project B. Each transition changes filesystem authority, project `AGENTS.md`, discovered skills, and project-bound tools beneath persisted model history.

The alternatives were to preserve mutable CWD with a model-visible notice, make project identity conversation-owned only, or assign an execution environment to both the surface and every conversation created there. A notice cannot make old tool calls and assumptions safe under new authority. Conversation-only project identity would make `/new` unexpectedly lose a topic’s project posture.

## Decision

Every conversation SHALL have one immutable **Execution Environment**:

- `personal`, using `$GOBLIN_HOME/scratch/workdir`; or
- `project`, identified by a validated canonical project root.

A surface without a project assignment uses the personal environment. `/project <path>` MAY assign a project environment to an unassigned surface, but it MUST start a fresh project conversation; it MUST NOT reopen the existing personal conversation under the project CWD. An assigned project surface MUST NOT switch to another project or back to personal through ordinary `/project` commands.

Every runner and resumed pi history SHALL match the conversation’s persisted execution environment. `/resume` MUST reject a conversation whose environment differs from the destination surface’s effective environment.

Multiple surfaces MAY share one execution environment. Shared CWD does not merge their conversations, memory scopes, schedules, or delivery routing.

## Consequences

Conversation history has stable filesystem authority and project guidance. `/new` preserves project posture because the surface remains assigned, while `/resume` retains pi-style continuation among compatible surfaces. The CWD-agnostic pi reopen path must be removed or constrained.

Changing projects requires another topic/surface. Recovery after a topic becomes unavailable needs an explicit future operation. Existing conversations and project paths require migration and canonicalization.

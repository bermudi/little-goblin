# immutable-project-environments

## Motivation

`/project` currently mutates a Telegram surface’s `projectDir`, disposes its runner, and reopens the same pi history with the new CWD. The same conversation can begin in `$GOBLIN_HOME/scratch/workdir`, switch to `/srv/project-a`, and later switch to `/srv/project-b` while retaining transcript, tool history, and model context. Each switch changes filesystem authority, project `AGENTS.md`, discovered skills, and project-bound tools underneath an existing conversation.

That is not merely surprising configuration; it makes the meaning and authority of persisted model history unstable. Goblin needs an immutable execution identity for every conversation before conversation rebinding and internal-life delivery can be made safe.

## Scope

This change depends on `telegram-surface-identity` and affects three capabilities: `sessions`, `project-command`, and `agent-runner-project-dir`.

### Sessions

- Introduce an **execution environment** value with two forms: `personal`, whose CWD is `$GOBLIN_HOME/scratch/workdir`, and `project`, whose identity is a validated canonical project root.
- Treat a surface with no project assignment as using the personal environment. A surface may receive one project assignment later, but an assigned project surface cannot return to personal or change to another project through ordinary commands.
- Persist an immutable execution-environment reference in every session/conversation state record. A conversation created on a surface captures that surface’s effective environment and never changes it.
- Allow many surfaces to share the same execution environment. Shared CWD does not merge bindings, transcripts, memory scopes, schedules, or Telegram delivery.
- Migrate legacy records by canonicalizing existing surface `projectDir` values and assigning each existing conversation the effective environment of its recorded/bound surface. Migration preserves history and fails loudly on invalid or unreadable project paths rather than silently changing authority.

### Project command

- Change `/project <path>` from a mutable CWD toggle into a one-time surface assignment.
- On first assignment, canonicalize and persist the project root, leave the provisional personal conversation stored and resumable, and create a fresh project conversation bound to the same surface.
- Reject `/project <other-path>` and `/project none` after assignment with guidance to create another Telegram topic. Repeating `/project` with the same canonical path reports the existing assignment without rotating again.
- Permit separate surfaces to bind the same canonical project root.

### AgentRunner project directory support

- Initialize a runner only from the conversation’s persisted execution environment. Surface assignment and conversation environment MUST match before runner creation.
- Personal conversations always use `$GOBLIN_HOME/scratch/workdir`; project conversations always use their canonical project root for CWD and project guidance/skill discovery.
- Reopen pi history only when its recorded CWD is compatible with the conversation environment. Remove the current CWD-agnostic reopen behavior that deliberately overrides an old pi header after `/project` switches.
- Preserve deployment identity and global Goblin skills; project guidance remains supplemental per decision 0004.

## Non-Goals

- **Conversation terminology and rebinding:** the broader Surface/Binding/Conversation lifecycle and environment-compatible `/resume` land in the dependent `conversation-lifecycle` change.
- **Project reset or recovery:** moving an assignment after Telegram topic deletion is deferred to surface lifecycle. Creating another topic is the normal path for another project.
- **One surface per project:** multiple surfaces may intentionally share a project root.
- **Project registry:** canonical paths are sufficient execution-environment identities in v1; no project database, display-name registry, or repository discovery is added.
- **Work-run ownership:** existing subagent and external-agent ownership is unchanged in this change.
- **Filesystem migration:** `state/sessions/` remains the storage path even though later domain language calls these records conversations.

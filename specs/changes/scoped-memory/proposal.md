# Proposal: scoped-memory

## Motivation

Goblin's curated memory store today is a flat pair of files (`memory.md`, `user.md`)
shared across every chat surface. The user organizes their life in goblin via
Telegram supergroup forum topics — `#Health`, `#IT`, `#Finance`, etc. — each topic
representing a distinct domain. Per decision 0002 `topic-ui-is-user-owned`, those
topics are durable, user-managed surfaces; goblin observes them but does not mutate
them.

The flat memory layout fights this model in three concrete ways:

1. **Cross-domain bleed.** A clinical observation written while in `#Health` is
   visible the next time the user is in `#IT`. The memory budget (4000 chars) is
   shared across every domain at once — every fact competes for the same space.
2. **No per-domain agency.** The agent cannot say "in this topic, the relevant
   facts are X" because there is no notion of *this topic*. It always sees
   everything or nothing.
3. **Subagents are stateless.** Anonymous subagents inherit nothing. Named
   subagents (`agents/<name>/`) have skills and an `AGENTS.md`, but no persistent
   self-knowledge — they relearn methodology every spawn.

The user has accepted (after a grilling pass on prior art across nine production
agent systems) the redesign described in `design.md`: memory becomes scoped by
`(chatId, topicId)`; `user.md` stays global as the identity tier; named subagents
gain their own persona memory; the `memory` tool is split by mutability.

This proposal materializes that redesign.

## Scope

**Three capabilities** are touched.

### `memory`

- New on-disk layout under `$GOBLIN_HOME/memory/`:
    - `user.md` (unchanged location, global, 2000-char cap).
    - `general/memory.md` for DMs and supergroup-no-topic chats (4000-char cap).
    - `topics/<chatId>/<topicId>/memory.md` per forum topic (4000-char cap each).
    - `agents/<name>/memory.md` per named subagent persona (4000-char cap each).
    - `archive/topics/<chatId>/<topicId>/` for orphaned topic scopes.
- Each scope file MAY carry a one-line `description` (used by the cross-scope
  index for progressive disclosure) stored in a YAML-style frontmatter header.
- The single `memory` tool is replaced by **three tools**:
    - `memory_read({target, scope?})` — read any scope's `memory.md` or `user.md`.
    - `memory_read_index()` — list all topic scopes and (where applicable) named
      agent persona scopes with their descriptions.
    - `memory_write({action, target, content?, old_text?, description?})` — mutate
      *only* the active scope. The five actions are `add`, `replace`, `remove`,
      `rewrite`, and `set_description`.
- The active scope is derived server-side from the calling session's locator
  (`(chatId, topicId)`); the agent cannot supply an arbitrary scope on writes.
- The per-turn snapshot rendering changes: it now includes a `## scope` header,
  `## user.md`, the active `## memory.md`, and a `## other scopes` index of
  available cross-domain memories.
- Atomic writes, character cap enforcement, and the existing single git repo at
  `$GOBLIN_HOME/memory/.git` are preserved; commit subjects gain a scope tag
  (e.g. `memory: add in topics/<chat>/<topic>`).

### `subagents`

- Anonymous subagents inherit the parent agent's active scope: same
  `topics/<...>/memory.md` (or `general/memory.md`) read+write, plus global
  `user.md`.
- Named subagents (`agents/<name>/`) follow a three-tier model:
    1. Global `user.md` (always loaded).
    2. Their own `agents/<name>/memory.md` persona memory (always loaded).
    3. The parent's active scope memory (active-tier loaded).
   All three are writable; cross-scope reads via `memory_read` work the same as
   for the main agent.
- A `target: "agent"` value on `memory_write` resolves to the calling named
  subagent's persona file. It is rejected for callers that have no named-agent
  identity (main agent, anonymous subagents).

### `agent`

- The per-turn snapshot built by the agent layer now sources from multiple scope
  files (user + active scope + cross-scope index) instead of a single
  `memory.md`. The format is fixed; the composition is dynamic per session.
- The agent layer wires `(chatId, topicId)` from the resolved session into the
  memory tool registration so `target: "memory"` resolves correctly per-turn.
- Tool registration changes: `createMemoryTool` is replaced by three factory
  functions producing the read / index / write tools described above.

## Non-Goals

- **No PII redaction.** Filtering sensitive content before persisting is real,
  but a project of its own. Parked as a v1.x backlog item.
- **No automatic defragmentation.** Cap overflow remains an error returned to the
  agent, who decides whether to consolidate. The new `rewrite` action makes a
  single-call defrag tractable, but no scheduled or threshold-triggered defrag is
  introduced.
- **No `/forget_scope` or `/promote` user commands.** Orphan handling is
  automatic (move to `archive/`). Cross-scope promotion is an agent-driven
  workflow if it ever becomes needed.
- **No multi-agent write coordination.** Subagents today execute sequentially.
  Concurrency safety (locking, branch-per-writer) is a v2 swarm concern. The
  unified `MemoryStore` is the chokepoint where that lock will live; it is not
  added now.
- **No memory-store migration.** The user runs goblin in development against an
  empty store; the code targets the new paths from day one. Pre-existing
  `$GOBLIN_HOME/memory/memory.md` is the user's manual cleanup.
- **No semantic search, vector store, or embeddings.** Scope-local `memory.md`
  files are small (4000 chars ≈ 1k tokens) and injected wholesale. Cross-scope
  discovery uses one-line descriptions. If/when a corpus outgrows this, that's a
  separate change.
- **No changes to `/archive`, `/new`, or any other command.** Decision 0002
  governs topic-UI separation; the corresponding command-layer fix lives in the
  in-flight `session-commands-cancel` change. This proposal is memory-only.
- **No changes to events.jsonl or transcript.jsonl.** Memory is curated; chat
  history is recall. They remain orthogonal.

# Glossary

- **AgentRunner**: The orchestrator that wraps a pi-coding-agent session for a given Telegram session. Owns memory injection, tool registration, and prompt dispatch. Not the LLM itself.
- **atomic write**: Write-to-temp-then-rename pattern used for all file mutations (state, bindings, memory). Guarantees no partial files on crash.
- **archived session**: A session moved under `state/sessions/archive/<id>/`. Archive clears bindings and removes the session from normal resolution and resume lookup.
- **binding**: Maps a `ChatLocator` to a session ID. Stored in `state/bindings.json`. DMs have at most one; topics have exactly one (auto-created).
- **bound session**: The session currently mapped from a `ChatLocator` by a binding. This is the session that handles the next message on that Telegram surface.
- **capability**: A tool, mode, or posture of the one assistant — not a sibling product. Project-directory mode is a capability: when a chat surface is bound to a `projectDir`, goblin remains the personal assistant with a project coat on; the "remote pi" utility is a side effect of starting in a custom `cwd` and letting pi auto-load skills + `AGENTS.md`. Surface affordances (reactions, file delivery) are likewise capabilities, not an "admin bot" product. Canon uses this term in spec titles (e.g. `Capability: AgentRunner Project Directory Support`). See decision 0004.
- **canon**: The set of accepted, implemented specs in `specs/canon/`. Each subdirectory is one domain module.
- **ChatLocator**: A discriminated key — `{ chatId }` for DMs, `{ chatId, topicId }` for forum topics — used to resolve which session handles a message.
- **defrag**: Agent-driven consolidation of memory files. Not a system operation; replaced by the global budget and auto-compaction in `memory-engine`.
- **dreaming**: Scheduled memory consolidation with three phases: light sleep (extract and dedupe transcript snippets), REM sleep (detect recurring themes across sessions), and deep sleep (promote short-term entries and compact the global budget). Runs in an internal `__goblin_dreaming__` session.
- **entry_kind**: Database column in `memory_entries` distinguishing the logical kind of an entry: `memory` (curated scope memory, including named-agent persona), `user` (global `user.md`), or `transcript` (chunked conversation snippet). Not to be confused with the `memory_write` tool `target` parameter.
- **external agent**: A coding agent that runs outside Goblin's `pi-coding-agent` process, such as Codex, Claude Code, or Devin. Accessed through the `external_agent` tool and managed by `ExternalAgentRunner`.
- **external-agent run**: One delegated task to an external agent. Has a UUID, backend, owning session, bound project directory, bounded event history, and a terminal status (`completed`, `failed`, `cancelled`, `timed_out`, or `interrupted`). Persisted under `$GOBLIN_HOME/scratch/external-agents/<runId>/`.
- **frozen summary**: Bounded memory summary injected into the system prompt at session creation (max 1200 chars total). Contains the active scope description, a `user.md` summary, an active scope `memory.md` summary, and a cross-scope index. Not refreshed mid-session.
- **global memory budget**: A single character budget (default 50,000) across all curated `memory_entries` with `entry_kind = "memory"` or `entry_kind = "user"`. Replaces the previous per-file 4000/2000 caps. Only `origin = "dreaming"` entries are eligible for compaction; user entries are preserved.
- **goblin** aka **main agent**: The AI bot. Single user, single process. Lives in Telegram.
- **GOBLIN_HOME**: Root data directory (default `~/goblin`). Organized into three groups: `workspace/` (user-authored prompt files — `SOUL.md`, `AGENTS.md`, `skills/`, named-agent definitions), `state/` (machine-managed — `bindings.json`, `topic-settings.json`, `schedules.json`, `sessions/`, `memory/`, `pi/`), and `scratch/` (ephemeral — `workdir/`, `subagents/`, `external-agents/`). `scratch/external-agents/` persists run records for reconciliation and status inspection but remains scratch data, so backup and cleanup expectations treat it as ephemeral.
- **HEARTBEAT.md**: Optional user-editable workspace prompt file at `$GOBLIN_HOME/workspace/HEARTBEAT.md` that sources the heartbeat prompt. Sibling to `SOUL.md` and `AGENTS.md`. If absent, empty, or whitespace-only, the system falls back to the built-in `HEARTBEAT_PROMPT` constant. Read at dispatch time (each heartbeat wake), not at schedule creation, so edits take effect on the next heartbeat without restart.
- **locator**: Shorthand for `ChatLocator`.

- **MCP**: Model Context Protocol. The external ecosystem of tools and resources that Goblin reaches through `mcporter`.

- **MCP catalog**: The in-memory map of enabled MCP servers and their tool names + descriptions, built from `mcporter list --json` and embedded in the `mcp_call` tool description.

- **mcporter**: The local MCP gateway CLI that handles OAuth, daemon keep-alive, stdio transports, and config discovery. Goblin invokes it as a subprocess rather than implementing an MCP client.

- **McpRunner**: Goblin's subprocess wrapper around `mcporter`; owns catalog discovery, tool invocation, schema fetch, and result normalization.

- **mcp_call**: The `ToolDefinition` that invokes `McpRunner.callTool` to run a tool on an MCP server.

- **mcp_describe**: The `ToolDefinition` that invokes `McpRunner.describeTool` to fetch the `inputSchema` of an MCP tool as JSON text.

- **memory.md / user.md**: Curated memory export files under `$GOBLIN_HOME/state/memory/`. The canonical store is `memory.sqlite`; markdown is regenerated by `memory export`. After the `memory-engine` change, `memory.md` exists once per scope (general / topic / named-agent persona); `user.md` remains a single global file.
- **memory scope**: The database `scope` value memory is keyed by. One of: `user` (global `user.md`), `general` (singleton — DMs and supergroup-no-topic), `topics/<chatId>/<topicId>`, `agents/<name>`, `archive/...` (orphaned topic scopes), or `transcript/<sessionId>` (chunked conversation history).
- **active scope**: The memory scope resolved from the calling session's locator (and, for named subagents, the agent's name). `memory_write` always targets the active scope; the agent cannot supply an arbitrary scope on writes.
- **persona memory**: A named subagent's `state/memory/agents/<name>/memory.md` — the agent's self-knowledge across invocations, distinct from any single topic's domain memory. Loaded into every snapshot that named agent sees.
- **scope description**: A one-line agent-curated summary stored in a YAML-style `--- description: ... ---` frontmatter at the top of a scope's `memory.md`. Used in `memory_read_index` and the snapshot's `## other scopes` section for progressive disclosure (≤200 chars).
- **MessageBuffer**: Implements `TurnCallbacks` to render agent activity as Telegram messages. Manages status phases, streaming edits, and rollover.
- **named subagent**: A subagent that loads its `AGENTS.md` and `skills/` from `~/goblin/workspace/agents/<name>/` (the definition dir — holds only `AGENTS.md` + `skills/`). Strictly isolated from parent skills.
- **native adapter**: An `ExternalAgentAdapter` that runs a backend CLI in a structured non-interactive mode, such as Codex JSON, Claude stream-JSON, or Devin ACP. Normalizes native events to `ExternalAgentEvent` before the runner consumes them.
- **pi-coding-agent**: The underlying agent framework that goblin wraps. Provides `AgentSession`, `defineTool`, extension/skill loading. Ships a sample subagent extension (`examples/extensions/subagent/`) that spawns child `pi` processes, but goblin's subagent system is custom-built on the core SDK.
- **queue**: The `/queue <text>` command enqueues text to run as a fresh turn after the current turn settles, via the per-session promise queue. The explicit opt-out from steer-by-default. Not to be confused with pi's internal `followUp` queue.
- **product shell**: The small code-owned part of Goblin's system prompt. Contains runtime mechanics and section framing, not deployed identity, user identity, or conversational voice.
- **project guidance**: The exact `AGENTS.md` from a session's bound `projectDir`, included in the main Goblin system prompt as repository/workspace instructions. Not deployment identity.
- **relevant memory**: Per-turn `## relevant memory` aside computed via hybrid search on the current prompt text and injected via `sendCustomMessage(..., { deliverAs: "nextTurn" })`. Bounded to 3 results by default and clamped to a maximum of 5. Replaces the previous full per-turn memory snapshot.
- **resumable session**: A non-archived session directory under `state/sessions/<id>/`, whether currently bound or unbound. `/resume` searches these sessions.
- **session**: A persisted conversation scoped to one `(chat, topic)` pair. Has its own `workdir/`, `events.jsonl`, `transcript.jsonl`, and `state.json`, all under `state/sessions/<id>/`.
- **SessionManager**: Owns session lifecycle — creation, resolution, persistence, and binding management.
- **snapshot**: Memory context surfaced to the agent. After `memory-engine`, this is split into a `frozen summary` (in the system prompt) and a per-turn `relevant memory` aside. The old `[goblin memory snapshot]` per-turn aside is removed.
- **SOUL.md**: Required deployment-owned prompt file at `$GOBLIN_HOME/workspace/SOUL.md` that defines the main Goblin's conversational identity and voice. Created by onboarding; not hardcoded in source.
- **stale binding**: A binding whose session directory no longer exists. DMs clear the binding; topics auto-recreate.
- **status phases**: Three coarse states rendered in the MessageBuffer status line: Thinking, Working, Done. Not per-tool.
- **steer**: Injecting a user message into a running turn via `AgentRunner.followUp()` → `AgentSession.followUp()`, without resetting the in-flight turn's callbacks or buffer. The default dispatch path for non-command text on a streaming runner. Distinct from queue (serialize-and-wait).
- **subagent**: An agent spawned by goblin (or another subagent) for focused work. Recursive up to depth 3.
- **TurnCallbacks**: Interface (`onTextDelta`, `onToolStart`, `onToolEnd`, `onStatusUpdate`, `onAgentEnd`) that bridges the agent layer to the Telegram layer.
- **unbound session**: A resumable session under `state/sessions/<id>/` that no current binding points to.
- **visibility**: Config for which tool names appear in status phases (`none | minimal | standard | verbose | debug`).
- **workdir**: Per-session working directory at `state/sessions/<id>/workdir/`. The agent's cwd for tool execution.

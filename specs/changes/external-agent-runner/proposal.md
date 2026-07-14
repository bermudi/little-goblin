# External Agent Runner

## Motivation

Goblin can currently delegate only to in-process pi subagents. That keeps delegation inside one model/runtime and prevents Goblin from using installed coding agents such as Codex, Claude Code, and Devin when their repository tooling, models, or provider-specific behavior are a better fit.

`agent-pty` can drive those CLIs, but exposing its terminal primitives directly would make Goblin responsible for keystrokes, screen hashes, prompt detection, and backend-specific TUI behavior. The useful interface is a coding task and an external-agent run; PTY mechanics should remain hidden behind an adapter.

This change adds external coding-agent orchestration as a capability of the one Goblin assistant, consistent with decision 0004. It introduces a runner that owns lifecycle, normalized events, persistence, limits, and cancellation while native adapters hide each CLI's machine-readable protocol. `agent-pty` is retained as the internal fallback for interactions that cannot complete through a native structured mode.

## Scope

### External-agents capability

- Add an `ExternalAgentRunner` module, separate from `SubagentRunner`, that owns external-agent runs for Codex, Claude Code, and Devin.
- Define a narrow adapter seam that normalizes provider-specific structured output into common status, output, completion, failure, and input-required events.
- Add native adapters using each installed CLI's non-interactive or machine protocol: Codex JSON events, Claude Code stream JSON, and Devin ACP/structured non-interactive operation.
- Add an `agent-pty` adapter behind the same seam for an explicit adapter fallback when a run requires terminal interaction; raw PTY actions are not exposed to Goblin.
- Add one `external_agent` tool with `start`, `status`, `message`, `cancel`, and `list` actions. `start` returns immediately with a run ID; status and terminal results are obtained without holding a tool call open for the full coding task.
- Bind every run to the spawning Goblin session and that session's configured project directory. The model cannot supply an arbitrary executable or working directory.
- Configure an explicit backend allowlist, concurrency limit, run timeout, and permission profile. If no external backends are enabled, the tool is omitted.
- Persist bounded run metadata, normalized events, and final results under `$GOBLIN_HOME/scratch/external-agents/` using atomic writes/append-only JSONL. Reconcile stale `running` metadata at startup.
- Enforce backend-specific safe permission arguments and a code-owned sanitized child environment; tool input cannot request approval bypass, arbitrary CLI flags, or environment values.

### Orchestration integration

- Construct one shared `ExternalAgentRunner` at the composition root and inject it into main `AgentRunner` instances for tool creation.
- Include external runs in session-scoped interrupt, runner disposal, and process shutdown cleanup so they do not outlive their owner unintentionally.
- Report external-run activity through existing turn status callbacks without giving external agents direct Telegram access.

### agent-pty support

- Extend the `agent-pty` protocol and CLI used by the PTY adapter with validated response types, abortable long-poll requests, exact child-environment support, a stdin/stdout `rpc` command, and backward-compatible owner flags. Little Goblin invokes the installed `agent-pty` executable rather than taking a non-portable sibling-repository dependency.
- Add daemon-side owner metadata and owner-scoped listing/cancellation so Goblin can isolate its sessions from unrelated `agent-pty` users sharing the daemon.
- Preserve the existing CLI, Pi extension, and MCP interfaces while extending their protocol support where required.
- Add integration tests for owner isolation, cancellation/disconnect cleanup, and the CLI operations consumed by Little Goblin.

## Non-Goals

- No raw `spawn`, `type`, `key`, `snapshot`, or other PTY tool is exposed to Goblin.
- No arbitrary executable, arbitrary CLI arguments, arbitrary environment mutation, or caller-selected cwd is accepted by the agent-facing tool.
- No automatic approval bypass, `dangerously-*` mode, or unrestricted filesystem profile is introduced.
- No Telegram inline-keyboard approval workflow is added; runs that require an approval unavailable under their configured profile report `input_required` and may accept a text `message` only when the selected adapter supports it.
- No worktree creation, merge automation, commit, push, or pull-request creation policy is added. External agents operate in the bound project directory under existing repository rules.
- No recursive external-agent spawning is provided to pi subagents in this change; the tool is available only to the main Goblin agent.
- No replacement or generalization of `SubagentRunner`; pi subagents and external-agent runs remain distinct modules.
- No guarantee that native or PTY processes survive a Goblin or daemon crash. Startup reconciliation records interrupted runs honestly rather than pretending to resume them.
- No cloud-agent job management or provider account setup. Authentication remains the installed CLI's responsibility.

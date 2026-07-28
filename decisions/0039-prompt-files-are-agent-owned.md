---
nospec: true
id: 0039
date: 2026-07-26
status: accepted
spine: false
amends: [0003]
---

# 0039: Prompt Files Are Agent-Owned

> Amends decision 0003, which described `SOUL.md` as deployment-owned.

## Context

`immutable-project-environments` makes `$GOBLIN_HOME/workspace` the personal Execution Environment and therefore the personal CWD. `ARCHITECTURE.md` flagged the consequence as blocking open work: pi's file tools would reach `SOUL.md`, `AGENTS.md`, `HEARTBEAT.md`, and the personal skill catalog by relative filename.

Three different actors were conflated under that one heading. Two are already settled:

- **Goblin's own code** — decisions 0007 and 0009: read-only access to workspace prompt files through path helpers.
- **External-agent child processes** — a separate policy surface outside this ruling. A same-user child process is not an OS sandbox merely because its working directory is project-scoped.

Only the third, **model tools inside the main runtime**, was unsettled.

### Enforcement reality

Goblin's main runtime already has `bash`. `createAgentSession` (`src/agent/backend.ts:145-155`) passes no `initialActiveToolNames`, `allowedToolNames`, or `excludedToolNames`, and pi's default active set is `[read, bash, edit, write]` (`agent-session.d.ts:102`). Pi's `resolveToCwd` handles absolute paths and `~` expansion; `cwd` is a base for relative paths, not a jail.

The exposure also predates the migration. `workdirPath()` returns `$GOBLIN_HOME/scratch/workdir` (`src/workspace/paths.ts:11-13`), a sibling of `workspace/`. `../../workspace/SOUL.md` reaches the identity file today. Making `workspace/` the CWD changes reachability from deliberate traversal to a relative filename — a far likelier *accident*, but not possible-to-impossible.

Therefore a reserved-path guard on `write`/`edit` could only ever prevent accidents. It could never be a security boundary: the main runtime's active `bash` tool runs as the operator's Unix user and can address paths beyond its CWD.

### Prior art

Goblin borrowed the SOUL/AGENTS split and the dreaming pipeline from OpenClaw, but diverged on ownership. In OpenClaw the identity file is explicitly agent-owned:

- `docs/concepts/soul.md:57-59` instructs the user to "Paste this into your agent and let it rewrite SOUL.md".
- `agents.files.set` writes any workspace file with no reserved-path check; only a workspace-boundary `FsSafeError` applies (`src/gateway/server-methods/agents.ts:840-886`).
- Setup writes templates through `writeFileIfMissing` and never overwrites (`src/agents/workspace.ts:945-957`).
- Bootstrap files are read at session start, not per turn, so an edit lands on the next session (`src/agents/bootstrap-files.ts:305-310`).

Two OpenClaw constraints matter more than the permission itself:

- **Dreaming never writes identity.** Its sources are `daily`, `memory`, `sessions`, `logs`, and `recall`; no code path reaches `SOUL.md`. Agent-owned means the agent rewrites its voice during a session with the operator present, not autonomously overnight.
- **Subagents do not receive identity files.** Subagent bootstrap is filtered to `AGENTS.md` and `TOOLS.md` (`src/agents/workspace.ts:1106-1114`), preventing identity drift through delegation.

OpenClaw has no versioning and no notification; `docs/concepts/agent-workspace.md:118-179` tells operators to keep the workspace in a private git repo. Goblin is Telegram-native and can do better for one message.

Alternatives rejected. Absolute protection contradicts the product description in `AGENTS.md` ("evolve its own skills") and the prior art. A reserved-path guard plus a dedicated self-modification tool adds a tool, a wrapper over pi's built-ins via `baseToolsOverride`, and a permission concept, to prevent an accident that `bash` can still cause. Nesting the CWD under `workspace/files/` was considered and rejected by the operator as unnecessary, and does not confine absolute paths either.

## Decision

`$GOBLIN_HOME/workspace/SOUL.md`, `AGENTS.md`, and `HEARTBEAT.md` are **agent-owned**. Goblin MAY rewrite them with ordinary file tools during a user-facing turn.

Onboarding SHALL continue to create `SOUL.md` and `AGENTS.md` from templates and MUST NOT overwrite existing files. `SOUL.md` SHALL remain required at startup per decisions 0003 and 0010. Goblin SHALL NOT gain a second identity file; the OpenClaw `IDENTITY.md` split is not adopted.

There SHALL be no reserved-path write guard on prompt files. A guard would be unenforceable while `bash` is active and would contradict the ownership model.

Every write to a reserved prompt file SHALL post a notice to the Surface bound to the runtime that performed it, naming the file and a bounded change summary. The notice is informational and non-blocking; failure to deliver it MUST NOT fail the write, and it MUST NOT include file contents beyond a bounded summary.

**Inner-life wakes MUST NOT write prompt files.** This is expressed as an absence in the code-owned capability profile of decision 0035, not as a guard on the file. Autonomous reflection MAY propose an identity change as a bounded effect requiring an ordinary authorized turn to apply; it MAY NOT apply one itself.

**Subagents MUST NOT receive deployment prompt files** in their system prompt or bootstrap. Named agents keep their own user-authored `workspace/agents/<name>/AGENTS.md`; that file is unaffected by this decision.

Recovery is **git in `$GOBLIN_HOME/workspace`**, documented for the operator, not implemented in code. Goblin SHALL NOT build a bespoke snapshot, undo, or version store for prompt files.

Goblin's own code remains read-only on these files. Decision 0009 is unchanged, and onboarding writes remain its stated exception.

This is not a security boundary. Operators requiring real filesystem isolation must use an OS-level sandbox; that deployment policy is outside this prompt-file ruling.

## Consequences

Goblin can genuinely evolve its own voice, which is what the product claims and what the prior art does. The operator sees every identity change in the chat where it happened, which is strictly better than OpenClaw's silent-write-plus-remember-to-git model, and costs one message.

At acceptance, three legacy records contradicted this decision and required repair: the glossary (then `specs/glossary.md`), `specs/canon/agent/spec.md`, and decision 0003 called `SOUL.md` "deployment-owned" or lacked the amendment pointer. The delivered change corrected those projections along with `ARCHITECTURE.md`.

The notification requires a Surface-addressed delivery seam, so the owning change depends on `telegram-surface-identity`, and the exposure it responds to arrives with `immutable-project-environments`. It therefore belongs immediately after step 2 of the implementation train, as a small `agent-owned-prompt-files` change covering the canon amendment, the notice, and the subagent bootstrap filter.

The subagent filter closes a hole Goblin has today: generic subagents currently inherit deployment prompt context with no protection against identity drift through delegation.

Accepted residual risk: a mis-instructed model can still corrupt its own identity mid-turn, and `bash` can still reach any file the Unix user can. The mitigation is visibility plus git, not prevention. If identity corruption is observed in practice, the next step is a bounded self-modification effect under decision 0035's proposal/validation model — not a path guard.

# Agents — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Ruling (operator, 2026-11-16)

"I need real subagents, like the ones you have in `claude`." Goblin hands
work to other agents through **two tools with two jobs**, in the standard
shape that Claude Code, hermes and openclaw share. This ruling replaces
the purpose-typed Pi Durable runtime (`design/subagents.md`), the Herdr
transport (`design/delegation.md`) and the `herdr` tool. Those docs
describe code that stays in the tree until it is removed (→ Removal
order).

| Tool | Job | Who decides | Runs on |
|---|---|---|---|
| `agent` | Give a piece of work to a child agent | Goblin, on its own judgment | Goblin's own runtime, as a child conversation |
| `delegate` | Run a named external harness (codex, opencode, claude, pi, devin) | The operator only | A T3 Code thread |

There is no third tool. The routing rule the model gets is one sentence:
**the operator named a harness → `delegate`; otherwise → `agent`, or do
the work yourself.**

Mechanisms borrowed, not scope:

- Claude Code `Agent`: agent types as markdown files with frontmatter;
  background runs; a follow-up message continues a child.
- hermes `delegate_task` (`tools/delegate_tool.py`): the child knows
  nothing of the parent conversation, so the task must stand alone;
  depth limit; `steer` / `stop` on live children.
- openclaw `sessions_spawn` (`src/agents/tools/sessions-spawn-tool.ts`):
  a child is a session that the UI can show; its result is announced back
  to the requester; one spawn tool, with an external-harness runtime
  (`runtime: "acp"`) beside the native one.

## `agent`: native subagents

### A subagent is a child conversation

`spawn` creates a conversation that has a `parent` (the origin
conversation) and an agent type. That conversation runs on the same
`Runtime` (`runtime.ts` → `submit`) as every other conversation: the
same engines (ai-sdk, claude-code), turn journal, compaction, tool
authority and logging. There is **no second agent loop and no second
model catalog**.

- **Context.** The child starts with the agent type's system prompt and
  the task text. It does not see the parent's history. The tool
  description tells goblin to write a self-contained task.
- **Model.** The agent type's `model` (a configured model reference),
  else the parent's model. All of goblin's providers work, including the
  claude-code subscription engine (DIRECTION.md → Inference Is A Core
  Constraint).
- **Tools.** The agent type's allowlist, limited to the tools the parent
  turn has. A child never gets `agent` (depth 1), `delegate` (only the
  operator starts a harness run, and a child does not hear the operator),
  or a tool that talks to a channel (`send`, `speak`, `ui`, `mail`).
- **Memory.** No recall and no retention: a child's exchanges are not
  operator exchanges.
- **Result.** The child's final reply is the result. A child settles as
  done, needs input (a type with `ask_operator`) or failed. Settlement sends a
  notice that wakes the parent through the existing notice path. The
  result arrives fenced: it is the child's claim, which goblin checks
  before it reports.
- **Visibility.** The app lists the child under its parent, and the
  operator can open it and read every step. Telegram does not show
  children.

### Agent types

An agent type is a markdown file: `$GOBLIN_HOME/agents/<name>.md`.
Frontmatter is validated with zod when the file is read; a bad file is a
loud error that names the file, never a silent skip.

```markdown
---
description: Reads code and answers questions about it. No writes.
model: claude-haiku        # optional; a configured model ref
tools: [read, search, bash] # optional; absent = the default child set
---
System prompt for this agent type.
```

- `description` is required. The `agent` tool description lists every
  type with its description, so goblin can choose one.
- Built in: `general`, which has the default child set (the parent's
  tools minus the exclusions above). An operator file with the same name
  replaces a built-in type.
- Types are read at turn start, like skills. A changed file applies on
  the next turn and needs no restart.
- Less-trusted models get bounded tools (DIRECTION.md → cheap/free
  workers): a type that names such a model also names a narrow `tools`
  list, for example the sandbox only. The type file is the control, not a
  runtime gate.

### Verbs

```
spawn {type?, task, background?, desktop?}   type defaults to general; background defaults to true; desktop is required for the computer type — spawn claims it for the child
list  {}
read  {id}                         status plus the child's latest messages
send  {id, text}                   steer a running child, or follow up a settled one
stop  {id}
```

- `background: true` returns the child id at once. The parent's turn
  continues or ends, and the notice wakes it later.
- `background: false` makes the tool call wait for the result. Parallel
  `spawn` calls in one step fan out. Stopping the parent's turn stops
  its waiting children.

### Limits

- **Depth 1.** A child cannot start a child.
- **`agents.maxRunning`** caps running children across all
  conversations. Above the cap, `spawn` queues the child and says so.
  Exhausted capacity is reported, never replaced by paid inference.
- **Crashes follow goblin's own rule.** A child turn cut by a restart is
  an unlanded turn (design/runtime-turn.md → Unlanded-turn progress); the
  parent gets a `failed` notice that names it. No mid-tool resume and no
  timeout-and-revive.

### Why goblin's runtime, not Pi Durable

- Pi Durable drives models through pi-ai, which has its own provider
  layer. Today it supports only z.ai GLM (`src/subagents/models.ts`).
  The claude-code engine is an Agent SDK step, not an HTTP model, so
  pi-ai cannot drive it. A bridge would mean a pi-ai provider for every
  goblin provider, maintained for ever.
- A child conversation reuses everything the runtime already has. The
  new code is the tool, the agent-type loader, the parent link and the
  settlement hook.
- What goes: mid-run crash resume, replay marks and the crash-approval
  gate. Children get the same crash rule as goblin's own turns.

## `delegate`: external harness runs on T3 Code

### Only when the operator asks

`delegate` runs a harness that the operator names: "have codex do X",
"an opencode run". The operator can also ask with a standing
instruction, for example the issue-build flow that starts a lead
(design/delegation.md → An issue build is one lead delegation). Goblin
never chooses `delegate` on its own judgment. Work goblin decides to
hand off goes to `agent`.

### Transport: the `t3` CLI

One adapter, `src/t3.ts`, knows the T3 Code wire. Domain modules see its
types only (the module-boundaries rule). Verified against `t3` v0.1.9 on
g7 (2026-11-16):

| Need | `t3` verb |
|---|---|
| Start | `t3 thread start <project> <message> --provider <id> --model <slug> [--worktree <base> --branch <name>] --json` |
| Follow up | `t3 thread send <thread> <message> --json`. A busy thread takes it as its next turn; nothing is interrupted |
| Status and result | `t3 thread show <thread> --messages N --json` |
| Discover | `t3 thread list --project <path> --json`, which returns `status`, `settled`, `providerInstanceId`, `model`, `pullRequests`, `parentThreadId` and `link` |
| Wait | `--wait`: exit 1 means the run failed, exit 2 means it waits for an answer (needs input) |

- **Harnesses stay config.** A harness name maps to a T3 provider
  instance and a model (seen on g7: `codex`, `claudeAgent`, `pi`,
  `acpRegistry_devin`, `acpRegistry_piz`). Goblin never guesses a model.
- **Gone with Herdr:** screen scraping, the `answer` keypress verb,
  trust-dialog seeding (`harness-trust.ts`), prompt-delivery checks and
  `goblin-herdr.service`. T3 Code owns the harness sessions.
- **The operator watches in T3 Code.** Each notice carries the thread
  `link`.

**Known gaps** (from `t3 thread --help`, v0.1.9):

- There is no stop or interrupt verb. Until T3 Code has one, `delegate
  stop` cannot be offered.
- There is no completion push. The watcher polls `show`, as it polls
  Herdr today.
- The T3 server is not a service on g7 (`t3 status`: "Service not
  installed"). `goblin.service` needs a server that stays up. Installing
  it (`t3 up`) is an operator action.

## Handover: T3 Code threads, not Herdr panes

The operator no longer works in Herdr; they work in T3 Code
(2026-11-16). "Take over this" binds a responsibility to T3 thread ids:

- discovery is `t3 thread list`;
- the responsibility observer polls `t3 thread show`;
- a managed send is `t3 thread send`. A busy thread queues the message
  instead of racing it, so the Herdr prompt-delivery race does not apply.

The `herdr` tool (the operator's `default` session) is removed. Nothing
replaces it: the operator's desk is T3 Code now.

## Computer use: a `computer` agent type (operator, 2026-11-16)

Computer use moves onto `agent`. It is a built-in agent type,
`computer`, whose tools are the desktop tools. The desktop pool stays as
it is (design/subagents.md → Desktops: a managed pool; `desktops*.ts`,
cua-driver): it has no Pi Durable code in it.

- **Tools:** `inspect` (the AT-SPI element tree as text), `act` (cua
  input, bound to an observation id), `launch`, `screenshot`, and
  `ask_operator` (needs input). They are goblin tools in zod, ported from
  `src/subagents/tools.ts`.
- **Lease:** `spawn` claims the named desktop with the child
  conversation as the lease holder (`LeaseHolder` kind `conversation`).
  Settlement releases it. Needs input releases it so the operator can
  act, as before.
- **Crash rule:** goblin's own rule. An `act` cut by a crash is
  reported, not replayed. Binding input to the latest observation (a
  stale or restarted frame's id is refused) stays in `desktops.ts`.
  The crash-approval gate (`approval-gate.ts`) is not ported.
- **Text first.** `inspect` + `act` by element need no images and work
  on any model. That ships first.
- **Screenshots second.** A frame in a tool result needs an image
  variant of `ToolOutput` (today text or json, `src/tool.ts`). This
  changes the ruling "no image bytes in results" (design/tools.md) for
  the providers whose pipe carries images, each one probe-verified:
  the AI SDK `image-data` tool-output part, and an MCP `image` content
  block on the claude-code bridge (`src/agent/claude-code/tools.ts`,
  text only today). A provider that cannot carry it gets no screenshot
  tool. Old frames become text stubs through the pruning marker, so
  they do not stay in every later request.
- **Model:** the operator chooses it in the type file. It must accept
  images before the screenshot tool mounts for it.

## Removal order

Each step keeps a working path (DIRECTION.md: do not retire useful
access before there is a working replacement).

1. Remove the `herdr` tool. The operator does not use the desk any more.
2. Build `agent`: child conversations, agent types and the parent link.
3. Build the `computer` agent type, text first.
4. Add image tool results and the `screenshot` tool.
5. Build the `src/t3.ts` adapter. Move `delegate` and responsibility
   attach/observe onto it, and prove one delegation end to end.
6. Delete the Herdr code: `src/herdr.ts`, its live check,
   `harness-trust.ts` and the unit.
7. Delete the `subagent` tool, `src/subagents/`, the `subagent_runs`
   table and the pi-durable, pi-ai and chord dependencies. Needs step 3.

## Machine targets: dropped (2026-11-17)

Delegation runs on this machine only. `delegation.machines` is gone: an
old herdr-shaped block logs a warning that names the rewrite and boots
without `delegate`. Reasons:

- `t3 thread start` (v0.1.9) has no environment flag. Linked
  environments (`t3 environment`) might reach other hosts, but that is
  unverified.
- The live config on g7 has no `machines` block (checked 2026-11-17).

If remote delegation comes back, it goes through T3 Code's own
environments, in `src/t3.ts`. It does not bring back a goblin-side
machine registry.

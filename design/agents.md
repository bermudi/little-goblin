# Agents — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Ruling (operator, 2026-11-16)

"I need real subagents, like the ones you have in `claude`." Goblin hands
work to other agents through **two tools with two jobs**, in the standard
shape that Claude Code, hermes and openclaw share. This ruling replaced
the purpose-typed Pi Durable runtime (removed in #609 — its desktop-pool
rulings live under "Computer use" below). `delegate` runs on pinned
herdr-core (`hc`) per the operator's direction on 2026-11-18 and the
implementation rulings recorded in `design/delegation.md`. Handover and
responsibility stay on T3 Code. The removed Goblin-side `herdr` tool does
not return; it controlled the operator's desk, not delegated runs.

| Tool | Job | Who decides | Runs on |
|---|---|---|---|
| `agent` | Give a piece of work to a child agent | Goblin, on its own judgment | Goblin's own runtime, as a child conversation |
| `delegate` | Run a named external harness (codex, opencode, claude, pi, devin) | The operator only | A named terminal on Goblin's private hc core |

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
- This is the in-turn reader for documents too long for the parent's
  context. `read_long` (#583, a tool-less helper call per 150k-char
  part) was removed in #666: it was written against the old async-only
  subagents, duplicated this verb once #638 landed, and added an
  unbounded spend path. Don't add a second in-turn reader.

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

- Pi Durable drove models through pi-ai, which has its own provider
  layer. It supported only z.ai GLM. The claude-code engine is an Agent
  SDK step, not an HTTP model, so pi-ai cannot drive it. A bridge would
  mean a pi-ai provider for every goblin provider, maintained for ever.
- A child conversation reuses everything the runtime already has. The
  new code is the tool, the agent-type loader, the parent link and the
  settlement hook.
- What went with the runtime (removed in #609): mid-run crash resume,
  replay marks and the crash-approval gate. Children get the same crash
  rule as goblin's own turns.

## `delegate`: external harness runs on hc

### Only when the operator asks

`delegate` runs a harness that the operator names: "have codex do X",
"an opencode run" — the operator's direction (2026-11-18) says to make
the required binary available and install the right hooks at execution.
The operator can also ask with a standing
instruction, for example the issue-build flow that starts a lead
(design/delegation.md → An issue build is one lead delegation). Goblin
never chooses `delegate` on its own judgment. Work goblin decides to
hand off goes to `agent`.

### Transport: pinned herdr-core (`hc`)

`src/hc.ts` owns the JSON-RPC socket contract; domain modules use the
adapter. Goblin verifies and installs the pinned binary, then starts one
home-hashed core session outside the service cgroup. Its state remains in
`~/.local/state/herdr-core/<session>/`; Goblin does not set
`XDG_STATE_HOME`. The core and its terminals survive Goblin restarts.
`src/hc.live.test.ts` is the gated wire check and uses only a throwaway
session.

- **Harnesses stay config** as `{kind, args?, askFirst?}` plus
  `delegation.defaults`. The retired T3 shape is rejected at boot with a
  fix-naming message. Goblin never guesses a model.
- **Hooks report lifecycle through OSC 7501.** Shared assets are copied
  durably to `$GOBLIN_HOME/bin/hc-hooks/`; hooks only report when
  `GOBLIN_HC_RUN=1`. Codex hooks and trust hashes merge additively into
  the operator's CODEX_HOME. Claude uses per-run settings; Pi an
  extension; Devin a per-run config. Codex runs with `--no-daemon` and
  OpenCode with `--standalone`: a shared app server or background service
  runs outside the hc terminal, so its hooks could not reach it. Codex
  also gets `-c check_for_update_on_startup=false`: its update prompt
  draws before any hook, so start timed out on it (verify r1,
  2026-11-19); the override is per run, never written to CODEX_HOME.
  OpenCode
  v2 reports from a TUI plugin (`deploy/hc-hooks/tui.js`, loaded through
  `OPENCODE_CLI_CONFIG_CONTENT`); its server plugin path cannot tell
  which terminal a session belongs to (herdr's v2 integration, 2026-11-19).
  The TUI has no model flag and `opencode mini` loads no plugins, so it
  never reports a status (probe, 2026-11-19, #742). A harness's
  `--model`/`-m` in `args` therefore moves into that same per-run config
  as `model`; goblin still never picks one.
- **Verbs:** start waits for the first status before sending the prompt;
  send waits for `working`; the watcher polls status until settlement;
  answer sends a key only after a live `blocked` preflight; stop kills
  the terminal. The operator can inspect the terminal through hc or the
  app's Delegations page.

## Handover: T3 Code threads

Handover and responsibility stay on T3 Code — "to communicate with
inner loop. that's it." (operator, 2026-11-18). "Take over this" binds a
responsibility to T3 thread ids:

- discovery is `t3 thread list`;
- the responsibility observer polls `t3 thread show`;
- a managed send is `t3 thread send`. A busy thread queues the message
  as its next turn; nothing is interrupted.

The Goblin-side `herdr` tool for the operator's own desk remains removed.
The operator's desk is T3 Code; Goblin's delegated runs use its private hc
core.

## Computer use: a `computer` agent type (operator, 2026-11-16)

Computer use moved onto `agent` in #605. It is a built-in agent type,
`computer`, whose tools are the desktop tools. The desktop pool stays as
it is — a managed pool with no agent-runtime code in it (`desktops*.ts`,
cua-driver).

- **Tools:** `inspect` (the AT-SPI element tree as text), `act` (cua
  input, bound to an observation id), `launch`, `screenshot`, and
  `ask_operator` (needs input). They are goblin tools in zod, ported from
  the retired Pi Durable tool set.
- **Lease:** `spawn` claims the named desktop with the child
  conversation as the lease holder (`LeaseHolder` kind `conversation`).
  Settlement releases it. Needs input releases it so the operator can
  act, as before.
- **Crash rule:** goblin's own rule. An `act` cut by a crash is
  reported, not replayed. Binding input to the latest observation (a
  stale or restarted frame's id is refused) stays in `desktops.ts`.
  The crash-approval gate was not ported.
- **Text first.** `inspect` + `act` by element need no images and work
  on any model. That ships first.
- **Screenshots second — built (#606).** `ToolOutput` gained a
  `content` variant (text plus image parts; `src/tool.ts`), probe-verified
  per pipe — the ruling and evidence table live in design/tools.md:
  openrouter and the claude-code MCP bridge carry image tool results,
  codex and openai-compatible do not. A provider that cannot carry it
  gets no screenshot tool. The tool's durable output is a small JSON
  descriptor (observation id, PNG path, byte count); `toModelOutput`
  re-reads the PNG at view time, so stored events, projections and
  window captures never hold image bytes. Old frames become text stubs:
  a between-turn sweep (`src/frame-stubs.ts`) commits a pruning-marker
  projection for every frame but the newest, and `prepareStep` stubs
  superseded frames in the outbound request view, so a frame does not
  ride every later request.
- **Model:** the operator chooses it in the type file. `screenshot`
  mounts only when the child's model lists image input (models.dev
  catalog — a cold catalog keeps it absent) AND the provider pipe
  carries image tool results (`carriesMedia`'s tool-result position).

### The desktop pool (rulings carried over from the retired runtime)

A desktop is a named, long-lived resource, not a property of a
conversation (operator ruling): **allocate, claim, share, reserve,
release.**

- **Allocate** — `desktop new <name>` creates a container from the
  desktop image; row-vs-engine reconcile on every call follows the
  sandboxes.ts rule.
- **Claim** — one controller lease; holders are an agent child
  conversation, a goblin conversation, the operator. **One controller at
  a time** (Cua's and Eliza's single-controller rule): two input sources
  on one screen act on frames the other just invalidated. Every input
  action renews the lease; an expired lease is claimable, so a dead
  holder can't pin a desktop.
- **Share** — anyone may observe (screenshots now, a live view later);
  only the lease holder sends input.
- **Reserve** — pinned against idle reaping (a desktop already logged
  into something).
- **Release / hand off** — e.g. child → operator for a CAPTCHA → child.
- **Reaping** at call time like the sandbox — never at boot, never
  shutdown: unleased, unreserved desktops idle beyond `idleHours` are
  removed, logged; a concurrent claim, observation or pin wins the race.
  `desktops.max` caps the pool (g7 has ~13 GB free; a desktop idles at
  ~281 MB with Chromium open, measured).
- **Audit-frame retention** (ruling): screenshots are bounded per desktop
  and pruned by the sweep — the caller's on every call, a reaped
  desktop's at removal. Destroy freezes the remaining trail on purpose: the audit
  exists for the post-mortem, not for space reclamation.

**The wall.** Desktops reuse the sandbox wall (design/sandbox.md → What
the wall is) — **network off by default with a live toggle** (operator
ruling), files cross only by import/export with the sandbox's
containment rules. Differences: PID 1 is the desktop session script
instead of a sleep, and desktops append `CAP_SYS_CHROOT` to the
five-cap wall (see below) — sandboxes keep exactly the five.

krun (podman `--runtime krun`, a KVM microVM per container) was the
preferred boundary, measured on g7 (crun 1.30.1 +LIBKRUN): a real VM
(guest kernel 6.12.109 vs host 7.2.9) where the desktop runs and xdotool
works — but **`podman exec` is unavailable** (`the handler does not
support exec`) and crun exposes no host→guest channel, while every goblin
interaction model rides exec. Sandbox argv is inert inside the guest (PID
1 is real root, all caps); `--memory` sizes the VM, `--cpus`/`--pids-limit`
are ignored (`krun.cpus`/`krun.ram_mib` annotations work); egress rides
TSI through host sockets; `isolate=strict` is not a datapath rule there,
though reachability measured identical to runc's bridge and live
connect/disconnect works. Cost: ~850 MB vs ~281 MB under runc.

**Ruled: runc for v1; krun parked with its blocker named.** Revisit when
an in-guest control channel independent of the network toggle exists (a
vsock→unix mapping in crun, or a guest agent design), or when a workload —
logged-in personal accounts, hostile downloads — makes the kernel
boundary worth that work.

Known limit, resolved by an extra desktop cap: Chromium's zygote needs
`CAP_SYS_CHROOT` to bring up its layer-1 sandbox (measured: under the
five-cap wall the inner child dies `SIGSEGV` after namespace setup and the
browser aborts `Failed to receive hello message from zygote`; SYS_CHROOT
alone recovers it). Desktops therefore create with
`extraCaps: ["SYS_CHROOT"]` on top of the five-cap wall — operator ruling,
desktops only; sandboxes keep exactly the five — and Chromium runs its
real renderer sandbox as the non-root `desk` user. Verified live: `CapEff
0x400cb` inside the desktop and `chrome://sandbox` read back through the
AT-SPI tree (`GOBLIN_DESKTOP_LIVE=1`).

**The desktop image** (`deploy/desktop/Containerfile`, Debian
trixie-slim) carries its X stack and **cua-driver** (trycua/cua, MIT;
official linux-x86_64 binary, version + sha256 pinned in the
Containerfile). Probe-verified at cua-driver 0.34.1 under runc:

- Element tokens are session-scoped — every call carries the lease's
  session label.
- Chromium's AT-SPI tree appears with `--force-renderer-accessibility` and
  a session bus (52 elements; input and button frames match the
  screenshot). Click by element verified independently.
- Honest outcomes, verbatim: `"effect":"unverifiable"` on dispatch,
  `"effect":"none"` on refusal, `stale_element_token` after a reload — a
  clean refusal, never a blind click. Chromium takes keys only with
  `delivery_mode:"foreground"` on X11; `set_value` on a web entry is
  refused.
- xdotool + scrot stay as the coordinate fallback (E2B's primitive set,
  verified in the same probe).
- **`goblin-launch` pins the desk identity, not the environment.** Run as
  root it `setpriv`s to the fixed `desk` uid/gid before dispatching the
  app; other non-root callers are refused. The session env is fixed in the
  script — nothing a session user can write under `/run/desk` is
  evaluated, and no caller input steers the target identity.

Building the image is operator permission, like pulling one: goblin never
builds through a tool; a missing image errors with the exact build line.

**Observation binding.** Observation tools are safe to repeat; input is
**bound to the latest observation** (Eliza's mechanism): an input names
the screenshot id it acted on; a stale id is refused, and a repeat of an
identical action against an unchanged frame is refused. A container
restart invalidates the newest observation before `podman.start`, so a
dead frame's id can never dispatch input again; the restart note tells
the caller to observe fresh.

**Logging.** Every desktop lifecycle op, lease transition (claim, renew,
expire, release, handoff) and network toggle logs desktop, holder and
reason. A screenshot of a weird result plus goblin.log must say which
desktop, which lease holder, which frame the action was bound to, and
what the driver claimed happened.

**Out, explicitly.** Controlling the operator's own KDE Wayland session
(a separate design: portal RemoteDesktop/libei, per-session consent), a
live view in the app, logged-in tasks before login handoff exists, Cua
Spaces/SDK, E2B's runtime, Agent Zero's platform, Open Interface and LCU.

## Removal order

Each step keeps a working path (DIRECTION.md: do not retire useful
access before there is a working replacement).

1. Remove the `herdr` tool. The operator does not use the desk any more.
2. Build `agent`: child conversations, agent types and the parent link.
3. Build the `computer` agent type, text first.
4. Add image tool results and the `screenshot` tool — **done (#606)**.
5. Build the `src/t3.ts` adapter. Move `delegate` and responsibility
   attach/observe onto it, and prove one delegation end to end.
6. Replace the T3 Code delegation transport with pinned hc — **#728**:
   `src/hc.ts` owns the wire; the Goblin installer owns the binary and
   stable hook assets; the private core survives app restarts. The
   operator-desk `herdr` tool remains removed.
7. Delete the `subagent` tool, `src/subagents/`, the `subagent_runs`
   table's code paths and the pi-durable, pi-ai and chord dependencies —
   **done (#609)**: the runtime, its tool and tests are gone, the
   `subagents` config block is a loud boot error naming `agent` + the
   `computer` type, and `desktops` moved to a top-level block. The
   `subagent_runs` table stays in existing databases, unused — dropping
   data needs the operator's OK.

## Machine targets: dropped (2026-11-17, kept 2026-11-18)

Delegation runs on this machine only — under hc as under T3 Code.
`delegation.machines` and per-harness machine fields do not come back:
a config carrying the T3 shape (`{provider, model, options}`) or a
`machines` block is rejected at boot with a message naming the
`{kind, args}` fix. The live config on g7 has no `machines` block
(checked 2026-11-17).

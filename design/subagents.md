# Subagents & computer use — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Subagents & computer use (ruling 2026-10-11)

Operator ask: "computer use" — eyes and hands on a desktop — without
replacing goblin or making the conversation wait on clicks. Classified
**machinery** (DESIGN.md → Non-goals): a **subagent runtime** with two
purposes — **computer use** over a **desktop pool**, **worker** runs in
the conversation's sandbox.

**Routing (operator ruling).** Project work goes through herdr — his
agents, his repos (design/delegation.md). Standalone long or code-heavy
work goes to a worker subagent; anything needing a screen to a computer
subagent. Goblin's own turn stays for chat and short work.

### Why not the obvious seams

- **Not goblin's own turn.** The daily driver (`zai/glm-5.3`) is text-only
  (models.dev: input `["text"]`), so a computer loop costs a `vision`
  round trip per frame and a 50-step GUI task holds the lane for minutes.
  The pipe can carry tool-result images — whether z.ai's server parses
  `input_image` inside `function_call_output` is unprobed.
- **Not herdr.** Delegation is goblin standing in for the operator with
  his harnesses, not a capability connector; a TUI's `idle|working`, seq
  counter and screen tail are cardboard and tape. **Computer use is never
  a delegation and never rides herdr.**
- **Not the AI SDK for the long loop.** Pi is the polished, widely used
  harness, trusted for long agentic runs; the `Why` section's exit from
  pi-ai governs goblin's _chat engine_, and a subagent runtime on pi-ai
  underneath does not reverse it.

### Subagent runtime: Pi Durable, in-process

`@earendil-works/pi-durable` (+ `pi-ai`, `chord`), **pinned exactly**
(newest release ≥7 days old), embedded in goblin's process —
probe-verified on g7 (2026-10-11, Bun 1.4.3):
- `openNodeSqliteStorage` runs under Bun as-is (`node:sqlite`); Pi Durable
  has no cross-process locking, so goblin owns its single storage file.
- **Crash resume** (kill -9 mid-tool and mid-stream): `replay: "safe"`
  tools re-enter on recovery, a cut-off model stream restarts cleanly, and
  boot calls `harness.resume()` — a goblin restart pauses runs, it does
  not kill them. Re-entry is only the _wrapper_: behind the mark, the
  crash-approval gate (below) decides from the durable lease whether a
  side-effecting call may run again.
- Concurrent conversations in one harness and `whenBusy: "steer"` both
  verified.

**Two recovery rules, deliberately.** Goblin's own turns keep
notify-don't-retry (the authority rule); subagent runs resume under Pi
Durable's semantics, made honest by the replay marks: observation repeats
safely, input never — an interrupted click is reported, not replayed
blind.

**Scope rules** (v1's generic + named agents, recursion, timeout-revive
and separate run store are retired):
- **Purpose-typed.** Two types, `computer` and `worker`: a type fixes its
  tools, execution environment, model and terminal outcomes in code. No
  generic "spawn an agent" tool, and **no type ever gets host bash** —
  delegation without the operator's harness.
- **No recursion, no chaining.** A subagent's tool set never starts
  another; a worker cannot start a computer run. Goblin orchestrates.
- **At most `maxRuns` running at once**, across types (operator ruling),
  because every type shares the operator's z.ai Coding Plan quota with
  goblin's chat; beyond it `start` queues the run and says so.
- **No timeout-and-revive.** Runs end by outcome, explicit stop or
  _exhausted retry budget_ — never on one infra hiccup; halt intents
  (stop, close, vanished row) are never retried.
- **Goblin starts them and owns the outcome.** Results return fenced (the
  delegation fence rule); reading arbitrary screens gains no authority by
  arriving in goblin's voice.
- **Only `src/subagents/` knows Pi Durable / pi-ai / chord** (the herdr.ts
  rule): an upstream API change touches one directory, and a gated live
  drift check pins the verbs goblin uses.

**Run state is rows.** Goblin's `subagent_runs` table holds routing while
Pi Durable holds transcripts; the task-scoped Pi lease stays the authority
on what may execute. Settled runs wake the origin through the
delegation-notice path. `/stop` fences goblin's turn, not runs — the
delegation precedent; a run ends with `subagent stop`.

**Models.** Config per type, never guessed (operator ruling): computer
`glm-5.3-flash` (vision), worker `glm-5.3` (text, code), both on z.ai's
Coding Plan URL (`openai-completions`). Measured: the operator's key is a
Coding Plan key — `paas/v4` answers `429 code 1113 Insufficient balance`;
the coding URL works. `glm-5.3-flash` cannot disable thinking (`400 code
1210`) — `thinking: "low"` minimum. The key resolves through goblin's
`auth.ts` in-process into Pi's `InMemoryCredentialStore` — never env,
argv, disk or log (probe-verified). Image transport verified: a marker
code read exactly from a tool-result image, 744 tokens for 640×400.

**Explicit constructor profile (experiment seam).** `SubagentsDeps` may
take per-kind model profiles substituting only the catalog entry; no
profile keeps the pinned GLM config unchanged, and the seam exists for
isolated experiment runners, not production configuration.

### Desktops: a managed pool

A desktop is a named, long-lived resource, not a property of a
conversation (operator ruling): **allocate, claim, share, reserve,
release.**
- **Allocate** — `desktop new <name>` creates a container from the
  desktop image; row-vs-engine reconcile on every call follows the
  sandboxes.ts rule.
- **Claim** — one controller lease; holders are a subagent run, a goblin
  conversation, the operator. **One controller at a time** (Cua's and
  Eliza's single-controller rule): two input sources on one screen act on
  frames the other just invalidated. Every input action renews the lease;
  an expired lease is claimable, so a dead holder can't pin a desktop.
- **Share** — anyone may observe (screenshots now, a live view later);
  only the lease holder sends input.
- **Reserve** — pinned against idle reaping (a desktop already logged
  into something).
- **Release / hand off** — e.g. run → operator for a CAPTCHA → run.
- **Reaping** at call time like the sandbox — never at boot, never
  shutdown: unleased, unreserved desktops idle beyond `idleHours` are
  removed, logged; a concurrent claim, observation or pin wins the race.
  `desktops.max` caps the pool (g7 has ~13 GB free; a desktop idles at
  ~281 MB with Chromium open, measured).
- **Audit-frame retention** (ruling): screenshots are bounded per desktop
  and pruned by the sweep — the caller's on every call, a reaped
  desktop's at removal. Destroy freezes the remaining trail on purpose: the audit
  exists for the post-mortem, not for space reclamation.

### The wall: runc now, krun parked

Desktops reuse the sandbox wall (design/sandbox.md → What the wall is) —
**network off by default with a live toggle** (operator ruling), files
cross only by import/export with the sandbox's containment rules.
Differences: PID 1 is the desktop session script instead of a sleep, and
desktops append `CAP_SYS_CHROOT` to the five-cap wall (see the resolved
Known limit below).

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

### Eyes and hands: cua-driver in the guest

The desktop image (`deploy/desktop/Containerfile`, Debian trixie-slim)
carries its X stack and **cua-driver** (trycua/cua, MIT; official
linux-x86_64 binary, version + sha256 pinned in the Containerfile). Probe-verified at cua-driver 0.34.1
under runc:
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

### The computer subagent

Its whole tool set is the desktop — **no bash, no host files, no network
of its own** — bound to one desktop and its lease:
- Observation is `replay: "safe"`; every frame also lands in the
  desktop's audit trail. Input is never replay-safe, and is **bound to
  the latest observation** (Eliza's mechanism): an input names the
  screenshot id it acted on; a stale id is refused, and a repeat of an
  identical action against an unchanged frame is refused. A container
  restart invalidates the newest observation before `podman.start`, so a
  dead frame's id can never dispatch input again; the restart note tells
  the caller to observe fresh.
- Terminal outcomes are tools, not inferred from prose: `finish` → done;
  `ask_operator` → needs_input (login, CAPTCHA, an ambiguous choice). The
  operator answers in the origin conversation; goblin steers the run.

Context growth is the harness's concern, not goblin's cache rule: the
subagent conversation is not a goblin conversation. Pi Durable's
compaction runs; whether old frames degrade to text stubs is decided from
phase-4 measurements (frames per task, tokens per frame), not now.

### The worker subagent

Pi Durable's coding tools over an execution environment backed by **the
origin conversation's sandbox** (operator ruling) — never the host. No
container-backed env exists upstream; goblin implements `ExecutionEnv`
over `sandboxes.ts` exec, so every command and file op inherits the
sandbox's wall, reconcile, logging and network state. Reads are
replay-safe; `bash`, `write` and `edit` are not.

**One sandbox, two users.** Serious work runs through the worker; goblin
still checks and reaches in with its own `sandbox` tool (operator ruling),
so the sandbox carries a run lease, not an exclusive lock:
- one worker run per conversation sandbox at a time — a second queues;
- goblin's `exec`, `import`, `export` and `network` keep working while a
  run holds it, and each result notes the run that holds the sandbox;
- goblin's `reset` is refused while a run holds it (it would destroy the
  run's state) — `subagent stop` first;
- idle reaping skips a sandbox whose run is `queued`, `running` or
  `needs_input`;
- a recreate (container gone) or restart-after-timeout during a run is
  reported to the run as a tool result, not hidden — its background
  processes died.

### Goblin's surface: `subagent` and `desktop`

In-process machinery is out of bash's reach, so these are native tools
(the browser stayed a skill because its CLI owns its lifecycle). `start`
returns at once — the turn ends, the conversation (and every other one)
keeps answering; the settle notice wakes it later.

### Config

Absent block = no tools, no harness opened; an absent type = that type is
off. Boot-frozen like `delegation` (the harness and its registry are
built once).

### Phase 3 as built

- **Queue eligibility.** The drain skips any queued row whose box is
  blocked (another active run on the same origin sandbox, or a desktop
  lease held elsewhere), so unrelated work never waits behind one
  conversation's second worker. A `needs_input` run frees its global slot
  but **retains its worker sandbox lease** (its files and processes are
  still the answer it waits on), while a computer `needs_input` releases
  the desktop controller lease so the operator can act.
- **Idempotent dual-store.** Terminal tools commit the outcome to the
  durable doc before returning: a settled submission with no doc outcome
  is `failed` — **plain prose is not completion** — and a second terminal
  call can never replace a recorded outcome. Replay marks do the crash
  work, deliberately NOT as an idempotency claim: re-entry lands in the
  crash-approval gate rather than replaying blind.
- **A claimed conversation never rolls back.** Once a Pi conversation id
  is recorded on a row, no failure may return that row to `queued`: it
  stays `running`, holds its lease and global slot, and rides the bounded
  recovery budget; a `failed` transition requires confirmed Pi
  cancellation — cancellation failure is safety-critical, never
  permission to release. A `stop` landing while cancellation confirmation
  awaits wins over the failure transition.
- **Goblin owns crash resolution, not outcome verification.** A
  crash-ambiguous side effect parks for a model-callable `subagent decide`
  verdict — a crash alone needs no human approval, and escalation is only
  for an actual operator judgment or an action already requiring
  permission. Every verdict requires concrete evidence (or an explicit
  statement it is unavailable) and reasoning; the owner stamps
  `decidedBy: "goblin"` and `outcome: "unverified"` — never
  caller-selectable. `done` is lifecycle completion, not verification of
  an interrupted effect: `record-result` supplies a labeled declaration
  without re-executing and is never presented as observed tool output or
  operator testimony, `authorize-retry` permits one further dispatch (not
  a claim the first attempt failed or succeeded), and `abandon` ends the
  run without claiming an outcome. Fresh observations are separate
  evidence, never promotion by verdict. The run keeps an append-only
  `crashDecisions` history that survives the pending mirror and the run's
  end. Legacy persisted decisions remain readable; absent
  provenance/evidence is explicitly unrecorded, never attributed to the
  operator.

  Every side-effecting tool (worker `write`/`edit`/`bash`, computer
  `act`/`launch`) runs behind a crash-approval gate keyed by a
  task-scoped Pi lease: an attempt commits before dispatch, the result
  after; a crash between them leaves the lease claimed and parks the run
  `needs_input` with a crash-resolution ask. `send` refuses a parked run;
  the decision commits to the lease before acting (a crash mid-decision
  re-asks), and a `done` lease replays its recorded result with zero
  dispatch. A declaration or refusal is an error result (`isError`, with
  a `crash_resolution_unverified` warning), never success-shaped — it
  reports an outcome no tool observed. Without that marking, every bash
  crash resolution logged pi-durable's broken-tool report (`Tool bash
  returned no structuredOutput`) to the host. `finish`, `ask_operator`
  and the observation tools stay ungated — the result/question machinery
  must never gate itself.
- **Only expected refusals become export errors.** Export and the final
  screenshot translate `DesktopError`, `SandboxError` and `PodmanError` —
  plus a box-files `{ error }` verdict — into persisted `exportErrors`;
  every other exception throws. No fabricated progress: a failed export
  leaves the run running and leased for the next scan's recovery.
- **Shutdown never delivers a retryable notice** — wakes check runtime
  admission before submission and the owner fences notices once closing
  begins.
- **A truncated screenshot is no screenshot.** A readback whose process
  result carries `truncated` or `outputCapped` is rejected before any
  durable write or observation mint — exit 0 and nonempty bytes don't
  redeem a partial frame.
- **Pinned.** `pi-durable`, `pi-ai` and `chord` exactly `1.3.0`,
  `typebox` `1.3.37`; the catalog metadata (context windows, thinking
  levels) is read from the pinned package, not re-declared.
- **Live check.** The credential resolves in-process (`loadAuthFile` /
  `AuthStore`, auth ref `zai`), so the only secret-adjacent value in the
  environment is an auth-file path, never a key.

### Logging

Every desktop lifecycle op, lease transition (claim, renew, expire,
release, handoff) and network toggle logs desktop, holder and reason;
every subagent run logs start, each tool call, model usage, resume and
settle outcome. A screenshot of a weird result plus goblin.log must say
which desktop, which lease holder, which frame the action was bound to,
and what the driver claimed happened.

### Out, explicitly

Controlling the operator's own KDE Wayland session (a separate design:
portal RemoteDesktop/libei, per-session consent), a live view in the app
(phase 5), logged-in tasks before login handoff exists, Cua Spaces/SDK,
E2B's runtime, Agent Zero's platform, Open Interface and LCU.

### Phases

Phases 4–5 remain: three real operator-chosen tasks, outcomes checked
independently of what the subagent claims, with frame/token measurements
settling the context policy; then live view + login handoff, krun
revisited.

## Owner decomposition (ruling 2026-10-17)

`openSubagents` reached 2,019 lines in five days — the
`openX`/`makeX` closure-factory idiom at its largest; this ruling fixes
its `// ----------` banner sections into the `src/subagents/` modules. The
pattern: `makeX(deps, ...narrowCallbacks)` returning `{ methods }` —
cross-unit calls are injected functions, and a unit never reaches back
into the owner scope. DESIGN.md owns the ~300-line bound;
`scripts/function-size-audit.ts` is the standing signal.

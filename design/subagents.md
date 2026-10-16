# Subagents & computer use — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Subagents & computer use (ruling 2026-10-11)

Operator ask: give goblin "computer use" — eyes and hands on a desktop —
without replacing goblin and without the conversation waiting on clicks.
Classified **machinery** (DESIGN.md → Non-goals): two systems return
together, designed here first — a **subagent runtime** with two
purposes, **computer use** over a **desktop pool** and **worker** runs in
the conversation's sandbox.

**Routing (operator ruling).** Work on the operator's projects goes
through herdr — his agents, his repos (design/delegation.md). Long or
code-heavy work that stands alone ("how does this GBA ROM compute XP?")
goes to a worker subagent. Anything that needs a screen goes to a
computer subagent. Goblin's own turn stays for chat and short work.

### Why not the obvious seams

- **Not goblin's own turn.** The daily driver (`zai/glm-5.3`) is text-only
  (models.dev: input `["text"]`) — a computer loop on it is a `vision`
  round trip per frame. A 50-step GUI task would also hold the lane for
  minutes, fill history with click noise and push compaction. The pipe is
  not the obstacle: the `responses` converter maps tool-result images to
  `input_image` inside `function_call_output` (`carriesMedia` says so);
  "no image bytes in results" is a tool-side rule (design/tools.md),
  and whether z.ai's server parses `input_image` there is unprobed.
- **Not herdr.** Delegation is goblin standing in for the operator with
  the operator's own harnesses — the operator at the keyboard, one level
  up. It is not a capability connector: a computer run observed through a
  TUI's `idle|working`, a seq counter and a screen tail is cardboard and
  tape. **Computer use is never a delegation and never rides herdr.**
- **Not the AI SDK for the long loop.** The operator trusts it for chat,
  not for long agentic runs; pi is the polished, widely used harness. The
  `Why` section's exit from pi-ai is about goblin's *chat engine*; a
  subagent runtime running on pi-ai underneath does not reverse it.

### Subagent runtime: Pi Durable, in-process

`@earendil-works/pi-durable` (+ `pi-ai`, `chord`), **pinned exactly**,
embedded in goblin's process. Probe-verified on g7 (2026-10-11, 1.0.2 —
the newest release ≥7 days old; Bun 1.4.3):

- `openNodeSqliteStorage` runs under Bun as-is (`node:sqlite`) — no
  facade. Storage is its own file, `state/subagents.sqlite`; one process
  owns it (Pi Durable has no cross-process locking), and that process is
  goblin.
- **Crash resume** (kill -9 mid-tool and mid-stream): a tool marked
  `replay: "safe"` is re-entered on recovery; a cut-off model stream
  restarts cleanly. Boot calls `harness.resume()`. A goblin restart
  pauses runs, it does not kill them. Re-entry is only the *wrapper* —
  for a side-effecting tool the crash-approval gate (below) stands
  behind the mark and decides from the durable lease whether the call
  may run again.
- Concurrent conversations in one harness and `whenBusy: "steer"` both
  verified.

**Two recovery rules, deliberately.** Goblin's own turns keep
notify-don't-retry (the authority rule). Subagent runs resume under Pi
Durable's semantics, made honest by the replay marks below: observation
is safe to repeat, input never is — an interrupted click is reported, not
replayed blind.

**Scope rules — what v1 got wrong** (V1-V2-MAP.md: generic + named
agents, recursion depth 3, 10-minute timeouts with revive, a separate run
store):

- **Purpose-typed.** A subagent type is code with a ruling here: its
  tools, its execution environment, its model, its terminal outcomes.
  Two types: `computer` and `worker`. No generic "spawn an agent" tool,
  and **no type ever gets host bash** — that is delegation without the
  operator's harness, v1's shape.
- **No recursion, no chaining.** A subagent's tool set never contains a
  way to start another; a worker cannot start a computer run. Goblin
  orchestrates.
- **At most `maxRuns` (3) running at once**, across types (operator
  ruling). Every type shares the operator's z.ai Coding Plan quota with
  goblin's chat, so the cap protects the bot's own responsiveness.
  Beyond it, `start` queues the run (`queued` status) and says so; the
  queue drains in start order as runs settle.
- **No timeout-and-revive.** Runs are durable; they end by outcome or
  by an explicit stop — or by an *exhausted retry budget*, never by a
  single infra hiccup: a transient failure during admission before a
  Pi conversation id is recorded (an import exec timeout, a cpIn
  error, a harness hiccup) re-queues the run with exponential backoff
  and retries the idempotent admission up to five times before
  settling `failed` with an origin notice; past a recorded
  conversation id there is no queued demotion — the failure rides the
  bounded recovery budget instead (ten scan attempts), and exhaustion
  settles `failed` only after the run's Pi work is confirmed aborted
  and idle, in the run's own lane. Halt intents (stop, close,
  vanished row) are never retried.
- **Goblin starts them and owns the outcome.** Results return to the
  origin conversation fenced (`<event source="subagent">`, the delegation
  fence rule) — a subagent that read arbitrary screens gains no authority
  by arriving in goblin's voice.
- **Only `src/subagents.ts` knows Pi Durable** (the herdr.ts rule). An API
  change is one module; a gated live drift check
  (`GOBLIN_SUBAGENTS_LIVE=1`) pins the verbs goblin uses.

**Run state is rows.** A `subagent_runs` table in goblin.sqlite: id,
type, origin conversation, box (desktop name or the sandbox), Pi
conversation id, task, status
(`queued|running|needs_input|done|failed|stopped`), created/finished,
plus a `pending_approval` mirror while a crash-ambiguous call waits on
a `decide` verdict. Pi
Durable's storage holds transcripts; goblin's row holds routing —
`pending_approval` included: it drives notices, `send` refusal and the
`awaiting_decision` summary flag, but the task-scoped Pi lease remains
the authority on what may execute. Settled
runs wake the origin conversation through `wake.ts`, the delegation-notice
path: `[subagent: #<id> <type> · <done|needs input|failed>]` plus the
fenced result, the exported file paths, and (computer) the final
screenshot path (goblin may `send_file` them).
`/stop` fences goblin's turn, not runs — the delegation precedent; a run
ends with `subagent stop`.

**Models.** Config per type, never guessed (operator ruling): computer
= `zai` `glm-5.3-flash` (vision), worker = `zai` `glm-5.3` (text,
code), both on `https://api.z.ai/api/coding/paas/v4`
(openai-completions). Measured: the operator's key is a Coding Plan key
— `paas/v4` answers `429 code 1113 Insufficient balance`; the coding URL
works. `glm-5.3-flash` cannot disable thinking (`400 code 1210`) —
`thinking: "low"` minimum. The key
resolves through goblin's `auth.ts` in-process into Pi's
`InMemoryCredentialStore` — never env, argv, disk or log (probe-verified).
Image transport verified: a marker code read exactly from a tool-result
image, 744 tokens for 640×400.

**Explicit constructor profile (experiment seam).** `SubagentsDeps` may
carry `modelProfiles?: Partial<Record<SubagentKind, SubagentModelProfile>>`
— a per-kind catalog entry validated by `subagentModelProfileSchema`
(strict: id, input modalities, reasoning, contextWindow ≥ maxTokens,
nonnegative cost, and a compat contract fixing `max_tokens` and denying
store/developer-role/reasoning-effort). A supplied profile must match the
configured `model.id`, admit the kind's required input (text for worker;
text+image for computer), and requires `model.thinking: "off"` — no
unverifiable effort mapping. Provider/baseUrl/credential still come from
the configured model block; the profile substitutes only the catalog
entry. Callers that pass no profile get the pinned GLM/native config
policy above, unchanged — this seam exists for isolated experiment
runners, not production configuration.

### Desktops: a managed pool

A desktop is a named, long-lived resource, not a property of a
conversation (operator ruling): **allocate, claim, share, reserve,
release.**

- **Allocate** — `desktop new <name>`: a container from the desktop
  image, a row in the `desktops` table (name PK, container, image,
  intended network state, reserved flag, lease holder + expiry,
  created/last-used ms). Reconcile row-vs-engine on every call, the
  sandboxes.ts rule (running used, stopped started + network re-applied,
  missing recreated and said so, labelled-without-row adopted).
- **Claim** — the controller lease. Holders: a subagent run, a goblin
  conversation, or the operator. **One controller at a time:** two input
  sources on one screen each act on a frame the other just invalidated
  (Cua's and Eliza's single-controller rule). Every input action renews
  the lease; an expired lease is claimable, so a dead holder can't pin a
  desktop.
- **Share** — anyone may observe (screenshots now, a live view later);
  only the lease holder sends input.
- **Reserve** — pinned against idle reaping (a desktop already logged
  into something).
- **Release / hand off** — e.g. run → operator for a CAPTCHA → run.
- **Reaping** at call time like the sandbox — never at boot, never
  shutdown: unleased, unreserved desktops idle beyond `idleHours` are
  removed, logged. The sweep lists stale rows globally, then joins the
  candidate's own lane and re-checks fresh idle/reservation/lease state
  immediately before removal — a concurrent claim, observation, or pin
  wins the race. The listing is synchronous in the caller's call (the
  caller's own desktop exempt) but the removals run on one detached,
  single-flight reaper chain: reaping desktop B never blocks acting on
  desktop A. `desktops.max` caps the pool (g7 has ~13 GB free; a
  desktop idles at ~281 MB with Chromium open, measured). The cap counts
  rows **plus pending allocations**: `allocate` claims its name in a
  pool-wide reservation set synchronously, before the first await of
  container creation, and releases it in `finally` — two parallel
  allocates can't both pass the check and double-create.
- **Audit-frame retention** (ruling): screenshots are bounded at the
  newest 200 PNGs per desktop under `state/desktops/<name>/shots/`,
  pruned by the sweep — the caller's dir every call, a reaped desktop's
  at removal. Destroy freezes the remaining trail on purpose: the audit
  exists for the post-mortem, not for space reclamation.

### The wall: runc now, krun parked

Desktops reuse the sandbox wall (design/sandbox.md → What the
wall is): pinned uid/gid map, no-new-privileges, no mounts,
`--pull=never`, the isolated network created-connected then disconnected,
**network off by default with a live toggle** (operator ruling). Files
cross only by import/export with the sandbox's containment rules. The
differences: the PID-1 command is the desktop session script instead of
a sleep, and desktops append `CAP_SYS_CHROOT` to the five-cap wall
(sandboxes keep exactly the five) — see the resolved Known limit below.

krun (podman `--runtime krun`, a KVM microVM per container) was the
preferred boundary and was measured on g7 (crun 1.30.1 +LIBKRUN):

- It is a real VM (guest kernel 6.12.109 vs host 7.2.9); the desktop runs
  and xdotool type/click verify inside it.
- **`podman exec` is unavailable** — `the handler does not support exec`
  — and crun's krun handler exposes no host→guest channel (its
  annotations: cpus, ram_mib, nested_virt, kernel, variant, gpu, tap,
  passt). Every goblin interaction model rides exec.
- The sandbox argv is accepted but inert inside the guest (PID 1 is real
  root, all caps); the VM is the wall. `--memory` sizes the VM;
  `--cpus`/`--pids-limit` are ignored (`krun.cpus`/`krun.ram_mib`
  annotations work). Egress rides TSI through host sockets —
  `isolate=strict` is not a datapath rule there, though reachability
  measured identical to runc's bridge and live connect/disconnect works.
- Cost: the desktop VMM sits at ~850 MB vs ~281 MB under runc.

**Ruled: runc for v1; krun parked with its blocker named.** Revisit when
an in-guest control channel independent of the network toggle exists
(a vsock→unix mapping in crun, or a guest agent design), or when a
workload — logged-in personal accounts, hostile downloads — makes the
kernel boundary worth that work. The backend stays one module, so the
swap is a module, not a registry.

Known limit, resolved by an extra desktop cap: Chromium's zygote needs
CAP_SYS_CHROOT to bring up its layer-1 sandbox (measured: under the
five-cap wall the inner child dies `SIGSEGV` after the namespace setup
and the browser aborts `Failed to receive hello message from zygote`;
SYS_CHROOT alone recovers it). Desktops therefore create with
`extraCaps: ["SYS_CHROOT"]` on top of the five-cap wall — operator
ruling, desktops only; sandboxes keep exactly the five — and Chromium
runs its real renderer sandbox as the non-root `desk` user. Verified
live: `CapEff 0x400cb` inside the desktop and `chrome://sandbox` read
back through the AT-SPI tree (`GOBLIN_DESKTOP_LIVE=1`).

### Eyes and hands: cua-driver in the guest

The desktop image (`deploy/desktop/Containerfile`, Debian trixie-slim;
package set borrowed from E2B Desktop's template, Apache-2.0) carries
Xvfb, XFCE, Chromium, xdotool, scrot, dbus + at-spi2, and
**cua-driver** (trycua/cua, MIT; official linux-x86_64 binary, version +
sha256 pinned in the Containerfile). Measured in the probe (cua-driver
0.34.1, runc):

- `cua-driver serve --socket` as a daemon started by the session script;
  calls are `podman exec <desktop> cua-driver call <tool> '<json>'
  --socket …`. Element tokens are session-scoped — every call carries the
  lease's session label.
- Chromium's AT-SPI tree appears with `--force-renderer-accessibility`
  and a session bus (52 elements; the input and button with frames that
  match the screenshot exactly). Click by element verified independently.
- Honest outcomes, verbatim: `"effect":"unverifiable"` on dispatch,
  `"effect":"none"` on refusal, `stale_element_token` after a reload — a
  clean refusal, never a blind click. Chromium takes keys only with
  `delivery_mode:"foreground"` on X11; `set_value` on a web entry is
  refused.
- xdotool + scrot stay in the image as the coordinate fallback (E2B's
  primitive set, verified in the same probe).
- **`goblin-launch` pins the desk identity, not the environment.** Run
  as root it `setpriv`s to the fixed `desk` uid/gid before dispatching
  the app; other non-root callers are refused. The session env
  (`HOME`, `DISPLAY`, `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`)
  is fixed in the script — nothing a session user can write under
  `/run/desk` is evaluated, and no caller input steers the target
  identity.

Building the image is operator permission, like pulling one: goblin never
builds through a tool; a missing image errors with the exact build line.

### The computer subagent

Its whole tool set is the desktop — **no bash, no host files, no network
of its own**. Bound to one desktop and its lease:

- Observation, `replay: "safe"`: `screenshot` (scrot → PNG → image
  content block; every frame also lands in
  `state/desktops/<name>/shots/` as the audit trail), `inspect`
  (`get_window_state`: tree + elements).
- Input, never replay-safe: `click`, `type`, `key`, `scroll`, `drag`,
  `launch`. **Bound to the latest observation** (Eliza's mechanism): an
  input names the screenshot id it acted on; a stale id is refused, and a
  repeat of an identical action against an unchanged frame is refused.
  cua-driver's `effect` field rides back verbatim. The id is
  `<name>:<shotSeq>:<uuid>` and the audit frame's basename carries the
  same uuid: a destroy + re-allocate inside one millisecond can neither
  replay the old id nor clobber its frame. For `screenshot`,
  `lastObsId` is written only after the PNG lands on disk — a
  screenshot id never points at a frame that wasn't written. And a
  container restart invalidates the newest observation BEFORE
  `podman.start`: the dead frame's id can never dispatch input again,
  so the restart note tells the caller to observe fresh.
- Terminal outcomes are tools, not inferred from prose: `finish(result)`
  → done; `ask_operator(question)` → needs_input (login, CAPTCHA, an
  ambiguous choice). The operator answers in the origin conversation;
  goblin steers the run.

Context growth is the harness's concern, not goblin's cache rule: the
subagent conversation is not a goblin conversation. Pi Durable's
compaction runs; whether old frames degrade to text stubs is decided from
phase-4 measurements (frames per task, tokens per frame), not now.

### The worker subagent

Pi Durable's coding tools (read, write, edit, bash) over an execution
environment backed by **the origin conversation's sandbox** (operator
ruling) — never the host. Pi Durable's `ExecutionEnv` is its
`FileSystem` (about twenty file operations) plus a `Shell`; goblin
implements it over `sandboxes.ts` exec, so every command and file op
inherits the sandbox's wall, reconcile, logging and network state. No
container-backed env exists upstream: this is goblin code, verified in
phase 3. File tools are replay-safe for reads only; `bash`, `write` and
`edit` are not.

**One sandbox, two users.** Serious work runs through the worker; goblin
still checks and reaches in with its own `sandbox` tool (operator
ruling). So the sandbox carries a run lease, not an exclusive lock:

- one worker run per conversation sandbox at a time — a second queues;
- goblin's `exec`, `import`, `export` and `network` keep working while a
  run holds it, and each result notes `run #<id> holds this sandbox`;
- goblin's `reset` is refused while a run holds it (it would destroy the
  run's state) — `subagent stop` first;
- idle reaping skips a sandbox whose run is `queued`, `running` or
  `needs_input`;
- a recreate (container gone) or restart-after-timeout during a run is
  reported to the run as a tool result, not hidden — its background
  processes died.

Terminal outcomes are tools, as for computer: `finish(result, files)`,
`ask_operator(question)`.

### Files in and out

Through the workspace, always, with the sandbox's existing rules
(design/sandbox.md → The tool): import only from a workspace path whose
realpath stays inside the workspace; export only regular files, streamed
through `cat`, written tmp + fsync + rename, 100 MiB cap. A host file
outside the workspace is copied in first — a deliberate act. Runs carry
the steps so nobody has to remember them:

Imports across all three consumers (sandbox tool, desktop tool, run
inboxes) read through `box-files.readImport`: containment and file kind
are checked on the opened FD, and only its bounded bytes are staged.
Cancellation propagates through worker staging copies; guest and host
stages are cleaned even when the destination script never dispatches.

- **In:** `start` takes `files: [workspace paths]`, imported to `/inbox`
  in the run's box before the first model call.
- **Out:** `finish(result, files: [box paths])` — on settle the owner
  exports each to `workspace/subagents/<run-id>/`; refusals (directory,
  symlink, over cap) are listed, not dropped. The notice names the
  paths; goblin reads, sends or hands them to the next run.
- **Box to box** (sandbox ↔ desktop): export → workspace → import.
  Nothing is shared between containers, by design.

### Goblin's surface: `subagent` and `desktop`

In-process machinery is out of bash's reach, so these are native tools
(the browser stayed a skill because its CLI owns its lifecycle). Mounted
when the `subagents` block exists (worker also needs the `sandbox`
block); flat schemas, per-action contracts inside `execute`:

- `subagent`: `start` (type, task, files; computer: the desktop — claims
  it), `list`, `status`, `send` (steer or answer), `stop`, `decide`
  (the crash-approval verdict on a parked run).
- `desktop`: `new`, `list`, `shot` (observe — the path goes to
  `send_file`), `claim`/`release`/`reserve`, `network`,
  `import`/`export`, `destroy`.

`start` returns at once — the turn ends, the conversation (and every
other one) keeps answering; the settle notice wakes it later.

### Config

```json5
subagents: {
  maxRuns: 3,
  worker: {   // needs the sandbox block
    model: {
      auth: "zai", // auth ref in auth.jsonl
      id: "glm-5.3",
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      api: "openai-completions",
      thinking: "high",
    },
  },
  computer: {
    model: {
      auth: "zai",
      id: "glm-5.3-flash",
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      api: "openai-completions",
      thinking: "low",
    },
  },
  desktops: {
    image: "localhost/goblin-desktop:1",
    max: 3,
    idleHours: 24, // 0 = never reap
    memory: "3g",
    cpus: 2,
    pids: 1024,
  },
}
```

Absent block = no tools, no harness opened; an absent type = that type
is off. Boot-frozen like `delegation` (the harness and its registry are
built once).

### Phase 3 as built

- **Queue eligibility.** `start` inserts a `queued` row and returns;
  a background drain admits rows FIFO, skipping any queued row whose
  box is blocked (another active run on the same origin sandbox, or a
  desktop lease held by someone else) so unrelated runnable work never
  waits behind one conversation's second worker. `maxRuns` counts
  actually executing/preparing runs; a `needs_input` run frees its
  global slot but **retains its worker sandbox lease** (the run's files
  and processes are still the answer it waits on), while a computer
  `needs_input` releases the desktop controller lease so the operator
  can act. `send` requeues the same Pi conversation and re-acquires
  before executing. A transient admission failure before a recorded
  Pi conversation id re-queues through the same drain: the retry
  delay rides the lease backoff map, a timer wakes the drain when it
  expires, and a persisted answer/steer intent survives the failed
  attempt untouched.
- **Idempotent dual-store.** Two stores advance one run:
  `subagent_runs` rows in goblin.sqlite (routing) and Pi Durable's own
  sqlite (transcripts + the typed run-state doc). The recipe: insert
  the row first; record the Pi conversation id **before** any model
  submission; submit with deterministic request ids
  (`subagent:<id>:input:<revision>`) so a crash-gap re-submit admits
  the same submission; terminal tools write the outcome into the
  durable doc via `api.commit` before returning, so settlement reads
  the doc — a settled submission with no doc outcome is `failed`
  (plain prose is not completion), and a second terminal call can
  never replace a recorded outcome. The failure reason names what
  actually happened: an `unanswered` settlement carries Pi's reason
  plus its detail verbatim (`model_error — 500 …`), and a "done"
  submission without a doc outcome is classified by the last
  assistant's recorded `stopReason` — `length` reports the output
  limit, another non-`stop` reason names itself, and a clean `stop`
  (or no recorded witness) gets the plain-prose wording. Replay marks do the crash work:
  reads/observation/`finish`/`ask_operator` are `replay:"safe"`
  (idempotent, no external effects); every input action and every
  sandbox mutation also carries the mark — deliberately, NOT as an
  idempotency claim: re-entry is the only door recovery offers, and it
  lands in the crash-approval gate, which parks the run for an operator
  decision rather than replaying blind. Boot:
  `harness.resume()` after all deps are bound, rows queued/running
  re-monitor and re-check their desktop holder; persisted `stopped`
  wins over any late settlement.
- **The doc's `inputRev` is the input a request consumed, never the
  newest admitted intent.** `beforeRequest` binds it inside one
  `harness.commit`: the generation task's request checkpoint names a
  transcript cutoff, and the newest admitted revision whose
  deterministic submission is placed at or below that cutoff is the
  consumed input. A queued or blocked steer binds nothing. Binding
  also clears a committed outcome whose rev differs from the consumed
  one — a stale outcome can neither abort the live request nor settle
  it — and a binding failure aborts the request loudly rather than
  guessing a revision. A steer refused by the desktop claim rolls
  `inputRev` back: the rev never reached Pi, no request id is reused,
  and the original monitor still owns settlement. Settlement accepts
  a doc outcome only when `outcome.rev` matches the row's current
  `inputRev`; on boot a stale outcome falls through to monitoring the
  latest submission.
- **A close landing mid-finalize leaves a recoverable row.**
  Finalization rechecks `closing || harnessClosed` at every boundary
  — after the doc snapshot, after the export loop (no new screenshot
  starts), after the final screenshot await, and before every terminal
  update — and returns with the row still `running`: the durable doc
  and every landed `exportProgress` record survive, no partial
  done/failed notice fires, the lease stays. The next boot's finalize
  resumes export where progress left off — landed files are never
  recopied — and settles once.
- **A claimed conversation never rolls back.** Once a Pi conversation
  id is recorded on a row, a submission may have landed — so no failure
  may return that row to `queued`: the row stays `running`, holds its
  worker/desktop lease and its global slot, and rides the bounded
  `recoveryPending` scan retry; the persisted intent (`inputIntent` /
  `inputRev`) survives untouched and `send` still rejects with
  persisted/retry wording. A `failed` transition is allowed only after
  Pi cancellation is confirmed — `harness.conversation()` lookup (a
  missing conversation is proof no work exists), then `conv.abort`
  with `{ background: true }` (joining background compaction too)
  and `conv.waitForIdle`. A closed harness or a failed lookup, abort
  or idle-join keeps the row running and owned; cancellation failure
  is safety-critical, never permission to release. And a `stop` that
  lands while cancellation confirmation awaits wins over the failure
  transition — the row settles `stopped`, not `failed`.
- **A crash-ambiguous side effect is operator-owned.** Every
  side-effecting tool (worker `write`/`edit`/`bash`, computer
  `act`/`launch`) executes behind a crash-approval gate keyed by a
  task-scoped Pi lease (`absent` → `claimed` → `decided` → `done`):
  the gate commits `claimed` with an attempt count before dispatch and
  `done` with the full result after. A crash between them leaves
  `claimed` — recovery re-enters the wrapper, the gate parks the row
  `needs_input` with a `pendingApproval` mirror (the lease stays the
  authority), wakes the origin with an approval ask naming the tool,
  call and attempts, and waits — freeing the global slot, holding no
  run lane. `send` refuses a parked run; only `subagent decide`
  resolves it: `record-result` feeds operator-supplied text as the
  call's output without re-executing, `authorize-retry` re-executes
  once under a raised attempt (a second kill re-asks), `abandon`
  records an aborted outcome and ends the run. The decision commits
  to the lease before acting — a crash mid-decision re-asks. A `done`
  lease replays its recorded result with zero dispatch: the
  result-committed-but-unsettled window needs no operator. A decided
  verdict may queue behind global capacity; the scheduler's admission
  releases it on BOTH paths — a live waiter or a stored decision —
  and attaches a settlement monitor either way unless one is already
  watching: a waiter registered by harness recovery (boot skips
  queued rows) has no monitor of its own, and releasing it unwatched
  would settle the Pi side unseen and leak the run's slot forever.
  `finish`,
  `ask_operator` and the observation tools stay ungated — the
  result/question machinery must never gate itself.
- **Only expected refusals become export errors.** Export and the
  final screenshot translate `DesktopError`, `SandboxError` and
  `PodmanError` — plus a box-files `{ error }` verdict — into
  persisted `exportErrors`; every other exception (host storage,
  EIO/EACCES, transport) throws. No fabricated progress, no notice,
  no terminal row: the run stays running and leased, and the next
  scan's recovery path finishes it once.
- **Boot cancellation precedes scheduling, including compaction.** Mark
  every terminal/pending-stop task through `abortTask` while Pi is still
  paused before calling conversation aborts, which enable scheduling.
  Cancellation must confirm background tasks too. Any failed boot
  cancellation refuses resume; startup closes the constructed owner
  before disabling the feature. A typed `DesktopLeaseError` is lost
  ownership; inspection/start/network errors instead retain the run and
  refuse boot resume, leaving recovery for a later successful startup.
  Request-guard snapshot and routing failures abort the request, not
  merely throw a hook exception that Pi would report and ignore. The
  same claim split rules a live run's next request: a typed
  `DesktopLeaseError` settles as lost ownership, while any other claim
  failure persists a continuation intent at a fresh revision and
  aborts the request — the consumed input's entry already lives in
  the transcript, so the intent is a goblin-voiced nudge, not a
  replayed operator message. The monitor's `inputIntent` preemption
  hands the run to the same bounded recovery budget instead of
  terminal-failing on one podman blip. The hook's run-lane wait is
  cancellation-aware: cancellation can hold the lane while joining
  the hook, without deadlocking or bypassing provisional steer writes.
- **Shutdown never delivers a retryable notice.** Wakes check runtime
  admission before history submission; the owner fences notices when
  closing begins. A stop completing during close retains `noticePending`
  for the next owner without storing the notice twice.
- **Finalization re-reads before every transition.** After any
  awaited boundary — the doc snapshot, each export iteration, the
  final screenshot, `lastAssistantStopReason` — the row is re-read
  before an ask/done/failed update; `stopRequested`, `stopped`,
  `closing` or a closed harness returns silently with no notice and
  no release. A stop racing a held read can't be answered by a stale
  question or failure.
- **Claim notes are caller evidence.** `claim` returns
  `Promise<DesktopRow & { note?: string }>` — reconcile warnings
  (recreated, adopted, restarted) ride the return value and are
  persisted by each subagents consumer onto the run's `lifecycleNote`
  before proceeding (respecting `stopRequested`), never onto the
  desktop row. The note reaches the operator through the run's
  diagnostic/final notice so the first screenshot after a recreate
  discloses the lost contents and lease. Settlement retains the note;
  completion notices and native status/list output include it inside
  the event fence even when the child model does not repeat it.
- **A truncated screenshot is no screenshot.** A screenshot readback
  whose process result carries `truncated` or `outputCapped` is
  rejected before any durable write or observation mint — exit 0 and
  nonempty bytes don't redeem a partial frame. No audit file, no
  `lastObsId`, no `shotSeq` advance; the error names the capped or
  truncated readback.
- **Pinned.** `@earendil-works/pi-durable`, `pi-ai`, `chord` at
  exactly `1.0.2`, `typebox` at `1.3.27` — exact versions in
  package.json; the catalog metadata (context windows, thinking
  levels) is read from the pinned package, not re-declared.
- **Live check.** `src/subagents.live.test.ts`, gated
  `GOBLIN_SUBAGENTS_LIVE=1` + `GOBLIN_SUBAGENTS_AUTH_FILE=<auth.jsonl
  path>` — the credential resolves in-process through `loadAuthFile`/
  `AuthStore` (auth ref `zai`), so the only secret-adjacent value in
  the environment is a path, never a key: the real harness against
  real z.ai (worker `glm-5.3` thinking high, computer `glm-5.3-flash`
  thinking low), a real drift sandbox and a real drift desktop, using
  `SUBAGENT_DRIFT_INPUTS` from `src/subagent-prompts.ts` verbatim.
  Every candidate name — worker and ask sandboxes, desktops, both
  networks — carries a per-run token; the check preflights all of
  them before creating anything, refuses on collision, removes
  exactly what it created, and preserves its log/screenshot evidence
  under `/tmp/goblin-subdrift-<token>/` with a REPORT.md. Not part of
  `bun test`.
- **Local gates.** `src/subagents.podman.test.ts`
  (`GOBLIN_SUBAGENTS_PODMAN_LIVE=1`) runs the real harness against a
  localhost fake model in a real cached-alpine sandbox — read, write,
  edit, bash, inbox import and export verified through `catFile`, no
  external network — and SIGKILLs a spawned runner
  (`src/subagents-kill.driver.ts`) mid-bash inside that real
  container: reopening the same durable state reports the call
  interrupted and never re-dispatches it (a marker file proves the
  command ran once). `src/subagents.crash.test.ts` does the same over
  the in-memory env; it runs unconditionally, the podman gate needs
  only the cached image. The in-process suite also proves the
  non-blocking contract end to end (origin + sibling turns answer
  while a worker's model request is in flight, its settle notice
  lands once through `wakeConversation`), Pi's compaction through our
  `Harness.open` integration, and the four failure shapes (output
  limit, prose stop, provider error, dead stream) landing `failed`
  with distinct reasons. A `harnessSettings` dep exists only for
  those tests — shrinking Pi's compaction window or disabling retry
  backoff — production passes nothing and Pi's defaults hold.
- **Files.** `src/subagents.ts` (owner, env adapter, tools, queue,
  settle), `src/subagent-runs.ts` (rows), `src/box-files.ts`
  (import/export boundary), `src/agent/tools/subagent.ts` +
  `desktop.ts` (native tools), `wakeConversation` in `src/wake.ts`
  (exact-origin route), wiring in `src/index.ts`.

### Logging

Every desktop lifecycle op, lease transition (claim, renew, expire,
release, handoff) and network toggle logs desktop, holder and reason.
Every subagent run logs start, each tool call (action, screenshot id,
cua-driver `effect`, ms), model call usage, resume-after-restart, and its
settle outcome. A screenshot of a weird result plus goblin.log must say
which desktop, which lease holder, which frame the action was bound to,
and what the driver claimed happened.

### Out, explicitly

Controlling the operator's own KDE Wayland session (a separate design:
portal RemoteDesktop/libei, per-session consent), a live view in the app
(phase 5 — Pi Durable's `watch()` is the seam), logged-in tasks before
login handoff exists, Cua Spaces/SDK, E2B's runtime, Agent Zero's
platform, Open Interface and LCU.

### Phases

1. This ruling.
2. Desktop image, `desktops.ts` pool + podman create variant, the live
   wall check extended to a desktop; non-root Chromium probe.
3. `subagents.ts` (Pi Durable owner, boot resume, run cap + queue), the
   computer extension, the sandbox-backed worker env + sandbox run
   lease, the `subagent` and `desktop` tools, files in/out, settle →
   wake.
4. Three real operator-chosen tasks, outcomes checked independently of
   what the subagent claims; frame/token measurements settle the context
   policy.
5. Live view + login handoff; krun revisited.

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
  subagent runtime running on pi-ai underneath does not reverse it. The
  same distinction answers design/projects.md's rejection of Pi Durable
  as goblin's engine — that ruling stands for the turn loop and does not
  bind subagents.

### Subagent runtime: Pi Durable, in-process

`@earendil-works/pi-durable` (+ `pi-ai`, `chord`), **pinned exactly**,
embedded in goblin's process. Probe-verified on g7 (2026-10-11, 1.0.2 —
the newest release ≥7 days old; Bun 1.4.3):

- `openNodeSqliteStorage` runs under Bun as-is (`node:sqlite`) — no
  facade. Storage is its own file, `state/subagents.sqlite`; one process
  owns it (Pi Durable has no cross-process locking), and that process is
  goblin.
- **Crash resume** (kill -9 mid-tool and mid-stream): a tool marked
  `replay: "safe"` reruns transparently; an unmarked tool is not rerun —
  the model receives `[error] Tool poke was interrupted and may have
  partially run`; a cut-off model stream restarts cleanly. Boot calls
  `harness.resume()`. A goblin restart pauses runs, it does not kill
  them.
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
- **No timeout-and-revive.** Runs are durable; they end by outcome or by
  an explicit stop.
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
(`queued|running|needs_input|done|failed|stopped`), created/finished. Pi
Durable's storage holds transcripts; goblin's row holds routing. Settled
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
  removed, logged. `desktops.max` caps the pool (g7 has ~13 GB free; a
  desktop idles at ~281 MB with Chromium open, measured).

### The wall: runc now, krun parked

Desktops reuse the sandbox wall verbatim (design/sandbox.md → What the
wall is): pinned uid/gid map, five caps, no-new-privileges, no mounts,
`--pull=never`, the isolated network created-connected then disconnected,
**network off by default with a live toggle** (operator ruling). Files
cross only by import/export with the sandbox's containment rules. Only the
PID-1 command differs: the desktop session script instead of a sleep.

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

Known limit, accepted: Chromium runs as container root with
`--no-sandbox` (it refuses root otherwise, measured). A renderer exploit
lands as container root inside the wall. Phase 2 tries the session as a
non-root user to recover Chromium's own sandbox and records the result.

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
  cua-driver's `effect` field rides back verbatim.
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
  it), `list`, `status`, `send` (steer or answer), `stop`.
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

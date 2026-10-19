# Sandbox — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Sandbox (ruling 2026-10-10)

On demand. Machinery, designed here first. `bash` is goblin-as-daniel on
prod g7 — the box running goblin.service and the memory stack — so "install
it and see", "run this fetched code", "try the destructive path" were
operator questions. The sandbox is the middle rung between that and guest
mode's search-only wall: a disposable Linux container per conversation
behind its own `sandbox` tool, turning "ask the operator" into "just try
it" for work that doesn't need the host.

Borrowed mechanism, not scope: hermes' execution backend behind a tool
(`tools/environments/docker.py` — cap-drop, no-new-privileges, pids/cpu/
memory caps, label-scoped orphan reaping) and openclaw's
`workspaceAccess: "none"` default (`docs/gateway/sandboxing/`). Not taken:
hermes' seven backends, openclaw's mode/scope matrix, sandboxed browsers,
egress proxies, per-agent overrides. One backend — rootless podman, on the
box and operated for the memory stack. The seam is the module boundary
(`src/podman.ts` is the only podman-aware module, the `herdr.ts` rule); a
second backend replaces that module, it doesn't grow a registry.

### What the wall is — and isn't

A rootless container shares the host kernel: not a VM, not a hard boundary
against a kernel exploit — a wall against goblin doing something dumb and
ordinary untrusted code. Measured on g7 (2026-10-10, podman 6.1.3,
runc, cgroup v2 with cpu/memory/pids delegated):

- **Identity.** Stock rootless maps container root to host uid 1000
  (daniel); the sandbox pins `--uidmap 0:40000:8192 --gidmap 0:40000:8192`,
  so container root is host uid 139999 — outside daniel and the
  memory stack's in-use subuids (postgres 999 → host 100998). All sandboxes
  share that range; isolation between them is namespaces, not uids.
  Package installs (`apk add`) work under the capability set below.
- **Capabilities.** `--cap-drop ALL --cap-add
  CHOWN,DAC_OVERRIDE,FOWNER,SETUID,SETGID --security-opt
  no-new-privileges`. Never `--privileged`, never `--env-host` (the
  container env is the image's, so no daemon env or secret reaches it),
  never the podman socket. This is the sandbox wall — *desktops* append
  `SYS_CHROOT` via `CreateSpec.extraCaps` so Chromium can run its own
  sandbox (design/subagents.md); sandboxes get exactly the five.
- **Filesystem: nothing shared.** No bind mounts, no volumes, no workspace
  exposure — bind mounts were rejected on measurement (idmapped mounts fail
  under rootless runc, `:U` leaves host files owned by subuid 100000, and a
  shared directory lets sandboxed code plant a symlink (`→ ~/.ssh/...`) for
  a host-side tool to follow). Files cross explicitly — `import` and
  `export` below.
- **Network: off by default, a live toggle.** Each sandbox is created on
  the dedicated `goblin-sandbox` network (`--opt isolate=strict`, created
  lazily, its isolate option verified on use) and disconnected before its
  first command. Lazy creation converges a racing creator — inspect →
  create → on failure inspect again, accepting the network only if it now
  exists with `isolate=strict`, so parallel first-ensures share the
  winner. `podman network connect/disconnect` toggles it live —
  filesystem and processes survive the switch (measured). `--network none`
  was rejected: a container created with it can never be connected later.
  The isolated bridge cannot reach the memory network (10.89.0.2:5432
  measured shut). **Connected, it reaches what daniel's sockets reach
  minus host loopback**: the internet, the LAN gateway, host sshd via
  `host.containers.internal:22`, and every tailnet-IP listener — the embed
  relay (11435, unauthenticated ollama), `tailscale serve` for goblin's
  own HTTP (443/8788, whose API routes are auth-gated — docs/security.md).
  Host loopback services (goblin 127.0.0.1, ollama 11434) measured
  unreachable. Pasta has no destination filter; LAN/tailnet blocking needs
  root or an egress proxy. Known limit, accepted: the pattern for untrusted
  code is connect → download → disconnect → run.
- **Resources.** `--memory`, `--cpus`, `--pids-limit` from config. Disk is
  not capped (rootless overlay has no quota); idle reaping bounds it.
- **The wall is verified live, from inside the container (2026-10-11).**
  The argv seam's fakes pin what goblin *asks* podman for; only a real
  container proves what it *gets*. `src/podman.live.test.ts`
  (`GOBLIN_PODMAN_LIVE=1`) creates one `goblin-drift-wall` container
  through the adapter and reads the wall back from the kernel:
  `/proc/self/{uid,gid}_map` = `0 40000 8192`, `CapEff`/`CapBnd` = exactly
  the five added caps (`0xcb`), `NoNewPrivs` = 1, `inspect` mounts = `[]`,
  and a real disconnect to the network-off default. In-container `/proc` is
  the strong form; inspect maps just restate the argv. Store safety
  carries over: own name and network, a `goblin.drift` label (never
  `goblin.sandbox=1`, which the running service adopts), exact-name removal
  only, no prune. Run after any podman upgrade; red means the wall moved —
  re-probe, re-pin, never discover it in a live sandbox.

### Lifetime: one per conversation, kept until idle

- Created lazily on the conversation's first sandbox call; named
  `goblin-sbx-<first 16 hex of sha256(conversation id)>`, labelled
  `goblin.sandbox=1` and `goblin.conversation=<id>`. PID 1 is `--init` over
  a long sleep; commands are `podman exec`. Every lifecycle query and
  removal filters on the label or the exact name — never a prune, never an
  unlabelled container (the memory stack shares the store).
- **State is rows.** A `sandboxes` table in goblin.sqlite (additive
  schema): conversation id (PK), container name, image, intended network
  state, created/last-used ms. The row is intent; podman is truth, and
  every call reconciles the two: a running container is used; a stopped
  one (host reboot) is started and its network re-applied from the row; a
  missing one is recreated from the row and the result says prior state is
  gone; a labelled container with no row (row lost) is adopted from
  `podman inspect`.
- **Idle reaping, never at boot** (operator ruling: a goblin restart or
  reboot mid-experiment must not kill the work). Each sandbox call sweeps
  rows idle longer than `idleHours` — excluding the calling conversation —
  removing the container then the row, logged. `idleHours: 0` never reaps.
  No ticker, no boot hook, no shutdown hook: goblin restarts leave
  containers untouched; a host reboot stops them with their filesystems
  intact.
- **Disabling the block reaps nothing.** Remove or empty `sandbox` and
  the tool unmounts — no call ever runs the sweep again, and tracked
  containers (possibly network-on) would strand silently. Instead of
  sweeping on the transition (an experiment may still matter), the config
  save logs a warning naming each stranded container plus the manual
  `podman rm -f` line; cleanup is a deliberate operator act
  (docs/operations.md).
- **`reset`** destroys and recreates — optionally on another image —
  disconnected.

### The tool

`sandbox`, mounted only when the `sandbox` config block exists (live-read
per turn, the vision/search gate). `bash`'s schema is untouched, so the
host tool's prefix bytes don't move when the sandbox is configured; the
new tool's appearance is the sanctioned config-change shift every gated
tool already makes. Flat schema, per-action contract enforced inside
`execute` (design/tools.md):

- `exec` — `command`, `timeout_ms` (bash's default and cap). Runs
  `/bin/sh -c` (alpine has no bash) in `/work`. Same bounded,
  tail-truncated output shape as `bash`, plus a note when the call created,
  started, or recreated the sandbox. On timeout, abort, or a stream
  output-cap the `podman exec` client is group-killed by `boundedRun` (the
  cap is a distinct `outputCapped` cause — a drain cutoff after exit is
  only `truncated`), but the client's death does not guarantee the guest
  command died — so the container is restarted (`-t 0`): background
  processes die, files stay, and the result's note names the real cause.
- `import` — `from` (host path, resolved under the workspace; its realpath
  must stay inside the workspace) → `to` (container path), via `podman
  cp`. The containment is the mechanical wall against copying host secrets
  into a networked sandbox by this path; moving something into the
  workspace first is a deliberate act. The shared `box-files.readImport`
  pins an open regular file, validates the FD's realpath inside the
  workspace and bounds its read before staging. Podman never reopens the
  caller's mutable workspace pathname.
- `export` — `from` (a regular file in the container) → `to` (relative
  path inside the workspace, default `sandbox-out/<basename>`). Bytes come
  out through `podman exec cat --` — file content only, never metadata, so
  a container symlink resolves inside the container and can't point a
  host write anywhere. Written tmp + fsync + rename; capped (100 MiB);
  non-regular files (directories, symlinks, devices) are refused outright
  rather than tarred — the safe subset ships, the tar path was never
  built. The destination is resolved once before the read (a bad path
  refuses early), then re-derived at write time by
  `box-files.writeExportBytes`, which pins the real parent to a directory
  FD (`O_DIRECTORY|O_NOFOLLOW`, verified against the realpath'd workspace
  via `/proc/self/fd/<fd>`) — a host path resolved before the container
  await is stale; an ancestor swapped for an outside symlink mid-read
  must not aim the write.
- `network` — `enabled: boolean`; connect/disconnect, row updated, state
  verified by inspect. Fail closed: a sandbox whose network state can't be
  confirmed off when off is intended is removed, not used — its row stays:
  it carries the image and intent the next call recreates from.
- `reset` — optional `image`. Destruction is gated on a successful
  replacement preflight: after the run-lease and ownership checks it
  verifies the target image is in the local store and the isolated network
  exists BEFORE removing the incumbent — an unavailable replacement never
  destroys the existing sandbox, its files or its row.

Cancellation: `import`, `export`, `network` and `reset` take the call's
abort signal and check it before the call, after the sweep and lane waits,
after each preflight read, and immediately before a mutation dispatches —
so a `/stop`'d call parked behind the lane never starts a
rm/create/connect/cp. A dispatched mutation's reconciliation finishes
anyway (a begun `rm` still gets its recreate and row; a begun
connect/disconnect its verifying inspect) — an abort never leaves a
half-reset or unverified state.

The description says what the model needs: not the host; root inside;
nothing here touches the operator's machine, files or services; network off
until enabled and, when on, reaching the operator's LAN/tailnet too; state
persists per conversation until reset or idle; files cross only by
import/export.

Guest personas never see it (`SANDBOX_TOOLS` in `src/tg/guest.ts` is an
allowlist — the name collision is historical: guest "sandbox" is a persona,
this is a container).

### Images: pulled only with operator permission

`--pull=never`, always. The configured image (default
`docker.io/library/alpine:latest`) and any `reset` image must already be in
the store; a missing image errors with the exact `podman pull` line for the
operator. Pulling is the permission — goblin never pulls through this tool.
Image refs are validated at the boundary (no leading `-`, a conservative
character set) so a ref can never become a podman flag.

### Config

```json5
sandbox: {
  image: "docker.io/library/alpine:latest", // default
  idleHours: 24,   // 0 = never reap
  memory: "2g",
  cpus: 2,
  pids: 512,
}
```

Absent or `""` = no tool. A hand edit in v1; the mini app round-trips the
block untouched. A settings row arrives when the operator asks for one.

### Logging

Every podman invocation logs op, container, conversation, exit code and
duration; lifecycle transitions (created, started, recreated, adopted,
network on/off, restarted-after-timeout, reaped, reset) log with the
reason. A screenshot of a weird sandbox result plus goblin.log must say
which container ran it, with what network state, and why it was in that
state.

# Sandbox — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Sandbox (ruling 2026-10-10)

On demand. Machinery, designed here first. `bash` is goblin-as-daniel on
prod g7 — the box running goblin.service and the memory stack — so "install
it and see", "run this fetched code", "try the destructive path" were
operator questions. The sandbox is the middle rung between that and guest
mode's search-only wall: a disposable Linux container per conversation
behind its own tool, turning "ask the operator" into "just try it" for
work that doesn't need the host.

Borrowed mechanism, not scope: hermes' execution backend behind a tool
(`tools/environments/docker.py`) and openclaw's `workspaceAccess: "none"`
default (`docs/gateway/sandboxing/`). Not taken: hermes' seven backends,
openclaw's mode/scope matrix, sandboxed browsers, egress proxies,
per-agent overrides. One backend — rootless podman, on the box and
operated for the memory stack; a second backend replaces `src/podman.ts`,
it doesn't grow a registry.

### What the wall is — and isn't

A rootless container shares the host kernel: not a VM, not a hard boundary
against a kernel exploit — a wall against goblin doing something dumb and
ordinary untrusted code. Measured on g7 (2026-10-10, podman 6.1.3, runc,
cgroup v2 with cpu/memory/pids delegated):
- **Identity.** Stock rootless maps container root to host uid 1000
  (daniel); the sandbox pins a subuid range that puts container root at
  host uid 139999 — outside daniel and the memory stack's in-use subuids
  (postgres 999 → host 100998). All sandboxes share that range; isolation
  between them is namespaces, not uids. Package installs (`apk add`) work
  under the capability set.
- **Capabilities.** The five-cap set in `src/podman.ts` is the sandbox
  wall — never widened: never `--privileged`, never `--env-host` (the
  container env is the image's, so no daemon env or secret reaches it),
  never the podman socket. _Desktops_ append `SYS_CHROOT` so Chromium can
  run its own sandbox (design/subagents.md); sandboxes get exactly the
  five.
- **Filesystem: nothing shared.** No bind mounts, no volumes, no
  workspace exposure — bind mounts were rejected on measurement (idmapped
  mounts fail under rootless runc, `:U` leaves host files owned by subuid
  100000, and a shared directory lets sandboxed code plant a symlink
  (`→ ~/.ssh/...`) for a host-side tool to follow). Files cross
  explicitly — `import` and `export` below.
- **Network: off by default, a live toggle.** Each sandbox is created on
  its own isolated bridge and disconnected before its first command;
  `podman network connect/disconnect` toggles it live — filesystem and
  processes survive the switch (measured). `--network none` was rejected:
  a container created with it can never be connected later. The isolated
  bridge cannot reach the memory network (10.89.0.2:5432 measured shut).
  **Connected, it reaches what daniel's sockets reach minus host
  loopback**: the internet, the LAN gateway, host sshd via
  `host.containers.internal:22`, and every tailnet-IP listener — the
  embed relay (11435, unauthenticated ollama), `tailscale serve` for
  goblin's own HTTP (443/8788, whose API routes are auth-gated —
  docs/security.md). Host loopback services (goblin 127.0.0.1, ollama
  11434) measured unreachable. Pasta has no destination filter;
  LAN/tailnet blocking needs root or an egress proxy. Known limit,
  accepted: the pattern for untrusted code is connect → download →
  disconnect → run.
- **Resources.** Memory, CPU and pids are capped from config; disk is not
  (rootless overlay has no quota) — idle reaping bounds it.
- **The wall is verified live, from inside the container (2026-10-11).**
  The argv seam's fakes pin what goblin _asks_ podman for; only a real
  container proves what it _gets_. `src/podman.live.test.ts`
  (`GOBLIN_PODMAN_LIVE=1`) builds one real container through the adapter
  and reads the wall back from the kernel — in-container `/proc` is the
  strong form; inspect would only restate the argv. Run after any podman
  upgrade; red means the wall moved — re-probe, re-pin, never discover it
  in a live sandbox. Store safety: own name and network, a `goblin.drift`
  label (never `goblin.sandbox=1`, which the running service adopts),
  exact-name removal only, no prune.

### Lifetime: one per conversation, kept until idle

- One per conversation, created lazily; every lifecycle query and
  removal filters on the label or the exact name — never a prune, never
  an unlabelled container (the memory stack shares the store).
- **State is rows; the row is intent and podman is truth.** Every call
  reconciles the two, and the result's note never misrepresents what
  happened: a recreate says the prior contents are lost; an adopted
  container that happens to be network-attached says its network is ON —
  the model must never believe files survived or isolation holds when
  they don't.
- **Idle reaping, never at boot** (operator ruling: a goblin restart or
  reboot mid-experiment must not kill the work). The sweep rides sandbox
  calls, removing containers idle longer than `idleHours`;
  `idleHours: 0` never reaps. No ticker, no boot hook, no shutdown hook:
  goblin restarts leave containers untouched; a host reboot stops them
  with their filesystems intact.
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
per turn). A separate tool, not more `bash` actions, so the host tool's
prefix bytes don't move when the sandbox is configured — the new tool's
appearance is the sanctioned config-change shift.
- `exec` — `/bin/sh -c` (alpine has no bash). The `podman exec` client
  dying (timeout, abort, output cap) does not kill the in-container
  command, so the container is restarted: background processes die,
  files stay.
- `import` — the host path must resolve (realpath) inside the workspace.
  That containment is the mechanical wall against copying host secrets
  into a networked sandbox by this path; moving something into the
  workspace first is a deliberate act.
- `export` — regular container files only, bytes out through `podman
  exec cat --`: file content, never metadata, so a container symlink
  can't point a host write anywhere. Non-regular files are refused
  outright — the safe subset ships, the tar path was never built. The
  destination is re-derived at host-write time; a path resolved before
  the container await is stale, and an ancestor swapped mid-read must not
  aim the write.
- `network` — fail closed: a sandbox whose network state can't be
  confirmed off when off is intended is removed, not used — its row
  stays, carrying the image and intent the next call recreates from.
- `reset` — destruction is gated on a successful replacement preflight
  (the target image is in the local store, the isolated network exists)
  BEFORE removing the incumbent — an unavailable replacement never
  destroys the existing sandbox, its files or its row.

Cancellation: a `/stop`'d call never starts a rm/create/connect/cp, but a
dispatched mutation still reconciles to completion — an abort never
leaves a half-reset or unverified state.

### Images: pulled only with operator permission

`--pull=never`, always. The configured image and any `reset` image must
already be in the store; a missing image errors with the exact `podman
pull` line for the operator. Pulling is the permission — goblin never
pulls through this tool. Image refs are validated at the boundary so a
ref can never become a podman flag.

### Config

Hand-edited only; the mini app round-trips the block untouched. A
settings row arrives when the operator asks for one.

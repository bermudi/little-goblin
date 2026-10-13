# Sandbox — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Sandbox (ruling 2026-10-10)

On demand. Machinery, designed here first. `bash` is goblin-as-daniel on
prod g7 — the box that runs goblin.service and the memory stack — so
"install it and see", "run this fetched code", "try the destructive path"
were operator questions. The sandbox is the middle rung between that and
guest mode's search-only wall: a disposable Linux container per
conversation, reached through its own `sandbox` tool. It converts "ask the
operator" into "just try it" for work that doesn't need the host.

Borrowed mechanism, not scope: hermes' execution backend behind a tool
(`tools/environments/docker.py` — cap-drop, no-new-privileges, pids/cpu/
memory caps, label-scoped orphan reaping) and openclaw's
`workspaceAccess: "none"` default (`docs/gateway/sandboxing/`). Not taken:
hermes' seven backends, openclaw's mode/scope matrix, sandboxed browsers,
egress proxies, per-agent overrides. One backend — rootless podman, already
on the box and already operated for the memory stack. The seam is the
module boundary (`src/podman.ts` is the only podman-aware module, the
`herdr.ts` rule); a second backend replaces that module, it doesn't grow a
registry.

### What the wall is — and isn't

A rootless container shares the host kernel. It is not a VM and not a
hard boundary against a kernel exploit; it is a wall against goblin doing
something dumb and against ordinary untrusted code. Measured on g7
(2026-10-10, podman 6.1.3, runc, cgroup v2 with cpu/memory/pids
delegated):

- **Identity.** Stock rootless maps container root to host uid 1000
  (daniel). The sandbox pins `--uidmap 0:40000:8192 --gidmap 0:40000:8192`:
  container root is host uid 139999 — outside daniel and outside the
  memory stack's in-use subuids (postgres 999 → host 100998). All
  sandboxes share that range; isolation between them is namespaces, not
  uids. Package installs (`apk add`) work under the capability set below.
- **Capabilities.** `--cap-drop ALL --cap-add
  CHOWN,DAC_OVERRIDE,FOWNER,SETUID,SETGID --security-opt
  no-new-privileges`. Never `--privileged`, never `--env-host` (the
  container env is the image's, so no daemon env or secret reaches it),
  never the podman socket. This is the sandbox wall — *desktops*
  append `SYS_CHROOT` via `CreateSpec.extraCaps` so Chromium can run
  its own sandbox (design/subagents.md); sandboxes always get exactly
  the five.
- **Filesystem: nothing shared.** No bind mounts, no volumes, no workspace
  exposure. Bind mounts were rejected on measurement: idmapped mounts fail
  under rootless runc, `:U` leaves host files owned by subuid 100000, and
  any shared directory lets sandboxed code plant a symlink (`→
  ~/.ssh/...`) for a host-side tool to follow. Files cross explicitly —
  `import` and `export` below.
- **Network: off by default, a live toggle.** Each sandbox is created on
  the dedicated `goblin-sandbox` network (`--opt isolate=strict`, created
  lazily, its isolate option verified on use) and disconnected before its
  first command. Lazy creation converges on a racing creator: inspect →
  create → on failure inspect again, accepting the network only if it now
  exists with `isolate=strict` — two conversations first-ensuring in
  parallel share the winner instead of one losing to "already exists". `podman network connect/disconnect` toggles it live —
  filesystem and processes survive the switch (measured). `--network none`
  was rejected: a container created with it can never be connected later.
  The isolated bridge cannot reach the memory network (10.89.0.2:5432
  measured shut). **Connected, it reaches what daniel's sockets reach minus
  host loopback**: the internet, the LAN gateway, host sshd via
  `host.containers.internal:22`, and every tailnet-IP listener — the embed
  relay (11435, unauthenticated ollama), `tailscale serve` for goblin's own
  HTTP (443/8788, whose API routes are auth-gated — docs/security.md). Host
  loopback services (goblin 127.0.0.1, ollama 11434) measured unreachable.
  Pasta has no destination filter; LAN/tailnet blocking needs root or an
  egress proxy. Known limit, accepted: the pattern for untrusted code is
  connect → download → disconnect → run.
- **Resources.** `--memory`, `--cpus`, `--pids-limit` from config. Disk is
  not capped (rootless overlay has no quota); idle reaping bounds it.
- **The wall is verified live, from inside the container (2026-10-11).**
  The argv seam's fakes pin what goblin *asks* podman for; only a real
  container proves what it *gets*, and a podman upgrade that changed how a
  wall property lands would otherwise surface at the worst moment.
  `src/podman.live.test.ts` (`GOBLIN_PODMAN_LIVE=1`) creates one
  `goblin-drift-wall` container through the adapter and reads the wall
  back from the kernel: `/proc/self/{uid,gid}_map` = `0 40000 8192`,
  `CapEff`/`CapBnd` = exactly the five added caps (`0xcb`),
  `NoNewPrivs` = 1, `inspect` mounts = `[]`, and a real disconnect to the
  network-off default. In-container `/proc` is the strong form — inspect
  maps would just restate the argv. Store safety carries over: own name
  and network, a `goblin.drift` label (never `goblin.sandbox=1`, which the
  running service adopts), exact-name removal only, no prune. Run after
  any podman upgrade; red means the wall moved — re-probe, re-pin, never
  discover it in a live sandbox.

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
  tail-truncated output shape as `bash`, plus a note when the call
  created, started, or recreated the sandbox. On timeout, abort, or a
  stream output-cap the `podman exec` client is group-killed by
  `boundedRun` (the cap is a distinct `outputCapped` cause — a drain
  cutoff after exit is only `truncated`), but the client's death does
  not guarantee the guest command died — so the container is restarted
  (`-t 0`): background processes die, files stay, and the result's
  note names the real cause.
- `import` — `from` (host path, resolved under the workspace; its realpath
  must stay inside the workspace) → `to` (container path), via `podman
  cp`. The containment is the mechanical wall against copying host secrets
  into a networked sandbox by this path; moving something into the
  workspace first is a deliberate act.
- `export` — `from` (a regular file in the container) → `to` (relative
  path inside the workspace, default `sandbox-out/<basename>`). Bytes come
  out through `podman exec cat --` — file content only, never metadata, so
  a container symlink resolves inside the container and can't point a
  host write anywhere. Written tmp + fsync + rename; capped (100 MiB);
  non-regular files (directories, symlinks, devices) are refused outright
  rather than tarred — the safe subset ships, the tar path was never
  built.
- `network` — `enabled: boolean`; connect/disconnect, row updated, state
  verified by inspect. Fail closed: a sandbox whose network state can't be
  confirmed off when off is intended is removed, not used.
- `reset` — optional `image`.

The description says what the model needs: not the host; root inside;
nothing here touches the operator's machine, files or services; network
off until enabled and, when on, reaching the operator's LAN/tailnet too;
state persists per conversation until reset or idle; files cross only by
import/export.

Guest personas never see it (`SANDBOX_TOOLS` in `src/tg/guest.ts` is an
allowlist — the name collision is historical: guest "sandbox" is a
persona, this is a container).

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

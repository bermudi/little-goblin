# Sandbox — goblin design

For configuration and operation, see
[Configuration](../docs/configuration.md#sandbox) and
[Operations](../docs/operations.md).

## Sandbox (ruling 2026-10-10)

The sandbox is a disposable rootless container per conversation for work
that does not need the host. It is not a VM: it shares the host kernel and
is not a hard boundary against a kernel exploit.

Borrowed mechanisms, not scope: Hermes's execution backend behind a tool
and OpenClaw's default of no workspace access.

### What the wall is — and isn't

No workspace binds, volumes, host environment or Podman socket enter the
sandbox. On g7 (2026-10-10, Podman 6.1.3, runc), rootless idmapped mounts
failed, `:U` changed host ownership, and shared directories allowed
host-followed symlink attacks; explicit file transfer was chosen instead.
Sandbox capabilities must not be widened to privileged execution.

Network is off by default. When connected, it can reach the internet, LAN,
host SSH and tailnet listeners, including the unauthenticated embedding
relay; host loopback was unreachable in the g7 measurement on 2026-10-10.
Pasta provides no destination filter. For untrusted code, connect to
download, disconnect, then run. Memory, CPU and process counts are bounded;
disk has no rootless overlay quota.

The live Podman drift test reads the effective wall from inside a real
container, rather than only checking requested arguments. Run it after
Podman upgrades; see its safety rules in `src/podman.live.test.ts`.

### Lifetime: one per conversation, kept until idle

Restarts and reboots must not destroy an experiment. Disabling the sandbox
does not remove existing containers, including ones left network-connected;
the operator decides when to remove them. Reconciliation must report lost
contents and actual network state honestly.

### The tool

File imports are confined to the workspace. Exports and sandbox-sourced
artifacts accept regular files only; exports must not allow symlink or
directory swaps to redirect a host write outside the workspace.

If network-off cannot be confirmed, the container is removed rather than
used. Reset must establish that its replacement is available before
destroying the existing container. A dispatched mutation must reconcile
even after cancellation. A timed-out or aborted execution restarts the
container because stopping the client alone does not stop its command;
files survive but background processes do not.

### Images: pulled only with operator permission

Goblin never pulls sandbox images through the tool. The operator's image
pull is the permission boundary.

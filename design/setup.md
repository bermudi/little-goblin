# Setup

For installation and provisioning steps, see [Setup](../docs/setup.md).
For diagnosis, see [Doctor](doctor.md).

## Product shape

Fresh installation uses two bootstrap inputs, config and auth, plus a
non-interactive installer. There is no general wizard; the memory installer's
explicit model and cost prompts are a deliberate exception.

The installer refuses existing installed targets before service or asset
mutation. An update uses the approved release path; reinstall or repair
requires separate operator authority. Installation does not create
credentials, log in, unlock wallets, warm snapshots, silently migrate
keys, change a bank's embedding model or delete operator state.

Completion always requires the built app, and requires Telegram only when
it is enabled. Configured optional integrations need explicit readiness
results, not silent passes.

## Install order

Input and existing-target checks precede dependency and service mutation;
frozen dependencies precede dependency-using validation. Explicit operator
provisioning precedes preflight. Client assets are checked before units are
installed, then startup acceptance and installed-phase diagnosis follow.
The operator's real Telegram message and app conversation are the
end-to-end handshake.

Cancellation reclaims owned processes, but does not roll back accepted
systemd jobs, running services or files already written. Recovery requires
separate authority.

## Phase-dependent expectations

Preflight is start-ready inspection after provisioning, not a healthy
verdict for an untouched checkout. Expected first-boot absences are pending
or skipped, never a health pass. Optional configured dependencies can fail
feature readiness even if the core service is alive.

## Startup acceptance

Acceptance belongs to the specific attempted start. Old readiness messages,
service-active status or a different invocation cannot prove that start
succeeded. It checks the actual local app and assets as well as startup and
polling, and rejects a restart or invocation change during acceptance.
Local loopback proof is not public-proxy readiness.

Journal evidence is allowlisted and safe; arbitrary messages, exception
text, configuration and environments must not be dumped. Missing evidence
is unverified, not a pass. Neither startup acceptance nor Doctor proves
future provider access or delivery.

## Installer rules

Linger failure warns rather than blocking installation; linger does not
unlock a wallet. The service PATH, not the interactive PATH, determines
whether commands needed at runtime are available.

Boot may create home layout before config validation fails. Missing seed
files are created without overwriting operator or agent edits; real-file
collisions are reported.

The app asset handler's broad stat catch masks non-ENOENT errors as 404,
a known defect that shared checks must not copy.

## Opt-in dependencies

A seeded skill is not a provisioned capability. The installer does not
silently install optional services, tools or credentials. Public exposure
requires bearer auth by policy; detecting a public URL does not enforce it.
See [Setup](../docs/setup.md) for prerequisites.

## Verification boundary

Fake external processes prove ordering and failure behavior, not real
systemd, Telegram or provider readiness. Real fresh-install startup
acceptance remains unverified without a separately approved installation.

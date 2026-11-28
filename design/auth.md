# Auth — goblin design

The trust model is in [Security](../docs/security.md); credential setup is in
[Configuration](../docs/configuration.md). This document records the choices
behind those boundaries.

## Auth

The agent's bash tool inherits the process environment, so provider secrets
must not be placed there. Resolved values must not enter tool environments,
model context or logs.

### Naming discipline (2026-10-10)

Config refers to credential record names, not values. Derived names are
materialized so a provider rename cannot silently change its credential.
Keyless Jina is deliberately excluded from name derivation. A missing configured
record warns at boot and fails at use rather than preventing boot: configuring
before provisioning is legitimate.

### Proton Pass (2026-09-26)

Goblin uses its own narrowly granted agent, never the owner's Pass session.
Direct `pass-cli` auth records are rejected at use rather than blocking boot:
a phone-only operator may otherwise be unable to repair a crash loop.

Foreground credential reads use encrypted local snapshots only: no remote or
owner-session fallback. Failed refresh preserves the last good snapshot;
age alone does not expire it. Missing keys, inaccessible snapshots and locked
wallets fail loud. Linger does not unlock a wallet, and PAM auto-unlock is
not assumed. Successful resolutions are memoized until an approved restart.
Provisioning and refreshing credentials are operator actions, not diagnostic
side effects. See [Setup](../docs/setup.md) and
[Configuration](../docs/configuration.md).

Task secret access uses a separate scoped agent session; expired task auth
does not fall back to the owner or expose the bootstrap token.

The boundary is not same-user isolation: Goblin has full bash access as the
same user, and OS-store encryption cannot protect an unlocked wallet from
arbitrary same-user code. Local snapshot reads do not create remote audit
events. A failed sync can retain old keys; upstream rotation or revocation
is the authority change. Grant narrowly.

### Filling pages from Pass (operator, 2026-11-28, #1017)

The `pass_fill` tool fills one field of a web page in Goblin's own
agent-browser session from a Pass item and returns only that it filled;
the value never reaches the model, the chat or the provider. The value
path is pass-cli stdout → Goblin's memory → agent-browser stdin — never
argv, logs or the tool result. Before the field is read, the page's host
must equal or be a subdomain of one of the item's saved websites, over
https (loopback http allowed). The check reads the URL of the frame where
element commands run, so a main-frame snapshot ref pointing into an
embedded frame is checked against the main page, and a page that
navigates between the check and the fill is not caught. Accepted:
Goblin's shell can still read its granted items. Rejected: shell commands
(the model writes the command, and masking hides only the exact value) and
the operator typing it (needs #863).
An expired task session is renewed with `pass-keys login` before the read
(#1016); `pass.loginProfile` names the profile.

### ChatGPT device-code ownership

Cancellation and sign-out revoke a login attempt's authority, including
while responses are being read. A late response must not install credentials
or alter a successor attempt. Refresh must not resurrect a signed-out file
or overwrite a newer credential pair. Existing fallback credentials do not
make a failed pairing successful; the flow error remains visible.

Creating a provider after sign-in must not overwrite an operator-owned
provider or its model references.

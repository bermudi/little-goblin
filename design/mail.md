# Email — goblin design

See [Setup](../docs/setup.md) and [Operations](../docs/operations.md) for
provisioning and use.

## Email (Gmail) + Workspace via gws

### Read and send authority

Gmail read and send credentials are separate. Gmail's read-only scope is a
mechanical limit on the read path, not merely a prompt rule; Drive is also
read-only because deletes are unrecoverable. Calendar and Sheets have write
access because they have undo history. Do not add other write scopes without
the operator's approval.

Mail reads and watcher events are fenced as untrusted and scored for prompt
injection. Scoring fails open on outage, with the outage indicated; without
the gate, watcher events are unscored. A model with bash can call gws directly
and bypass the wrapper, so this is not a hard security boundary. Event text
sent for scoring reaches the scoring provider; mail bodies are not logged.

The mail tool requests a draft, never a send. Only an authorized operator's
approval can trigger a send through the separate send credential. This
protects against a tricked model, not hostile same-user code with full bash.
An app password was rejected because it would combine read and send
authority. A testing-mode Google OAuth app has seven-day refresh tokens;
the operator's send client must be in production mode.

### Uncertain outcomes

A timeout posting an approval does not prove it failed. Keep the draft
pending and never automatically repost; the operator checks Telegram before
requesting a replacement.

Send intent is recorded before the Gmail request (2026-10-31). A crash
after that point can leave the outcome unknown, including when Gmail
accepted the message. Never automatically resend or mark it unsent; the
operator checks Sent before abandoning the claim. Graceful shutdown waits
for in-flight sends, but power loss and forced termination remain possible.

### Watcher tradeoffs

A new, changed or expired filter starts at the current head: backlog is not
new mail, and mail in the gap may be late or missed. Delivery is at least
once across a crash between firing and checkpointing; consumers must
tolerate repeats. Disabling or deleting a program during scoring prevents
the pending submit.

Gmail search indexing can lag history. The watcher holds an unconfirmed
arrival for a bounded grace of about 50 subsequent history records
(2026-10-23); history IDs are not a distance measure. Residual loss is
accepted for arrivals that outlast the grace, fall outside a full search
page, or precede a later match already fired. The watcher warns when a
full page or oversized collapsed record can hide matches.

Push watch was rejected because Pub/Sub resources and recurring watch
renewals introduce a second system to operate.

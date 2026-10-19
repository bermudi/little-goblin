# Auth — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Auth

The trust model — assets, trust classes, entry points, failure policy, what
is deliberately out of scope — lives in [`docs/security.md`](../docs/security.md).
This section owns *why* the secret discipline looks the way it does; that doc
owns *who is trusted with what*. A change that widens trust belongs in both.

No secrets in env — the agent's `bash` tool inherits the process environment,
and env vars leak — and resolved values never enter the tool environment, the
model context, or logs.

### Naming discipline (2026-10-10)

Config blocks reference secrets by record *name* — a join key between
`goblin.json5` (shareable) and `auth.jsonl` (0600, the only place values
live). Names cannot be deleted from the config: two providers of one kind
with different keys, and one record serving many features, need the
indirection. But a typed, required name in every settings field restates what
the config already knows, so blank means "derive":

- **Search/fetch steps and `openrouter` providers default to the kind's own
  record name.** `jina` is deliberately outside the map: it works keyless, so
  blank must mean "no key", never a record named `jina`.
- **`openai-compatible`/`responses` providers have no derivable name** — the
  kind is a protocol, not a vendor — so blank materializes as the provider's
  own name at save.
- **Defaults materialize, they don't linger**: the config stays
  self-describing, and renaming a provider never re-points its credential.
- **The settings UI picks from real names, never values.** Names are not
  secret material, but they are boot-pinned like resolution itself: a record
  added to `auth.jsonl` mid-run appears only after the approved restart. A
  name missing from the list warns inline and never blocks a save —
  config-before-key is legitimate order.
- **Boot sweeps configured refs against record names (ruling 2026-10-17)**:
  a configured-but-missing credential surfaces at boot, not at first use.
  Existence only — values are never resolved — and warn-not-refuse: a missing
  record still fails loud at first actual use, like a poisoned one.

### Proton Pass (2026-09-26)

Proton Pass is the operator's credential backbone. Remote access uses a
scoped, audited **agent token of Goblin's own**; foreground provider/MCP
consumption reads encrypted local snapshots, not Pass. Rulings:

- **Goblin's own agent token** (`goblin-dev`, provisioned by the owner —
  Goblin never creates, renews, grants, or revokes agents). Grants are item by
  item, viewer; the audit trail is its own. The bootstrap PAT lives in the OS
  store under `goblin-dev`, not `$GOBLIN_HOME/pass-cli.env`, and handling is
  process-only: never print it, pass it in argv, or put it in model context.
  Profile names stay environment-scoped even on prod; prod/dev split by bot
  token and state home.
- **Never the owner session, by mechanism.** A `!` command invoking `pass-cli`
  directly is poisoned at load. Not a boot refusal: a phone-only operator
  cannot fix a crash loop, so the feature needing that key fails loud instead;
  install.sh refuses such records before enabling the unit. Sync uses only the
  scoped agent lane, no owner-session fallback.
- **Goblin's own keys resolve through pass-keys**: the refs-mode `goblin-dev`
  profile, ID-addressed. `get PROFILE NAME` is a pure local snapshot read —
  only the requested value reaches stdout, diagnostics go to stderr, and it
  never logs in, warms, or falls back to Pass/network. Successes are memoized
  for the process lifetime — so auth edits and rotated keys need an approved
  Goblin restart.
- **Encrypted local snapshots** live per profile in Secret Service/KWallet. A
  complete, successful sync replaces that profile's snapshot; failure leaves
  the last-good snapshot intact and usable offline. Age is information, not an
  expiry gate. Missing, invalid or inaccessible snapshots, missing keys, or a
  locked/unavailable wallet fail loud — no blank value, no remote fallback. A
  persistent wallet preserves snapshots across reboot if unlocked; PAM
  auto-unlock is not assumed or proven, and linger alone does not unlock a
  wallet.
- **Warmer** means explicit background sync, not a foreground cache check:
  `pass-keys warm PROFILE` always refreshes from Pass even when a snapshot is
  present. Foreground resolution must not wait for remote warm. Initial
  snapshots must be provisioned before relying on offline startup; installation
  and live credential migration are separate operator actions, not effects of
  editing these sources.
- **MCP keeps generic `run`**: it reads only the local snapshot, puts keys in
  the child environment and directly execs — no warming, no Pass contact, no
  proxying the child's output. Stdout belongs to the child; provider auth uses
  `get`, so no `printenv` child and no exported profile keys.
- **Secrets during tasks: the `pass-cli` skill.** Powers remain `pass-cli run`
  (masked output), `inject`, and `item totp`; never `item view`,
  `--no-masking`, or item/vault/agent writes. Tasks use a separate agent
  session; calls within one session never interleave. The operator
  provisions/refreshes this session from the OS-store bootstrap through a
  process-only helper. Missing or expired task auth fails loud: no PAT-file
  sourcing, no owner fallback, no exposing the bootstrap PAT via snapshot
  keys.
- **Honest boundary**: same uid, full bash — the token's grants are the real
  limit, and anything Goblin sees goes to its model provider. OS-store
  encryption protects stored secrets, not against arbitrary same-user code
  accessing an unlocked wallet; local reads add no remote audit event (the
  Pass audit records sync/task accesses). A failed sync can keep old keys
  available until a successful refresh; upstream revocation/rotation is the
  real authority change. Grant narrowly.

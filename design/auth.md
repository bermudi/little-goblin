# Auth — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Auth

The trust model — assets, trust classes, entry points, failure policy, and
what is deliberately out of scope — lives in [`docs/security.md`](../docs/security.md).
This section owns *why* the secret discipline looks the way it does; that doc
owns *who is trusted with what*. A change that widens trust belongs in both.

No secrets in env — the agent's `bash` tool inherits the process environment,
and env vars leak. Instead: `$GOBLIN_HOME/auth.jsonl`, mode `0600`, one record
per line:

```json
{"name": "openrouter", "value": "!pass-keys get goblin-dev OPENROUTER_API_KEY"}
```

A value is either a literal credential or `!<command>` — resolved by executing
the command and reading stdout, lazily at the point of use, in-process.
Resolved values never enter the tool environment, the model context, or logs.

### Naming discipline (2026-10-10)

Config blocks reference secrets by record *name* — a join key between
`goblin.json5` (UI-written, shareable) and `auth.jsonl` (0600, the only
place values live). Names cannot be deleted from the config: two
providers of one kind with different keys, and one record serving many
features (the `mimo` record keys both mimo transcription and mimo TTS),
need the indirection.
But a typed, required name in every settings field restates what the
config already knows, so blank means "derive":

- **Search/fetch steps and `openrouter` providers default to the kind's
  own record name** (`authDefaults` in `src/config.ts`, one source with
  the schema; served to both clients on the config GET). `jina` is
  deliberately outside the map — it works keyless, so blank must mean
  "no key", never a record named `jina`.
- **`openai-compatible`/`responses` providers have no derivable name** —
  the kind is a protocol, not a vendor — so both clients materialize a
  blank as the *provider's own name* (the convention the operator
  already followed by hand) at save time.
- **Defaults materialize, they don't linger**: `writeConfig` re-parses
  through the schema, so every save writes an explicit name into the
  file. The config stays self-describing, `check-auth`/operations docs
  need no derivation rules, and renaming a provider never re-points its
  credential.
- **The settings UI picks from real names**: the config GET carries
  `authNames` — the boot-loaded store's record names, bare and sorted,
  values never. Names are not secret material (`check-auth` already
  printed them), but they are boot-pinned like resolution itself: a
  record added to `auth.jsonl` mid-run appears after the approved
  restart. A name missing from the list warns inline and never blocks a
  save — config-before-key is legitimate order.
- **Boot sweeps configured refs against record names (ruling
  2026-10-17).** `missingAuthNames(config, has)` walks
  `authReferences(config)` — every auth-bearing config field, the
  doctor/installer's shared source — and warns once per absent record:
  a configured-but-missing credential surfaces at boot, not at first
  use of the feature. Existence only — secret values are never
  resolved by the sweep — and warn-not-refuse: a missing record still
  fails loud at first actual use, like a poisoned one. Sorted names,
  one warn each.

### Proton Pass (2026-09-26)

Proton Pass is the operator's credential backbone. Remote access uses a
scoped, audited **agent token of Goblin's own**; foreground provider/MCP
consumption reads encrypted local snapshots, not Pass. Rulings:

- **Goblin's own agent token** (`goblin-dev`, provisioned by the owner —
  Goblin never creates, renews, grants, or revokes agents). Grants are
  item by item, viewer; the audit trail (`agent monitor goblin-dev`) is
  its own. The bootstrap PAT lives in the OS store under `goblin-dev`,
  not `$GOBLIN_HOME/pass-cli.env`. Both `goblin-dev` and
  `goblin-mcp-dev` profiles share this dedicated agent, bootstrap
  identity and serialized sync session, but each has its own snapshot.
  Bootstrap handling is process-only: never print it, pass it in argv,
  or put it in model context. Profile names stay environment-scoped
  even on prod; prod/dev split by bot token and state home.
- **Never the owner session, by mechanism.** A `!` command that
  invokes `pass-cli` directly is poisoned at load: `log.error` names
  the record, and every `resolve` rejects without running it. Not a
  boot refusal: a phone-only operator cannot fix a crash loop, so the
  feature needing that key fails loud instead. install.sh refuses
  such records before enabling the unit. Sync uses only the scoped
  agent lane, with no owner-session fallback.
- **Goblin's own keys resolve through pass-keys** (`~/build/pass-keys`).
  The refs-mode `goblin-dev` profile is ID-addressed. A record reads
  `{"name": "openrouter", "value": "!pass-keys get goblin-dev OPENROUTER_API_KEY"}`.
  `get PROFILE NAME` is a pure local snapshot read: only the requested
  value reaches stdout; diagnostics go to stderr. It never logs in,
  warms, or falls back to Pass/network. `src/auth.ts` already supports
  these command refs and needs no change: its 15 s bound remains,
  successful resolutions are memoized for the process lifetime, and
  rejected resolutions retry on next use. Auth edits and rotated keys
  therefore require an approved Goblin restart.
- **Encrypted local snapshots** live per profile in Secret
  Service/KWallet, with the key set and last successful sync time.
  A complete, successful sync replaces that profile's snapshot;
  failure leaves the last-good snapshot intact and usable offline.
  Age is information (`pass-keys status PROFILE` reports age and local
  availability), not an expiry gate. Missing, invalid or inaccessible
  snapshots, missing keys, or a locked/unavailable wallet fail loud;
  no blank value and no remote fallback. A persistent wallet preserves
  snapshots across reboot if unlocked. PAM auto-unlock is not assumed
  or proven; linger alone does not unlock a wallet.
- **Warmer** means explicit background sync, not a foreground cache
  check: `pass-keys warm PROFILE` always refreshes from Pass even when
  a snapshot is present. `deploy/goblin-keys.service.in` renders one
  `warm` line per config-referenced auth record (the preflight-gated
  set, rendered by the installer from `scripts/install-options.ts`
  output — records fold last-wins by name first, so a shadowed pass
  record warms nothing) plus the MCP lane's pinned profile, sequentially, with
  restart-on-failure every 60 s; `.timer` runs at 06:30/18:30 and
  catches missed runs. `goblin.service` retains `Wants=` but has no
  `After=goblin-keys.service`: foreground resolution must not wait for
  remote warm. Initial snapshots must be provisioned before relying on
  offline startup. Installation and live credential migration are
  separate operator actions, not effects of editing these sources.
- **MCP keeps generic `run`**: `scripts/mcp` calls `pass-keys run
  goblin-mcp-dev -- …`. `run` reads only its local snapshot, puts keys
  in the child environment and directly execs the command. It does not
  warm, contact Pass, or proxy the child's output. Stdout belongs to
  the child; provider auth uses `get` so it need not create a
  `printenv` child or export the profile's keys.
- **Secrets during tasks: the `pass-cli` skill**, shipped like the
  browser's (`deploy/skills/pass-cli/SKILL.md`, seeded write-if-absent).
  Powers remain `pass-cli run` with `pass://` refs (masked output),
  `inject` to an explicit path, and `item totp` with a task reason.
  Never `item view`, `--no-masking`, or item/vault/agent writes. Tasks
  use the separate `$GOBLIN_HOME/state/pass-cli-task/` agent session;
  calls within one session never interleave with each other. The
  operator provisions/refreshes this session from the OS-store
  bootstrap through a process-only helper. Missing or expired task
  auth fails loud: no PAT-file sourcing or owner fallback, and no
  exposing the bootstrap PAT via snapshot keys.
- **Honest boundary**: same uid, full bash — the token's grants are
  the real limit, and anything Goblin sees goes to its model provider.
  OS-store encryption protects stored secrets, not against arbitrary
  same-user code accessing an unlocked wallet. Local reads add no
  remote audit event; the Pass audit records sync/task accesses. A
  failed sync can keep old keys available until a successful refresh;
  upstream revocation/rotation is the real authority change. Grant
  narrowly.


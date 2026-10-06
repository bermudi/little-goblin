# Auth — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Auth

The trust model — assets, trust classes, entry points, failure policy, and
what is deliberately out of scope — lives in [`docs/security.md`](docs/security.md).
This section owns *why* the secret discipline looks the way it does; that doc
owns *who is trusted with what*. A change that widens trust belongs in both.

No secrets in env — the agent's `bash` tool inherits the process environment,
and env vars leak. Instead: `$GOBLIN_HOME/auth.jsonl`, mode `0600`, one record
per line:

```json
{"name": "openrouter", "value": "!pass show api/openrouter"}
```

A value is either a literal credential or `!<command>` — resolved by executing
the command and reading stdout, lazily at the point of use, in-process.
Resolved values never enter the tool environment, the model context, or logs.

### Proton Pass (2026-09-26)

Proton Pass is the operator's credential backbone; goblin reaches it
only through a scoped, audited **agent token of its own**. Found at
design time: five of six `auth.jsonl` records ran `pass-cli item view`
with no session dir, which resolves to the owner's default session
(`~/.local/share/proton-pass-cli`, present on this box) — full
account, no audit trail. Rulings:

- **Goblin's own agent token** (`pass-cli agent create goblin`, an
  owner action — goblin never creates, renews, grants, or revokes
  agents). Grants are item by item, viewer; its audit trail
  (`agent monitor goblin`) is its own; revoking it touches nothing
  else. The PAT lives in `$GOBLIN_HOME/pass-cli.env`
  (`PROTON_PASS_PAT=…`, 0600, owner-written, never read into model
  context).
- **Never the owner session, by mechanism.** A `!` command that
  invokes `pass-cli` directly (records go through pass-keys, below) is
  poisoned at load: `log.error` names the record, and every `resolve`
  of it rejects with the same reason — the command never runs. Not a
  boot refusal: the unit restarts forever and a phone-only operator
  can't fix a crash loop, so the feature needing that key fails loud
  instead. install.sh refuses such records before enabling the unit.
- **Goblin's own keys resolve through pass-keys** — the one
  implementation of the Pass → agent lane → tmpfs cache discipline
  (retries, negative cache, herd collapse; `~/build/pass-keys`). A
  `goblin-dev` profile in refs mode, ID-addressed; pass-keys gains optional
  per-profile `sessionDir` and `patFile` so goblin's profile logs in
  with goblin's token (defaults unchanged for pi/mcporter). A record
  reads `{"name": "openrouter", "value": "!pass-keys run goblin-dev --
  printenv OPENROUTER_API_KEY"}` — pass-keys writes only to stderr,
  stdout is the child's.
- **Warmer**: a cold pass-keys login can take ~100 s (3 × 30 s +
  backoff), past auth's 15 s resolve bound. Goblin ships its own
  `deploy/goblin-keys.service` (oneshot `pass-keys warm goblin-dev` +
  `pass-keys warm goblin-mcp-dev`, restart-on-failure every 60 s, never
  gives up) + `.timer`
  (06:30/18:30), installed by install.sh; `goblin.service`
  `Wants=`/`After=` it, so boot resolves are tmpfs reads. A cold miss
  still fails loud, and the evicted rejection retries on next use.
- **Secrets during tasks: the `pass-cli` skill**, shipped like the
  browser's (`deploy/skills/pass-cli/SKILL.md`, seeded write-if-absent).
  Powers: `pass-cli run` with `pass://` refs (masked output — the
  program gets the secret, goblin doesn't), `inject` to an explicit
  path, `item totp` with a reason naming the task. Never `item view`,
  never `--no-masking`, never item/vault/agent writes. Its guard uses
  goblin's PAT with a separate session dir
  (`$GOBLIN_HOME/state/pass-cli-task/`) from the pass-keys lane
  (`$GOBLIN_HOME/state/pass-cli/`): pass-cli calls sharing a session
  must never run concurrently, and a long `run` must not hold
  pass-keys' lock. Open before build: confirm one PAT can hold two
  live sessions; if not, the skill takes pass-keys' flock instead.
- **Honest boundary**: same uid, full bash — the token's grants are
  the real limit, and anything goblin sees goes to its model
  provider. Grant narrowly.


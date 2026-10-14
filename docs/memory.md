# Optional Hindsight service + Goblin memory integration

Memory is **opt-in and off by default**. Without a `memory` block in
`goblin.json5`, ordinary conversations are byte-identical to before: no
recall, no retention, no extra tool, no worker timer.

When configured, each admitted turn recalls bounded evidence pre-turn
(fail-open, persisted per-turn and re-materialized verbatim so provider
prefix caches stay valid), completed text exchanges enqueue retention in
the same SQLite transaction as history, a bounded worker drains the
outbox, `memory_search` offers deeper recall, and `memory_reflect` investigates
cross-session patterns with supporting evidence. `/memory` controls
per-topic inclusion; `/forget` resolves then deletes sources with a
suppression that survives restarts and future backfills.

The queue keeps a stable remote operation ID across retries/restarts.
Acknowledgement is not completion; records stay queued until Hindsight
reports completion. Queued content is bound to its original endpoint and
bank. Failed or missing remote operations remain visible in the database
rather than being discarded or blindly replayed.

Verified end-to-end against the real Hindsight stack on 2026-09-24
(retention, recall, installer, watch timer) and live since — the
2026-09-25 reboot auto-started the stack on schedule. Do not treat the
raw client's delete method as a complete forgetting mechanism — see
`/forget` below.

On 2026-09-27, a synthetic live drill verified cross-topic recall and a
dated correction in three private Telegram topics: four visible replies,
four completed retention operations, and source-backed recall in the fresh
topics. A controlled API restart with no pending operations returned
healthy without changing the queue; the watch's healthy no-op was also
observed. A later drill paused the API process until the running container
reported `unhealthy`; the scheduled watch restarted the API, leaving the
database running, and readiness returned HTTP 200. Another restart caught
an acknowledged remote retention operation still `pending`: it completed
afterward under the same operation ID with one submission and a stored
document. Interruption during active `processing` was not observed (two
synthetic attempts completed before the probe saw that state). The synthetic
topics and three additional retained drill documents remain for audit,
not auto-deleted.

## Operator controls

- `/memory` — status (`disabled|healthy|degraded|pending` with outbox
  counts, last recall time/outcome, and blocked detail) and whether this
  topic is included.
- Settings mini app → Memory tab — the same status as a live read-only
  card above the config fields (state, queue line, last recall, blocked
  list with the `/memory retry` · `/memory dismiss` hint). Polled while
  the tab is open; the verbs themselves stay in Telegram.
- `/memory retry` — requeue blocked retention under fresh operation ids.
  A stale operation id is a dead remote op server-side; replaying it can
  never succeed.
- `/memory dismiss` — drop blocked retention from review. Dismissed rows
  stay in the database for audit (failed/missing remote operations are
  never silently discarded) and are removed by `/forget delete`.
- `/memory off` — exclude this topic: pending retention is cancelled,
  already-submitted operations remain tracked through their remote outcome,
  and no new retention is sent or
  shared memories are recalled here (automatic, `memory_search`, or `memory_reflect`).
  `/memory on` re-includes. Both bump the epoch (fence in-flight turns)
  and are logged cache boundaries.
- `/forget <query>` — resolve and list matching sources as a numbered
  list (dates and snippets). The listing is cached for that topic for
  10 minutes.
- `/forget delete <n>` (a number from the latest listing) or the full
  `<documentId>` — after reviewing the listing: suppress the source
  (survives restarts/backfill), stop its queued retention, delete the
  remote document through every bank that holds it, and redact recalled
  snapshots citing it. If a delete fails, re-run the same command:
  unfinished deletions are kept and retried, never assumed done. A
  number from a missing, expired, or other-topic listing refuses
  (fail-closed). Original chat history, backups, and provider retention
  are untouched — forgetting is not erasure.
- `memory` block edits in the mini app apply on **restart**: queued rows
  are bound to their endpoint+bank, so a live switch could never redirect
  pending personal content. The process logs a warning when a save
  changes the block.

## Memory quality and explicit investigation

New configurations default to automatic recall at `mid` / 2048 tokens, while
explicit search uses separate `searchBudget: "high"` / `searchMaxTokens: 4096`.
Existing explicit automatic bounds are respected. `preferObservations: true`
removes duplicate supporting facts when their observation is returned, without
excluding fresh raw facts. `minScores: {semantic: 0.3}` is an initial automatic
relevance floor, not a calibrated accuracy guarantee; set `minScores: {}` to
disable it. `searchMinScores` defaults empty so deliberate relational searches
can retrieve graph-only evidence. Floors are also enforced client-side, and a
result missing a configured score stage is excluded.

A small synthetic check with the existing local `embeddinggemma` and its
configured task prefixes produced cosine scores 0.627–0.645 for matching
questions (including Spanish), versus at most 0.127 for nonmatching pairs.
That supports the initial 0.3 floor for these examples, not a claim about
accuracy or completeness on the live bank.

`memory_reflect` uses the current service's configured LLM to search and reason
over memory. It returns synthesis, dated supporting facts, mental models, and
the service directives that influenced it. Those directives are evidence about
its reasoning, not instructions for Goblin. It never runs automatically and is
not callable through `script`. Defaults: `reflectBudget: "high"`,
`reflectMaxTokens: 4096`, `reflectTimeoutMs: 120000`. It adds model calls, latency,
and provider cost. A missing evidence envelope is a protocol error. No evidence
means `grounded: false`; oversized evidence items are omitted whole with a count.

Completed exchanges now preserve their full text for Hindsight's extraction
chunking. Exchanges over one million characters are rejected for retention with
a log warning; the completed reply is still saved. Recall preserves whole facts
inside an estimated character budget, reporting omissions instead of cutting off
qualifications.

Pattern-based credential screening runs before new outbox persistence and
memory requests, and before recalled/reflected text enters model context. It is
not a guarantee that every secret is recognizable. It does not scrub existing
history, old outbox rows at rest, remote memories, backups, or provider retention.
Explicit search/reflection results remain part of original conversation history;
forgetting indexed sources is not erasing that history.

These advanced fields are editable in `goblin.json5` and preserved by the app
settings editor. All memory config changes apply on the approved backend restart.

## Bank creation (operator step, once)

Goblin never creates banks. With the stack running:

```sh
# Create the bank (replace goblin with your bank id):
curl -s -X PUT http://127.0.0.1:8888/v1/default/banks/goblin \
  -H 'content-type: application/json' \
  -d '{"mission": "Remember the operator'"'"'s preferences, decisions, commitments, people, and ongoing work. Assistant suggestions are not operator decisions. Date every fact. Extract every fact in English regardless of the conversation language; keep proper nouns, product names, and quoted terms verbatim."}'

# Then steer the knobs Goblin actually exercises — the installer sends
# both of these itself at creation; the curl is for repair. The generic
# `mission` above lands on reflect_mission (Hindsight 0.10), which only
# affects the explicit memory_reflect investigation. Extraction follows
# retain_mission; consolidation follows observations_mission:
curl -s -X PATCH http://127.0.0.1:8888/v1/default/banks/goblin/config \
  -H 'content-type: application/json' \
  -d '{"updates": {
    "retain_mission": "Remember the operator'"'"'s preferences, decisions, commitments, people, and ongoing work. Assistant suggestions are not operator decisions. Date every fact. Extract every fact in English regardless of the conversation language; keep proper nouns, product names, and quoted terms verbatim.",
    "observations_mission": "Consolidate the operator'"'"'s preferences, decisions, commitments, people, and ongoing work. Assistant suggestions are not operator decisions. Preserve corrections as dated evolution. Write consolidated facts in English; keep proper nouns, product names, and quoted terms verbatim."
  }}'
```

The missions guide extraction and consolidation quality, not privacy —
exclusions are enforced in Goblin before any external request. Keep the
bank ID stable: changing embedding models for an existing bank needs an
explicit compatibility/re-indexing procedure, not a config edit.

## Consolidation (observations)

The bank consolidates retained facts into deduplicated, evidence-grounded
observations automatically after retain/delete/update (verified live,
2026-10-06: auto-consolidation and observations enabled; 14 observations
present). This is server-side LLM work on the same configured extraction
model — provider credit is a live dependency here too, and a failed
consolidation round surfaces through `/memory status`, not chat. Recall
returns observations alongside raw facts by default; they are dated
evidence like anything else recalled. The Memories browser shows
documents and extracted facts, not observations.

## Verified launch profile

Assets: `deploy/memory/`. The shipped 1.0.0 target was checked against tagged
source, the registry manifest, and image revision metadata. This inspection
did not pull images, restart services, read operator credentials, or invoke
models. Existing deployments keep their old image until an approved migration.

- Hindsight **1.0.0-slim**, API-only, pinned to multi-architecture manifest
  `sha256:1e889b5f44a3546a40765d084162cf0807c0b08c97fb29f64d0705597f1ef3b6`.
  Image revision matches tag `v1.0.0`:
  `39c65ffe2f140d0c84cee58566cad8900c5b9908`.
- PostgreSQL **17 / pgvector 0.8.2 / bookworm**, also digest-pinned. Both indexes
  advertise Linux amd64 and arm64. Hindsight uses `pgvector` and native PostgreSQL
  text search, not optional VectorChord/ParadeDB extensions. Its migrations create
  `vector` and `pg_trgm` (the latter ships in PostgreSQL contrib). The dedicated
  database role owns this isolated database and can run those migrations.
- Extraction (`retain`), consolidation and reflection inherit the operator's
  global LLM selection. Supported LLM providers: `zai`, `openai`, `openrouter`.
  Each requires `HINDSIGHT_API_LLM_PROVIDER`, `HINDSIGHT_API_LLM_MODEL`,
  `HINDSIGHT_API_LLM_BASE_URL` and `HINDSIGHT_API_LLM_API_KEY`. No model or
  endpoint is supplied by the guard. Choose a compatible model and HTTP(S)
  endpoint; prefer HTTPS for remote services.
- Embeddings require `HINDSIGHT_API_EMBEDDINGS_PROVIDER` and the selected
  provider's settings (no credential fallback):

  | Provider | Required model / auth | Endpoint |
  | --- | --- | --- |
  | `openrouter` | `HINDSIGHT_API_EMBEDDINGS_OPENROUTER_MODEL`, `HINDSIGHT_API_EMBEDDINGS_OPENROUTER_API_KEY` | Selecting this provider explicitly selects upstream's fixed `https://openrouter.ai/api/v1`; this profile has no embedding endpoint override for it. |
  | `openai` | `HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL`, `HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY` | Require `HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL` for OpenAI or a compatible endpoint. |

  Remove the previous provider's fields when switching; inactive settings fail.
  Model IDs are operator-selected, not allowlisted. The env file's
  `glm-5.3-flash` at `https://api.z.ai/api/paas/v4` (not the coding-plan endpoint)
  and OpenRouter `voyageai/voyage-4-lite` are **examples, not locks or defaults**.
  `voyageai` is a model namespace, not the selected Hindsight provider.
- Reranker remains an operator decision. The example is deliberately blank and
  **fails startup**. Explicitly selecting **`rrf`** chooses the verified
  model-free option: preserve retrieval's reciprocal-rank-fusion ordering,
  without a cross-encoder, model download or reranking provider call. It is not
  equivalent in recall quality to a learned reranker. No silent fallback.

The launch guard rejects missing settings, provider chains, per-operation
and unknown overrides before initialization, preventing silent upstream defaults.
Changing model IDs or supported endpoints/providers requires only operator config,
not a code change. This profile supports only the mappings above and model-free
`rrf`; wider provider or learned-reranker choices belong in an operator-managed
external BYO Hindsight deployment, not an implicit fallback here. The slim image
excludes local ML models; Hugging Face offline flags add defense in depth.
Goblin calls reflection only through the explicit `memory_reflect` tool,
never for automatic context injection. It uses the service's existing
configured LLM and returns synthesis with supporting evidence. Do not expose bank configuration APIs to
untrusted clients: bank-level overrides are outside this launch guard.

### Evidence

- [Tagged configuration reference](https://github.com/vectorize-io/hindsight/blob/v1.0.0/hindsight-docs/docs/developer/configuration.mdx)
  (LLM per-operation inheritance, embeddings, `rrf`, extensions).
- [Tagged embedding implementation](https://github.com/vectorize-io/hindsight/blob/v1.0.0/hindsight-api-slim/hindsight_api/engine/embeddings.py),
  [reranking implementation](https://github.com/vectorize-io/hindsight/blob/v1.0.0/hindsight-api-slim/hindsight_api/engine/cross_encoder.py),
  [migrations](https://github.com/vectorize-io/hindsight/blob/v1.0.0/hindsight-api-slim/hindsight_api/migrations.py),
  [image build](https://github.com/vectorize-io/hindsight/blob/v1.0.0/docker/standalone/Dockerfile).
- [Z.AI model](https://docs.z.ai/guides/vlm/glm-5.3-flash),
  [standard endpoint](https://docs.z.ai/guides/overview/quick-start).
- [OpenRouter embedding catalog](https://openrouter.ai/api/v1/embeddings/models).
- [pgvector Docker image](https://github.com/pgvector/pgvector#docker),
  [Quadlet reference](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html).

Catalog presence and supported wire configuration are **not** a successful live
compatibility test. Account access, GLM structured extraction, dimensions,
provider routing, quality, migrations and rootless runtime remain untested.

## Operator setup

Run the interactive installer from the repository root:

```sh
uv run python deploy/memory/install.py
```

It reads goblin's own registry first: providers goblin already uses are
proposed as Enter-accepting defaults, and their API keys are resolved
directly from its auth store — file to env file, never printed, never
retyped. Only new providers prompt for a key (hidden input). Model
selection searches the provider's live /models catalog (fetched with
the just-resolved key; failures print the reason and fall back to free
text). It then generates the database password (`secrets.token_urlsafe`,
written to a 0600 env file, never printed), validates the whole
configuration against the launch guard **before** anything is written,
installs the Quadlet assets and the health-watch timer, pre-pulls the
pinned images, starts the stack, enables it at boot (a healthy stack
survives reboots like goblin itself), creates the bank, adds the
`memory` block to `goblin.json5` (with
a backup and automatic rollback if goblin fails to boot), and restarts
goblin. Provider knowledge (roles, endpoints, catalogs, key resolution)
lives in `deploy/memory/providers.py`. `--no-start` stops after
installing config and assets (nothing is enabled until the confirmed
first start); `--reconfigure` re-prompts models and
keys, rewrites `hindsight.env` only (the database password is reused
from `postgres.env` — a new one would not rotate the existing role),
and restarts the API. Running it again on an installed stack prints
status.

### Manual path (advanced)

The installer is a convenience over deliberately simple assets; the steps
it automates, for reference or degenerate environments:

Requires Linux, rootless Podman with Quadlet and `Notify=healthy` support, a
systemd user manager, subordinate UID/GID mappings, uv for offline Python checks,
and sufficient storage. Generator validation passed with Podman 6.1.2. Check
older versions with the dry run below; do not assume compatibility. The container
includes its own Python. No Node sidecar or control-plane UI is deployed.

From the repository root, **when choosing to install**:

```sh
install -d -m 700 "$HOME/.config/goblin-memory"
install -d -m 700 "$HOME/.config/containers/systemd"
install -d -m 755 "$HOME/.config/systemd/user"
install -m 644 deploy/memory/start.py "$HOME/.config/goblin-memory/start.py"
install -m 644 deploy/memory/*.container deploy/memory/*.network \
  deploy/memory/*.volume "$HOME/.config/containers/systemd/"
install -m 644 deploy/memory/goblin-memory-watch.service \
  deploy/memory/goblin-memory-watch.timer "$HOME/.config/systemd/user/"
```

The shipped API Quadlet has `[Install]` / `WantedBy=default.target`.
Reloading makes Quadlet generate the boot dependency; do not enable the
generated service or hand-write a wants symlink. Enable the health timer
after the confirmed first start:

```sh
systemctl --user daemon-reload
systemctl --user show -p Wants default.target  # must include goblin-memory-api.service
systemctl --user enable --now goblin-memory-watch.timer  # 5-min health watch
```

Create `~/.config/goblin-memory/postgres.env` and `hindsight.env` privately, mode
0600, using the example files as a **schema**, not as working credentials. Never
put real values in this repository, shell history, chat, Goblin config or its
tool environment. Do not source these files. Podman reads literal `KEY=value`;
there is no shell expansion. Use the operator's secret-management workflow.

`postgres.env` supplies only `POSTGRES_PASSWORD`. In `hindsight.env`, set the
provider keys and a database URI of the form
`postgresql://hindsight:<percent-encoded-password>@db:5432/hindsight`, matching
the database password. Choose models and endpoints using the mappings above.
Explicitly decide whether to set `HINDSIGHT_API_RERANKER_PROVIDER=rrf`. No auth
secret is supplied or generated by these assets. Database password variables
initialize a **new** volume only; changing the file does not rotate an existing
role's password. Coordinate SQL password rotation and the URI while API is stopped.

Config paths use systemd `%h` (the user manager's home), not a fixed operator
home. If using another layout or port, edit installed assets deliberately.
SELinux bind-mount relabeling is scoped to the installed launch script (`:Z`).

### Offline validation

```sh
PYTHONDONTWRITEBYTECODE=1 uv run python -m unittest discover -s deploy/memory -p 'test_*.py' -v
uv run --with mypy mypy --strict deploy/memory/start.py deploy/memory/test_config.py \
  deploy/memory/install.py deploy/memory/test_install.py \
  deploy/memory/providers.py deploy/memory/test_providers.py
QUADLET_UNIT_DIRS="$PWD/deploy/memory" \
  /usr/lib/systemd/system-generators/podman-system-generator --user --dryrun
```

Generator location varies by distribution (also commonly
`/usr/libexec/podman/quadlet`). This only generates units; it neither pulls images
nor opens external config files. Tests use synthetic values only.

### Start only after explicit authorization for provider traffic

**Starting Hindsight can call the embedding provider during dimension detection
and can resume persisted background work. It is not a no-cost connectivity test.**

```sh
systemctl --user daemon-reload
systemctl --user start goblin-memory-api.service
systemctl --user status goblin-memory-db.service goblin-memory-api.service
curl --fail --silent --show-error http://127.0.0.1:8888/health/ready
```

Database readiness gates API startup; API readiness checks database reachability,
not model quality. Health probes do not call models. Exits restart on failure;
health becoming unhealthy after startup is visible but deliberately does not
restart the process just because the database is unreachable. Fix the cause,
then restart if needed. Initial pulls/migrations may exceed the 300-second
systemd startup budget: inspect logs and increase `TimeoutStartSec` deliberately.
The API Quadlet ships `[Install]` / `WantedBy=default.target`; the generator
creates its boot dependency and the database starts through `Requires`/`After`.
Older installed Quadlets missing this section need an operator edit and reload.
Generated services are not enabled with `systemctl enable`. User lingering, if desired,
is an explicit operator/admin decision (`loginctl enable-linger`).

```sh
journalctl --user -u goblin-memory-db.service -u goblin-memory-api.service --since today
podman inspect --format '{{.State.Health.Status}}' goblin-memory-api
systemctl --user stop goblin-memory-api.service goblin-memory-db.service
```

Do not dump full container inspection or env files into logs/support chats:
container environment includes credentials. Upstream logs may include sensitive
errors or memory content; treat journal access and retention as sensitive.
Monitor disk capacity, DB/API health and restart failures; keep PostgreSQL
autovacuum enabled. No automatic volume pruning, cleanup or auto-update is set.

## Exposure and data ownership

The private bridge has only these two containers; PostgreSQL publishes **no**
host port. Outbound networking is intentionally available for HTTPS providers.
Only `127.0.0.1:8888` is published. No Hindsight API authentication is provisioned:
loopback is not authentication against other local users, same-network
containers or untrusted tools running as this user. Use a trusted single-operator
host. Do not bind publicly or proxy remotely without deliberately designed TLS
and authentication. A separate existing remote service is a later Goblin-side
configuration choice, not a reason to expose this database.

Self-hosted storage is not local processing: the selected LLM endpoint receives
retained source text and memories/evidence; the selected embedding provider
receives storage text and recall queries. In the example these are Z.AI and
OpenRouter with VoyageAI routing, respectively. `rrf`
sends nothing to a reranking provider. Provider retention policies apply. Do not
send secrets. This stack does not implement Goblin's exclusions or consent gates.

All durable memory state is in named volume `goblin-memory-db`: sources, vectors,
derived facts, banks, jobs and schema. API containers are disposable; no local
model cache or file-upload storage is configured. Config/credentials live outside
the repository and must be recovered separately. If adding filesystem-backed
uploads later, explicitly design their persistence and backup too.

## Operator-owned backup, restore and upgrades

No backup timer, retention policy, encryption scheme or off-machine destination
is installed. The operator owns all of them and must perform restore drills.
Back up the database, role definitions if customized, external config/secrets
through the secret manager, and exact image digests/assets. Restrict backup file
permissions and encrypt/store off-host according to your policy.

Example logical dump, **run by the operator**, using a destination they choose:

```sh
# Stop API writers/background jobs; leave the DB running.
systemctl --user stop goblin-memory-api.service
umask 077
# BACKUP is an operator-selected NEW file, outside the repository.
# noclobber prevents overwriting an earlier backup; check command exit status.
(set -C; podman exec goblin-memory-db pg_dump -U hindsight -d hindsight -Fc > "$BACKUP")
# Verify the archive; this is not a substitute for a restore drill.
podman exec -i goblin-memory-db pg_restore --list < "$BACKUP"
```

Do not keep a failed/partial dump as a successful backup. For physical backups,
use supported PostgreSQL tooling or a clean shutdown of both services before
copying the volume; never copy a live PGDATA directory as an ordinary file backup.

Restore into a **separate, empty** database/volume on an isolated test stack using
the same pinned PG/extensions first. Adapt names/network/port in copied Quadlets,
keep its API stopped, and never point it at the production volume. Initialize
matching database/role credentials, then:

```sh
# RESTORE_DB_CONTAINER names that isolated PostgreSQL container, NOT production.
podman exec -i "$RESTORE_DB_CONTAINER" pg_restore \
  --exit-on-error --no-owner -U hindsight -d hindsight < "$BACKUP"
```

Check schema, extensions, counts and pending work before starting the restored
API. Startup can resume jobs and make paid calls. Reconcile forgotten-source
suppression/exclusions from the future Goblin integration **before serving or
ingesting restored data**: old backups can resurrect deleted memories. A DB
restore is not erasure from backups, original history or provider retention.

For upgrades: read release/migration notes; take and verify a backup; stop API;
verify new registry digests/platforms and provider mappings; rehearse migration
and recovery on the isolated restore; then update pins deliberately. Preserve the
old assets and backup. Hindsight migrates on startup. **Image rollback alone is
not schema rollback**: restore the pre-upgrade DB to a separate volume and run
the matching old API if migration cannot be reversed. PostgreSQL major upgrades
require a supported dump/restore or `pg_upgrade` procedure, never just changing
the image against old PGDATA. Embedding model/dimension changes need an explicit
re-indexing plan, not an environment edit. Never delete the old volume until the
operator has verified recovery and chosen its retention policy.

## Benchmarking

`deploy/memory/bench.py` measures the stack's two tuning surfaces without
mutating anything. Both subcommands read the live service and hindsight.env;
keys stay in process memory and are never printed.

- `uv run deploy/memory/bench.py llm` — renders the bank's exact retain
  prompts and response schema via `prompts/preview`, then replays them
  against the configured LLM under a matrix of the sampling knobs
  (temperature, `reasoning_effort`, output-language pin — the pin is
  simulated by applying upstream's own prompt transformation). Paid calls;
  prints the plan first and requires `--yes`. Raw records go to `--out`
  JSONL. `--full` adds the remaining cross-product cells.
- `uv run deploy/memory/bench.py recall` — embedding-model latency race
  (deployed OpenRouter model vs the local Ollama candidate) plus a
  retrieval-quality A/B (hit@k / MRR over `bench_fixtures/gold_queries.json`
  against the live bank). Re-run the A/B before any embedding swap, and
  again if the bank grows an order of magnitude — ranking deltas between
  models grow with corpus size.

Known reading notes: language grading is a two-layer verdict — the configured
LLM acts as a structured judge (ISO 639-1 + confidence, over the fact texts,
not keys or entity names), and deterministic script detection cross-checks it
for cross-script drift (a judge "en" on Cyrillic text is a hard fail). Judge
failures are counted as *ungraded*, never as passes; `--no-judge` skips
grading for latency-only runs. Extraction coverage is graded against curated
gold assertions in `bench_fixtures/docs.json` (strict: a near-miss is false
coverage), and each fixture declares its expected baseline language, so pinned
cells are graded against "en" on every doc and baseline cells against
source-preservation. The Ollama candidate's first call after idle eviction
pays the model reload (~2-3 s) — that is the `OLLAMA_KEEP_ALIVE` caveat
surfacing in the data, not model slowness.

## Performance baseline (measured 2026-10-07/08)

From live traffic (`~/goblin/state/goblin.log`) and a same-seat replay
against the local API. The numbers below are the reference for any latency
work on the memory stack.

- Response gap (intake → first model call), 46 turns: p50 1837 ms, p90 3454,
  p95 4356, max 7103.
- Hindsight recall (goblin-side `memory request completed` durationMs), 51
  recalls over ~3 weeks: p50 863 ms, p90 1633, p95 2459, max 2646. Recall is
  ~half the median gap and nearly all of its tail.
- Recall anatomy (hindsight's own phase log): `generate_query_embedding`
  297–358 ms of a 314–382 ms total — **the query embedding call is ~95% of
  recall latency**; retrieval + RRF + token filtering are ~15 ms combined;
  the cross-encoder reranker is skipped (`reranker=rrf`, 0 ms).
- The embedding hop is `voyageai/voyage-4-lite` @ OpenRouter. Warm RTT from
  this host: 230–270 ms; hindsight's Python client observes 300–950 ms
  (connection setup after idle + provider variance explain the p50 863 →
  warm ~414 spread).

The embedding hop is local since 2026-10-09 (ollama `embeddinggemma` via
the embed relay — see "Local embeddings"); the remote figures above are
the pre-swap baseline.

## Local embeddings (applied 2026-10-09)

Recall's embedding hop is local: the bank embeds with ollama's
`embeddinggemma` (768-dim, GPU) on the system `ollama.service`
(`127.0.0.1:11434`), reached as an `openai`-provider endpoint in
`hindsight.env`. The API container cannot reach that listener directly —
the rootless bridge net `goblin-memory` has no path to host loopback,
`host.containers.internal` does NOT work for it (refused), and ollama
403s requests whose `Host` header is non-local — so a socat relay
(`goblin-embed-relay.service`, user unit) listens on the tailscale /32
`100.90.205.106:11435` and forwards to `127.0.0.1:11434`. The tailscale
address is host-local, stable, and never LAN-routed; the relay's
`range=<addr>/32` admits only sources presenting that address, and pasta
NAT makes container traffic arrive from exactly that — nothing off-box
or off-tailnet can reach ollama through the relay. Dependency to note:
tailscale down = no relay = the memory API cannot boot (it test-embeds
during init), which is why the relay unit is `WantedBy`/`Before` the API.

`goblin-embed-pin.timer` fires `goblin-embed-pin.service` on boot +3min
and every 10min: an `/api/embed` call with `keep_alive=-1` THROUGH the
relay keeps the model resident (default keep_alive evicts after 5min
idle) and doubles as the embed-path health signal — a failure leaves a
failed unit, and `systemctl --user status goblin-embed-pin` is the check.
An optional sudo drop-in
`/etc/systemd/system/ollama.service.d/keepalive.conf` containing
`[Service]` + `Environment=OLLAMA_KEEP_ALIVE=-1` makes the pin redundant
(a drop-in survives the upstream installer rewriting `ollama.service`);
the timer's health signal stays useful either way.

Setup (or re-add on another box): write
`~/.config/goblin-memory/embed-relay.env` from
`deploy/memory/embed-relay.env.example` (`GOBLIN_EMBED_RELAY_ADDR`,
`GOBLIN_EMBED_MODEL`), run `uv run python deploy/memory/install.py` so
the units land, then `--reconfigure` choosing provider `openai`, model
`embeddinggemma`, the relay base URL (`http://<addr>:11435/v1`), and any
non-empty dummy key — ollama ignores it. embeddinggemma's task prefixes
(`HINDSIGHT_API_EMBEDDINGS_QUERY_PREFIX` / `_PASSAGE_PREFIX`) are written
automatically from `EMBEDDING_PREFIXES` in `deploy/memory/providers.py`.

Measured on the live bank: recall 250–283 ms flat (vs ~550 ms remote
warm and 2.3–2.7 s cold — the per-turn remote re-cold leg is gone).
Quality is honestly mixed and treated as comparable: the earlier
fact-level A/B (28 queries × 199 facts, without prefixes) had voyage
ahead (hit@1 0.96 vs 0.89, MRR 0.982 vs 0.940); a second eval on raw
conversation text (~30 hand-labeled queries, labels revised between
rounds) had instructed gemma ahead (hit@1 0.71, hit@5 1.00, MRR 0.834,
vs voyage 0.63 / 0.97 / 0.785). bm25 and graph legs are unchanged by
the swap.

### Switching embedding models / rollback

Use `uv run python deploy/memory/install.py --reconfigure` — it rewrites
the whole `hindsight.env`, so no stale `EMBEDDINGS_OPENAI_*` or prefix
keys survive; hand-flipping `HINDSIGHT_API_EMBEDDINGS_PROVIDER` fails the
launch guard (leftover keys read as "unsupported override").

A dimension change (768 ↔ voyage's 1024) auto-applies only while
`memory_units`/`mental_models` hold no embeddings
(`hindsight_api/migrations.py`). With data the API refuses to boot — the
vector column is global, not per bank — so switching models on a
populated bank is a re-index: back up first (the Backup section). The
re-embed procedure itself is NOT verified; treat it as unproven.

## Extraction LLM: effective knobs (all UNPINNED today)

`hindsight.env` sets no sampling knobs, so gpt-6-luna runs on hindsight's
built-in defaults. Hindsight never sends `top_p`/`top_k`/`seed` at all (no
code path; `HINDSIGHT_API_LLM_EXTRA_BODY` is the only injection hatch).
Per-pipeline temperature defaults (config.py): retain 0.1, consolidation 0.0,
reflect 0.9, verification 0.0 — per-operation overrides
`HINDSIGHT_API_LLM_TEMPERATURE_{RETAIN,REFLECT,CONSOLIDATION,VERIFICATION}`,
with `none/off` sentinels to omit the parameter entirely. `reasoning_effort`
is unset → omitted (luna's own default); `HINDSIGHT_API_LLM_REASONING_EFFORT`
and per-operation variants exist. Structured output uses json_schema
(response_format) — luna accepts strict schema mode on OpenRouter.

Bench smoke (n=2, directional; verify with `bench.py llm --reps 5 --yes`,
~40+40 calls ≈ 130k tokens): retain wall 8.8–12.4 s at defaults → **3.0–6.1 s
with effort=low**, completion tokens −60%, with one coverage miss (75% vs
100%) — the speed/completeness trade the full run must quantify.

## Extraction language drift incident (2026-09-25; fix UNAPPLIED)

Four facts in the bank are Russian (EN 157 / ES 38 / RU 4). All four trace to
one English exchange in topic 546583, retained 2026-09-25 23:45 UTC. The
extraction prompt demands source-language preservation (`_DEFAULT_LANGUAGE_RULE`
in `retain/fact_extraction.py`, surfaced as a prompt block with
`field=llm_output_language`); luna violated it on one call; consolidation then
faithfully "preserved the source language" of the RU facts and derived two
more (the `doc=null` pair). This is upstream-acknowledged: hindsight's
`prompt_utils.py` cites issue #181 — a multilingual model drifts "to an
unrelated language" unless `HINDSIGHT_API_LLM_OUTPUT_LANGUAGE` is set.

Remediation, all pending bermudi's OK (live mutations): add
`HINDSIGHT_API_LLM_OUTPUT_LANGUAGE=English` to `hindsight.env` (+ API restart;
trade: Spanish exchanges extract as English facts going forward); reprocess
the two source documents (`POST /documents/{id}/reprocess` — ids in
`bench` git history / facts `966c1aa4`, `11677f83`); then forget the two
consolidation-derived RU facts (`19dd4557`, `6d22027e`, `doc=null`) after
verifying reprocess does not clean them itself. For next time: enable
`HINDSIGHT_API_LLM_TRACE_ENABLED` and/or bank `audit_log_enabled` so the
drifting call is recorded.

## Environment facts (verified this session)

- hindsight-api: `127.0.0.1:8888`, no auth on loopback, bank `goblin`
  (wiped and recreated 2026-10-09 — 0 facts at swap time); DB timestamps
  are UTC, journal displays local (UTC-6).
- `audit_log_enabled: false`; bank missions sat at the pre-pin text
  ("…Date every fact.") until 2026-10-10, when `retain_mission` and
  `observations_mission` were set to the canonical English-pinned texts
  via the `/config` PATCH above (the generic `mission` field was left —
  it feeds the explicit memory_reflect tool, not extraction).
- Container→host networking: bridge net `goblin-memory`;
  `host.containers.internal` does NOT reach host loopback listeners
  (refused) — the `goblin-embed-relay` socat unit on the tailscale /32
  is the container's path to host ollama.
- Ollama daemon active on `127.0.0.1:11434`; embeddinggemma + nomic
  pulled; embeddinggemma kept resident by `goblin-embed-pin.timer`
  (`keep_alive=-1`; default eviction is 5 min idle).
- Bench commits: `b3f6e0a` (tool), `8bff773` (judge grading). Docs section:
  Benchmarking, above. Not deployed — `scripts/deploy.sh` is the only
  sanctioned push and was not run.

Unit tests: `uv run -m unittest discover -s deploy/memory -p 'test_bench.py'`.

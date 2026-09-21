# Optional Hindsight service

This is **service infrastructure only**, not Goblin memory integration. Nothing
in Goblin is enabled or changed. No SDK, ingestion, recall, backfill, scheduler,
or backup automation is installed. `DESIGN.md` remains the integration contract.

## Verified launch profile

Assets: `deploy/memory/`. Public upstream documentation, tagged source, registry
manifests and image configuration were checked on 2026-09-21; no images were
pulled, services started, credentials read, or model calls made.

- Hindsight **0.10.0-slim**, API-only, pinned to the multi-architecture manifest
  digest in the Quadlet. Image revision matches tag `v0.10.0`:
  `5d46f9c8c8eb4fb96f549aa63abe1191b82a7840`.
- PostgreSQL **17 / pgvector 0.8.2 / bookworm**, also digest-pinned. Both indexes
  advertise Linux amd64 and arm64. Hindsight uses `pgvector` and native PostgreSQL
  text search, not optional VectorChord/ParadeDB extensions. Its migrations create
  `vector` and `pg_trgm` (the latter ships in PostgreSQL contrib). The dedicated
  database role owns this isolated database and can run those migrations.
- Extraction (`retain`) and consolidation inherit the explicitly configured
  global `zai` / `glm-5.3-flash`. The endpoint is explicitly
  `https://api.z.ai/api/paas/v4`, **not** Hindsight's default coding-plan endpoint.
  Z.AI documents this model ID and the standard OpenAI-compatible endpoint.
- Embeddings: Hindsight provider **`openrouter`**, setting
  `HINDSIGHT_API_EMBEDDINGS_OPENROUTER_MODEL=voyageai/voyage-4-lite`, with a separate
  `HINDSIGHT_API_EMBEDDINGS_OPENROUTER_API_KEY`. Hindsight uses
  `https://openrouter.ai/api/v1`; OpenRouter's public embeddings catalog lists
  this exact ID. `voyageai` is the model namespace here, not a Hindsight provider.
- Reranker remains an operator decision. The example is deliberately blank and
  **fails startup**. Explicitly selecting **`rrf`** chooses the verified
  model-free option: preserve retrieval's reciprocal-rank-fusion ordering,
  without a cross-encoder, model download or reranking provider call. It is not
  equivalent in recall quality to a learned reranker. No silent fallback.

The launch guard rejects missing settings, alternate models, provider chains,
per-operation overrides and unsupported Hindsight settings before initialization.
This is intentionally one narrow, auditable profile, not a general configuration
framework. A different provider or learned reranker requires a reviewed change to
this profile and its tests, with explicit model/endpoint selection. The slim
image excludes local ML models; Hugging Face offline flags add defense in depth.
Reflection, if someone calls it directly, also inherits the same global GLM model;
Goblin does not call it. Do not expose the service's bank configuration APIs to
untrusted clients: bank-level overrides are outside this launch guard.

### Evidence

- [Tagged configuration reference](https://github.com/vectorize-io/hindsight/blob/v0.10.0/hindsight-docs/docs/developer/configuration.md)
  (LLM per-operation inheritance, embeddings, `rrf`, extensions).
- [Tagged embedding implementation](https://github.com/vectorize-io/hindsight/blob/v0.10.0/hindsight-api-slim/hindsight_api/engine/embeddings.py),
  [reranking implementation](https://github.com/vectorize-io/hindsight/blob/v0.10.0/hindsight-api-slim/hindsight_api/engine/cross_encoder.py),
  [migrations](https://github.com/vectorize-io/hindsight/blob/v0.10.0/hindsight-api-slim/hindsight_api/migrations.py),
  [image build](https://github.com/vectorize-io/hindsight/blob/v0.10.0/docker/standalone/Dockerfile).
- [Z.AI model](https://docs.z.ai/guides/vlm/glm-5.3-flash),
  [standard endpoint](https://docs.z.ai/guides/overview/quick-start).
- [OpenRouter embedding catalog](https://openrouter.ai/api/v1/embeddings/models).
- [pgvector Docker image](https://github.com/pgvector/pgvector#docker),
  [Quadlet reference](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html).

Catalog presence and supported wire configuration are **not** a successful live
compatibility test. Account access, GLM structured extraction, dimensions,
provider routing, quality, migrations and rootless runtime remain untested.

## Operator setup (not automatic)

Requires Linux, rootless Podman with Quadlet and `Notify=healthy` support, a
systemd user manager, subordinate UID/GID mappings, Python 3 for offline tests,
and sufficient storage. Generator validation passed with Podman 6.1.2. Check
older versions with the dry run below; do not assume compatibility. The container
includes its own Python. No Node sidecar or control-plane UI is deployed.

From the repository root, **when choosing to install**:

```sh
install -d -m 700 "$HOME/.config/goblin-memory"
install -d -m 700 "$HOME/.config/containers/systemd"
install -m 644 deploy/memory/start.py "$HOME/.config/goblin-memory/start.py"
install -m 644 deploy/memory/*.container deploy/memory/*.network \
  deploy/memory/*.volume "$HOME/.config/containers/systemd/"
```

Create `~/.config/goblin-memory/postgres.env` and `hindsight.env` privately, mode
0600, using the example files as a **schema**, not as working credentials. Never
put real values in this repository, shell history, chat, Goblin config or its
tool environment. Do not source these files. Podman reads literal `KEY=value`;
there is no shell expansion. Use the operator's secret-management workflow.

`postgres.env` supplies only `POSTGRES_PASSWORD`. In `hindsight.env`, set the
provider keys and a database URI of the form
`postgresql://hindsight:<percent-encoded-password>@db:5432/hindsight`, matching
the database password. Leave the documented model/endpoint selections intact.
Explicitly decide whether to set `HINDSIGHT_API_RERANKER_PROVIDER=rrf`. No auth
secret is supplied or generated by these assets. Database password variables
initialize a **new** volume only; changing the file does not rotate an existing
role's password. Coordinate SQL password rotation and the URI while API is stopped.

Config paths use systemd `%h` (the user manager's home), not a fixed operator
home. If using another layout or port, edit installed assets deliberately.
SELinux bind-mount relabeling is scoped to the installed launch script (`:Z`).

### Offline validation

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s deploy/memory -p 'test_*.py' -v
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
The services have no boot activation by default. To opt into boot startup, add
`[Install]` / `WantedBy=default.target` to the API Quadlet and reload. Generated
services are not enabled with `systemctl enable`. User lingering, if desired,
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

Self-hosted storage is not local processing: Z.AI receives retained source text
for extraction and memories/evidence for consolidation; OpenRouter and its
VoyageAI routing receive text embedded for storage and recall queries. `rrf`
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

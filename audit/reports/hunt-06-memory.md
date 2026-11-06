> Audited 2026-10-23 16:43 local, at repo commit `59d3f7d7` (tracked tree clean; only untracked audit/ notes). Production files are identical at `9d4f861e`, the HEAD this audit closed on — its sole change is app/src/WindowView.test.tsx.

# Hunt 06 — Long-term memory (src/memory/, src/runtime-memory.test.ts, deploy/memory/)

Read-and-report only. Rules of engagement honored: no production edits, no
installs, no live services, no env-gated live tests run, no secret values read
or printed (the two `.env.example` files were the only env files opened).

Test evidence (all run from the repo root / deploy/memory as the brief directs):

- `bun test src/memory/ src/runtime-memory.test.ts` → **118 pass, 1 skip**
  (the live wire-contract test self-skips without `GOBLIN_MEMORY_LIVE=1`;
  never run live).
- `bun run typecheck` (both tsc programs) → **clean**.
- `uv run --with pytest pytest test_install.py` → 116 passed + 34 subtests.
- `pytest test_config.py test_healthcheck.py` → 12 passed + 27 subtests.
- `pytest test_providers.py test_bench.py` → 36 passed.
- `uv run --with mypy mypy --strict <docs/memory.md offline-validation file set>`
  → **17 errors, all in test_install.py** (finding F1).

Severity: P0 data loss / crash / security hole on a normal path; P1 wrong
behavior on a plausible path; P2 broken edge or error path; P3 invariant
hygiene.

---

## 1. Findings (most severe first)

**No P0 and no P1 findings.** The core memory machinery held up against every
invariant I could trace from design/memory.md. The real defects are two P2
recovery/gate issues and a set of P3 hygiene items.

### F1 (P2) — The documented Python type-check gate is red

- Where: `deploy/memory/test_install.py` (17 strict-mypy errors, lines 370,
  374, 380, 409, 411, 413, 921, 922, 925, 1088, 1090, 1529, 1636, 1653,
  2123, 2131, 2204). `install.py`, `providers.py`, `start.py`,
  `test_config.py`, `test_providers.py` are clean.
- Rule violated: docs/memory.md → "Offline validation" ships
  `uv run --with mypy mypy --strict deploy/memory/start.py
  deploy/memory/test_config.py deploy/memory/install.py
  deploy/memory/test_install.py deploy/memory/providers.py
  deploy/memory/test_providers.py` as the gate; the hunt brief states "Python
  side must type-check and pass". Two error classes: `Module "install" does
  not explicitly export attribute "read_goblin_providers"/"os"/...`
  (implicit re-exports under `--strict`) and `Missing type arguments for
  generic type "list"/"Callable"`.
- Trigger: run the documented command verbatim — it exits non-zero today.
- Caveat: there is no mypy pin anywhere in the tree, so the gate may have
  drifted green→red with a mypy release; either way the documented command is
  not reproducibly green, which is the finding.

### F2 (P2) — Half-install between env write and first secret registration has no installer recovery path

- Where: `deploy/memory/install.py:1570` (fresh path writes `HINDSIGHT_ENV`)
  → `:1577-1579` (`apply_secret_block`, `sync_secrets`). If `install_assets`
  (missing asset → `fail`), `apply_secret_block` (missing markers → `fail`),
  or the **first** `ensure_secret` inside `sync_secrets` fails — or the
  operator Ctrl+C's in that window — the box is left with `hindsight.env`
  present and **zero** registered `HINDSIGHT_API_*` podman secrets.
- Dead ends from that state (all read-verified, not executed — ROE forbids
  running install.py):
  - Plain rerun: `main()` takes the existing-install branch
    (`install.py:1539-1551`), which only `refresh_assets` and prints
    "rerun with --resume".
  - `--resume` (`:1520-1537`): `start_stack()` → `systemctl --user start
    goblin-memory-api.service` fails because the installed Quadlet references
    a podman secret that was never created (`goblin-memory-api.container:17`)
    → `run()` → `fail()` → exit.
  - `--reconfigure` refuses at `:1408-1411`: `not managed_secrets()` is
    truthy for an empty registry — the pre-pod-install guard also catches
    this fresh-install-crash state.
  - `cli()`'s interrupt handler (`:1610-1616`) actively promises "safe to
    rerun; existing files are detected and kept" — for this window the rerun
    cannot complete the install.
- Rule violated: design/memory.md → "Deployment and configuration" ("Fail
  loud: every step reports what it is doing and aborts with context on the
  first failure. Idempotent for assets...") combined with the module header
  contract ("refuses to touch existing env files unless --reconfigure") — the
  refusal leaves no path back to a working install short of hand-deleting the
  0600 env file or hand-running `podman secret create`.
- Test sketch: fake `ensure_secret` to raise on the first call after
  `HINDSIGHT_ENV` is written; rerun `main([])` → assert the installer offers
  a path that converges (e.g. re-registering secrets) rather than a
  `--resume` that cannot start the API.

### F3 (P3) — Installed API Quadlet carries `Secret=HINDSIGHT_API_LLM_API_KEY,type=mount` twice

- Where: static line `deploy/memory/goblin-memory-api.container:17` plus the
  marker block written by `apply_secret_block` (`install.py:619-634`), which
  always includes the LLM secret because `needed_secrets()`
  (`install.py:179-183`) unconditionally contains `answers.llm_secret`.
- Verified by simulation (scratch copy of the shipped file + the real
  `apply_secret_block`): the installed file ends with the line twice.
  `test_install.py:253-265` (`ApplySecretBlockTest`) uses a synthetic
  quadlet without the static line, so the real-file combination is untested.
- Consequence: relies on podman deduplicating identical secret mounts. The
  live stack boots, so current podman tolerates it (unverified directly — no
  podman allowed); any podman that rejects duplicate `--secret` mounts would
  break container start. Also plain confusion: the static line exists to
  guarantee the LLM key, yet the installer rewrites it inside the managed
  block on every fresh install.

### F4 (P3) — Credential screening swallows ordinary words after `secret:` / `password:` in operator speech

- Where: `src/memory/screen.ts:30-34` (`secret_assignment` pattern's value
  alternative `[^\s,;}]+` has no minimum length).
- Probe-verified (scratch script, idempotence also confirmed):
  - "the secret: is that I love coffee in the mornings" →
    "the secret: [REDACTED:secret_assignment] that I love coffee..." (the
    word "is" is eaten)
  - "remember: the wifi password: works" style sentences lose the word
    following the keyword-colon.
- This garbles recall queries, recall evidence, and retained documents on
  plausible phrasing. design/memory.md → "Recall: Memory quality and safety"
  explicitly accepts the trade ("pattern screening is not a secrecy
  guarantee") and over-redaction errs safe, so this is a quality note, not a
  correctness violation — but the zero-length floor makes the mangling more
  aggressive than the pattern's intent (compare `authorization`, which
  requires 8+ token characters).

### F5 (P3) — Browse list endpoints' 1 MiB byte cap contradicts their own schema allowance

- Where: `src/memory/hindsight.ts:247` (`MAX_RESPONSE_BYTES = 1_048_576`)
  applies to `listDocuments`/`listMemories` (`:600`, `:628`), while the
  envelope schema (`:190-196`) allows 200 items × 64,000-char fact text ≈
  12.8 MB. A heavy memories page fails with `too_large` (loud error in the
  operator browse routes) well before the schema's own bound. Compare
  `getDocument` (12 MiB, `:565`) and `reflect` (16 MiB, `:495`) which were
  sized to their schemas. Fails loud per the guardrail; the inconsistency is
  the finding.

### F6 (P3) — `recall()`'s inline fallback defaults contradict the policy module

- Where: `src/memory/hindsight.ts:428-429` — `max_tokens:
  options.maxTokens ?? 2_048`, `budget: options.budget ?? "low"`.
  `MEMORY_DEFAULTS.budget` is `"mid"` (`src/memory/policy.ts:4`), and
  `reflect()` four lines down correctly uses `MEMORY_DEFAULTS.*`
  (`:482-483`). All current callers pass explicit values, so the literals are
  dead — but any future caller that omits `budget` silently gets a *lower*
  effort than every documented default. Misleading dead default.

### F7 (P3) — `secret_lookup` fragility: comma hazard and over-broad newline strip

- Where: `deploy/memory/install.py:533-539`.
  - The lookup command is embedded into one comma-joined
    `--driver-opts` string (`lookup=…,store=…,list=true,delete=true`); any
    comma inside an auth-store `!` command would corrupt option parsing.
    Today's `pass-keys get goblin-dev NAME` records are comma-free (lead —
    podman parsing behavior unverified, no podman allowed).
  - `| tr -d '\n'` strips **all** newlines while the docstring says "defend
    against a trailing newline"; a multi-line credential (e.g. a PEM) would
    be corrupted. Harmless for the API keys this profile uses; the docstring
    and behavior disagree.

### F8 (P3) — Parked-row forget guidance is unreachable on Telegram when memory is unconfigured

- Where: `src/memory/mod.ts:598-607` — with `enabled: false` and
  `deleting > 0`, state reads `"disabled"` and the `/forget delete` retry
  note rides only `detail`. On Telegram, `/memory` bails earlier still
  (`src/tg/commands.ts:303-307`: `deps.memory` is null when unconfigured →
  "memory is not configured"). The state that most needs the "retry
  /forget delete" guidance (rows parked by a failed forget, then the memory
  block removed) cannot show it on the channel the guidance names. The app
  status surface does include the note (`src/http/operator.ts:483`).
  design/memory.md → "Slice 2 rulings" (5)/(7): "Parked rows surface as
  degraded with `/forget delete` retry guidance". Cross-module pointer —
  commands are out of this hunt's scope.

### F9 (P3) — Scoped Python files outside the documented gate carry 23 strict-mypy errors

- Where: `bench.py` (20 errors: `fail() -> None` at `:59` defeats NoReturn
  narrowing and produces the bogus arg-type error at `:96`; bare `dict`/
  untyped defs throughout), `test_bench.py:11,13`, `test_healthcheck.py:42`.
  `healthcheck.py` itself is clean. These files are not in docs/memory.md's
  offline-validation command, so the gate never sees them — drift by
  omission.

---

## 2. Checked and clean (later passes can skip)

- **Outage degradation of the chat path**: recall failure persists the
  unavailable-marker block, marks the latch, turn still completes and queues
  retention (`mod.ts:205-296`; `runtime-memory.test.ts:136-153`); the
  unavailable block is distinct from "no relevant memories" in model context;
  worker transport failures back off capped at 300 s + 5 s tick — never a
  tight loop, never dropped silently (`queue.ts:435-502`); `OUTAGE_STALE_AFTER_MS`
  (15 min) provably exceeds the worst-case failure cadence (~5 m 5 s).
- **Outage notice discipline**: exactly one notice per episode, staleness
  reset accounting, late-mark cannot mute a successor, episode survives
  restart (`outage.ts`; `outage.test.ts`); blocked notices latch once per
  document and survive restart (`queue.ts:375-381`; tests); no per-retry
  notifications anywhere.
- **Queue durability across restarts**: SQLite outbox; retry replays the same
  operation id and identical bytes; HTTP ack ≠ completion (`submitted` polls
  until terminal); an operation that disappears remotely → `blocked` for
  operator reconciliation, never resubmitted blindly (`queue.ts`,
  `queue.test.ts:86-253`).
- **Retain's binding rule**: rows are keyed to the endpoint+bank target hash;
  the worker only drains `client.target`; a destination change cannot
  redirect pending personal content; old-bank rows never drain through the
  current worker (`queue.ts:126-143`; tests).
- **Forget protocol**: settle → suppress → park → per-destination remote
  delete + per-destination row release → recall-snapshot redaction with
  window-capture purge and recall-version bump in one transaction; busy and
  foreign-bank refusals leave all tracking intact; failed delete keeps
  unconfirmed destinations parked; `/memory retry` cannot touch deletions;
  dismissed/blocked rows cancel under the same delete (`forget.ts`,
  `queue.ts:239-257`, `mod.ts:465-486`; `forget.test.ts`).
- **Suppression**: bank-agnostic (document-id keyed), checked before every
  enqueue at the commit producer (`turn/finish.ts:194-208`), rides inside the
  append transaction (`conversation.ts:1546-1552`); re-enqueue after park is
  harmless (UNIQUE + identical-payload check).
- **Exclusion (#85)**: enforced in Goblin before any external request;
  stamp-at-append eligibility; re-enabling never ships the excluded era
  (recall query and retention canary-tested in `runtime-memory.test.ts:155-202`).
- **Hindsight client zod validation**: every response schema-parsed with
  identity refines (retain bank/op ids, operation id, document id+bank);
  redirects rejected; auth resolution failure pre-request; error classes
  never echo untrusted bodies; timeouts cover stalled bodies; byte caps on
  readJson; reflection's aggregate limit maps to `too_large` (resource
  failure), other shape failures to `protocol` — exactly the doc's split
  (`hindsight.ts`; `hindsight.test.ts`).
- **Credential screening**: applied at every egress (enqueue payload, submit
  wire, recall/reflect queries, per-message query sources, recall results,
  prior context); idempotent under repeated screening (probe-verified).
- **Bank/mission**: Goblin never creates banks; the installer (operator step)
  PUTs the mission at creation, patches `retain_mission` +
  `observations_mission`, never patches an existing bank, warns on drift
  with a repair line (`install.py:867-951`) — matches slice-2 ruling 6 and
  the English-fact pin in `DEFAULT_MISSION`.
- **Credentials discipline in install.py** (checked every code path against
  the header contract): env files can only ever carry non-secret settings —
  `render_env_file` hard-rejects any `*_API_KEY`/`*_PASSWORD` except the
  documented `local-ollama` sentinel; podman secrets store only lookup
  commands (stdin payload at create is a fixed marker string, discarded by
  the no-op `store`); `managed_secrets` failures name secrets, never values;
  `providers.resolve_auth_key` keeps values file→memory→header only;
  `bench_key` likewise; `print_summary` prints secret *names*; nothing
  prints a resolved value anywhere.
- **healthcheck.py**: exits 1 on connection failure/timeout/non-2xx, 0 on
  2xx; never raises into the probe runner (tested). Both containers'
  `HealthCmd` values carry no shell metacharacters — the AGENTS.md /
  design/memory.md quadlet ruling holds (mounted script for the API,
  `pg_isready` argv for the DB).
- **start.py**: fail-closed validate-before-exec; DB URI pinned to the
  passwordless pod-loopback form; unsupported `HINDSIGHT_*` overrides
  rejected; `HF_HUB_OFFLINE`/`TRANSFORMERS_OFFLINE` block implicit model
  downloads (reranker ruling); reranker must be explicitly `rrf`.
- **Embed-relay dependency**: relay unit `Before=` + `WantedBy=` the API
  unit, enabled before API start in `start_stack`, `--reconfigure`, and the
  printed deferred commands; invalid `embed-relay.env` fails before any
  durable write in every branch.
- **Env examples**: both files contain no credential material; the blank
  reranker value is the documented explicit-decision prompt; the example
  model id matches `EMBEDDING_PREFIXES` base-id matching.
- **Config optionality**: absent memory block → no client, no boot
  destination row, byte-identical turns (`mod.test.ts:328-331, 499-503`).
- **Cache stability**: recall blocks persisted verbatim pre-model-call,
  materialized immediately before the anchoring user message with stable ids;
  same-anchor fenced retry replaces the orphan; enable/disable is a
  permitted boundary; memory blocks are never fed back into retention or
  recall queries (stored history never contains them; builders read the
  memory-bound projection).
- **#111 transcript ruling**: stored transcripts retain as operator speech
  with a path reference; transcript-less attachments retain nothing
  (`mod.ts:71-86`; `mod.test.ts:238-288`; `runtime-memory.test.ts:417-445`).
- **Reflection latch**: `memory-reflect` never touches `noteRecall` (the
  ruling's carve-out); the search tool does, which is telemetry, not a
  violation.

## 3. Couldn't verify / leads without a written source

- **Live Hindsight wire contract** (0.10-pinned expectations vs the deployed
  1.0.0-slim image): `hindsight.live.test.ts` intentionally unrun per ROE.
  All wire-shape conclusions rest on the pinned OpenAPI expectations in code
  and the fake-server tests.
- **Podman tolerance of the duplicate `Secret=` line** (F3): would need a
  real `podman run` — forbidden. The live stack implies it works today.
- **Whether the mypy gate (F1) was ever green**: no mypy version pin exists
  anywhere; cannot reproduce the original green run.
- **F2 recovery gap**: verified by control-flow reading only; ROE forbids
  executing install.py against real state.
- **Comma-in-lookup driver-opts parsing** (F7): podman behavior unverified.
- **Doc-declared unverified items** remain unverified and unchanged:
  mid-`processing` restart edge (design/memory.md header) and the
  delete→consolidation→observation cascade (`/forget delete` may leave
  derived observations; the doc itself carries this caveat).
- I found no written rule about *where* blocked rows on an **old** target
  must surface in `/memory status` beyond "forgetting is their
  reconciliation path" — current behavior (old-target blocked rows absent
  from the current-bank status counts, parked `deleting` rows visible
  globally) looks deliberate and is tested; not reported as a finding.

---

## Simplifications & code smells (P3, evidence-backed)

1. **Duplicate LLM `Secret=` line** (F3): either drop the static line in
   `goblin-memory-api.container:17` (the installer block always covers the
   LLM key) or make `apply_secret_block` skip names already present
   statically. Today's redundancy is untested against the real shipped file.
2. **`recall()`'s literal defaults** (F6): import `MEMORY_DEFAULTS` like
   `reflect()` does, or drop the unreachable fallbacks — `policy.ts` is the
   single policy owner by design.
3. **`bench.py` `fail() -> None` vs `install.py` `fail() -> NoReturn`**:
   the missing `NoReturn` is itself the cause of mypy's bogus `arg-type`
   error at `bench.py:96` (narrowing defeated). One-line fix; unify the two
   helpers or share one.
4. **`bench.py:417`**: `f"ungraded"` — f-string with no placeholder.
5. **bench.py / test_bench.py / test_healthcheck.py missing from the
   documented validation command** (F9): add them to the docs/memory.md
   offline-validation block (and fix) so the gate covers the shipped files.
6. **test_install.py's implicit re-export access** (`install.os`,
   `install.read_goblin_providers`, … — the attr-defined errors in F1):
   importing from the owning module (`providers`, stdlib) or adding explicit
   re-exports silences the noise and keeps the import graph honest.
7. **`blockedDetail` re-derives the document-id scheme by string surgery**
   (`queue.ts:390-393`: `document_id.includes("/") ? split("/").pop() …`)
   while `documentIdFor` (`mod.ts:307-313`) builds it — the scheme is
   server knowledge per design/memory.md §8 and should live in one helper.
8. **`secret_lookup` docstring vs behavior** (F7): says "trailing newline",
   strips all newlines — align the comment or use `tr -d '\n'`'s honest
   description.
9. **`formatRecallBlock`** (`mod.ts:188-194`) is a wrapper used once in
   production (the unavailable path) plus tests; could be inlined — minor.
10. **`tickNow()`** on the `MemoryWorker` interface (`mod.ts:751-753`)
    bypasses the pause/stopped gates and is used only by tests — a
    test-only seam on a production surface; worth a comment or a narrower
    export.

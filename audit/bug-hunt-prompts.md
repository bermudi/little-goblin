# Bug-hunt prompt pack — goblin v2

One self-contained prompt per area of the tree. Paste a single block into a
fresh session opened at the repo root; that session reads the area's spec and
code and reports findings — it does not fix anything. Run at most 4 hunts
concurrently (operator rule). The working tree may be dirty — hunts read the
tree as it stands.

Every block below is independent: it carries its own scope, spec pointers,
test command, rules of engagement, and report format. Do not paste the header
or the ToC along with it.

## Table of contents — the partition

| # | Area | Scope (detail in the prompt) | Governing spec | Test command |
|---|------|------------------------------|----------------|--------------|
| 1 | Telegram intake & delivery | `src/tg/` | `design/telegram.md` | `bun test src/tg/` |
| 2 | Turn engine & conversation store | `src/runtime.ts`, `src/turn/`, journal, resume, loops, `src/conversation.ts`, `src/rolling.ts` | `design/runtime-turn.md`, `DESIGN.md` | `bun test src/runtime.test.ts src/conversation.test.ts src/turn/ src/turn-journal.test.ts src/turn-journal.crash.test.ts src/turn-resume.test.ts src/loop-detect.test.ts src/rolling.test.ts` |
| 3 | Prompt assembly & model layer | `src/agent/` prompt/providers/stream/thinking/codex (not tools, voice, skills) | `design/model.md`, `DESIGN.md` → Cache stability | `bun test src/agent/prompt.test.ts src/agent/compaction.test.ts src/agent/filter-stream.test.ts src/agent/thinking.test.ts src/agent/providers.test.ts src/agent/provider-errors.test.ts src/agent/models-dev.test.ts src/agent/zai-responses.test.ts src/agent/sniff.test.ts src/agent/title.test.ts src/agent/attachments.test.ts src/agent/image.test.ts src/agent/vision.test.ts src/agent/codex/` |
| 4 | Cache stability & pruning | `src/cache-*.ts`, `src/pruning-marker.ts`, `src/window-capture.ts` | `DESIGN.md` → Cache stability | `bun test src/cache-observation.test.ts src/cache-pruning.test.ts src/pruning-marker.test.ts src/window-capture.test.ts` |
| 5 | Voice — ASR & TTS | `src/agent/{onemin,onemin-speech,recording,transcribe*,tts*}.ts`, `app/src/speech.tsx` | `design/asr.md` | `bun test src/agent/onemin.test.ts src/agent/onemin-speech.test.ts src/agent/recording.test.ts src/agent/transcribe.test.ts src/agent/transcribe-cloud.test.ts src/agent/transcribe-whistle.test.ts src/agent/tts.test.ts src/agent/tts-cloud.test.ts app/src/speech.test.tsx` |
| 6 | Long-term memory | `src/memory/`, `src/runtime-memory.test.ts`, `deploy/memory/` | `design/memory.md` | `bun test src/memory/ src/runtime-memory.test.ts` + `uv run --with pytest pytest <file>` per Python test in `deploy/memory/` |
| 7 | App channel server — HTTP surface | `src/http/`, `src/app-{approvals,link,media,push}.ts`, `src/stateview.ts` | `design/app.md` | `bun test src/http/ src/app-media.test.ts src/app-push.test.ts src/stateview.test.ts` |
| 8 | App client (PWA & mini app) | `app/src/` (minus `speech.tsx`), `app/index.html`, `app/public/`, `app/vite.config.ts`, `app/tsconfig.json` | `design/app.md` | `bun test app/src/` |
| 9 | Subagents, herdr & delegation | `src/subagents/`, `src/{delegations,delegation-lifecycle,subagent-runs,subagent-prompts,spinoff,herdr,harness-trust}.ts` | `design/subagents.md`, `design/delegation.md` | `bun test src/subagents/ src/subagent-runs.test.ts src/delegations.test.ts src/delegation-lifecycle.test.ts src/spinoff.test.ts src/herdr.test.ts src/harness-trust.test.ts` |
| 10 | Agent tools layer | `src/agent/tools/`, `src/agent/turn-tools.ts` | `design/tools.md`, `design/web.md` | `bun test src/agent/tools/ src/agent/turn-tools.test.ts` |
| 11 | Sandbox, podman & desktops | `src/{podman,sandboxes,sandbox-lifecycle,box-files,desktops}.ts`, `deploy/desktop/` | `design/sandbox.md` | `bun test src/podman.test.ts src/sandboxes.test.ts src/sandbox.integration.test.ts src/box-files.test.ts src/desktops.test.ts src/goblin-launch.test.ts` |
| 12 | Mail | `src/mail*.ts`, `src/injection.ts`, `scripts/goblin-mail` | `design/mail.md` | `bun test src/mail.test.ts src/mail-gws.test.ts src/mail-outbox.test.ts src/mail-watcher.test.ts src/injection.test.ts src/goblin-mail.test.ts` |
| 13 | Auth & keys | `src/auth.ts`, `scripts/{mcp,check-auth.ts,check-mcp-config.ts}` | `design/auth.md` | `bun test src/auth.test.ts src/auth.parse.test.ts scripts/check-mcp-config.test.ts` |
| 14 | Health & doctor | `src/{doctor,health,health-sqlite}.ts`, `scripts/{doctor,check-startup.ts,startup-categories.ts}` | `design/doctor.md` | `bun test src/doctor.test.ts src/health.test.ts scripts/doctor.test.ts scripts/check-startup.test.ts` |
| 15 | Programs, scheduler & wake | `src/program*.ts`, `src/{programs,scheduler,wake,wake-store,wake-dispatcher}.ts` | `design/programs.md` | `bun test src/programs.test.ts src/program-proposals.test.ts src/scheduler.test.ts src/wake.test.ts src/wake-store.test.ts src/wake-store.crash.test.ts src/wake-dispatcher.test.ts` |
| 16 | Projects, notes & tags | `src/{projects,notes,tags}.ts`, `src/agent/note-rewrite.ts` | `design/projects.md` | `bun test src/projects.test.ts src/notes.test.ts src/tags.test.ts src/agent/note-rewrite.test.ts` |
| 17 | Skills | `src/skill-*.ts`, `src/reviewer.ts`, `src/agent/{skills,skill-fetch,skill-inject}.ts`, `scripts/backfill-skill-sources.ts`, `deploy/skills/` | `design/skills.md` | `bun test src/skill-decisions.test.ts src/skill-provenance.test.ts src/reviewer.test.ts src/agent/skills.test.ts src/agent/skill-fetch.test.ts scripts/backfill-skill-sources.test.ts` |
| 18 | System1 & responsibility feed | `src/system1.ts`, `src/responsibilit*.ts`, `src/reply-ratings.ts` | `design/system1.md` | `bun test src/system1.test.ts src/responsibilities.test.ts src/responsibility-feed.test.ts src/responsibility-observer.test.ts src/responsibility-service.test.ts src/reply-ratings.test.ts src/handover-loop.test.ts` |
| 19 | Boot, config & core state | `src/{config,config-pins,durable,sqlite,log,proc,targets}.ts`, `src/index.ts` | `DESIGN.md` → Config, State layout, Module map | `bun test src/config.test.ts src/config-pins.test.ts src/boot.test.ts src/durable.test.ts src/log.test.ts src/proc.test.ts` |
| 20 | Ops, install & deploy | `scripts/` deploy/install/publish/checks/audits, `deploy/*.service*` | `docs/operations.md`, `design/setup.md` | `bun test scripts/deploy.test.ts scripts/install.test.ts scripts/install-options.test.ts scripts/check-cache-contracts.test.ts scripts/cache-report.test.ts` |
| 21 | Testkit, fixtures & boundaries | `src/testkit*`, `src/test-helpers/`, `src/{module-boundaries,channel-boundary}.test.ts`, `bunfig.toml` | `AGENTS.md` → Tests, `DESIGN.md` → Test posture | `bun test src/testkit.test.ts src/module-boundaries.test.ts src/channel-boundary.test.ts` |

### Explicit exclusions (checked, not hunted)

- `docs/` — operator documentation, not code. Exception: `docs/operations.md`
  is the *spec* for hunt 20.
- `experimental/pi-approval` — experimental lane, not wired into the build.
- `audit/`, `arch-audit.md`, `README.md` — notes and prose.
- `package.json`, `bun.lock`, `biome.json`, `tsconfig.json`,
  `goblin.json5.example` — build/tool config; exercised via
  `bun run typecheck` and the test suite, not hunted directly.
- `app/dist`, `app/dist.a`, `app/dist.b`, `deploy/memory/__pycache__`,
  `*/testdata/` — generated slots and in-area fixtures.
- `node_modules/`.
- `*.live.test.ts` — env-gated live drift checks; excluded from every hunt by
  the rules of engagement.

---

## Hunt 1 — Telegram intake & delivery

```text
You are hunting bugs in goblin v2 (this repo): a Telegram-native personal AI
agent, Bun + strict TypeScript, prod runs from this very tree. Read-and-report
only — you find bugs, you do not fix them.

Read first (the definition of correct):
- design/telegram.md — every ruling in it is a checkable invariant. Extract
  them as your checklist before reading code.
- AGENTS.md → Guardrails for the tree-wide rules: fail loud (no swallowed
  exceptions; ENOENT → null is the only sanctioned special case); durable
  writes (whole-file state: tmp + fsync + renameSync preserving mode;
  SQLite: WAL + transactions instead); zod validation at every external
  boundary; no `any`; `log` from src/log.ts, never `console`; only src/tg/
  knows grammy — vendor types must not leak past it.
- DESIGN.md → "Domain model" and "The authority rule" for the turn/intake
  contract this channel feeds.

Scope — hunt only these files: src/tg/ (all modules and colocated tests).
Run from the repo root: `bun test src/tg/` and `bun run typecheck`.

What counts as a bug here:
- Violation of any design/telegram.md ruling — cite the section by name.
- Guardrail violations in scoped files (list above).
- Specifics to probe: update validation at the grammy boundary (shape,
  guest/allowedUsers roles — DESIGN.md → Non-goals names the fenced sandbox
  lane rules); intake buffer coalescing and its flush at epoch change;
  delivery authority re-checked when each queued Telegram action executes
  (not only when queued — DESIGN.md → The authority rule); flood-wait and
  send-retry paths; the approval gates (mail, program, skill) and their
  channel-neutral owners (src/channel-boundary.test.ts pins the mechanism —
  is the boundary still mechanical, or has a Telegram import crept into
  shared owners?); media intake (size/type validation before it reaches the
  store); topic placeholder rename one-shot vs explicit operator rename;
  the rolling-DM bell/navigation paths that call into src/app-link.ts.

Out of scope (note pointers, don't chase): the turn engine that consumes
intake (hunt 2), the app channel (hunt 7), tool execution (hunt 10), mail
machinery behind src/tg/mail-approval.ts (hunt 12). Style/naming opinions,
test-count opinions.

Rules of engagement:
- No production-code edits, no fixes, no commits, no installs; scratch notes
  only under /tmp.
- Never touch live services: no Telegram API calls, no systemctl, no herdr,
  no podman. Never run env-gated live drift tests (GOBLIN_*_LIVE=1).
- Never read or print secret values — structure only.
- A finding requires: file:line, the violated rule quoted with doc + section,
  and the triggering input/path or a sketch of the test that would catch it.
  Unverified suspicions are leads, labeled as such.

Report:
1. Findings, most severe first. Severity: P0 data loss / crash / security
   hole on a normal path; P1 wrong behavior on a plausible path; P2 broken
   edge or error path; P3 invariant hygiene.
2. What you checked and found clean (so later passes can skip it).
3. What you couldn't verify, and any rule you suspected but couldn't trace
   to a written source — say so, don't invent citations.
```

## Hunt 2 — Turn engine & conversation store

```text
You are hunting bugs in goblin v2 (this repo): a Telegram-native personal AI
agent, Bun + strict TypeScript, prod runs from this very tree. Read-and-report
only — you find bugs, you do not fix them.

Read first (the definition of correct):
- design/runtime-turn.md — the architecture ruling for the turn. Extract its
  invariants as your checklist before reading code.
- DESIGN.md → "Domain model" and "The authority rule": conversation identity
  is its channel address; a turn re-checks its (conversationId, epoch)
  authority around every await; fenced turns abort quietly and log; the sole
  post-fence exception is the cancellation edit stamping "⏹ superseded" from
  displayed text only. Steering folds at prepareStep; the ownership
  high-water mark bounds anchors (durable seq, never app-controlled message
  id); a submit that cannot be prepared errors its own delivery and is never
  re-queued (poison pill); /stop fences the running turn and drops queued
  ones; shutdown fences every lane under a bounded budget; boot never
  auto-retries a half-run turn.
- AGENTS.md → Guardrails: fail loud; durable writes (src/conversation.ts is
  SQLite: WAL + transactions, NOT tmp/fsync/rename — its own header says so);
  zod at boundaries; no `any`; `log` from src/log.ts.

Scope — hunt only these files: src/runtime.ts, src/conversation.ts,
src/turn/ (admission, finish, itemize, overflow, retry-guard,
skill-attribution, skill-view, state, stream, view), src/turn-journal.ts,
src/turn-resume.ts, src/loop-detect.ts, src/loop-watchdog.ts, src/rolling.ts,
plus their colocated tests.
Run from the repo root: `bun test src/runtime.test.ts src/conversation.test.ts
src/turn/ src/turn-journal.test.ts src/turn-journal.crash.test.ts
src/turn-resume.test.ts src/loop-detect.test.ts src/rolling.test.ts` and
`bun run typecheck`.

What counts as a bug here:
- Violation of any ruling above — cite doc + section.
- Specifics to probe: epoch bump rules (which commands bump, which must not —
  model/thinking edits never bump); the journal's crash classification (a row
  still `running` at open → `interrupted`, surfaced as boot notice; graceful
  shutdown stamps `fenced`); resume riding journaled rows only; overflow
  recovery keeping the turn's captured selection; steered input not
  re-recalled; the rolling DM resolution (dm:<chat> pins the current
  conversation, never one concrete row); loop detection false positives on
  legitimately repetitive work; unserialized queue access on the
  per-conversation lane.

Out of scope (note pointers, don't chase): Telegram delivery mechanics
(hunt 1), prompt assembly and model calls (hunt 3), cache pruning policy
(hunt 4), the HTTP stream surface (hunt 7), subagent lanes (hunt 9).

Rules of engagement:
- No production-code edits, no fixes, no commits, no installs; scratch notes
  only under /tmp.
- Never touch live services: no systemctl, no Telegram, no herdr, no podman.
  Never run env-gated live drift tests (GOBLIN_*_LIVE=1).
- Never read or print secret values — structure only.
- A finding requires: file:line, the violated rule quoted with doc + section,
  and the triggering input/path or a sketch of the test that would catch it.
  Unverified suspicions are leads, labeled as such.

Report:
1. Findings, most severe first. Severity: P0 data loss / crash / security
   hole on a normal path; P1 wrong behavior on a plausible path; P2 broken
   edge or error path; P3 invariant hygiene.
2. What you checked and found clean (so later passes can skip it).
3. What you couldn't verify, and any rule you suspected but couldn't trace
   to a written source — say so, don't invent citations.
```

## Hunt 3 — Prompt assembly & model layer

```text
You are hunting bugs in goblin v2 (this repo): a Telegram-native personal AI
agent, Bun + strict TypeScript, prod runs from this very tree. Read-and-report
only — you find bugs, you do not fix them.

Read first (the definition of correct):
- design/model.md — the model layer ruling. Extract its invariants as your
  checklist before reading code.
- DESIGN.md → "Cache stability": the request for turn N+1 is the request for
  turn N with new content appended — bytes already sent are never rewritten.
  The system prompt is frozen per conversation (built at the first turn; no
  clock, no per-turn variability); operator file edits inject at conversation
  boundaries only. Attachment representation is a pure function of the
  catalog's modalities; no whole-turn budget, no newest-first eviction.
- AGENTS.md → Guardrails: fail loud; zod at external boundaries; no `any`;
  `log` from src/log.ts; every model call logs usage with the cached split
  and a request prefix hash.

Scope — hunt only these files in src/agent/ (NOT tools/, NOT the voice files,
NOT the skill files — those are other hunts): prompt.ts, compaction.ts,
filter-stream.ts, thinking.ts, providers.ts, provider-errors.ts, models-dev.ts,
zai-responses.ts, sniff.ts, title.ts, step.ts, cache-contracts.ts,
attachments.ts, image.ts, vision.ts, catalog-fetch.ts, the codex/ directory,
plus their colocated tests.
Run from the repo root: `bun test src/agent/prompt.test.ts
src/agent/compaction.test.ts src/agent/filter-stream.test.ts
src/agent/thinking.test.ts src/agent/providers.test.ts
src/agent/provider-errors.test.ts src/agent/models-dev.test.ts
src/agent/zai-responses.test.ts src/agent/sniff.test.ts src/agent/title.test.ts
src/agent/attachments.test.ts src/agent/image.test.ts src/agent/vision.test.ts
src/agent/codex/` and `bun run typecheck`.

What counts as a bug here:
- Violation of any ruling above — cite doc + section.
- Specifics to probe: anything that injects per-turn variability into the
  system prompt or rewrites already-sent prefix bytes (each sanctioned
  one-time rewrite is enumerated in DESIGN.md → Cache stability — everything
  else that moves the request hash is a bug); attachment re-computation
  happening more often than the sanctioned once; compaction starting a fresh
  stable prefix as an explicit logged boundary (never silent eviction);
  provider-error paths that swallow or misclassify; streaming filter bugs
  that drop or duplicate content parts; thinking-level handling; catalog
  refresh changing modalities without the sanctioned one-time recompute;
  unvalidated provider/catalog responses (models-dev fetch is external
  input — zod it).

Out of scope (note pointers, don't chase): tool execution (hunt 10), voice
modules (hunt 5), skill resolution (hunt 17), turn admission/authority
(hunt 2), cache pruning policy (hunt 4).

Rules of engagement:
- No production-code edits, no fixes, no commits, no installs; scratch notes
  only under /tmp.
- Never touch live services: no model API calls (tests fake the provider),
  no systemctl, no Telegram. Never run env-gated live drift tests
  (GOBLIN_*_LIVE=1).
- Never read or print secret values — provider configs are read as structure
  only, never their auth fields.
- A finding requires: file:line, the violated rule quoted with doc + section,
  and the triggering input/path or a sketch of the test that would catch it.
  Unverified suspicions are leads, labeled as such.

Report:
1. Findings, most severe first. Severity: P0 data loss / crash / security
   hole on a normal path; P1 wrong behavior on a plausible path; P2 broken
   edge or error path; P3 invariant hygiene.
2. What you checked and found clean (so later passes can skip it).
3. What you couldn't verify, and any rule you suspected but couldn't trace
   to a written source — say so, don't invent citations.
```

## Hunt 4 — Cache stability & pruning

```text
You are hunting bugs in goblin v2 (this repo): a Telegram-native personal AI
agent, Bun + strict TypeScript, prod runs from this very tree. Read-and-report
only — you find bugs, you do not fix them.

Read first (the definition of correct):
- DESIGN.md → "Cache stability" — read it twice; it is this area's entire
  spec. Key rulings: prefix-append invariant; pruning is opt-in via the
  bootstrap-only `cachePruning` config block (profiles of route key +
  settings hash); a committed projection rewrites the model-facing view ONLY
  — the `events` row is never modified — and the marker replays
  byte-identically on every later read and restart; new batches commit only
  between turns, when the profile is unexpired and observed receipts don't
  contradict the presumed expiry; a contradiction suspends new batches but
  never committed rows; prefix relations (first/same/append/rewrite) are
  structural facts, never proof of warmth or provider bug; cache-call
  evidence has no automatic age-based deletion or prompt-hash stripping.
- design/runtime-turn.md where it references compaction/pruning.
- AGENTS.md → Guardrails (fail loud, durable writes, zod, no `any`,
  log not console).

Scope — hunt only these files: src/cache-observation.ts, src/cache-pruning.ts,
src/cache-pruning-policy.ts, src/pruning-marker.ts, src/window-capture.ts,
plus their colocated tests.
Run from the repo root: `bun test src/cache-observation.test.ts
src/cache-pruning.test.ts src/pruning-marker.test.ts
src/window-capture.test.ts` and `bun run typecheck`.

What counts as a bug here:
- Violation of any ruling above — cite doc + section.
- Specifics to probe: any code path that mutates an `events` row (that is
  P0 territory); marker replay drifting across restart (serialize once,
  compare bytes); batch commits landing mid-turn or on an expired/
  contradicted profile; suspension logic that unwinds committed rows;
  treating a zero-cache-read call as automatic proof of provider bug or
  warmth; window-capture storing a reconstruction instead of the exact
  outbound prompt of the final model call (its header pins "never a
  reconstruction"); usage receipts parsed without zod.

Out of scope (note pointers, don't chase): the turn boundaries that trigger
commits (hunt 2), prompt assembly (hunt 3), config parsing of the
cachePruning block (hunt 19 — the policy semantics stay here).

Rules of engagement:
- No production-code edits, no fixes, no commits, no installs; scratch notes
  only under /tmp.
- Never touch live services: no systemctl, no Telegram, no pods. Never run
  env-gated live drift tests (GOBLIN_*_LIVE=1).
- Never read or print secret values — structure only.
- A finding requires: file:line, the violated rule quoted with doc + section,
  and the triggering input/path or a sketch of the test that would catch it.
  Unverified suspicions are leads, labeled as such.

Report:
1. Findings, most severe first. Severity: P0 data loss / crash / security
   hole on a normal path; P1 wrong behavior on a plausible path; P2 broken
   edge or error path; P3 invariant hygiene.
2. What you checked and found clean (so later passes can skip it).
3. What you couldn't verify, and any rule you suspected but couldn't trace
   to a written source — say so, don't invent citations.
```

## Hunt 5 — Voice (ASR & TTS)

```text
You are hunting bugs in goblin v2 (this repo): a Telegram-native personal AI
agent, Bun + strict TypeScript, prod runs from this very tree. Read-and-report
only — you find bugs, you do not fix them.

Read first (the definition of correct):
- design/asr.md — the speech recognition ruling. Extract its invariants as
  your checklist before reading code.
- DESIGN.md → "Non-goals" item 2: voice notes are chat-native — a broken
  voice path is a bug against the design, not a deferral.
- AGENTS.md → Guardrails (fail loud, zod at external boundaries, no `any`,
  log from src/log.ts, durable writes).

Scope — hunt only these files: src/agent/onemin.ts, src/agent/onemin-speech.ts,
src/agent/recording.ts, src/agent/transcribe.ts, src/agent/transcribe-cloud.ts,
src/agent/transcribe-whistle.ts, src/agent/tts.ts, src/agent/tts-cloud.ts,
app/src/speech.tsx, plus their colocated tests.
Run from the repo root: `bun test src/agent/onemin.test.ts
src/agent/onemin-speech.test.ts src/agent/recording.test.ts
src/agent/transcribe.test.ts src/agent/transcribe-cloud.test.ts
src/agent/transcribe-whistle.test.ts src/agent/tts.test.ts
src/agent/tts-cloud.test.ts app/src/speech.test.tsx` and
`bun run typecheck`.

What counts as a bug here:
- Violation of any design/asr.md ruling — cite the section.
- Specifics to probe: local-vs-cloud fallback (does a cloud failure degrade
  loudly or silently return nothing?); audio format/mime handling at the
  boundaries (Telegram voice, app recordings); provider responses parsed
  without zod; temp audio files leaking (not cleaned on error paths);
  duration/size limits enforced where the doc says; TTS output delivered to
  the right sink with failures propagated; the recording capture path in the
  app dropping the tail of an utterance or double-submitting.

Out of scope (note pointers, don't chase): the speak/transcribe agent tools
(hunt 10), Telegram media intake plumbing (hunt 1), generic streaming
(hunt 3).

Rules of engagement:
- No production-code edits, no fixes, no commits, no installs; scratch notes
  only under /tmp.
- Never touch live services: no transcription/TTS API calls (tests fake the
  providers), no Telegram, no systemctl. Never run env-gated live drift
  tests (GOBLIN_*_LIVE=1).
- Never read or print secret values — structure only.
- A finding requires: file:line, the violated rule quoted with doc + section,
  and the triggering input/path or a sketch of the test that would catch it.
  Unverified suspicions are leads, labeled as such.

Report:
1. Findings, most severe first. Severity: P0 data loss / crash / security
   hole on a normal path; P1 wrong behavior on a plausible path; P2 broken
   edge or error path; P3 invariant hygiene.
2. What you checked and found clean (so later passes can skip it).
3. What you couldn't verify, and any rule you suspected but couldn't trace
   to a written source — say so, don't invent citations.
```

## Hunt 6 — Long-term memory

```text
You are hunting bugs in goblin v2 (this repo): a Telegram-native personal AI
agent, Bun + strict TypeScript, prod runs from this very tree. Read-and-report
only — you find bugs, you do not fix them.

Read first (the definition of correct):
- design/memory.md — the memory system ruling. Extract its invariants as your
  checklist before reading code.
- DESIGN.md → "Product boundary" and "State layout": memory is an optional
  separate Hindsight service backed by PostgreSQL; it does NOT migrate the
  conversation store.
- AGENTS.md → Live services: embeddings are local ollama `embeddinggemma`
  via `goblin-embed-relay`; tailscale or ollama down = the memory API can't
  embed or boot; changing the embedding model with a non-empty bank is a
  re-index, not an env edit. AGENTS.md → Guardrails for the rest.

Scope — hunt only these files: src/memory/ (destinations, forget, hindsight,
outage, policy, queue, screen, mod), src/runtime-memory.test.ts, and
deploy/memory/ (install.py, start.py, providers.py, healthcheck.py, bench.py,
their test_*.py files, the .container/.pod/.service/.timer/.network/.volume
units, and the .env examples).
Run: from the repo root `bun test src/memory/ src/runtime-memory.test.ts`
and `bun run typecheck`; from deploy/memory run each Python test offline —
`uv run --with pytest pytest test_install.py` (same for test_config.py,
test_healthcheck.py, test_providers.py, test_bench.py). The Python tests are
offline with synthetic values only; keep them that way.

What counts as a bug here:
- Violation of any design/memory.md ruling — cite the section.
- Specifics to probe: outage behavior (memory down must degrade the chat
  path loudly-but-gracefully per the doc — find where it instead crashes the
  turn or silently drops writes); queue durability across restarts; forget
  semantics actually deleting what the doc says (and nothing else);
  destination policy enforcement; hindsight client validating API responses
  with zod; install.py writing podman secrets/env (credentials must only
  ever be lookup commands — read deploy/memory/install.py's header contract
  and check every code path against it); healthcheck.py exiting correctly on
  each failure mode; the embed-relay dependency making boot fail loud.
- Python side must type-check and pass; a red Python test is a finding.

Out of scope (note pointers, don't chase): the memory agent tool (hunt 10),
the runtime's memory admission toggle (hunt 2), unit installation on the
host (hunt 20).

Rules of engagement:
- No production-code edits, no fixes, no commits, no installs; scratch notes
  only under /tmp. Do NOT run install.py or start.py against real state.
- Never touch live services: no podman, no ollama, no tailscale changes, no
  systemctl, no Postgres. Never run env-gated live drift tests
  (src/memory/hindsight.live.test.ts stays unrun).
- NEVER read or print secret values: the deploy/memory/*.env.example files
  are fine (examples), but no real env files, no podman secret dumps.
- A finding requires: file:line, the violated rule quoted with doc + section,
  and the triggering input/path or a sketch of the test that would catch it.
  Unverified suspicions are leads, labeled as such.

Report:
1. Findings, most severe first. Severity: P0 data loss / crash / security
   hole on a normal path; P1 wrong behavior on a plausible path; P2 broken
   edge or error path; P3 invariant hygiene.
2. What you checked and found clean (so later passes can skip it).
3. What you couldn't verify, and any rule you suspected but couldn't trace
   to a written source — say so, don't invent citations.
```

## Hunt 7 — App channel server (HTTP surface)

```text
You are hunting bugs in goblin v2 (this repo): a Telegram-native personal AI
agent, Bun + strict TypeScript, prod runs from this very tree. Read-and-report
only — you find bugs, you do not fix them.

Read first (the definition of correct):
- design/app.md — the App channel ruling (UIMessage stream endpoints, the
  PWA/mini-app split, streaming members, settings saves). Extract its
  invariants as your checklist before reading code.
- DESIGN.md → "Product boundary": the app client is the one client, two
  doors; the channels are disjoint; the one sanctioned crossing is the
  Telegram spin-off.
- AGENTS.md → Guardrails: src/http serves app/dist under /app/ and /t/ with
  a fail-loud 500 + log line when the build is missing; the built client is
  live per request (dist is a symlink to the published slot, resolved per
  request). Fail loud, zod at boundaries, no `any`, log not console.

Scope — hunt only these files: src/http/ (every module: app-* routes, auth,
check, mod, operator routes, app-wire, app-shared, app-sse, app-dist,
app-testing), src/app-approvals.ts, src/app-link.ts, src/app-media.ts,
src/app-push.ts, src/stateview.ts, plus their colocated tests.
Run from the repo root: `bun test src/http/ src/app-media.test.ts
src/app-push.test.ts src/stateview.test.ts` and `bun run typecheck`.

What counts as a bug here:
- Violation of any design/app.md ruling — cite the section.
- Specifics to probe: SSE/streaming backpressure and member fan-out (a
  merged or steered second client watches the whole reply — DESIGN.md →
  Domain model); settings save freshness riding If-Match (competing saves
  must not silently overwrite); app auth on every route that needs it;
  stateview containment (router zod-validates names AND the realpath
  re-check defeats lexical traversal and symlink indirection; serves real
  files, never links — its header pins this); push subscription validation;
  media upload bounds; app-dist resolving the symlink per request and
  500-ing loudly on missing build; unvalidated UIMessage parts arriving
  from the client (external input — zod); conversation id minting staying
  client-side per the doc.

Out of scope (note pointers, don't chase): the React client itself (hunt 8),
the turn engine behind streams (hunt 2), spin-off orchestration (hunt 9),
push/service workers client-side (hunt 8).

Rules of engagement:
- No production-code edits, no fixes, no commits, no installs; scratch notes
  only under /tmp.
- Never touch live services: no real HTTP binds beyond what tests do, no
  systemctl, no Telegram. Never run env-gated live drift tests
  (GOBLIN_*_LIVE=1).
- Never read or print secret values (auth tokens, push keys) — structure
  only.
- A finding requires: file:line, the violated rule quoted with doc + section,
  and the triggering input/path or a sketch of the test that would catch it.
  Unverified suspicions are leads, labeled as such.

Report:
1. Findings, most severe first. Severity: P0 data loss / crash / security
   hole on a normal path; P1 wrong behavior on a plausible path; P2 broken
   edge or error path; P3 invariant hygiene.
2. What you checked and found clean (so later passes can skip it).
3. What you couldn't verify, and any rule you suspected but couldn't trace
   to a written source — say so, don't invent citations.
```

## Hunt 8 — App client (PWA & Telegram mini app)

```text
You are hunting bugs in goblin v2 (this repo): a Telegram-native personal AI
agent, Bun + strict TypeScript, prod runs from this very tree. The app client
is Vite + React + strict TS, `@ai-sdk/react` useChat over UIMessage stream
endpoints. Read-and-report only — you find bugs, you do not fix them.

Read first (the definition of correct):
- design/app.md — the App channel ruling, client side. Extract its
  invariants as your checklist before reading code.
- AGENTS.md → Guardrails: the app client is the one client, two doors — no
  second client, no unchecked client .js; wire types are imported from
  server sources so config schema changes break typecheck, not the page;
  app/tsconfig.json joins `bun run typecheck`; telegram-webapp.d.ts must
  stay out of the server program (it changes how linkedom's parseHTML
  resolves in src/agent/tools/fetch.ts).
- AGENTS.md → Live services: app/dist is a symlink to the published slot;
  `bun run app:build` only stages dist.next.

Scope — hunt only these files: everything under app/src/ EXCEPT
app/src/speech.tsx (voice hunt owns it) — App.tsx, ChatView, WindowView,
views (Memory, Note, Project, Settings, State, Log, Attention, Operator,
Approvals, InterruptedTurns, PushControls, ResponsibilityFeed, ThreadSources,
SkillPicker/Sheet), Composer and the draft modules, markdown.tsx, api.ts,
telegram.ts, url.ts, chatWidth.ts, tools/ (tool part renderers), ui/
(incl. Chart, HtmlFrame, UiPart), sw/service-worker tests — plus
app/index.html, app/public/, app/vite.config.ts, app/tsconfig.json.
Run from the repo root: `bun test app/src/` and `bun run typecheck`.

What counts as a bug here:
- Violation of any design/app.md ruling — cite the section.
- Specifics to probe: navigation races (App.navigation-races.test.ts exists —
  what it doesn't cover); streaming-state handling around interrupt/steer
  (does a fenced turn leave the composer stuck?); drafts surviving
  navigation; telegram.ts detecting the mini-app environment and adapting
  correctly with graceful degradation outside Telegram; wire types imported
  from server sources (a redefined copy in the client is a finding);
  HtmlFrame/Chart sanitization (generative UI renders agent-produced HTML —
  what contains it?); the tool part renderers mapping every server part
  type or failing visibly; markdown rendering of adversarial content;
  settingsDraft/settingsSave racing a concurrent save (If-Match is the
  server's job — does the client respect the conflict response?);
  unchecked `any` or non-null assertions hiding unvalidated server data.

Out of scope (note pointers, don't chase): the HTTP endpoints themselves
(hunt 7), voice capture (hunt 5), the publish/dist-slot mechanics (hunt 20).

Rules of engagement:
- No production-code edits, no fixes, no commits, no installs; scratch notes
  only under /tmp. Do not run `bun run app:build` (it stages dist.next —
  leave publishing alone).
- Never touch live services: no Telegram, no systemctl. Never run env-gated
  live drift tests (GOBLIN_*_LIVE=1).
- Never read or print secret values — structure only.
- A finding requires: file:line, the violated rule quoted with doc + section,
  and the triggering input/path or a sketch of the test that would catch it.
  Unverified suspicions are leads, labeled as such.

Report:
1. Findings, most severe first. Severity: P0 data loss / crash / security
   hole on a normal path; P1 wrong behavior on a plausible path; P2 broken
   edge or error path; P3 invariant hygiene.
2. What you checked and found clean (so later passes can skip it).
3. What you couldn't verify, and any rule you suspected but couldn't trace
   to a written source — say so, don't invent citations.
```

## Hunt 9 — Subagents, herdr & delegation

```text
You are hunting bugs in goblin v2 (this repo): a Telegram-native personal AI
agent, Bun + strict TypeScript, prod runs from this very tree. Read-and-report
only — you find bugs, you do not fix them.

Read first (the definition of correct):
- design/subagents.md and design/delegation.md — extract their rulings as
  your checklist before reading code.
- AGENTS.md → Guardrails: only src/subagents/ knows pi-durable/pi-ai/chord;
  the herdr and harness-trust wire contracts live in src/herdr.ts /
  src/harness-trust.ts; domain modules see adapter types, never vendor types
  (src/module-boundaries.test.ts enforces the importable cases).
- AGENTS.md → Live services: panes run bermudi's interactive zsh — aliases
  already add no-approval flags; harness args repeating them is fatal. Herdr
  probing goes to throwaway named sessions only.

Scope — hunt only these files: src/subagents/ (admission, approval-gate,
crash, drain, env, errors, kill.driver, models, mod, podman, recovery,
row-access, run-doc, settle, testing, tools, transfer), src/subagent-runs.ts,
src/subagent-prompts.ts, src/delegations.ts, src/delegation-lifecycle.ts,
src/spinoff.ts, src/herdr.ts, src/harness-trust.ts, plus their colocated
tests.
Run from the repo root: `bun test src/subagents/ src/subagent-runs.test.ts
src/delegations.test.ts src/delegation-lifecycle.test.ts src/spinoff.test.ts
src/herdr.test.ts src/harness-trust.test.ts` and `bun run typecheck`.

What counts as a bug here:
- Violation of any ruling in the two design docs — cite doc + section.
- Specifics to probe: vendor imports leaking outside src/subagents/;
  admission/approval gates bypassable; crash and recovery paths losing run
  rows or double-settling; drain killing the wrong lanes or missing its
  budget; settle/transfer mutating rows non-atomically; row-access scoping
  (which sessions may read which rows); env construction injecting secrets
  into child environments beyond the sanctioned pass-keys lane; spin-off
  forking before launch settles and rolling back an unstarted launch by its
  pin (src/spinoff.ts header); harness-trust verification skipping
  unverified cases instead of failing closed; herdr wire parsing of
  unexpected frames.

Out of scope (note pointers, don't chase): the delegate/herdr/subagent agent
tools (hunt 10 — thin wrappers over this machinery), the sandbox the
delegation runs in (hunt 11), the app conversation a spin-off creates
(hunt 7).

Rules of engagement:
- No production-code edits, no fixes, no commits, no installs; scratch notes
  only under /tmp.
- Never touch live services: NEVER start or message herdr sessions (no
  `herdr --session ...`), no podman, no systemctl. Never run env-gated live
  drift tests (src/herdr.live.test.ts, src/subagents/live.test.ts,
  src/harness-trust.live.test.ts stay unrun).
- Never read or print secret values — structure only.
- A finding requires: file:line, the violated rule quoted with doc + section,
  and the triggering input/path or a sketch of the test that would catch it.
  Unverified suspicions are leads, labeled as such.

Report:
1. Findings, most severe first. Severity: P0 data loss / crash / security
   hole on a normal path; P1 wrong behavior on a plausible path; P2 broken
   edge or error path; P3 invariant hygiene.
2. What you checked and found clean (so later passes can skip it).
3. What you couldn't verify, and any rule you suspected but couldn't trace
   to a written source — say so, don't invent citations.
```

## Hunt 10 — Agent tools layer

```text
You are hunting bugs in goblin v2 (this repo): a Telegram-native personal AI
agent, Bun + strict TypeScript, prod runs from this very tree. Read-and-report
only — you find bugs, you do not fix them.

Read first (the definition of correct):
- design/tools.md — the tool layer ruling. design/web.md — the web access
  ruling (fetch/search). Extract their invariants as your checklist.
- DESIGN.md → "State layout": workspace/ is the agent's home — every tool
  runs there.
- AGENTS.md → Guardrails: tool args are external input — zod at the
  boundary; src/agent/tools/fetch.ts uses linkedom parseHTML, and
  app/src/telegram-webapp.d.ts must stay out of the server program or that
  resolution changes; fail loud, no `any`, log every tool call.

Scope — hunt only these files: src/agent/tools/ (bash, delegate, desktop,
edit, fetch, herdr, history, image, mail, memory, memory-reflect, mod, note,
paths, program, read, responsibility, sandbox, script, script-worker, search,
send, speak, subagent, transcribe, truncate, ui-schema, ui, vision, web,
write), src/agent/turn-tools.ts, plus their colocated tests.
Run from the repo root: `bun test src/agent/tools/ src/agent/turn-tools.test.ts`
and `bun run typecheck`.

What counts as a bug here:
- Violation of any design/tools.md or design/web.md ruling — cite doc +
  section.
- Specifics to probe: path confinement (every file tool resolves inside
  workspace/ — paths.ts is the chokepoint; escape via .., symlinks, or
  absolute paths is P0); zod schemas rejecting what the doc rejects and
  accepting what it accepts; truncate bounds enforced before results enter
  history; bash/script timeouts and output caps (boundedRun always settles —
  SIGTERM → grace → SIGKILL per src/proc.ts); script-worker lifecycle
  (orphaned workers, unbounded concurrency); fetch parsing untrusted HTML
  safely (script/iframe stripping, redirect handling, content-type checks);
  send/speak addressing (can a tool message an arbitrary chat?); tool
  results logged with the fields to reconstruct the call; ui-schema
  validating generated UI before it reaches the client.

Out of scope (note pointers, don't chase): the machinery behind delegate/
subagent/herdr tools (hunt 9), sandboxes behind the sandbox tool (hunt 11),
mail behind the mail tool (hunt 12), memory behind memory tools (hunt 6),
turn admission of tool results (hunt 2), the client renderers (hunt 8).

Rules of engagement:
- No production-code edits, no fixes, no commits, no installs; scratch notes
  only under /tmp.
- Never touch live services: no network fetches beyond what tests fake, no
  herdr, no podman, no Telegram sends, no systemctl. Never run env-gated
  live drift tests (GOBLIN_*_LIVE=1).
- Never read or print secret values — structure only.
- A finding requires: file:line, the violated rule quoted with doc + section,
  and the triggering input/path or a sketch of the test that would catch it.
  Unverified suspicions are leads, labeled as such.

Report:
1. Findings, most severe first. Severity: P0 data loss / crash / security
   hole on a normal path; P1 wrong behavior on a plausible path; P2 broken
   edge or error path; P3 invariant hygiene.
2. What you checked and found clean (so later passes can skip it).
3. What you couldn't verify, and any rule you suspected but couldn't trace
   to a written source — say so, don't invent citations.
```

## Hunt 11 — Sandbox, podman & desktops

```text
You are hunting bugs in goblin v2 (this repo): a Telegram-native personal AI
agent, Bun + strict TypeScript, prod runs from this very tree. Read-and-report
only — you find bugs, you do not fix them.

Read first (the definition of correct):
- design/sandbox.md — the sandbox ruling. Extract its invariants as your
  checklist before reading code.
- DESIGN.md → "Non-goals": anyone who is not the operator appears only as a
  fenced sandbox lane; the allowedUsers slice is fenced — sandboxed turns +
  standing sandbox DMs, guest persona + `search` only, memory-excluded, no
  app doors, no sandbox `fetch`.
- AGENTS.md → Live services: quadlet HealthCmd takes no shell
  metacharacters (podman 5.4 CMD-SHELL re-quoting caused restart loops);
  healthchecks are mounted scripts. The podman wire contract lives only in
  src/podman.ts.

Scope — hunt only these files: src/podman.ts, src/sandboxes.ts,
src/sandbox-lifecycle.ts, src/box-files.ts, src/desktops.ts, plus colocated
tests (src/podman.test.ts, src/sandboxes.test.ts,
src/sandbox.integration.test.ts, src/box-files.test.ts, src/desktops.test.ts,
src/goblin-launch.test.ts) and deploy/desktop/ (Containerfile,
goblin-desktop-session, goblin-launch).
Run from the repo root: `bun test src/podman.test.ts src/sandboxes.test.ts
src/sandbox.integration.test.ts src/box-files.test.ts src/desktops.test.ts
src/goblin-launch.test.ts` and `bun run typecheck`.

What counts as a bug here:
- Violation of any design/sandbox.md ruling — cite the section.
- Specifics to probe: lane fencing (can a sandboxed turn reach operator
  state, app doors, memory, or fetch? each is a named fence in the docs);
  lifecycle leaks (sandbox not torn down on turn crash, stale registry rows
  after podman restart); box-files transfer path validation; desktops
  registry (sqlite) consistency across crashes; goblin-launch dispatch
  (root must dispatch THROUGH setpriv to the fixed desk uid/gid, desk
  dispatches directly, any other caller refused, nothing steerable by env —
  src/goblin-launch.test.ts pins this; check the script itself for
  divergence); Containerfile healthcheck shape; podman command construction
  (argument injection via user-controlled names).

Out of scope (note pointers, don't chase): subagent admission policy
(hunt 9), the sandbox/desktop agent tools (hunt 10), unit installation
(hunt 20).

Rules of engagement:
- No production-code edits, no fixes, no commits, no installs; scratch notes
  only under /tmp.
- Never touch live services: NEVER run podman (no image pulls, no container
  starts), no systemctl, no real setpriv. Never run env-gated live drift
  tests (src/podman.live.test.ts, src/desktops.live.test.ts stay unrun).
- Never read or print secret values — structure only.
- A finding requires: file:line, the violated rule quoted with doc + section,
  and the triggering input/path or a sketch of the test that would catch it.
  Unverified suspicions are leads, labeled as such.

Report:
1. Findings, most severe first. Severity: P0 data loss / crash / security
   hole on a normal path; P1 wrong behavior on a plausible path; P2 broken
   edge or error path; P3 invariant hygiene.
2. What you checked and found clean (so later passes can skip it).
3. What you couldn't verify, and any rule you suspected but couldn't trace
   to a written source — say so, don't invent citations.
```

## Hunt 12 — Mail

```text
You are hunting bugs in goblin v2 (this repo): a Telegram-native personal AI
agent, Bun + strict TypeScript, prod runs from this very tree. Read-and-report
only — you find bugs, you do not fix them.

Read first (the definition of correct):
- design/mail.md — the mail ruling. Extract its invariants as your checklist
  before reading code.
- File-header contracts you must verify code against: src/mail-outbox.ts —
  "`send` never sends: it queues a pending row and the operator's tap decides
  it; rows survive restarts; every transition logs the recipient domain —
  never the body." src/injection.ts — "Fail-open: a System1Error never
  blocks reads; anything else propagates loud. Hard boundary: readonly Gmail
  scopes — the checker only scores already-fetched text, it never grants
  write authority."
- AGENTS.md → Guardrails (fail loud, durable writes, zod, no `any`,
  log not console); the gws wire contract lives only in src/mail-gws.ts.

Scope — hunt only these files: src/mail.ts, src/mail-approval.ts,
src/mail-gws.ts, src/mail-outbox.ts, src/mail-watcher.ts, src/injection.ts,
scripts/goblin-mail, plus colocated tests (src/mail.test.ts,
src/mail-gws.test.ts, src/mail-outbox.test.ts, src/mail-watcher.test.ts,
src/injection.test.ts, src/goblin-mail.test.ts — the last drives the real
shell script with a fake gws on PATH).
Run from the repo root: `bun test src/mail.test.ts src/mail-gws.test.ts
src/mail-outbox.test.ts src/mail-watcher.test.ts src/injection.test.ts
src/goblin-mail.test.ts` and `bun run typecheck`.

What counts as a bug here:
- Violation of any design/mail.md ruling — cite the section.
- Specifics to probe: any code path where the agent's send actually sends
  without the operator's tap; pending rows lost or double-executed across
  restarts; injection checker granting or exercising any write scope;
  fail-open widening beyond System1Error; logs anywhere carrying message
  bodies, subjects, or addresses beyond the sanctioned recipient domain;
  watcher polling error paths (does a transient gws failure kill the
  watcher loop?); gws responses parsed without zod; the shell script's
  argv/quoting handling (it runs with real credentials in prod).

Out of scope (note pointers, don't chase): the Telegram approval UI over
mail (hunt 1), the mail agent tool (hunt 10), system1 itself (hunt 18).

Rules of engagement:
- No production-code edits, no fixes, no commits, no installs; scratch notes
  only under /tmp.
- Never touch live services: no gws, no Gmail, no mail send of any kind, no
  systemctl. Never run env-gated live drift tests (src/mail-gws.live.test.ts
  stays unrun).
- Never read or print secret values — structure only. This area is full of
  credentials; when in doubt, don't open the file.
- A finding requires: file:line, the violated rule quoted with doc + section,
  and the triggering input/path or a sketch of the test that would catch it.
  Unverified suspicions are leads, labeled as such.

Report:
1. Findings, most severe first. Severity: P0 data loss / crash / security
   hole on a normal path; P1 wrong behavior on a plausible path; P2 broken
   edge or error path; P3 invariant hygiene.
2. What you checked and found clean (so later passes can skip it).
3. What you couldn't verify, and any rule you suspected but couldn't trace
   to a written source — say so, don't invent citations.
```

## Hunt 13 — Auth & keys

```text
You are hunting bugs in goblin v2 (this repo): a Telegram-native personal AI
agent, Bun + strict TypeScript, prod runs from this very tree. Read-and-report
only — you find bugs, you do not fix them.

Read first (the definition of correct):
- design/auth.md — the auth ruling. Extract its invariants as your checklist
  before reading code.
- AGENTS.md → Keys: auth.jsonl command records use `!pass-keys get
  goblin-dev NAME`; `get` reads only the local encrypted snapshot and fails
  loud on missing snapshots/keys or a locked wallet; goblin loads auth at
  boot and memoizes successful resolutions (auth edits need an approved
  restart — that is designed behavior, not a bug); scripts/mcp keeps
  `pass-keys run goblin-mcp-dev -- ...` — snapshot keys enter only the child
  environment, then direct exec, no Pass fallback.

ABSOLUTE RULE for this hunt: never read, print, echo, or "just check" any
secret value — not key material, not auth.jsonl payloads, not env files, not
pass-keys output. You review code and structure only. If a test fixture or
command would surface a real value, that command is out of bounds; say so in
the report instead of running it.

Scope — hunt only these files: src/auth.ts, src/auth.test.ts,
src/auth.parse.test.ts, scripts/mcp, scripts/check-auth.ts,
scripts/check-mcp-config.ts, scripts/check-mcp-config.test.ts.
Run from the repo root: `bun test src/auth.test.ts src/auth.parse.test.ts
scripts/check-mcp-config.test.ts` and `bun run typecheck`. Read
scripts/check-auth.ts and scripts/mcp as code; run them only if their own
help/usage shows they are read-only structure checks — otherwise skip
execution and review statically, saying so.

What counts as a bug here:
- Violation of any design/auth.md ruling — cite the section.
- Specifics to probe: parse failures that silently drop or default a
  credential instead of failing loud; memoization caching negative results
  (a transient wallet lock permanently masking a good key until restart);
  resolution error paths swallowing context; scripts/mcp leaking snapshot
  keys into anything but the child env (argv, logs, parent env);
  check-mcp-config accepting malformed configs; auth records whose command
  spawns a shell where the doc requires direct exec.

Out of scope (note pointers, don't chase): the HTTP session layer
(src/http/auth.ts, hunt 7), the podman shell-secret flow in deploy/memory
(hunt 6), unit installation of goblin-keys (hunt 20).

Rules of engagement:
- No production-code edits, no fixes, no commits, no installs; scratch notes
  only under /tmp.
- Never touch live services: no pass-keys commands that contact remote
  stores, no systemctl, no wallet operations. Never run env-gated live
  drift tests (GOBLIN_*_LIVE=1).
- A finding requires: file:line, the violated rule quoted with doc + section,
  and the triggering input/path or a sketch of the test that would catch it.
  Unverified suspicions are leads, labeled as such.

Report:
1. Findings, most severe first. Severity: P0 data loss / crash / security
   hole on a normal path; P1 wrong behavior on a plausible path; P2 broken
   edge or error path; P3 invariant hygiene.
2. What you checked and found clean (so later passes can skip it).
3. What you couldn't verify, and any rule you suspected but couldn't trace
   to a written source — say so, don't invent citations.
```

## Hunt 14 — Health & doctor

```text
You are hunting bugs in goblin v2 (this repo): a Telegram-native personal AI
agent, Bun + strict TypeScript, prod runs from this very tree. Read-and-report
only — you find bugs, you do not fix them.

Read first (the definition of correct):
- design/doctor.md — the doctor ruling. Extract its invariants as your
  checklist before reading code.
- DESIGN.md → "Setup and diagnosis": doctor is one bounded diagnostic pass
  that reports — it never repairs, initializes state, or changes services.
- AGENTS.md → Process: `bun run doctor` is read-only diagnosis with no
  repair and no restart authority; its contract (stdout/stderr split,
  shared-check rules, 422/500 boundaries) lives in design/doctor.md.

Scope — hunt only these files: src/doctor.ts, src/health.ts,
src/health-sqlite.ts, scripts/doctor, scripts/doctor.test.ts,
scripts/check-startup.ts, scripts/check-startup.test.ts,
scripts/startup-categories.ts.
Run from the repo root: `bun test src/doctor.test.ts src/health.test.ts
scripts/doctor.test.ts scripts/check-startup.test.ts` and
`bun run typecheck`.

What counts as a bug here:
- Violation of any design/doctor.md ruling — cite the section.
- Specifics to probe: ANY mutating call in the doctor path (a write, a
  service restart, an init — each is P0 by the design contract); checks that
  report healthy without actually probing (a green lie is worse than a red
  truth); unbounded diagnostics (a hang with no budget); health-sqlite
  queries that lock or migrate the live DB; 422 vs 500 misclassification on
  the boundaries the doc defines; check-startup categories drifting from
  scripts/startup-categories.ts; stderr diagnostics leaking into the
  stdout report (or report JSON leaking into stderr); swallowed probe
  errors reported as passes.

Out of scope (note pointers, don't chase): the boot path doctor advises
about (hunt 19), unit healthchecks in deploy/ (hunts 6, 20), the HTTP
surface (hunt 7).

Rules of engagement:
- No production-code edits, no fixes, no commits, no installs; scratch notes
  only under /tmp.
- Never touch live services: do not run `bun run doctor` against the live
  GOBLIN_HOME, no systemctl, no podman. Never run env-gated live drift
  tests (GOBLIN_*_LIVE=1).
- Never read or print secret values — structure only.
- A finding requires: file:line, the violated rule quoted with doc + section,
  and the triggering input/path or a sketch of the test that would catch it.
  Unverified suspicions are leads, labeled as such.

Report:
1. Findings, most severe first. Severity: P0 data loss / crash / security
   hole on a normal path; P1 wrong behavior on a plausible path; P2 broken
   edge or error path; P3 invariant hygiene.
2. What you checked and found clean (so later passes can skip it).
3. What you couldn't verify, and any rule you suspected but couldn't trace
   to a written source — say so, don't invent citations.
```

## Hunt 15 — Programs, scheduler & wake

```text
You are hunting bugs in goblin v2 (this repo): a Telegram-native personal AI
agent, Bun + strict TypeScript, prod runs from this very tree. Read-and-report
only — you find bugs, you do not fix them.

Read first (the definition of correct):
- design/programs.md — the programs ruling (scheduling, wake dispatch,
  approval, webhooks). Extract its invariants as your checklist before
  reading code.
- File-header contracts to verify code against: src/wake.ts — "Wakes use
  ordinary turn submission so queued and live turns share ordering and epoch
  fencing. A constructed sink must be released if submission throws."
  src/program-hook.ts — "The raw token exists only inside these call paths —
  stores, stamps and logs see its sha256 hash or nothing at all."
- AGENTS.md → Guardrails (fail loud, durable writes, zod, no `any`,
  log not console).

Scope — hunt only these files: src/programs.ts, src/program-approval.ts,
src/program-hook.ts, src/program-ops.ts, src/program-proposals.ts,
src/scheduler.ts, src/wake.ts, src/wake-store.ts, src/wake-dispatcher.ts,
plus colocated tests.
Run from the repo root: `bun test src/programs.test.ts
src/program-proposals.test.ts src/scheduler.test.ts src/wake.test.ts
src/wake-store.test.ts src/wake-store.crash.test.ts
src/wake-dispatcher.test.ts` and `bun run typecheck`.

What counts as a bug here:
- Violation of any design/programs.md ruling — cite the section.
- Specifics to probe: cron parsing edge cases (DST, month ends, timezone —
  cron-parser is external input, zod/validate it); scheduler ordering under
  restart (missed vs doubled fires; the crash tests exist — what do they not
  cover?); wake submission throwing without releasing its sink; wake epoch
  fencing (a stale wake must not land on a new epoch's turn); hook tokens
  hashed everywhere outside the mint/rotate call paths (a raw token in a
  log line or store row is P0); approval flows minting without the grant;
  dispatcher losing wakes on crash; program state transitions that strand a
  program in an uneditable state.

Out of scope (note pointers, don't chase): the Telegram approval adapters
(hunt 1), the program agent tool (hunt 10), turn admission of woken turns
(hunt 2).

Rules of engagement:
- No production-code edits, no fixes, no commits, no installs; scratch notes
  only under /tmp.
- Never touch live services: no real cron changes, no webhook calls, no
  systemctl. Never run env-gated live drift tests (GOBLIN_*_LIVE=1).
- Never read or print secret values — webhook tokens above all: structure
  only.
- A finding requires: file:line, the violated rule quoted with doc + section,
  and the triggering input/path or a sketch of the test that would catch it.
  Unverified suspicions are leads, labeled as such.

Report:
1. Findings, most severe first. Severity: P0 data loss / crash / security
   hole on a normal path; P1 wrong behavior on a plausible path; P2 broken
   edge or error path; P3 invariant hygiene.
2. What you checked and found clean (so later passes can skip it).
3. What you couldn't verify, and any rule you suspected but couldn't trace
   to a written source — say so, don't invent citations.
```

## Hunt 16 — Projects, notes & tags

```text
You are hunting bugs in goblin v2 (this repo): a Telegram-native personal AI
agent, Bun + strict TypeScript, prod runs from this very tree. Read-and-report
only — you find bugs, you do not fix them.

Read first (the definition of correct):
- design/projects.md — the projects & notes ruling. Extract its invariants as
  your checklist before reading code.
- DESIGN.md → "Product boundary": notes are the ruled exception to
  files-stay-where-humans-edit-them — their editing surface is the app, so
  they are rows.
- File-header contract to verify code against: src/tags.ts — "One module
  owns every marker spelling: a typo fails one schema instead of silently
  changing what reaches memory."
- AGENTS.md → Guardrails (fail loud, durable writes, zod, no `any`,
  log not console).

Scope — hunt only these files: src/projects.ts, src/notes.ts, src/tags.ts,
src/agent/note-rewrite.ts, plus colocated tests (src/projects.test.ts,
src/notes.test.ts, src/tags.test.ts, src/agent/note-rewrite.test.ts).
Run from the repo root: `bun test src/projects.test.ts src/notes.test.ts
src/tags.test.ts src/agent/note-rewrite.test.ts` and
`bun run typecheck`.

What counts as a bug here:
- Violation of any design/projects.md ruling — cite the section.
- Specifics to probe: project slug handling (collision, case, path safety
  under projects/<slug>/); note row versioning (lost updates between the app
  editor and the agent's rewrite — is there an If-Match/seq discipline?);
  note-rewrite racing a human edit (whose write wins, and is the loser's
  data preserved?); marker spellings validated in ONE schema (any code path
  accepting a tag spelling the schema doesn't define); machinery-speech
  tagging (isMachineryText) misclassifying user text; memory integration
  reading tags the writer never wrote; zod on note content arriving from the
  app.

Out of scope (note pointers, don't chase): the app's note editor UI
(hunt 8), the note agent tool (hunt 10), memory destinations consuming tags
(hunt 6).

Rules of engagement:
- No production-code edits, no fixes, no commits, no installs; scratch notes
  only under /tmp.
- Never touch live services: no systemctl, no Telegram. Never run env-gated
  live drift tests (GOBLIN_*_LIVE=1).
- Never read or print secret values — structure only.
- A finding requires: file:line, the violated rule quoted with doc + section,
  and the triggering input/path or a sketch of the test that would catch it.
  Unverified suspicions are leads, labeled as such.

Report:
1. Findings, most severe first. Severity: P0 data loss / crash / security
   hole on a normal path; P1 wrong behavior on a plausible path; P2 broken
   edge or error path; P3 invariant hygiene.
2. What you checked and found clean (so later passes can skip it).
3. What you couldn't verify, and any rule you suspected but couldn't trace
   to a written source — say so, don't invent citations.
```

## Hunt 17 — Skills

```text
You are hunting bugs in goblin v2 (this repo): a Telegram-native personal AI
agent, Bun + strict TypeScript, prod runs from this very tree. Read-and-report
only — you find bugs, you do not fix them.

Read first (the definition of correct):
- design/skills.md — the skills ruling (catalog, staging, invocation,
  provenance, automatic saving). Extract its invariants as your checklist
  before reading code.
- File-header contracts to verify code against: src/skill-part.ts — "A
  user-message part carrying a reference, not content... Store format = wire
  format: the part persists with history; the body rides only the owning
  turn's [view]." src/reviewer.ts — "Every completed turn is gated by System
  One... Any gate failure falls back to the 8+ tool-call rule. Every gate
  logs probabilities, thresholds, trigger, tool names, fallback streak."
- AGENTS.md → Guardrails (fail loud, durable writes, zod, no `any`,
  log not console).

Scope — hunt only these files: src/skill-decisions.ts, src/skill-part.ts,
src/skill-provenance.ts, src/reviewer.ts, src/agent/skills.ts,
src/agent/skill-fetch.ts, src/agent/skill-inject.ts,
scripts/backfill-skill-sources.ts, deploy/skills/ (browser, gws, herdr, mcp,
pass-cli skill dirs), plus colocated tests.
Run from the repo root: `bun test src/skill-decisions.test.ts
src/skill-provenance.test.ts src/reviewer.test.ts src/agent/skills.test.ts
src/agent/skill-fetch.test.ts scripts/backfill-skill-sources.test.ts` and
`bun run typecheck`.

What counts as a bug here:
- Violation of any design/skills.md ruling — cite the section.
- Specifics to probe: skill body visibility (the owning turn's injected body
  collapses to its `[skill: name]` marker on the NEXT turn's view — and the
  body must never persist into history beyond that contract); `{ name }`
  resolution against the catalog including manual-only entries; `{ url,
  path }` pinning a server-fetched copy (is the fetch validated/bounded?);
  reviewer fallback correctness (gate failure → 8+ tool-call rule, never
  skip review entirely); provenance recording on every save path;
  skill-inject mutating the frozen system prompt mid-conversation (prompt
  injection waits for a conversation boundary — DESIGN.md → Cache
  stability); backfill script idempotence and mode preservation on rewrite;
  staged-vs-live catalog drift.

Out of scope (note pointers, don't chase): system1's decision wire
(hunt 18), the skill part's rendering in the app (hunt 8), prompt assembly
around injected skills (hunt 3).

Rules of engagement:
- No production-code edits, no fixes, no commits, no installs; scratch notes
  only under /tmp.
- Never touch live services: no skill fetching from real URLs beyond what
  tests fake, no systemctl. Never run env-gated live drift tests
  (GOBLIN_*_LIVE=1).
- Never read or print secret values — structure only.
- A finding requires: file:line, the violated rule quoted with doc + section,
  and the triggering input/path or a sketch of the test that would catch it.
  Unverified suspicions are leads, labeled as such.

Report:
1. Findings, most severe first. Severity: P0 data loss / crash / security
   hole on a normal path; P1 wrong behavior on a plausible path; P2 broken
   edge or error path; P3 invariant hygiene.
2. What you checked and found clean (so later passes can skip it).
3. What you couldn't verify, and any rule you suspected but couldn't trace
   to a written source — say so, don't invent citations.
```

## Hunt 18 — System1 & responsibility feed

```text
You are hunting bugs in goblin v2 (this repo): a Telegram-native personal AI
agent, Bun + strict TypeScript, prod runs from this very tree. Read-and-report
only — you find bugs, you do not fix them.

Read first (the definition of correct):
- design/system1.md — the System One ruling (the typed-decision model) and
  the responsibility/handover machinery it gates. Extract its invariants as
  your checklist before reading code.
- File-header contracts to verify code against: src/system1.ts — "OpenRouter
  Decisions API (alpha). One primary POST, at most one backup; typed yes/no
  (noul) questions... answers carry {type, noul}; usage carries input/output
  tokens + cost." src/responsibilities.ts — attachments "bind explicitly
  selected Herdr agents to it by stable identity (terminal_id + agent_session
  when Herdr exposes one — never pane + kind alone, which a same-kind
  replacement inherits). Generations..." src/reply-ratings.ts — "record-only
  by design — nothing reads them into the model, history, FTS, or memory. A
  vote change is a new row; reads are latest-wins per stamped reply."

Scope — hunt only these files: src/system1.ts, src/responsibilities.ts,
src/responsibility-feed.ts, src/responsibility-observer.ts,
src/responsibility-service.ts, src/reply-ratings.ts, plus colocated tests
(src/system1.test.ts, src/responsibilities.test.ts,
src/responsibility-feed.test.ts, src/responsibility-observer.test.ts,
src/responsibility-service.test.ts, src/reply-ratings.test.ts,
src/handover-loop.test.ts).
Run from the repo root: `bun test src/system1.test.ts
src/responsibilities.test.ts src/responsibility-feed.test.ts
src/responsibility-observer.test.ts src/responsibility-service.test.ts
src/reply-ratings.test.ts src/handover-loop.test.ts` and
`bun run typecheck`.

What counts as a bug here:
- Violation of any design/system1.md ruling — cite the section.
- Specifics to probe: system1 fail-open/fail-closed per consumer (the doc
  says which questions may default — a mail-path System1Error never blocks
  reads, but a reviewer gate failure must FALL BACK, not skip); the wire
  contract (validate the response with zod — noul typing, usage parsing,
  cost accounting); more than one backup call; handover-key idempotence and
  revision-bumping corrections; generation fencing on attachments;
  identity-bound attachment (pane+kind alone is the named bug shape);
  reply-ratings rows read into model/history/FTS/memory anywhere (violates
  record-only — P1); observer dedup missing a duplicate development;
  feed read-model drift from the durable store.

Out of scope (note pointers, don't chase): consumers of system1 decisions
(reviewer — hunt 17; mail injection — hunt 12; loop watchdog — hunt 2),
herdr identity mechanics (hunt 9), the app's feed view (hunt 8).

Rules of engagement:
- No production-code edits, no fixes, no commits, no installs; scratch notes
  only under /tmp.
- Never touch live services: no OpenRouter calls (tests fake the provider),
  no systemctl. Never run env-gated live drift tests (GOBLIN_*_LIVE=1).
- Never read or print secret values — structure only.
- A finding requires: file:line, the violated rule quoted with doc + section,
  and the triggering input/path or a sketch of the test that would catch it.
  Unverified suspicions are leads, labeled as such.

Report:
1. Findings, most severe first. Severity: P0 data loss / crash / security
   hole on a normal path; P1 wrong behavior on a plausible path; P2 broken
   edge or error path; P3 invariant hygiene.
2. What you checked and found clean (so later passes can skip it).
3. What you couldn't verify, and any rule you suspected but couldn't trace
   to a written source — say so, don't invent citations.
```

## Hunt 19 — Boot, config & core state

```text
You are hunting bugs in goblin v2 (this repo): a Telegram-native personal AI
agent, Bun + strict TypeScript, prod runs from this very tree. Read-and-report
only — you find bugs, you do not fix them.

Read first (the definition of correct):
- DESIGN.md → "Config": one canonical object — a save parses through the
  schema and rewrites the file whole (tmp+fsync+rename, mode preserved);
  comments/key order dropped; unknown keys rejected at load (a typo fails
  loud); malformed JSON5 or schema-invalid incumbent fails loud — a save
  never silently resets; absent block = capability off; no secrets in
  goblin.json5.
- DESIGN.md → "State layout" and "Module map": SQLite durability = WAL +
  transactions (synchronous=NORMAL minimum), not tmp/fsync/rename — that
  ritual is for whole-file state only; index.ts wires and never rules — a
  rule with no owning module doesn't get to live there.
- AGENTS.md → Guardrails: fail loud; ENOENT → null is the ONLY sanctioned
  special case; `log` from src/log.ts writes JSONL on stdout AND appends to
  $GOBLIN_HOME/state/goblin.log — a screenshot plus the log must fully
  reconstruct what the process did.

Scope — hunt only these files: src/config.ts, src/config-pins.ts,
src/durable.ts, src/sqlite.ts, src/log.ts, src/proc.ts, src/targets.ts,
src/index.ts, plus colocated tests (src/config.test.ts,
src/config-pins.test.ts, src/boot.test.ts, src/durable.test.ts,
src/log.test.ts, src/proc.test.ts).
Run from the repo root: `bun test src/config.test.ts src/config-pins.test.ts
src/boot.test.ts src/durable.test.ts src/log.test.ts src/proc.test.ts` and
`bun run typecheck`.

What counts as a bug here:
- Violation of any ruling above — cite doc + section.
- Specifics to probe: durable.ts not preserving file mode, skipping fsync,
  or renaming across filesystems; log.ts failing silently when the log file
  is unwritable (or blocking the process); proc.ts boundedRun paths where
  the promise never settles (timeout → SIGTERM → grace → SIGKILL — check
  every branch incl. the cap-overflow one); config load accepting unknown
  keys or a save resetting a malformed incumbent; config-pins drift
  detection false-quiet; targets.ts address parsing (canonical conversation
  addresses — a mis-parse routes turns to the wrong conversation, P0);
  boot order in index.ts (rules creeping into the wiring; missing fail-loud
  on unavailable hard dependencies).

Out of scope (note pointers, don't chase): every feature module config.ts
feeds (their own hunts), the HTTP surface (hunt 7), deploy/restart
mechanics (hunt 20).

Rules of engagement:
- No production-code edits, no fixes, no commits, no installs; scratch notes
  only under /tmp.
- Never touch live services: never run against the live $GOBLIN_HOME (tests
  use fixtures), no systemctl, no Telegram. Never run env-gated live drift
  tests (GOBLIN_*_LIVE=1).
- Never read or print secret values — config/auth parsing is structure only.
- A finding requires: file:line, the violated rule quoted with doc + section,
  and the triggering input/path or a sketch of the test that would catch it.
  Unverified suspicions are leads, labeled as such.

Report:
1. Findings, most severe first. Severity: P0 data loss / crash / security
   hole on a normal path; P1 wrong behavior on a plausible path; P2 broken
   edge or error path; P3 invariant hygiene.
2. What you checked and found clean (so later passes can skip it).
3. What you couldn't verify, and any rule you suspected but couldn't trace
   to a written source — say so, don't invent citations.
```

## Hunt 20 — Ops, install & deploy

```text
You are hunting bugs in goblin v2 (this repo): a Telegram-native personal AI
agent, Bun + strict TypeScript. `goblin.service` runs from this very tree, so
these scripts are production infrastructure. Read-and-report only — you find
bugs, you do not fix them and you do not run the mutating scripts.

Read first (the definition of correct):
- docs/operations.md — the operator contract for deploying and updates
  (markers, mechanics). This file is your primary spec.
- design/setup.md — install ruling: no wizard ever; fresh setup never
  quietly updates an existing installation.
- AGENTS.md → Live services: scripts/deploy.sh is the only sanctioned
  update (gate → conditional install/build → restart → verify) and running
  it IS the restart OK; it never pushes/fetches/pulls; publish-app.sh does
  the atomic dist.a/dist.b flip; the memory stack is never auto-deployed;
  quadlet HealthCmd takes no shell metacharacters.

Scope — hunt only these files: scripts/deploy.sh, scripts/deploy.test.ts,
scripts/publish-app.sh, scripts/install.sh, scripts/install.test.ts,
scripts/install-options.ts, scripts/install-options.test.ts,
scripts/check-app-assets.ts, scripts/check-cache-contracts.ts,
scripts/check-cache-contracts.test.ts, scripts/cache-report.ts,
scripts/cache-report.test.ts, scripts/comment-audit.ts,
scripts/function-size-audit.ts, scripts/loop-calibrate.ts,
scripts/reviewer-stats.ts, scripts/replay-v7-history.ts,
scripts/backup-state.sh, deploy/goblin.service, deploy/goblin-herdr.service,
deploy/goblin-keys.service.in, deploy/goblin-keys.timer.
Run from the repo root: `bun test scripts/deploy.test.ts
scripts/install.test.ts scripts/install-options.test.ts
scripts/check-cache-contracts.test.ts scripts/cache-report.test.ts` and
`bun run typecheck`. Review the shell scripts statically; do NOT execute
deploy.sh, install.sh, publish-app.sh, or backup-state.sh.

What counts as a bug here:
- Violation of any docs/operations.md or design/setup.md ruling — cite doc +
  section.
- Specifics to probe: deploy.sh gate ordering (can any path reach the
  restart without the gate passing?); partial-failure states (a failed build
  leaving the tree half-deployed or the service down); install.sh
  re-running over an existing installation (must refuse, not update);
  path substitution quoting (spaces, empty vars); publish-app.sh flip not
  atomic (a request seeing a missing dist mid-flip); replay/audit scripts
  mutating state they only claim to read; backup-state.sh restorability
  (does the backup actually capture WAL sidecars?); systemd units
  (HealthCmd metacharacters, missing guards, restart loops); check-* gates
  exiting 0 on skipped checks.

Out of scope (note pointers, don't chase): the code being deployed
(all other hunts), memory stack units (hunt 6), goblin-launch (hunt 11).

Rules of engagement:
- No production-code edits, no fixes, no commits, no installs; scratch notes
  only under /tmp.
- NEVER run the mutating scripts (deploy/install/publish/backup) or touch
  live services: no systemctl, no podman, no git push/fetch/pull.
- Never read or print secret values — structure only.
- A finding requires: file:line, the violated rule quoted with doc + section,
  and the triggering input/path or a sketch of the test that would catch it.
  Unverified suspicions are leads, labeled as such.

Report:
1. Findings, most severe first. Severity: P0 data loss / crash / security
   hole on a normal path; P1 wrong behavior on a plausible path; P2 broken
   edge or error path; P3 invariant hygiene.
2. What you checked and found clean (so later passes can skip it).
3. What you couldn't verify, and any rule you suspected but couldn't trace
   to a written source — say so, don't invent citations.
```

## Hunt 21 — Testkit, fixtures & boundaries

```text
You are hunting bugs in goblin v2 (this repo): a Telegram-native personal AI
agent, Bun + strict TypeScript, prod runs from this very tree. Read-and-report
only — you find bugs, you do not fix them.

Read first (the definition of correct):
- AGENTS.md → Tests — the entire section, twice. Key rulings: bun runs all
  files of one invocation in a single process and scopes a module-level
  afterEach to the first-importing file, so bunfig.toml's [test] preload of
  src/testkit.ts and src/subagents/testing.ts must keep their cleanup hooks
  global; every fixture lives under a per-process root
  goblin-test-fixtures-<pid>-<random> in tmpdir; the import-time sweep
  removes ONLY roots older than an hour AND with the named owner PID
  provably dead (kill(pid, 0) → ESRCH; alive EPERM, symlinks, and every
  other name or error preserve); legacy goblin-* dirs and foreign scratch
  are never touched; crash leftovers self-heal on the next run.
- DESIGN.md → "Test posture": tests guard boundaries and invariants, not
  implementations; fakes at the two external edges; the suite stays smaller
  than src/.
- AGENTS.md → Guardrails: module-boundaries.test.ts enforces that domain
  modules never import vendor packages (each external contract has one
  adapter); channel-boundary.test.ts keeps approval owners channel-neutral.

Scope — hunt only these files: src/testkit.ts, src/testkit.test.ts,
src/testkit/ (fake-api.ts, fake-model.ts), src/test-helpers/ (boot.ts,
loopback-preload.ts, turn-crash-child.ts, wake-crash-child.ts),
src/module-boundaries.test.ts, src/channel-boundary.test.ts, bunfig.toml.
Run from the repo root: `bun test src/testkit.test.ts
src/module-boundaries.test.ts src/channel-boundary.test.ts` and
`bun run typecheck`.

What counts as a bug here:
- Violation of any ruling above — cite doc + section.
- Specifics to probe: the sweep's liveness check (a PID reused by another
  process → EPERM/alive must PRESERVE, never delete — trace every branch of
  the error handling; a wrong branch deletes a live process's fixtures);
  sweep age logic (off-by-one on the hour boundary is P3, deleting young
  roots is P1); fixture roots escaping the namespace (a helper handing out
  a path outside goblin-test-fixtures-*); a new fixture helper relying on
  its own module-level hooks (the exact 2026-10-22 ENOSPC incident shape);
  fake-api/fake-model drifting from the real provider/Telegram shapes they
  claim to fake (pin verbatim behavior, don't invent); boundary tests whose
  import lists have gone stale (enforcing nothing — a green test that
  can't fail); crash-child helpers not exercising the real crash path.

Out of scope (note pointers, don't chase): the production modules the
fixtures fake (their hunts), subagents/testing.ts (hunt 9 — but flag here
if the preload list in bunfig.toml diverges from what exists).

Rules of engagement:
- No production-code edits, no fixes, no commits, no installs; scratch notes
  only under /tmp.
- Never touch live services: no systemctl, no Telegram. Never run env-gated
  live drift tests (GOBLIN_*_LIVE=1). Do not delete anything from /tmp by
  hand — if you observe leaked fixture dirs, report them, don't clean them.
- Never read or print secret values — structure only.
- A finding requires: file:line, the violated rule quoted with doc + section,
  and the triggering input/path or a sketch of the test that would catch it.
  Unverified suspicions are leads, labeled as such.

Report:
1. Findings, most severe first. Severity: P0 data loss / crash / security
   hole on a normal path; P1 wrong behavior on a plausible path; P2 broken
   edge or error path; P3 invariant hygiene.
2. What you checked and found clean (so later passes can skip it).
3. What you couldn't verify, and any rule you suspected but couldn't trace
   to a written source — say so, don't invent citations.
```

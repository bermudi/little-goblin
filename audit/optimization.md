# Optimization review — goblin v2

Read-only review. No tracked source file was modified; `git status --porcelain` is empty at
the baseline HEAD. Spec: `DESIGN.md` plus the area docs in `design/`. Guardrails: `AGENTS.md`
(fail loud · durable writes · no `console.log` · one adapter per external contract).
Prior work built on, not duplicated: `arch-audit.md` (rev `5e7977d`, three findings) and the
five-finding summary appended to the same file; `audit/telegram.md` (format standard).

"Optimize" is read here as **runtime performance plus maintainability** — the brief's own
words ("faster, leaner, or structurally simpler"). Token/API cost is treated as a *lever*
inside that frame, not as the target. Where a proposal would trade quality for cost (the
recall query length, the compaction threshold) the trade is surfaced, never taken silently.

---

## Baseline — 2026-10-22

| Item | Value | Command |
| --- | --- | --- |
| HEAD | `cc3a968c818eecedca53b4a8e5c319f591c67c55` — *"Merge worktree/brave-field-2950: live context gauge — the in-flight turn's window occupancy streams over the chat wire"* | `git rev-parse HEAD` |
| Tests | **4224 pass · 83 skip · 0 fail** — 4307 tests across 233 files, 17253 expect() calls, 318.70 s, exit 0 | `bun test` |
| Typecheck | **exit 0** (both `tsc` programs: server + `app/tsconfig.json`) | `bun run typecheck` |
| Working tree | clean at the baseline (no staged, unstaged, or untracked changes). The only file this review adds is this report, `audit/optimization.md` (untracked). No tracked file was modified. | `git status --porcelain` |

A second full run taken earlier the same session, at `abdc1ebd` (the HEAD before the
operator's six commits landed mid-review), was **4214 pass · 83 skip · 0 fail** — 4297 tests
across 232 files, 320.11 s, exit 0. The two runs differ only by the operator's commits; no
pre-existing failure exists in either.

**Method note.** The running prod process is *not* at this HEAD: `systemctl --user status
goblin` shows it started 2026-10-21 11:12:29 CST, before `abdc1ebd` (2026-10-21 20:35) and
therefore before `cc3a968c`. This review analyses the **tree**, not the live process. The
runtime log analysed below (`~/goblin/state/goblin.log`, 10 380 JSONL lines,
2026-09-17 → 2026-10-22) is the live process's log and therefore reflects older builds;
every claim drawn from it is marked with the build it describes.

**Measurement instruments used** (all outside the repo; nothing in the tree was touched):

- `bun:sqlite` instrumentation preload (`/tmp/sqlcount-preload.ts`) that counts statement
  executions and rows read, plus a SQL-text histogram, driven by a harness that runs **one
  real turn through the real `Runtime`** against a real SQLite file
  (`/tmp/measure-rows.ts`).
- `sqlite3 "file:/home/daniel/goblin/state/goblin.sqlite?mode=ro"` for schema, `EXPLAIN QUERY
  PLAN`, and row/size statistics (read-only; the live file was never written).
- `jq` over the runtime log for every count quoted.
- `bun run scripts/function-size-audit.ts` (the repo's own smell-line tool).
- Ad-hoc micro-benchmarks in `/tmp` for the schema-conversion, recall-query, TTS and FTS
  numbers, each reported with its command.

---

## Verdict (short form)

**The `arch-audit.md` verdict still holds at HEAD — and it holds more strongly than it did at
`5e7977d`, because all three of its findings have since been fixed in code.** What replaces
them is *not* a general refactor but a short list of pattern-level wins: one dormant
mechanism (proactive compaction, never armed in 149 turns), two per-step recomputations of
constants, two unbounded history scans on paths that want one row, one serial synthesis
loop, one missing index, and one duplicated decision vocabulary. None of them requires
removing a feature. The largest *measured* win is not a speed-up at all: it is the discovery
that **goblin's proactive compaction has never once fired**, because the context-window
denominator it triggers on is 1 000 000 tokens.

---

## Part 0 — Re-check of the three `arch-audit.md` findings at HEAD

`arch-audit.md` was written at `5e7977d`. 91 commits have landed since (the audit's own
revision is an ancestor of this HEAD). All three findings were taken up in the same week
(2026-10-19), each with its own commit and its own design ruling. Re-checked by reading the
current code, not the commit messages.

| # | `arch-audit.md` finding | Status at `cc3a968c` | Evidence |
| --- | --- | --- | --- |
| A1 | Tool replay conflates call equivalence with execution identity (`turn-journal.ts`, `runtime.ts`, `turn-resume.ts`) | **FIXED** — the argument-hash replay queue is gone; a *refusal* fence replaced it | `src/turn/retry-guard.ts` (new module, 144 lines); `src/turn-journal.ts:242-248` now documents `replayKey` as *"a call SIGNATURE … never execution identity"*; `src/runtime.ts:568` calls `classifyRetry(name, guard?.get(replayKey(name, input)))`; `src/turn/retry-guard.ts:118-135` **refuses** an unowned effectful repeat and only executes safe reads afresh; `src/turn/retry-guard.ts:93-116` requires an operator grant, consumed atomically with the dispatch (`src/turn-journal.ts:616-639`) |
| A2 | Resumed turns can inherit the wrong causal anchor | **FIXED** — resumption is now refused when newer unowned input exists | `src/turn-resume.ts:311-361` (`stalenessRefusal`): *"every durable user event after the run's anchor must be one the attempt recorded as its own input"*; a post-anchor user event the run never owned ⇒ `code:"conflict"`, refuse; `src/turn/admission.ts:71-79` records `ownedInputSeqs` and anchors on the run's own `anchorSeq` |
| A3 | Standing-program authorization is enforced by model instructions | **FIXED** — grant-shaped changes stage an operator approval | `src/agent/tools/program.ts:145` (*"Grant-shaped changes are proposals, never self-grants"*), `:254` (*"pending operator approval — nothing is active until they approve it"*); `src/program-approval.ts` (184 lines) owns the decision; `design/programs.md:31` records the ruling (*"a grant-shaped … approval, not a conversational one"*, 2026-10-20) |

**Commits:** `0cf5e6a5` *"fix(resume): replace argument-hash replay with evidence-aware
recovery fence"*; `7fcab874` *"fix(resume): enforce durable input ownership and source-linked
admission"*; `d43cff8c` *"feat(programs): gate grant-shaped changes behind durable operator
approvals"*.

### Part 0b — Re-check of the five findings in the `arch-audit.md` trailing summary

That summary is the record of an earlier, deeper review of the same tree (it wrote
`audit/architecture-review-2026-10-19.md`, which is not in the tree). Re-checked:

| # | Prior finding | Status at `cc3a968c` | Evidence |
| --- | --- | --- | --- |
| P1 | `buildStep(conv, {})` is a write — a no-op `/compact` froze an empty tool list into the system prompt | **FIXED** | `src/runtime.ts:444-446`: *"Metadata only — never buildStep: resolving a model and building a system prompt here would freeze a snapshot no turn asked for."* `src/runtime.ts:447` reads `compaction.contextWindow(conv)` instead; `src/agent/step.ts:90-93` is a catalog read only. The prior review's repro script is gone; the behaviour is now pinned by `src/runtime.test.ts:1690,1702-1704,1729-1732` |
| P2 | Sink capabilities inferred from optional-method presence; `makeResumeSinks.sinkHooks` restates the fact as a channel-keyed literal | **STILL PRESENT** | `src/runtime.ts:207` (`t.sink.onStreamChunk !== undefined`), `:645`, `:677`, `:978`; `src/app-media.ts:37`; `src/turn/stream.ts:115`; `src/turn-resume.ts:82-90` restates the capability table per channel. → carried as **F12** |
| P3 | `titleImplicit` means opposite things per channel | **STILL PRESENT** | `src/conversation.ts:113-115` is the only spec; `src/http/app-chat.ts:287` and `src/spinoff.ts:93` set it to `true` *after* a successful auto-title, inverting the spec. → carried as **F11** |
| P4 | The two intake pipelines share no seam | **PARTIALLY ADDRESSED** | The *decisions* now route through shared owners (`src/app-approvals.ts`, commit `08c2fd8c`); the decision *vocabulary* is still hand-written twice. → carried as **F9** |
| P5 | Which conversation mutations must fence in-flight turns is decided per call site | **STILL OPEN, no live defect** (as the prior review said) | `src/conversation.ts:1449` `setMeta` (no epoch bump) vs `:1487` `applySettings` (bumps). `memoryExcluded` is written through both: `src/projects.ts:302` (`applySettings`, fenced — with an explicit comment) and `src/http/app-conversations.ts:448` (`setMeta`, unfenced). The latter is benign **only** because it runs inside the creation branch (`existing === null`). One unguarded door away from a live defect. → carried as **F13** |

**Nothing in Part 0 is an optimisation opportunity.** It is the mapping the brief asked for:
three arch-audit findings, all fixed, plus the prior review's five, three still open and
carried forward below as **F12** (P2), **F11** (P3), **F9** (P4) and **F13** (P5).

---

## Part 1 — Findings, ranked by impact vs. effort

Severity follows `audit/telegram.md`: **P1** = the feature is not doing what it claims to do;
**P2** = measurable waste on a live path, or a structural duplication that already produces
divergence; **P3** = bounded, low-impact hygiene.
The list below is **ranked** (P1 first, then P2 by measured impact, then P3 by blast radius);
the **identifiers are stable and are not in ranked order** — `F9` and `F10` sit in the P2
band because they were filed later, and every cross-reference in this document uses the
identifier, never the position.
Every performance number is a measurement I ran, or is explicitly labelled *inferred —
unverified*.

| # (rank) | ID | Severity | Finding | Tag | Effort |
| --- | --- | --- | --- | --- | --- |
| 1 | F1 | P1 | Proactive compaction has never fired (0 events in 149 turns) — the trigger sits at 750 000 tokens against a 1 000 000-token catalogue denominator | NEW | S (log + config + one ruling) |
| 2 | F2 | P2 | TTS chunks are synthesized serially — the one 2-chunk synthesis in the log took 328 s | NEW | S |
| 3 | F3 | P2 | The model view is materialized from an unbounded full-history scan, twice per turn | NEW | M (3 separable steps) |
| 4 | F4 | P2 | Every tool schema is converted zod → JSON-Schema on every model step, twice (≈ 60 ms/turn) | NEW | M |
| 5 | F9 | P2 (structure) | One decision vocabulary, two hand-maintained copies, already drifted in 3 of 8 cases | EXTENDS P4 | XS |
| 6 | F10 | P2 (structure) | `src/conversation.ts` is one 1213-line closure holding 19 responsibilities | NEW | L (9 commits) |
| 7 | F5 | P3 | The authority fence reads 17 columns to compare one integer, 11×/turn | NEW | XS |
| 8 | F6 | P3 | `compactions` has no index on `conversation_id`; the compaction row is read twice per turn | NEW | S |
| 9 | F7 | P3 | Five "what is the last message?" call sites load the entire conversation | NEW | M |
| 10 | F8 | P3 | The interrupted-turn listing scans every run in the database and filters in JS | NEW | S |
| 11 | F11 | P3 | `titleImplicit`: one column, two meanings, and the app writers invert its only spec | EXTENDS P3 | S + a ruling |
| 12 | F12 | P3 | Sink capability is inferred from optional-method presence and restated by hand | EXTENDS P2 | M |
| 13 | F13 | P3 | Fencing is decided per call site: `memoryExcluded` is written through both doors | EXTENDS P5 | M + a ruling |
| 14 | F14 | P3 | The memory queue's operation poll is double-cadenced, un-backed-off, and fsyncs on every tick | NEW | S |

---

### F1 — Proactive compaction has never fired: the trigger sits at 750 000 tokens · **P1** · NEW

**What is suboptimal.** The turn is supposed to compact *before* it grows into the
provider's limit. The trigger is `lastStepInputTokens ≥ 75 % of contextWindow`
(`src/runtime.ts:43` `COMPACT_AT_PCT = 75`, fired at `src/runtime.ts:1054`). The denominator
comes from the models.dev catalog via `contextLimit(provider, modelId)`
(`src/agent/models-dev.ts:100-108`, called from `src/agent/step.ts:44-48` and
`src/agent/step.ts:90-93`). For the configured model — `zai/glm-5.3-flash`, `zai/glm-5.3`
(`~/goblin/goblin.json5:34,62`) — the catalog entry says **1 000 000**. The trigger is
therefore 750 000 tokens. The highest occupancy ever observed is **96 429 tokens**.

**Evidence (measured).**

```console
$ jq -r 'select(.msg=="turn completed") | .window.limit // "null"' ~/goblin/state/goblin.log \
    | sort | uniq -c
    133 1000000
     18 null
$ jq -r 'select(.msg=="turn completed") | .window.pct // "null"' ~/goblin/state/goblin.log \
    | sort -n | uniq -c | tail -3
      2 6
      1 10                      # 96 429 input tokens — the maximum ever seen
$ grep -c -i 'compact' ~/goblin/state/goblin.log
2                              # both are tool-call *arguments*, not compaction events
$ grep -c -i 'overflow' ~/goblin/state/goblin.log
0
```

**Zero** compaction events and **zero** overflow events in 10 380 log lines, 149 completed
turns, 35 days. And because `src/agent/compaction.ts` logs every outcome — `"compaction
skipped"` (`:216`, `:221`), `"compaction summarizing"` (`:235`), `"history compacted"`
(`:357`) — and **none of those strings appears anywhere in the log**, the conclusion is
stronger than "the proactive trigger never armed": **no compaction of any kind has run in
this window** — not the proactive path, not the overflow-recovery path
(`src/runtime.ts:1104` → `recoverFromOverflow` → `doCompact(conv, "overflow")`), and not a
manual `/compact`. The mechanism that would keep a long conversation from hitting the
provider's ceiling is therefore also the mechanism that has never been exercised in
production.

The catalog itself is not a single number — the same model id appears under many providers
with different limits:

```console
$ jq -r 'to_entries[] | select(.value.models? != null) | .key as $p | .value.models
    | to_entries[] | select(.key == "glm-5.3") | "\($p)\tctx=\(.value.limit.context)"' \
    ~/goblin/state/models.dev.json | sort | uniq -c | sort -rn | head
 zai   ctx=1000000          # ← the direct match, the one goblin takes
 llmgateway ctx=1048576
 scaleway ctx=256000
 engy  ctx=327680
 zhipuai ctx=1000000
 ...   (≈45 providers list this id)
```

I checked the cross-provider fallback hypothesis and it is **wrong for this deployment**:
`zai` *is* a catalog key, so `contextLimit` takes the direct match
(`src/agent/models-dev.ts:104`) and the 1 000 000 is genuinely the `zai` entry — not another
vendor's number. Whether the z.ai coding-plan endpoint actually honours 1 000 000 is
**unverified** (I have no provider-side source for it). But `zenmux` and `qiniu-ai` both list
`z-ai/glm-5` at **200 000**, and at 96 429 tokens the highest observed turn would already be
at **48 %** of a 200 k limit.

That the mechanism is dormant is also **user-visible**: the app's context gauge computes
`pct = input / limit` (`src/http/app-conversations.ts:661-664`) against the same
denominator, so a catalogue that is 5× too large makes the gauge read "10 %" where the
truth is "48 %". The gauge's denominator is the *one* number the operator would use to
decide a conversation is running out of room.

**Proposed change** (no feature removed; the compaction feature stays and gets *armed*):

1. **Log the denominator's provenance.** `contextLimit` should return
   `{ limit, source: "direct" | "cross-provider" | "unknown", providerKey }` and the
   `turn completed` window object (`src/turn/finish.ts:39,120`) should carry it. Today
   `window.limit` is a bare number with no provenance — under the `AGENTS.md` logging bar
   ("every external boundary emits a line with the fields to explain it") this is a gap.
2. **Treat the cross-provider fallback as "unknown", not as a number.**
   `src/agent/models-dev.ts:106-110` currently returns *some* provider's limit for an
   id-only match. Returning `null` there would make `contextWindow: null` — which the
   compaction budgets already handle (`src/runtime.ts:452-459` falls back to 20 000/32 000).
   *This is a behaviour change on a path the brief protects, so it needs a ruling.*
3. **Let the operator state the limit.** Add an optional per-model `contextWindow` override
   in the existing config schema (`src/config.ts` — the provider registry already lives
   there). The operator knows what his provider allows; the catalog is a guess. This makes
   the threshold *authoritative* instead of inherited, and is the single change that would
   have armed compaction automatically.
4. **Log the compaction decision either way.** When `pct` is computed, log the branch taken
   (`"below threshold"` / `"compacting"`), so "compaction never runs" is visible rather than
   inferred from an absence.
5. **Keep the turn path off the network for the denominator.** `design/app.md` rules that
   *"The gauge's denominator never stalls on the network: a cold models.dev memory falls
   back to a one-time disk-cache parse (`contextLimitCached`), memory wins once a turn
   warms it."* That ruling binds the **gauge** route
   (`src/http/app-conversations.ts:646` is the only `contextLimitCached` caller), but the
   **turn path** still uses the blocking `contextLimit` / `inputModalities`
   (`src/agent/step.ts:44-48`), whose `ensure()` can fetch over the network with a 10 s
   timeout (`src/agent/catalog-fetch.ts:14,82`). Extending the same non-blocking rule to
   `buildStep` keeps the gauge's contract and removes a network stall from the head of the
   first turn after a 24 h idle. *This needs a line in `design/app.md` or `design/model.md`*
   — the current ruling names the gauge, not the turn.

**Expected gain.** Not a speed-up — a *correctness* gain: the mechanism that keeps a long
conversation from hitting the provider's ceiling gets armed. Measured today: 0 compactions
in 149 turns. *Inferred — unverified:* with a 200 000 denominator the trigger would sit at
150 000, and the 96 429-token turn would have been at 64 %.

**Risk.** Medium, and deliberately ordered: steps 1 and 4 are pure logging (zero risk);
step 2 changes a fallback value (needs a ruling in `design/model.md`); step 3 touches the
config schema (`src/config.ts` is zod-validated, so a bad value fails loud, and
`src/config.test.ts` covers the schema). The compaction *budgets* also derive from the
denominator (`src/runtime.ts:452-459`: tail = 25 %, input = 50 %), so a too-small window
compacts too eagerly — a wrong number in the *other* direction is the real hazard, and step 3
is the operator's defence against it.

**Consumers.** `src/agent/models-dev.ts`, `src/agent/step.ts:44-48,90-93`,
`src/runtime.ts:446-459,1054`, `src/turn/finish.ts:39,120`, `src/http/*` (the `/context`
gauge reads the same limit), `design/model.md`.

---

### F2 — TTS chunks are synthesized serially · **P2** · NEW

**What is suboptimal.** `synthesizeSpeech` awaits each chunk inside a `for` loop. The chunks
are independent pieces of text; a long reply pays *N* sequential websocket handshakes and
*N* sequential synthesis windows.

**Evidence.**

- `src/agent/tts.ts:713-715`:
  ```ts
  for (const chunk of chunks) {
      audio.push(await remux(await synthesize(chunk, options)));
  }
  ```
- `src/agent/tts.ts:9` — `const CHUNK_LIMIT = 10_000;` — so a 30 000-character reply is
  three chunks.
- `src/agent/tts.ts:14-20` — the file's own note: *"Synthesis runs ~74 chars/s (measured
  2026-09-27) … the 10k-char CHUNK_LIMIT needs ~135s"*, with
  `EDGE_TIMEOUT_MAX_MS = 300_000`.
- **Measured from the runtime log**, the one multi-chunk synthesis in the window:
  ```
  2026-10-02T04:10:52.490Z  speech synthesis started   chars=18739 chunks=2
  2026-10-02T04:16:20.187Z  speech synthesis completed chunks=2 bytes=6990740
  ```
  → **327.7 s serial** for 18 739 characters. The three single-chunk syntheses give a
  per-chunk rate of **277 / 331 / 359 chars/s** (3 388 chars in 12.21 s, 3 560 in 10.74 s,
  1 065 in 2.97 s) — i.e. the code's 74 chars/s comment is ~4× pessimistic, and the same
  18 739 characters at the observed rate plus two handshakes predicts ~61 s.
  *Inferred — unverified:* the 5.4× gap between 61 s and 327.7 s is provider-side variance
  on that day; the serial structure is what prevents one chunk's synthesis from covering
  another's variance.

**Proposed change.** A small bounded pool (2–3 in flight) over the chunk array, order
preserved. `Promise.all` over the chunk array would preserve order but lose the provider's
concurrency tolerance; a pool of 2 is the conservative form. The `completedChunks` warn line
(`src/agent/tts.ts:716-722`) must count *completed* chunks, not `audio.length`, so it stays
accurate under partial failure.
**Expected gain.** Removes one full chunk's synthesis and one handshake from the critical
path: for the measured 18 739-character case, from two sequential chunks to one chunk's
latency (≈30 s at the observed rate) plus the slower of the two — *inferred — unverified*
until a real 2-chunk synthesis is re-run through the change. The gain scales with reply
length; below 10 000 characters there is one chunk and no gain.

**Risk.** Medium. Edge TTS may rate-limit or reorder; the pool must stay small and ordered,
and each call keeps its own per-call timeout budget (`edgeTimeoutMs` is per call,
`src/agent/tts.ts:22-24`). The `speak` tool runs *inside* the turn, so this latency is turn
latency, and the voice lane has a wedged-socket guard that must survive the change. The
`completedChunks` warn line (`src/agent/tts.ts:721`) must count *completed* chunks, not
`audio.length`, so it stays accurate under partial failure.

**Consumers.** `src/agent/tts.ts` → `src/agent/tools/speak.ts` → the turn's `deliverVoice`
hook (`src/runtime.ts:870-880`).

---

### F3 — The model view is materialized from an unbounded full-history scan, twice per turn · **P2** · NEW

**What is suboptimal.** `modelEntries` loads **every** event row of the conversation,
`JSON.parse`s every `data` blob, and *then* discards everything before the compaction
boundary with a JavaScript filter.

- `src/conversation.ts:964-967` — `qHistory` = `SELECT seq, anchor_seq, role, data FROM events WHERE conversation_id = ? ORDER BY seq` (the whole `data` blob, unbounded).
- `src/conversation.ts:1708-1723` — `historyDetail` parses every row (`parseEvent`, `src/conversation.ts:556-580`) and sorts on the causal key.
- `src/conversation.ts:1725-1732` — `modelEntries` filters on `(e.anchorSeq ?? e.seq) > compaction.boundarySeq` **in JS**.
- The same predicate is restated in `src/agent/compaction.ts:36-37`: *"The model view cuts on the same key, `(anchorSeq ?? seq) > boundarySeq` — keep them in sync."*
- It is called **twice per turn**: `src/runtime.ts:802` → `src/turn/admission.ts:70` (admission) and `src/runtime.ts:1010` → `src/turn/finish.ts:74` (landing). A **third** time in the steer path (`src/runtime.ts:981` → `src/turn/stream.ts:372`).

**Evidence (measured).** Instrumenting `bun:sqlite` and driving one real turn through the
real `Runtime`:

```console
$ bun --preload /tmp/sqlcount-preload.ts /tmp/measure-rows.ts
historyTurns=  0 stmts= 22 rowsRead=    2 fullEventScanCalls=1 turnMs=51.3
historyTurns= 10 stmts= 22 rowsRead=   22 fullEventScanCalls=1 turnMs= 4.9
historyTurns= 50 stmts= 22 rowsRead=  102 fullEventScanCalls=1 turnMs= 3.0
historyTurns=150 stmts= 22 rowsRead=  302 fullEventScanCalls=1 turnMs= 3.9
historyTurns=400 stmts= 22 rowsRead=  802 fullEventScanCalls=1 turnMs= 4.4
```

Statement count is flat at 22; **row count is linear in history** (2 rows per historical
turn). Production payload sizes:

```console
$ sqlite3 "file:/home/daniel/goblin/state/goblin.sqlite?mode=ro" \
    "SELECT COUNT(*), SUM(LENGTH(data)), AVG(LENGTH(data)), MAX(LENGTH(data)) FROM events;"
363  4352448  11990.2  461925
```

The largest conversation holds 32 events / 286 KB. So the largest turn in the live system
parses ~286 KB of JSON **twice** per turn, and the single largest event (462 KB) is parsed
on every turn that reads the history.

**Proposed change**, in three independent, separately-landable steps:

1. **Push the causal cut into SQL.** The filter is `COALESCE(anchor_seq, seq) > ?` and the
   sort is `ORDER BY COALESCE(anchor_seq, seq), seq` — both expressible. Add
   `qHistoryCausal` beside `qHistory` and use it in `modelEntries` when a compaction exists;
   leave `historyDetail`/`historyEntries` alone (they need the full causal record). Guard
   with the existing test that already asserts the two agree
   (`src/runtime.test.ts:1448` derives the boundary from the stored compaction and compares
   the tail against `historyDetail`).
   **Caveat that must be ruled on before this lands:** today a corrupt row *outside* the
   model's view is still parsed and still warned about
   (`src/conversation.ts:570-573`, `"corrupt history row — degrading to placeholder"`).
   After the change it is never parsed, so it is never warned about — a **logging
   reduction**, which this brief forbids. It needs either an explicit ruling (*"a corrupt
   row outside the model's view need not be warned about"*) or a cheap integrity sweep
   alongside.
2. **Hand the admission entries to the landing path** instead of re-reading. `landAttempt`
   (`src/turn/finish.ts:74`) filters by `e.seq <= deps.steerMark`; the safe form is
   *"admission entries ∪ everything with `seq` after the admission mark"* — one query
   instead of a second full read plus a second parse of the same blobs.
3. **Add the index** `events_causal(conversation_id, COALESCE(anchor_seq, seq), seq)` so
   step 1 is a range scan rather than a filtered scan. This is a write to the production
   DB and must land through `scripts/deploy.sh` (`AGENTS.md`).

**Expected gain.** Step 1 turns an O(conversation) read into an O(tail) read — on a
compacted conversation, from every event to the post-boundary tail only. Step 2 removes one
full read + parse per turn outright. *Inferred — unverified* in wall-clock terms (the
measured turn is 3–5 ms at 400 turns of synthetic history, because those rows are small);
the number that matters is the **462 KB single event** and the 286 KB conversation, neither
of which the synthetic harness reproduces.

**Risk.** Low for step 2, medium for step 1 (the logging caveat above, plus the
byte-identical-output requirement of the cache-stability invariant in
`design/runtime-turn.md` → "What must not change"), low for step 3 (one more index
maintained on every append).

**Consumers.** `src/conversation.ts:1725` → `src/turn/admission.ts:78`, `src/runtime.ts:802/981/1010`,
`src/turn/finish.ts:74`; `src/agent/compaction.ts:209`; `src/cache-pruning.ts:187`;
`src/app-push.ts:188`; `src/http/app-conversations.ts:802,856`.

---

### F4 — Every tool schema is converted zod → JSON-Schema on every model step, twice · **P2** · NEW

**What is suboptimal.** Two independent components re-derive every tool's JSON Schema on
every step of the tool loop, from a value that is constant for the whole turn.

- **goblin's own gauge.** `measurePrompt` (`src/turn/itemize.ts:151-168`) walks every
  message *and* calls `toolDefsChars` (`src/turn/itemize.ts:137-150`), which does
  `asSchema(t.inputSchema).jsonSchema` (`:142`) and `JSON.stringify` of the result (`:145`)
  **per tool**. `measurePrompt` is called from `notePrompt`
  (`src/turn/stream.ts:280-281`), which fires **once per model step**
  (`src/turn/stream.ts:321,324,364,367,387`) — but `lastPromptChars` is read in exactly
  **one** place, the `finish` part's metadata (`src/turn/stream.ts:515`). Every step but the
  last is pure waste.- **The AI SDK's own copy.** The SDK calls `prepareTools` **inside** the per-step loop
  (`node_modules/ai/dist/index.js:5580-5585`), and `prepareTools` calls
  `asSchema(tool.inputSchema).jsonSchema` per tool
  (`node_modules/ai/dist/index.js:2015-2027`). `asSchema` builds a fresh wrapper each call
  (`node_modules/@ai-sdk/provider-utils/dist/index.js:3165-3171`) and the memoization inside
  `zod4Schema` is **per wrapper** (`:3206-3222`), so the conversion re-runs.

**Evidence (measured).**

```console
$ bun run /tmp/schema-bench.ts
cold zod->JSON-Schema for 6 tools: 2.70ms  (0.450 ms/tool), schema bytes=1320
6 steps x 6 tools = 36 conversions: 2.49ms per turn
pre-built: 36 serializations only: 0.08ms per turn
```

0.450 ms per tool per conversion. The tool set is **23 tools** at maximum
(`src/agent/tools/mod.ts:116-165` — 4 unconditional + 19 conditional, plus `script` when
scripting is on), and the log shows **863 model steps across 149 completed turns ≈ 5.8
steps/turn**. So goblin's gauge alone performs ≈ 133 conversions per turn ≈ **60 ms/turn**,
and the SDK's copy adds a similar amount.

**Proposed change.**

1. **Pre-build each tool's JSON Schema once.** The pattern already exists in this tree:
   `src/agent/tools/ui.ts:9` uses `jsonSchema<UiInput>(asSchema(uiInputSchema).jsonSchema,
   { validate })` from `@ai-sdk/provider-utils`; `asSchema` then returns it as-is
   (`provider-utils:3170`), so the SDK's per-step `prepareTools` becomes a no-op copy. The
   schema objects must be **module-level** (or memoized per tool), not rebuilt per turn, or
   the cost merely moves from O(steps) to O(1)-per-turn.
2. **Compute the gauge once per turn.** Keep the outbound message reference from the last
   `prepareStep` and compute the segments in the `messageMetadata` callback for the `finish`
   part (`src/turn/stream.ts:515`), or memoize `toolDefsChars` per `ToolSet` identity — the
   tool set does not change between steps. This is what the design already wants:
   `design/app.md` rules that *"The gauge reads the final step's prompt (`usage.lastInput`),
   never the turn's billed sum across the tool loop (ruling 2026-10-19: the two differ by
   the step count, and the sum once read as a 223k window on a 37k one)"*. Computing the
   final step's figure once, at the finish, is the design's own contract — the current code
   computes every step's figure and throws all but one away.

**Expected gain.** Removes ≈ 60 ms/turn of zod→JSON-Schema work in goblin's gauge and a
similar amount inside the SDK — *inferred — unverified* as a wall-clock figure (I measured
the 0.450 ms/tool conversion in isolation, not its share of a live turn), but the
arithmetic (23 tools × 5.8 steps × 0.450 ms) is measured input times measured input.

**Risk.** Medium-low. The JSON Schema must be **input-side** (`io: "input"`,
`target: "draft-7"`) to match what the SDK produces today; the `ui` tool's usage is the
in-tree reference. The gauge's output must stay byte-identical — the app's context gauge
consumes it and `design/app.md` rules on it.

**Consumers.** `src/agent/tools/*` (schema construction), `src/turn/itemize.ts:137-168`,
`src/turn/stream.ts:280-387,515`, the AI SDK's request assembly.

---

### F9 — One decision vocabulary, two hand-maintained copies, already drifted · **P2 (structure)** · EXTENDS P4

**What is suboptimal.** The mail-approval decision outcome is mapped to operator-facing text
in **two** places, by hand, and they have already diverged.

- `src/tg/mail-approval.ts:117-134` — a flat `switch (outcome.kind)` over eight cases.
- `src/http/app-conversations.ts:385-401` — the same eight cases as a **nine-level nested
  ternary**.

| outcome kind | Telegram (`answerText`) | App (nested ternary) |
| --- | --- | --- |
| `gone` | `"draft gone"` | `"draft gone"` ✓ |
| `settled` | `` `already ${row.status}` `` | `` `already ${row.status}` `` ✓ |
| `busy` | `"sending — wait for the verdict"` | same ✓ |
| `expired` | `"draft expired"` | same ✓ |
| `cancelled` | `"cancelled"` | `"draft cancelled — never sent"` ✗ |
| `sent` | `"sent"` | `"draft sent"` ✗ |
| `retry` | `"send failed — see the notice"` | `outcome.message` — the **raw error** ✗ |
| `conflict` | `"send raced another decision"` | same ✓ |

Three of eight differ. The `retry` divergence is the one with a consequence: the app door
returns the raw upstream message to the client where Telegram returns a fixed string.

**Proposed change.** One exported function — `describeMailDecision(outcome): string` —
owned by the shared approval owner (`src/app-approvals.ts` already exists for exactly this
role: *"Decisions still route through the shared owners — this module never decides"*), and
both doors call it. The app door keeps its `{ status, message }` envelope; the message text
comes from the shared function. Decide the `retry` text once (the Telegram wording is the
safer of the two: it does not surface upstream text).

**Expected gain.** No runtime gain. Maintainability gain: the *decision* is already shared;
only the *vocabulary* is duplicated, and it has drifted in 3 of 8 cases. This is the
"structurally simpler" half of the brief's target, and the cheapest fix in this report —
one exported function and two call sites.

**Risk.** Very low. The only behaviour change is the two drifted `cancelled`/`sent` strings
and the `retry` string, which should be a deliberate, reviewed wording choice (and a change
to the app's client-visible text).

**Consumers.** `src/tg/mail-approval.ts:117-134`, `src/http/app-conversations.ts:385-401`,
`src/app-approvals.ts`.

---

### F10 — `src/conversation.ts` is one 1213-line closure holding 19 responsibilities · **P2 (structure)** · NEW

**What is suboptimal.** `openStore` (`src/conversation.ts:583-1796`) is a single closure
owning 43 prepared statements and 30+ public methods, across every concern the conversation
domain has:

schema & migration · DM-rolling bookkeeping · address resolution · settings & epoch ·
prompt snapshots · event append & projections · the model view · compaction · memory
contexts & eligibility · FTS search · project binding · delete cascade · event context.

It also constructs **three other modules' stores** (`src/conversation.ts:713-715`:
`MemoryQueue`, `MemoryContexts`, `MemoryDestinations`) and calls **two other modules'
schema installers** (`:614-615`: `ensureProjectsSchema`, `ensureNotesSchema`) — both of
which already own their own tables elsewhere (`src/notes.ts:186`, `src/projects.ts:110`).

**Evidence (measured).**

```console
$ bun run scripts/function-size-audit.ts
23 function(s) over 300 lines:
  src/conversation.ts:583 openStore — 1214 lines      # ← the worst offender in the tree
  src/desktops.ts:410 makeDesktops — 1133 lines
  src/tg/delivery.ts:152 makeDeliverySink — 1030 lines
  src/index.ts:106 boot — 783 lines
  src/http/app-conversations.ts:287 handleConversationsRoute — 764 lines
  ...
```

`DESIGN.md` → "## Module map" rules: *"Flat modules, one job each … `index.ts` wires and
never rules … Inside a module, state clusters by lifetime live in their own units — never
one scope of closures."* `AGENTS.md`: *"One module, one job."* The design names the smell
line (≈300) and ships the tool that measures it.

**Proposed change.** See sketch **S3** below. The `ConversationStore` **interface** does not
change shape — 30+ consumers depend on it — and `openStore` becomes a composer. The
`reply_ratings` DDL (`src/conversation.ts:772-801`) and the `app_push_*` DDL
(`:805-827`) move to `src/reply-ratings.ts` and `src/app-push.ts`, which already own those
tables' semantics. Explicitly **not** moved: the compaction text projection and the memory
retention projection (`design/runtime-turn.md` → "The two text projections (#84 / #111)"),
the model-view builder (`src/turn/view.ts`), `src/rolling.ts`'s policy, and the `events` FTS
triggers.

**Expected gain.** No runtime gain. `openStore` 1213 lines → a ~150–200-line composer, with
five or six siblings each under the 300-line bar. Measurement instrument already exists:
`scripts/function-size-audit.ts` before and after.

**Risk.** Medium-low — it is a wide but mechanical import refactor. Constraints: one
`Database` handle and one store instance (`src/sqlite.ts:1-3` warns that several stores
already open the same file as separate connections; `DESIGN.md` → "The shape: disjoint
channels" says *one store*); no nested `db.transaction` (bun:sqlite has no savepoints —
`src/notes.ts:361`); the `events` FTS triggers must be created by the module that owns
`events`; `PRAGMA foreign_keys = ON` (`src/conversation.ts:597`) must remain set, because
the `turn_runs → conversations` cascade (`src/turn-journal.ts:377`) depends on it; and the
new modules must not import `src/runtime.ts` (`src/module-boundaries.test.ts:72-74` —
*"http/mod.ts stays runtime-free"*).

**Consumers.** All — via the unchanged interface.

---

### F5 — The authority fence reads 17 columns to compare one integer, eleven times per turn · **P3** · NEW

**What is suboptimal.** The authority rule (DESIGN.md → "The authority rule") is a
*re-read* of the conversation's epoch before every side effect — that re-read is load-bearing
and must not be removed. But it re-reads the **whole row** and materialises a full
`Conversation` object (17 fields, `toConversation` at `src/conversation.ts:496-514`) to
compare one integer, and it does so 11 times per turn.

**Evidence (measured).** 11 × `SELECT * FROM conversations WHERE id = ?` per turn (the
instrumented harness above), against a query that pulls every column
(`src/conversation.ts:929`). The store already owns the narrow query —
`qEpoch` (`src/conversation.ts:1039-1041`) — and the fence does not use it
(`src/runtime.ts:518-521`: `const current = this.deps.store.get(convId)?.epoch;`).

**Proposed change.** Add `epochOf(id): number | null` to the `ConversationStore` interface,
implement it from `qEpoch`, and route the four fence sites through it
(`src/runtime.ts:519`, `:820`, `:973`, `:1118`). Keep the full `get()` where the *whole*
row is genuinely needed (`src/runtime.ts:430` — manual compaction needs fresh settings;
`src/runtime.ts:1039` — the reviewer needs the live exclusion flag).

**Expected gain.** Statement count is deliberately **unchanged** (11 → 11): the freshness
semantics are the invariant, and this proposal does not touch them. What drops is bytes and
allocation: 11 full-row materialisations + 11 object builds per turn become 11 single-integer
reads. *Inferred — unverified* in bytes; the row is small and SQLite pages it either way.

**Risk.** Low, with one sharp edge: `qEpoch` returns `undefined` for a missing row while
`get()` returns `null`. `epochOf` must return `null` for a missing row so that
`null !== epoch` **still fences** a deleted conversation, matching today's behaviour.

**Consumers.** `src/runtime.ts` (fence sites) → `src/turn/stream.ts` (the injected
`assertAuthority` / `holdsAuthority`), `src/tg/delivery.ts` (the delivery fence).

---

### F6 — `compactions` has no index on `conversation_id`, and the compaction row is read twice per turn · **P3** · NEW

**Evidence (measured).**

```console
$ sqlite3 "file:/home/daniel/goblin/state/goblin.sqlite?mode=ro" \
    "EXPLAIN QUERY PLAN SELECT boundary_seq, summary, ... FROM compactions
     WHERE conversation_id = 'x' ORDER BY id DESC LIMIT 1;"
QUERY PLAN
`--SCAN compactions
```

A **scan**, where `events`, `event_projections` and `conversations` are all index-served
(`SEARCH … USING INDEX sqlite_autoindex_…`). The query
(`src/conversation.ts:913-925`) runs **twice** per turn — from `modelEntries`
(`src/conversation.ts:1726`) and from `memoryEligibility` (`src/conversation.ts:1565`) —
microseconds apart, with no intervening write, and the second read fetches the whole
`summary` text it does not use.

**Proposed change.** (a) Add
`CREATE INDEX IF NOT EXISTS compactions_conv_id ON compactions(conversation_id, id DESC)` —
turns the scan into a `SEARCH` that also satisfies the `ORDER BY id DESC LIMIT 1` with no
sort. (b) Thread the already-read compaction into `memoryEligibility`
(`src/conversation.ts:335` signature, `:1560-1566` impl) with a three-state parameter
(`undefined` = "read it yourself", `null` = "there is no pointer row", object = "here it
is") so no existing caller changes behaviour. (c) Optionally split the internal
`modelEntries` path so it fetches only `boundary_seq, summary, summary_eligible`, leaving
the public `getCompaction` shape intact for `src/agent/compaction.ts:210` and
`src/http/app-conversations.ts`.

**Expected gain.** 2 executions/turn → 1, and `SCAN` → `SEARCH`. *Inferred — unverified* in
wall-clock: today `compactions` holds one row per compacted conversation, so the scan is
trivial — but the table is append-only and never pruned (no `DELETE FROM compactions`
outside `deleteConversation`, `src/conversation.ts:1100`), so the scan grows without bound.

**Risk.** Low, with one sharp edge: the `undefined` vs `null` distinction must be exact. A
`null` that means "not supplied" would silently make `summaryEligible` always `false` — a
memory-retention correctness bug (the retention path would refuse to retain). Do **not**
thread the compaction across `src/runtime.ts:865` → `:1011`: a threshold compaction can land
between them and each call site must see a fresh pointer. The index is a production-DB
write → `scripts/deploy.sh`.
**Consumers.** `src/runtime.ts:865,1011`, `src/conversation.ts:1726,1565`,
`src/cache-pruning.ts:198`, `src/agent/compaction.ts:210`, `src/http/app-conversations.ts`.

---

### F7 — Five "what is the last message?" call sites load the entire conversation · **P3** · NEW

**What is suboptimal.** Five sites want one message and parse the whole history to find it.

| Site | Line | What it wants |
| --- | --- | --- |
| `src/rolling.ts:226` | `deps.store.history(current.id)` then `.some(m => m.role === "assistant")` | a boolean |
| `src/tg/bell.ts:53` | `.findLast(m => m.role === "assistant")` | the last assistant message |
| `src/spinoff.ts:85` | `.findLast(m => m.role === "user")` | the last user message |
| `src/http/app-chat.ts:183` | `.findLast(m => m.role === "user")` | the last user message (the app retry path) |
| `src/app-push.ts:187-189` | `.historyDetail(conv.id).findLast(e => e.message.role === "assistant")` | the last assistant message + its seq |

The store already owns the shape: `qLastUserSeq` (`src/conversation.ts:968-970`),
`qLastReplyAnchor` (`:971-973`).

**Proposed change.** One store method, `lastMessage(id, role)`, backed by
`SELECT seq, role, data FROM events WHERE conversation_id = ? AND role = ?
ORDER BY COALESCE(anchor_seq, seq) DESC, seq DESC LIMIT 1`, using `parseEvent` and the
same `corruptPlaceholder` fallback as `historyDetail` (`src/conversation.ts:1712`). The
`COALESCE(anchor_seq, seq)` ordering is required: `findLast` on the causal array is **not**
`ORDER BY seq DESC`, because an anchored response has a high `seq` but an early causal
position. The index from F3 step 3 serves this query directly.

**Expected gain.** Each site: O(conversation) rows + O(conversation) JSON.parse → 1 row,
1 blob. On the largest production conversation that is ~286 KB of parsing → ~12 KB.
*Inferred — unverified* as a wall-clock figure. These sites are **not** on the per-turn
critical path (turn completion, DM routing, push, app retry), so this is a latency-spike
win, not a throughput win.

**Risk.** Medium — the ordering is the whole risk and must be proven by a test on a
conversation containing anchored responses, not by reading. `src/runtime.test.ts:1984`
builds such a fixture (`r.store.historyDetail(r.conv.id)` with an `anchorSeq` set). The corrupt-row
fallback must reproduce `historyDetail`'s placeholder rather than return `null`, or
`src/tg/bell.ts:55` would report "no reply" for a corrupt reply.

**Consumers.** `src/rolling.ts`, `src/tg/bell.ts`, `src/spinoff.ts`, `src/http/app-chat.ts`,
`src/app-push.ts`.

---

### F8 — The interrupted-turn listing scans every run in the database and filters in JS · **P3** · NEW

**What is suboptimal.** `journal.interrupted()` is
`${RUN_SELECT} WHERE r.status = 'interrupted' ORDER BY r.started_ms, r.run_id`
(`src/turn-journal.ts:544-546`), where `RUN_SELECT` (`src/turn-journal.ts:366-372`) is
`SELECT r.*` plus **five correlated COUNT subqueries**. It returns *every* interrupted run
in the database; the caller then filters by conversation **in JavaScript**
(`src/turn-resume.ts:119-123` `findRun`, `:344-347`) and throws most of it away.
`turn_runs` has no index on `conversation_id` — the column is written
(`src/turn-journal.ts:461-467`) and **never read by any query**.

**Proposed change.** Two indexes beside the DDL (`src/turn-journal.ts:375-407`):
`turn_runs_conv_status(conversation_id, status, started_ms)` and
`turn_runs_status(status, started_ms, run_id)`; plus a conversation-scoped read
`interruptedIn(conversationId)` used at `src/turn-resume.ts:120` and `:344-346`. The
second index also makes the boot reclassification (`WHERE status='running'`,
`src/turn-journal.ts:447-450`) index-ordered.

**Expected gain.** The app's `/interrupted` route goes from O(all runs in the DB × 5
subqueries) to O(one conversation's runs). *Inferred — unverified* in wall-clock: the table
holds one row per attempt and **nothing ever deletes it** (no `DELETE FROM turn_runs` or
`FROM turn_tool_calls` anywhere in `src/`), so the scan grows without bound — the same
retention question the prior review's §"cleared" list did not raise.

**Risk.** Low. `findRun`'s ambiguity check (`src/turn-resume.ts:122`) is preserved: the JS
filter was already applied before the `runId` prefix match, so scoping the query earlier is
semantically identical. Two indexes on a table that grows forever is one extra index insert
per attempt against a read win that grows with the table.

**Consumers.** `src/turn-journal.ts`, `src/turn-resume.ts`, `src/http/app-conversations.ts`
(the `/interrupted` and `/runs/:id/decide` routes), `src/tg/turn-notice.ts` (boot notices),
`src/runtime.ts:906,926`.

**Ruling needed.** `design/runtime-turn.md` → "The turn journal" specifies the journal's
*durable semantics* and says nothing about **retention**. A crashed-turn record is
operator-visible evidence (`src/tg/turn-notice.ts` reports it at boot), so pruning it is an
operator decision, not an optimization. This finding asks only for the index.

---

### F11 — `titleImplicit`: one column, two meanings, and the app writers invert its only spec · **P3** · EXTENDS P3

**Evidence.** The column's only specification is `src/conversation.ts:113-115`:

> *Telegram placeholder name — the bot owes it a real one. Cleared by explicit rename or a
> successful auto-title.*

Writers:

| Site | Value | Spec-conformant? |
| --- | --- | --- |
| `src/tg/titles.ts:19` | `true` (platform placeholder) | ✓ |
| `src/tg/titles.ts:23` | `false` (explicitly named topic) | ✓ |
| `src/tg/titles.ts:62` | `false` (after a successful auto-title) | ✓ — "cleared by a successful auto-title" |
| `src/conversation.ts:1391` | `true` (a new app conversation awaiting a name) | ✓ |
| `src/http/app-conversations.ts:451,993` | `false` (operator rename) | ✓ |
| **`src/http/app-chat.ts:287`** | **`true` (after the app auto-title produced a real name)** | ✗ **inverted** |
| **`src/spinoff.ts:93`** | **`true` (after the spin-off auto-title)** | ✗ **inverted** |

Readers: `src/tg/titles.ts:41,52`, `src/tg/mod.ts:360,365,660`, `src/spinoff.ts:92` — all
consistent with the spec, and all channel-gated (`src/tg/titles.ts:41` requires
`threadId !== null`, so app rows are excluded). So **no cross-pool leak today**; the cost is
purely that the column's only spec is false for the app pool.

**Proposed change.** Pick one meaning and state it in the column's comment. Two coherent
options: (a) "the title is provisional and may be replaced" (the app pool's meaning) — then
`src/tg/titles.ts:62` should set `false` too, because a successful auto-title *settles* the
debt, and the Telegram readers keep working; or (b) "Telegram owes this conversation a real
name" (today's text) — then the two app writers must set `false`, and
`src/spinoff.ts:92`'s guard must change to a different signal (it currently relies on the
app writer's `true` to re-title a spun-off conversation). Option (a) is the smaller change.

**Expected gain.** No runtime gain. Maintainability gain: today a reader who trusts the
comment will mis-handle app rows, and the next writer will add a third meaning.

**Risk.** Low, but the *choice* is a product decision about what a title means, so it needs
a line in `design/app.md` or `design/telegram.md` — not a unilateral code change.

**Consumers.** `src/http/app-chat.ts:287`, `src/spinoff.ts:92-93`, `src/tg/titles.ts:19,23,41,52,62`,
`src/tg/mod.ts:360,365,660`, `src/http/app-conversations.ts:451,993`, `src/conversation.ts:113-115,1391`.

---

### F12 — Sink capability is inferred from optional-method presence and restated by hand · **P3** · EXTENDS P2

**Evidence.** "Is this sink a streaming sink?" is decided by the *presence of an optional
method*, in five places: `src/runtime.ts:207` (`t.sink.onStreamChunk !== undefined`),
`:645`, `:677`, `:978`, `src/app-media.ts:37`, `src/turn/stream.ts:115`. Separately,
`src/turn-resume.ts:82-90` restates a related capability as a channel-keyed literal:

```ts
sinkHooks: (conv) =>
    channelOf(conv.id) === "app"
        ? { voice: true, recording: false, file: true }
        : deps.wake.delivery === undefined
            ? { voice: false, recording: false, file: false }
            : { voice: true, recording: true, file: true },
```

with a comment that has to explain why the app's table differs from Telegram's. The prior
review noted that the table is pinned by a test
(`src/turn-resume.test.ts:1964,1980,2010` assert the three per-channel capability rows), so
drift against the real sinks stays green.

**Proposed change.** One explicit capability object per sink — e.g.
`TurnSink` gains an optional `capabilities?: { streams: boolean; voice: boolean;
recording: boolean; file: boolean }` — with the *presence* of `onStreamChunk` kept only as
the runtime's fallback for sinks that do not declare it. The `sinkHooks` table then becomes a
read of the declared capability rather than a hand-written table, and the drift test
compares declared capabilities to the real sinks.

**Expected gain.** No runtime gain. Maintainability gain: one place states what a sink can
do, instead of one place inferring it from method presence and another restating it per
channel.

**Risk.** Low. The `TurnSink` interface is consumed in `src/runtime.ts`, `src/turn/stream.ts`,
`src/app-media.ts`, `src/turn-resume.ts`, `src/tg/delivery.ts`, `src/http/app-sse.ts` and the
testkit — a type-only addition with a fallback keeps every existing sink working.

**Consumers.** `src/runtime.ts`, `src/turn/stream.ts`, `src/app-media.ts`, `src/turn-resume.ts`,
`src/tg/delivery.ts`, `src/http/app-sse.ts`, `src/testkit.ts`.

---

### F13 — Fencing is decided per call site: `memoryExcluded` is written through both doors · **P3** · EXTENDS P5

**Evidence.** `DESIGN.md` → "The authority rule": *"Each conversation carries a monotonic
`epoch`, bumped on conversation-scoped settings changes (`/voice`, `/memory on|off`)"*.
`memoryExcluded` **is** `/memory on|off`. It is written through two store methods that
differ in whether they bump the epoch:

- `src/conversation.ts:1487-1492` — `applySettings` = `applyPatch` + `bump` in one transaction. Used by `src/projects.ts:302` (`applySettings`, fenced — with the comment *"epoch bump included — a live turn is fenced"*), `src/tg/commands.ts:107` (the `/memory` command), `src/http/app-conversations.ts:531`.
- `src/conversation.ts:1449-1451` — `setMeta` = `applyPatch` only, no bump. Used by `src/http/app-conversations.ts:448` (`memoryExcluded: true` — **not** fenced), `src/tg/guest.ts:375` (persona + `memoryExcluded`), `src/http/app-chat.ts:287`, `src/spinoff.ts:93`, `src/tg/mod.ts:359`, `src/tg/titles.ts:62`, `src/http/app-conversations.ts:451,600,991`.

The `src/http/app-conversations.ts:448` case is benign **only** because it sits inside the
`existing === null` creation branch — a new conversation has no live turn. The near-miss is
real: the same field, same meaning, one door fenced and one not, with nothing in the type
system saying which is which.

**Proposed change.** Split the store interface by *intent* rather than by *mechanism*:
`setDisplayMeta(id, patch)` (title, pin, archive — no epoch) and
`setTurnSettings(id, patch)` (voice, memoryExcluded, persona — bumps). Make the
conversation-scoped settings patch a discriminated union so the compiler refuses a
turn-affecting field on the display path. The guest path (`src/tg/guest.ts:375`) needs an
explicit decision: it changes `persona`, which is a prompt-class change, not a display
change.

**Expected gain.** No runtime gain today (the prior review found no live defect, and I
agree — admission-time capture absorbs it). Maintainability gain: the "does this fence?"
question is answered by the type, not by reading each call site.

**Risk.** Low-medium: it is a type-level change to a widely-used store interface, and the
guest path needs a ruling (does a persona flip fence a live turn? — `design/telegram.md` →
"Roles and permissions" should say).

**Consumers.** `src/conversation.ts` (interface + impl), `src/projects.ts:302`,
`src/tg/commands.ts:107`, `src/tg/guest.ts:375`, `src/http/app-conversations.ts:448,531`,
`src/http/app-chat.ts:287`, `src/spinoff.ts:93`, `src/tg/mod.ts:359`, `src/tg/titles.ts:62`.

---

### F14 — The memory queue's operation poll is double-cadenced, un-backed-off, and fsyncs on every tick · **P3** · NEW

**What is suboptimal.** A retained document is submitted asynchronously; the queue worker
polls the remote operation until it reports a terminal state. The poll is *required*
(`design/memory.md` → "Retain: a durable projection of completed exchanges": *"an HTTP
acknowledgement is not proof of completion"*) — its **cadence** is not.

**Evidence (measured from the log).** 232 of 602 memory requests (38.5 %) are
`operation` polls; 103 of them (44 %) were **no-ops** — the row stayed `submitted`. The
cadence is exactly 10 s, not the intended 5 s:

```
2026-10-21T23:06:08.317Z  from submitted → submitted  attempts 2
2026-10-21T23:06:18.318Z  from submitted → submitted  attempts 3
2026-10-21T23:06:28.319Z  from submitted → submitted  attempts 4
```

`next_attempt` is persisted as `clock() + 5000` *after* the HTTP call
(`src/memory/queue.ts:487`), and the worker timer is `setInterval(…, 5000)`
(`src/memory/mod.ts:727-732`) — so the row is always due just *after* the next tick and
the effective interval is two ticks. The error branch has an exponential backoff
(`src/memory/queue.ts:474`), but the *success-but-not-terminal* branch leaves the delay at
its 5 000 ms seed (`src/memory/queue.ts:440`). Every poll also issues an fsync'd
`UPDATE … attempts = attempts + 1` on a table opened with `PRAGMA synchronous = FULL`
(`src/memory/queue.ts:186-197`, `src/conversation.ts:585-589`), plus three JSONL lines.

**Proposed change.** (a) In the submitted branch, derive the delay from the row's own poll
counter — `min(60 000, 5 000 · 2^min(polls, 4))` — so a slow operation is polled 5 s, 10 s,
20 s, 40 s, 60 s instead of every 10 s forever. (b) Align the first poll with the timer
deliberately instead of accidentally: compute `next_attempt` from the tick time, not from
`clock()` after the HTTP call, so the intended 5 s cadence is the one that happens.

**Expected gain.** *Inferred — unverified:* the log's own distribution (mean 1.5 no-op polls
per run, max 22) suggests ≈ 63 fewer HTTP GETs, 63 fewer fsync'd UPDATEs and ≈ 190 fewer
log lines over the 35-day window — ≈ 9 % of the memory subsystem's traffic.

**Risk.** Low, with one knock-on: a row stays `submitted` longer, so
`memoryStatus` (`src/memory/mod.ts:574-634`) reports "N retentions draining" for longer.
Nothing else consumes the `completed` state — the forget path settles its own operations
(`src/memory/forget.ts:16-38`). The existing test at `src/memory/queue.test.ts:113-120`
drives the clock by hand and must be updated to the new cadence deliberately; its intent
("acknowledgement alone is not completion") is preserved.

**Consumers.** `src/memory/queue.ts` (the worker), `src/memory/mod.ts:653-754`
(`startMemoryWorker`), `src/index.ts:452-464` (boot), `src/tg/commands.ts:8` and
`src/http/operator.ts:34` (`memoryStatus`), `src/memory/forget.ts`.

---

## Part 2 — Implementation sketches for the top three

These are sketches, not patches. Each names the module layout, the interface, and the
migration order.

### S1 — Arm the compaction trigger (F1)

**Module layout.** No new module. The change is a *return-shape* change plus a config
addition:

```
src/agent/models-dev.ts
    export interface ContextLimit {
        limit: number | null;
        source: "direct" | "cross-provider" | "unknown";
        providerKey: string | null;   // which catalog key supplied the number
    }
    export async function contextLimitDetail(provider, modelId): Promise<ContextLimit>
    export function contextLimitCachedDetail(provider, modelId): ContextLimit | null

src/agent/step.ts
    buildStep:        → step.contextWindow (number | null, unchanged)
                       + step.contextWindowSource (new, informational)
    compaction.contextWindow: → number | null (unchanged for callers)

src/turn/finish.ts
    window: { input, limit, pct, source }   // + one field

src/config.ts
    providers.<name>.models.<model>.contextWindow?: number   // zod-validated, optional
```

**Interface.** `contextLimit` keeps its current signature and semantics; a new
`contextLimitDetail` carries the provenance. The config field is optional and validated by
the existing schema — an absent value means "use the catalog", a present value means
"the operator says this is the limit" and wins over the catalog.

**Migration order.**

1. *Observability only.* Add `source`/`providerKey` to the window object and log them.
   No behaviour change. This alone makes the current 1 000 000 attributable.
2. *Config knob.* Add the optional `contextWindow` override to the provider registry
   (`src/config.ts` + `src/config.test.ts`). Still no behaviour change until the operator
   sets it.
3. *Cross-provider fallback → unknown.* Change `src/agent/models-dev.ts:106-110` to return
   `null` instead of another provider's number. **Requires a ruling in `design/model.md`**:
   the catalogue's id-only match is currently load-bearing for models whose provider key is
   not a models.dev key (openrouter ids, `zai-coding-plan`).
4. *Log the compaction branch.* When `pct` is computed, log which side of
   `COMPACT_AT_PCT` the turn fell on.

**Guardrail check.** No feature removed; no validation skipped; no logging reduced (step 1
and 4 add lines). The compaction budgets at `src/runtime.ts:452-459` keep their
`contextWindow === null` fallback.

### S2 — Bound the per-turn history work (F3 + F5 + F6 + F7, one coherent change)

**Module layout.** The store stays one module for now; this is a *query* change, and a
module split is F10's job. The new queries and the index live beside their peers:

```
src/conversation.ts
    // beside qHistory (:964)
    qHistoryCausal   — WHERE conversation_id = ?1 AND COALESCE(anchor_seq, seq) > ?2
                       ORDER BY COALESCE(anchor_seq, seq), seq
    qLastMessage     — WHERE conversation_id = ? AND role = ?
                       ORDER BY COALESCE(anchor_seq, seq) DESC, seq DESC LIMIT 1
    // beside qEpoch (:1039) — already exists
    epochOf(id): number | null
    // new DDL beside the events DDL
    CREATE INDEX IF NOT EXISTS events_causal
        ON events(conversation_id, COALESCE(anchor_seq, seq), seq)
    CREATE INDEX IF NOT EXISTS compactions_conv_id
        ON compactions(conversation_id, id DESC)
```

**Interface.** The `ConversationStore` interface gains three members — `epochOf`,
`lastMessage`, and an optional second parameter on `memoryEligibility` — and *loses*
none. Every addition is backward-compatible; the three-state `memoryEligibility` parameter
(`undefined` | `null` | object) preserves every existing caller's behaviour.

**Migration order.**

1. `epochOf` + route the four fence sites through it. Pure bytes; the statement count is
   deliberately unchanged. Test: a deleted conversation still fences.
2. The `compactions_conv_id` index + threading the already-read compaction into
   `memoryEligibility`. Test: the retention path's `summaryEligible` is unchanged for a
   conversation with and without a compaction.
3. `qHistoryCausal` + `events_causal`, used by `modelEntries` **only when a compaction
   exists**. Test: the existing assertion that the SQL view and
   `historyDetail(...).filter((e) => (e.anchorSeq ?? e.seq) > boundary)` agree
   (`src/runtime.test.ts:1448` derives the boundary from the stored compaction) must pass
   *byte-identically*. **The corrupt-row
   logging caveat must be ruled on before this step lands.**
4. `lastMessage` + the five call sites. Test: on a conversation with anchored responses,
   `lastMessage(id, "assistant")` equals `history(id).findLast(m => m.role === "assistant")`
   (`src/runtime.test.ts:1984` supplies the fixture), and a corrupt last row yields
   the placeholder, not `null`.
5. Hand the admission entries to `landAttempt` (the union form: admission entries ∪
   `seq > admission mark`). Test: the landed anchor and the ownership high-water mark are
   unchanged with and without a steer.

**Guardrail check.** No feature removed; no validation skipped. Step 3 is the only step
that touches logging, and it *reduces* it — it is gated on an explicit ruling. Steps 2–3
are production-DB writes and land through `scripts/deploy.sh` (`AGENTS.md`).

### S3 — Split `src/conversation.ts` (F10)

**Module layout.** Flat siblings at the `src/` root, colocated `.test.ts` each — the
pattern `src/notes.ts` and `src/projects.ts` already use (each owns its own schema).

```
src/conversation.ts            — the ConversationStore INTERFACE + openStore as a composer
src/conversation-schema.ts     — DDL + migrations + FTS triggers (the events owner)
src/conversation-address.ts    — resolve / get / listAppConversations / forkToApp /
                                 bindProject / listProjectConversationIds
src/conversation-history.ts    — append / history / historyDetail / modelEntries /
                                 eventProjections / applyEventProjections / lastSeq /
                                 eventContext / deleteConversation
src/conversation-search.ts     — searchHistory / FTS
src/conversation-rolling.ts    — rollDm / previousDm / backDm / currentDm / the dm_rolls
                                 and dm_roll_highwater tables
src/conversation-memory.ts     — memory contexts + memoryEligibility
src/conversation-compaction.ts — getCompaction / setCompaction
src/conversation-settings.ts   — applyPatch / readSettings / initializeSettings / bump /
                                 prompt snapshots
src/reply-ratings.ts           — + the reply_ratings DDL (moved out of conversation.ts)
src/app-push.ts                — + the app_push_* DDL (moved out of conversation.ts)
```

**Interface.** `ConversationStore` is unchanged — every one of its 30+ members keeps its
name, signature and semantics. The split is *internal*: each sibling exports a factory
(`openConversationHistory(db): ConversationHistory`) and `openStore` composes them and
returns the same façade object. This is what makes the change reviewable: **the public
surface does not move**, so the 30+ consumers are untouched.

**Migration order.** One responsibility per commit, in dependency order, each commit
green on `bun test` and `bun run typecheck`:

1. `conversation-settings.ts` (patch + epoch + settings read) — the smallest, most
   self-contained.
2. `conversation-memory.ts` (contexts + eligibility).
3. `conversation-compaction.ts` (the compaction pointer; it also picks up F6's
   `compactions_conv_id` index).
4. `conversation-search.ts` (FTS search + the `events_fts` triggers, which must be created
   by the module that owns `events` — so this and step 5 land together).
5. `conversation-history.ts` (+ the `events` DDL and the FTS triggers).
6. `conversation-rolling.ts`.
7. `conversation-address.ts`.
8. `conversation-schema.ts` (the remaining DDL and migrations).
9. `reply-ratings.ts` and `app-push.ts` DDL moves.

**Constraints that must hold throughout.** One `Database` handle, one store instance
(`DESIGN.md` → "The shape: disjoint channels"; `src/sqlite.ts:1-3`); `PRAGMA foreign_keys =
ON` stays set (`src/conversation.ts:597`) because the `turn_runs → conversations` cascade
depends on it; no nested `db.transaction` (bun:sqlite has no savepoints — `src/notes.ts:361`);
the new siblings must not import `src/runtime.ts`
(`src/module-boundaries.test.ts:72-74` — *"http/mod.ts stays runtime-free"*); and
`design/memory.md`'s sentence naming
`memory/mod.ts` as the retention projection's home, plus any similar sentence naming
`conversation.ts`, must be updated in the same commit as the move.

**Measurement.** `bun run scripts/function-size-audit.ts` before and after — the expected
delta is `src/conversation.ts:583` leaving the >300 list, with every new module under it.

---

## Excluded — reachable only by cutting a feature

Kept visible, not acted on.

1. **Drop the reviewer gate's per-turn model call.** 116 gate calls in the log, mean 1 020 ms
   each, 12 of which triggered a review. The gate is a *feature* (the reviewer). It is
   off the reply path (`void reviewer.considerTurn(...)`, `src/turn/finish.ts:256`), so
   removing it would cost a capability and buy little latency.
2. **Skip the admission-time memory recall.** `DESIGN.md` → "Turn" rules: *"Recall stays
   admission-time — steered input is not re-recalled."* Moving the recall off the path would
   remove a large share of the measured response gap — the operator's own measurements put
   the response gap at p50 1 837 ms and recall at p50 863 ms, *"~half the median gap and
   nearly all of its tail"* (`docs/memory.md:497-501`), and my own log read of the last
   7 days gives recall p50 743 ms / p90 1 257 ms / max 1 885 ms over 45 samples. But it is a
   ruled behaviour, not a tuning knob. The legitimate lever is the *payload* — the recall
   query is a fixed 2 000-character cap (`src/memory/mod.ts:91`) and ~95 % of recall latency
   is the embedding of that payload (`docs/memory.md:502-505`) — not the placement. The
   payload is a *quality* trade (a shorter query recalls less), so it needs the operator's
   call, and it needs the payload length logged before anyone touches it.
3. **Truncate or drop large tool results from history.** The largest single event is 462 KB
   and is re-parsed on every history read (F3). Capping it would change what the model
   sees — a feature reduction. The legitimate lever is the *projection* mechanism goblin
   already has (`src/cache-pruning.ts` — a committed, byte-stable overlay), which is
   opt-in per `DESIGN.md` → "Cache stability" and currently inert (no `cachePruning` block in
   the live config).
4. **Stop writing the turn journal.** `turn_runs` and `turn_tool_calls` grow forever
   (nothing deletes them — F8). Pruning terminal runs would remove the operator-visible
   "crashed turn" evidence (`src/tg/turn-notice.ts` reports it at boot). That is an operator
   decision, not an optimization.
5. **Drop the `events` FTS triggers** to make appends cheaper. Measured: the triggers cost
   0.07 ms per small insert and 0.29 ms per 40 KB insert (300 inserts each way). The
   trigger *is* `history_search` — removing it removes a feature.
6. **Replace the turn journal's durable writes with in-memory state.** The journal is the
   crash-recovery record; removing durability removes `/resume` and the boot "interrupted
   turn" notice.
7. **Stop the app's live context gauge from streaming.** The new merge at `cc3a968c` added
   it; it is a feature the operator just landed. F4's fix makes it *cheaper* without
   removing it.

---

## Not worth it — plausible, evaluated, rejected

1. **"Tune the prompt cache."** Measured: over the last 7 days, 431 model steps carried
   19 338 365 input tokens of which 18 321 488 were cache reads — a **94.7 % hit rate**;
   only 30 of 431 steps read zero cached tokens, and those are the first step of a
   conversation. `prefixRelation` over the logged window: 218 `append`, 23 `first`, 2
   `rewrite`. The cache is healthy; there is no win here.
2. **"Make the compaction threshold lower."** See F1 — the threshold is not the problem;
   the *denominator* is. Lowering the percentage would compact on a wrong number.
3. **"Cache the recall result per conversation."** Recall is admission-time and
   *content-dependent* (the query is built from the admitted history, `src/memory/mod.ts:224`),
   so a cache key would have to be the history itself — at which point the cache is the
   history read, and the read is already cheap (F3 is the real fix).
4. **"Batch the `conversation_id` re-reads into one."** The authority fence's re-read is the
   invariant (`DESIGN.md` → "The authority rule": *"before any side effect … the turn
   re-checks that it still holds authority"*). Caching it would trade correctness for bytes.
   F5 narrows the *columns* read, not the *number* of reads, for exactly this reason.
5. **"Precompute the model view once per conversation."** The view changes with every
   append, steer, compaction and pruning projection; caching it would need invalidation
   across five writers. F3's cheaper query and F3 step 5 (hand the entries over) get most
   of the win without the invalidation surface.
6. **"Move the `titleImplicit` semantics change to the app team."** No — it is a two-line
   change in this tree, and the ambiguity is the cost (F11).
7. **"Rewrite the `await` chains in the turn loop."** The serial `recall → buildStep` pair
   (`src/runtime.ts:860`, `:936`) is the only clearly independent pair, and `buildStep` is
   fast once the catalog is warm; the recall dominates. Parallelizing them saves
   min(recall, buildStep) ≈ small in steady state — but it is nearly free, and it touches
   the same `buildStep` call F1's denominator work touches, so it is worth doing alongside
   F1 rather than filed on its own.
8. **"Replace `bun:sqlite` with a different store."** The measured per-turn statement count
   is 22 and the measured rows are small; the store is not the bottleneck. A migration would
   risk the durability rules (`AGENTS.md`: whole-file tmp+fsync+rename; SQLite WAL +
   transactions) for no measured gain.
9. **"Split `src/memory/mod.ts`."** It does hold 10 responsibilities
   (`src/memory/mod.ts` — client construction, message text, recall query, evidence
   rendering, recall orchestration, retention projection, the SQLite contexts store, status,
   the worker, boot wiring), but it is a *maintainability* item of the same class as F10
   and no more urgent. Fold it into F10's programme rather than filing it separately.
10. **"Turn the `events` table's `data` column into a normalized form."** It would shrink
    the 462 KB worst case, but the blob *is* the durable event, and the FTS triggers
    (`src/conversation.ts`) parse it on insert. A schema migration on a live, append-only
    table is a far larger risk than F3's query change.

---

## Ruling

**The `arch-audit.md` verdict still holds at HEAD, and it now holds for a stronger reason
than it did at `5e7977d`: all three of its findings have been fixed in code — the
argument-hash replay queue is gone in favour of an evidence-aware refusal fence, resumption
refuses to inherit a run whose post-anchor input it never owned, and grant-shaped program
changes now stage an operator approval — so the architecture's remaining pressure is
*below* the general-refactor threshold the audit identified, not above it.** What replaces
those findings is a set of pattern-level wins that no single one of them would have found:
the most consequential is not a speed-up at all but the discovery, from the log, that
goblin's **compaction has never once fired** — no `"compaction skipped"`, no `"compaction
summarizing"`, no `"history compacted"` in 10 380 log lines, 149 turns, 35 days — because
the proactive trigger sits at 750 000 tokens against a 1 000 000-token catalogue
denominator while the highest observed turn was 96 429: a mechanism intended to keep turns
cheap that has never been armed, and therefore never been exercised; then two per-step
recomputations of constants (the tool-schema conversion, ≈ 60 ms/turn measured at
0.450 ms per tool, and the window gauge, computed once per step and read once per turn);
an unbounded full-history scan materialized twice per turn where a bounded query would do;
a serial TTS synthesis loop whose one multi-chunk instance in the log took 328 s; one
missing index on `compactions` that turns a `SEARCH` into a `SCAN`; and one decision
vocabulary written twice and already drifted in three of eight cases. None of these
requires removing a feature, skipping a validation, or reducing logging — with one
exception that must be ruled on first: pushing the compaction cut into SQL would stop
warning about corrupt rows outside the model's view, and that is a logging reduction this
brief forbids. **What would change the verdict:** a
fourth general architectural problem of the A1/A2/A3 shape — two subsystems that must agree
on a fact and do not, or a capability with no owner outside the model. The closest current
candidate is F1's family: the context-window denominator is a fact that the provider, the
catalogue and the operator may all disagree about, and goblin currently believes whichever
one the catalogue names, without recording that it did so; the fix there is to make the
number authoritative and attributable, not to restructure anything. If the operator's
deployment ever gains a second channel, a second model provider with a different window
semantics, or a second memory bank, that fact would need an owner of its own — and *that*
would be the finding that overturns "no general refactor".

---

## Appendix — every measurement in this report, and how to re-run it

| # | Measurement | Command | Result |
| --- | --- | --- | --- |
| 1 | Test baseline | `bun test` | 4224 pass · 83 skip · 0 fail, 4307 tests / 233 files, 318.70 s, exit 0 |
| 2 | Typecheck | `bun run typecheck` | exit 0 |
| 3 | Per-turn SQL statements & rows | `bun --preload /tmp/sqlcount-preload.ts /tmp/measure-rows.ts` | 22 statements/turn; 11× `SELECT * FROM conversations WHERE id = ?`; 2× compactions read; 1× full events scan; rows read 2 → 22 → 102 → 302 → 802 for 0/10/50/150/400 historical turns |
| 4 | Query plans | `sqlite3 "file:/home/daniel/goblin/state/goblin.sqlite?mode=ro" "EXPLAIN QUERY PLAN …"` | `compactions` → `SCAN compactions`; `events` → `SEARCH events USING INDEX sqlite_autoindex_events_1`; `event_projections` → `SEARCH`; `conversations` → `SEARCH` |
| 5 | Event payload sizes | `sqlite3 "file:…?mode=ro" "SELECT COUNT(*), SUM(LENGTH(data)), AVG(LENGTH(data)), MAX(LENGTH(data)) FROM events;"` | 363 events, 4 352 448 B total, avg 11 990 B, max 461 925 B; largest conversation 32 events / 286 KB |
| 6 | Catalogue limits for `glm-5.3` | `jq -r 'to_entries[] \| select(.value.models? != null) \| .key as $p \| .value.models \| to_entries[] \| select(.key=="glm-5.3") \| "\($p)\tctx=\(.value.limit.context)"' ~/goblin/state/models.dev.json` | `zai` = 1 000 000 (the direct match goblin takes); ≈ 45 providers list the id, with 200 000 / 256 000 / 1 048 576 among them |
| 7 | Compaction never fires | `grep -c -i 'compact' ~/goblin/state/goblin.log`; `grep -c -i 'overflow' …`; `jq -r '.msg' … \| grep -iE 'compac\|summar'` | 2 (both tool-call arguments), 0, and **no** `compaction skipped` / `compaction summarizing` / `history compacted` line — i.e. no compaction of any kind ran in the window |
| 8 | Window denominator & occupancy | `jq -r 'select(.msg=="turn completed") \| .window.limit, .window.pct' ~/goblin/state/goblin.log` | 133× limit 1 000 000, 18× null; max pct 10 (96 429 tokens) |
| 9 | Cache hit rate (last 7 days) | `jq -r 'select(.msg=="model step usage" and .ts>"2026-10-15") \| [(.cacheReadTokens//0), .inputTokens] \| @tsv'` | 431 steps, 19 338 365 input tokens, 18 321 488 cache-read → 94.7 %; 30 steps with zero cache read |
| 10 | `prefixRelation` distribution | `jq -r 'select(.msg=="model call") \| .prefixRelation // "null"' ~/goblin/state/goblin.log` | 218 `append`, 23 `first`, 2 `rewrite`, 691 without the field (older builds) |
| 11 | Recall latency (last 7 days) | `jq -r 'select(.msg=="memory request completed" and .operation=="recall" and .ts>"2026-10-15") \| .durationMs'` | n=45, mean 792 ms, p50 743, p90 1257, max 1885 |
| 12 | Memory request mix | `jq -r 'select(.msg=="memory request") \| .operation' ~/goblin/state/goblin.log` | 602 total: operation 232, retain 209, recall 136, documents 11, memories 7, document 7; 103 no-op polls |
| 13 | zod → JSON-Schema cost | `bun run /tmp/schema-bench.ts` | 0.450 ms/tool; 36 conversions = 2.49 ms; pre-built JSON Schema = 0.08 ms for 36 serializations |
| 14 | Model steps per turn | 863 `model step usage` lines ÷ 149 `turn completed` | ≈ 5.8 steps/turn |
| 15 | `buildRecallQuery` cost | `bun run /tmp/recall-bench.ts` | 0.67 ms @ 10 msgs, 1.12 ms @ 50, 4.30 ms @ 200 (3 000-char messages); `screenMemoryText` 0.022 ms per 3 000 chars |
| 16 | TTS durations | `jq -r 'select(.msg\|test("speech synthesis"))' ~/goblin/state/goblin.log` | 2-chunk case 327.7 s for 18 739 chars; single-chunk rates 277 / 331 / 359 chars/s |
| 17 | FTS trigger cost on insert | `bun run /tmp/fts-bench.ts` | 0.12 vs 0.05 ms/insert (200 B payload); 0.44 vs 0.15 ms/insert (40 KB payload), 300 inserts each |
| 18 | Turn latency | turn `started`/`completed` pairing over the log | 149 turns, mean 190.4 s, p50 35.5 s, p90 249.7 s, max 9831.8 s |
| 19 | Module smell line | `bun run scripts/function-size-audit.ts` | 23 functions over 300 lines; `src/conversation.ts:583 openStore — 1214 lines` |
| 20 | Boot-failure history | `jq -r 'select(.msg=="boot failed") \| .error' ~/goblin/state/goblin.log` | 308 total: 234 `auth.jsonl: command for "telegram" exited 1`, 64 `getMe timed out after 30000ms`, 10 auth timeout — the last at 2026-10-21T17:12:24Z, i.e. *before* the HEAD commit `abdc1ebd` *"fix(startup): isolate Telegram from the primary app channel"* |

### What could not be verified

- **The provider's true context limit for `zai/glm-5.3`.** The catalogue says 1 000 000;
  other providers list the same model at 200 000–1 048 576. I have no provider-side
  source. F1's conclusion is stated as the *measured* fact (the trigger never arms) plus the
  *unverified* question (what the real limit is).
- **The 327.7 s TTS run's decomposition.** I measured the total and the per-chunk rate from
  other runs; the ~5.4× gap between them on that date is inferred, not attributed.
- **Wall-clock attribution of F3/F4/F5 to a live turn.** I measured the row counts, the
  statement counts, the conversion cost and the payload sizes separately; I did not
  CPU-profile a turn in flight.
- **Whether the 18 `window: null` turns and the 3 000+ `prefixRelation`-less log lines
  reflect an older build or a cold catalog.** The log spans several builds; I could not
  attribute each line to a build.
- **The prod process is not at this HEAD**, so the log describes earlier builds throughout.
- **`scripts/deploy.sh` was not run and `goblin.service` was not restarted**, per the
  brief. All production-DB writes named in the findings (the `events_causal` and
  `compactions_conv_id` indexes) are therefore *proposals*; they land through
  `scripts/deploy.sh`, which needs the operator's OK.

### Assumptions made

- "Optimize" = runtime performance **plus** maintainability, per the brief's own wording.
- The `arch-audit.md` trailing five-finding summary describes the same tree (its
  `audit/architecture-review-2026-10-19.md` is not in the tree, so I re-checked each
  finding against the code rather than against the summary).
- `turn_journal.ts`'s `replayKey` remains a *signature*; A1's fix is the refusal fence
  around it, not its removal.
- The live log's pre-2026-10-06 lines come from the predecessor tree (the log records the
  `goblin-v2` → `little-goblin` rename), so pre-October counts are labelled where used.
- A proposal that would *reduce* logging is a violation of the brief, not a trade-off to be
  made — which is why F3 step 3 is gated on a ruling rather than shipped.

> Audited 2026-10-23 18:18 local, at repo commit `9d4f861e` (tracked tree clean; only untracked audit/ notes).

# Hunt 16 — Projects & Notes (src/projects.ts, src/notes.ts, src/tags.ts, src/agent/note-rewrite.ts)

Read-and-report pass, 2026-10-23. Spec: design/projects.md (ruling 2026-10-10),
DESIGN.md → Product boundary, src/tags.ts file-header contract, AGENTS.md →
Guardrails. Test override honored: no suite/typecheck runs; one scratch
verification file ran (`bun test /tmp/hunt16-scratch.test.ts`, repo modules,
read-only probes, tmp $GOBLIN_HOME). All findings below are static-read unless
marked "verified by scratch run".

Severity counts: **P0: 0 · P1: 0 · P2: 1 · P3: 6** (+5 simplification items).

## Findings

### P2-1. noteFence neutralization is over-broad: it mangles any `</note…` in operator text, not just the fence closer

- **Where:** `src/notes.ts:113` — `const body = d.body.replace(/<\/note/gi, "<\\/note");`
- **Rule violated:** design/projects.md → Notes → "**Markdown is the only format** (operator ruling): `body_md` is the truth and **exactly what the model reads**". The fence is the model's view of the note (`noteFence` header: "Fenced rendering shared by the note tool's read and the model view"); here the model reads something that is not `body_md`.
- **What happens:** the regex matches the six characters `</note` regardless of what follows. The actual fence closer is `</note>` (line 114), so any operator text whose XML-ish tag merely *starts* with `note` — `</notebook>`, `</notes>`, `</notework>` — is rewritten with an inserted backslash before the model ever sees it. The neutralization itself is required (the comment: "a literal `</note` in the body is neutralized so operator text can't close its own fence") and a plain `</note>` in the body genuinely must be escaped; the defect is matching the prefix instead of the actual closer `</note>`.
- **Trigger / evidence (verified by scratch run):** `noteFence({id:"n",title:"t",rev:1,body:"a </notebook> b </notes> c"})` → `<note id="n" rev="1" title="t">\na <\/notebook> b <\/notes> c\n</note>`. A note holding an XML/HTML snippet or prose about note-tags is silently corrupted in every model-facing rendering (note tool `read`, attached-note model part). The stored `body_md` is never touched — fidelity defect only, no data loss.
- **Test sketch:** `expect(noteFence({id:"i",title:"t",rev:1,body:"<notebook>x</notebook>"})).toContain("</notebook>")` — fails today; a `</note>` body still comes back escaped.

### P3-1. Redundant flag mutations bump `stateRev` and emit misleading log lines

- **Where:** `src/notes.ts:441-464` (`applyMove`/`applyPin`/`applyArchive` unconditionally `state_rev = state_rev + 1` and log), same asymmetry in `src/projects.ts:289-291` (`patch` with `archived:false` on a never-archived project logs "project archived").
- **Rule violated:** the store's own stated invariant, `src/notes.ts:35-37` — "`stateRev` orders **every accepted mutation** — content AND flag — so a delayed flag response can never pass for current" — plus the content path's explicit no-op discipline (`src/notes.ts:141-142`, "a no-op write bumps nothing", implemented at line 384). A redundant `setPinned(true)` on an already-pinned note is not a mutation, yet it advances the very token whose job is to mean "the note changed remotely".
- **Trigger / evidence (verified by scratch run):** `create` (stateRev 1) → `setPinned(true)` → `setPinned(true)` again → `move(id, null)` on an already-loose note → stateRev 4, with two spurious "note pinned"/"note moved" log lines. A retried pin PATCH from the app (duplicate delivery is plausible) makes the editor's staleness token move with no real change — worst realistic effect is a needless refetch or a refused acceptance check; `rev` (the If-Match token) is unaffected.
- **Test sketch:** `notes.setPinned(n.id,true); expect(notes.setPinned(n.id,true).stateRev).toBe(2)` — returns 3 today.

### P3-2. Slug collision suffix escapes the 48-char cap slugify enforces

- **Where:** `src/projects.ts:222-225` — the loop sets `slug = \`${base}-${n}\`` from `base` already sliced to 48 (line 43); no re-slice.
- **Rule violated:** the module's own tested invariant, `src/projects.test.ts:39-42` ("the slug caps at 48 chars") — the cap holds only for the un-suffixed base.
- **Trigger / evidence (verified by scratch run):** two projects named `"y".repeat(60)` → slugs of length 48 and **50**. Path safety is unaffected (charset stays `[a-z0-9-]`), and no design ruling names 48 — this is internal-consistency hygiene only.

### P3-3. Lead: isMachineryText prefix match silently drops operator speech that quotes a notice back

- **Where:** `src/tags.ts:22-24`; consumer `src/memory/mod.ts:377` — a user-role text starting with `[program: ` / `[delegation: ` is excluded from retention (`continue`) before `userTexts` is built.
- **What happens:** bermudi pasting a delegation notice he just received back at goblin ("`[delegation: #7 stuck · needs input] waiting on you` — what is this?") has that entire message classified as machinery and never retained. The anchoring is deliberate and pinned by `src/tags.test.ts:44` ("matching is anchored at the start"), so this is a designed tradeoff, not an accident — but I could **not** trace a written ruling blessing prefix collision with operator speech (design/memory.md is not in this brief's reading list; see "couldn't verify"). Labeled a lead for exactly that reason.
- **Cost:** silent memory gap; the message stays in history, so nothing is lost outright.

### P3-4. projectWorkdir's non-ENOENT stat failures skip the designed log line and error message

- **Where:** `src/projects.ts:166-171` — the `catch` handles only `ENOENT`; any other stat failure (EACCES/EPERM on an existing but unreadable dir) propagates raw from `statSync` without the "project dir missing" log line or the designed error naming the project.
- **Rule violated:** design/projects.md → Projects → cwd: "A vanished `dir` fails the turn at admission **with the path in the error and the log**". For the EACCES branch the error does carry the path (Node's message embeds it) and the throw still lands as a failed turn (per the comment at lines 152-154), but the log line is missing — "a screenshot of weird behavior plus the log file must fully reconstruct" (AGENTS.md → Guardrails) leans on the turn-failure log instead.
- **Trigger:** `chmod 000` a linked project dir, then start a turn in a bound conversation. Fail-loud holds; observability is the gap.

### P3-5. resolveLinkedDir TOCTOU: statSync outside the realpath try throws raw

- **Where:** `src/projects.ts:67` — `statSync(real)` sits outside the `try` around `realpathSync` (lines 58-66). A directory vanishing (or made unreadable) in the window between the two calls throws a raw ENOENT/EACCES → surfaces as a 500 instead of the intended `ProjectInputError` 422 naming the input.
- **Rule tension:** the module's boundary contract, `src/projects.ts:30-32` — "Operator-facing input refused at the domain boundary — the HTTP layer maps this to 422; everything else propagates as a 500". Microsecond window on an operator-initiated path; fail-loud either way. Edge-of-edge; recorded for completeness.

### P3-6. restore() logs "note restored" for a no-op restore

- **Where:** `src/notes.ts:582-598` — when the version's title/body equal the current state, `applyWrite` takes the no-op path (rev unchanged), but `restore` still logs `note restored {fromRev, newRev}` with `newRev === fromRev`, reading as a mutation that never happened.
- **Rule violated:** AGENTS.md → Guardrails ("a screenshot … plus the log file must fully reconstruct what the process did") — a log line asserting a restore that changed nothing. Cosmetic; the log is not wrong about data, only about whether a write occurred.

## Checked and found clean (later passes can skip)

1. **Slug derivation** (`src/projects.ts:35-46, 219-227`): collision loop checks rows *and* stray on-disk dirs (tested); case folding (identical names/`My App` vs `my app` collide→suffix); path safety — charset is exactly `[a-z0-9-]`, `../..` and pure-Unicode names fold to `project`, no traversal. Hexdump-verified the mark-strip range is exactly U+0300–U+036F, and strip-before-lowercase ordering prevents the `İ`-style mark-reintroduction class of bug. Rename never moves slug/home/dir (design: "The slug derives from the name once and is frozen"); refused link leaves no row and no home (validate-before-ensureDir order, tested).
2. **resolveLinkedDir** (design → Projects → "Two paths per project"): relative/`~user` refused; ENOENT named; non-directory refused; goblin-home containment via realpaths including symlinks into the tree (all tested); symlinked dirs stored resolved per the design note.
3. **projectWorkdir**: missing project row and vanished dir both throw with the identifier and log; never falls back to the workspace (design → cwd ruling; tested).
4. **Memory propagation** (design → Projects → Memory): shared→off propagates `memoryExcluded` + epoch bump to project conversations only, purges queued retention through the real outbox even without a memory client; off→shared touches nothing existing; already-excluded conversations don't re-bump (all tested).
5. **Note versioning / lost-update discipline** (the brief's If-Match probe): `expectedRev` guards `write`, `patch` (content only, per the documented interface), and `restore`; `NoteConflictError` carries the current note so the 409 hands it back whole; versions are pre-write snapshots, so every superseded state that the design means to keep is preserved — agent/append/rewrite/restore sources always version, app→app writes coalesce exactly per the ruled 10-minute session gap (design: "A typing session is one version"), cap 100 prunes oldest. The app editor ↔ agent race resolves in favor of whoever lands first; the loser gets 409+current note, and an agent write always snapshots the editor's text first. The rewrite path itself writes nothing server-side (design → "AI rewrite on selection": "It writes nothing") — verified `generateNoteRewrite` makes exactly one `generateText` and returns text.
6. **replaceRanges**: sorted + overlap + bounds + expected-text guards refuse atomically (nothing written); back-to-front application; UTF-16 offsets (emoji test); every refusal path logs with reason.
7. **Body cap**: enforced on create/write/append/replaceRanges/patch incl. aggregate-append growth; legacy oversized notes may shrink or hold but not grow; combined patches roll flags back with the refused body write (all tested).
8. **Schema & FTS**: `state_rev` migration is idempotent with existing rows at 1 (tested against a pre-migration table); external-content FTS5 triggers cover insert/update/delete; rebuild-on-empty guard reindexes a pre-FTS store; note delete cascades versions and cleans FTS (tested).
9. **Tag ownership** (tags.ts header contract): every producer in the tree goes through the constructors — `scheduler.ts:468,545` (`programFireTag`), `delegation-lifecycle.ts:1038` (`delegationNoticeTag`), `conversation.ts:455,490` (`corruptRowId`/`compactionSummaryId`), `memory/mod.ts:560` (`memoryBlockId`) — and every consumer predicate goes through `isMachineryText`/`isCompactionSummaryId`. No hand-rolled spelling anywhere in `src/`; the two prompt-text mentions (`prompt.ts:311`, `delegate.ts:270`) are model documentation, not parsers. Constructor∘predicate round-trips are pinned by `src/tags.test.ts`.
10. **note-rewrite.ts**: root `cfg.model`/`cfg.thinking` only (never a model the operator didn't configure — design ruling); config captured once per request; `maxRetries: 0`; caller abort ∪ 120 s timeout; empty and length-truncated output refused *before* the ok log (the log never claims a success the caller never saw); log fields carry note id, model, and byte counts only — "Rewrite logs never carry note text" holds. **Verified by scratch run** that the ok-path usage fields populate correctly through the real `generateText` mapping (`{input:10,cacheRead:4,cacheWrite:2,output:3}`) — the colocated tests never assert these fields.
11. **zod at the app boundary** (cross-checked in `src/http/app-notes.ts` / `app-projects.ts`, other hunts' files): note create/patch/append/rewrite bodies are strict and bounded (title ≤200, body ≤ `NOTE_BODY_MAX`, selection ≤50k non-empty, instruction ≤2k; `source` enum limited to `app`|`rewrite`); project create/patch bounded (name ≤80, instructions ≤20k, memory enum); list limit is server-set (1000+1 with truncation flag) — no client-controlled limit or injection surface (all SQL parameterized).

## Couldn't verify

- **App-editor side of the rewrite race** (draining pending autosaves before rewrite, refusing acceptance on a changed local document / newer remote revision without discarding the buffer — design → "AI rewrite on selection"): lives in `app/` + the acceptance PATCH flow, hunt 8's scope. Only the store primitives (`rev`/`stateRev`/If-Match/409-with-note) were verified.
- **A written ruling for prefix-anchored machinery classification** (P3-3): design/memory.md was not in this brief's reading list and was not read; suspected ruling, untraced — stated, not invented.
- **Live provider shapes** for `finishReason`/`usage`: verified only through the real SDK `generateText` against the fake provider edge (the suite's sanctioned fake point per AGENTS.md → Tests). Real-provider drift is the live drift checks' domain, not run here.
- **Single-writer assumption**: all note/project mutations are synchronous on one event loop; no second writer to the sqlite file was searched for beyond DESIGN.md's "one Bun process" statement. If any auxiliary tool ever opens the DB, the collision/`existsSync` checks have TOCTOU windows — unexplored because no such tool is known.

## Simplifications & code smells (operator addition; P3-level, evidence-backed)

1. **`setPinned`/`setArchived`/`move` triplicate the patch flag path** — `src/notes.ts:599-613` are three copies of `mustGet → apply* → mustGet`, while `patch` (lines 540-551) already composes the same `apply*` helpers inside a transaction. The wrappers could be one-liners over `patch` (or deleted with callers moved to `patch`), removing three hand-rolled non-transactional flag paths that the redundant-bump finding (P3-1) lives in.
2. **`applyPin`/`applyArchive` are the same statement modulo column and value** — `src/notes.ts:450-464`; a single `applyFlag(id, column, value)` (or `patch` reuse) collapses them.
3. **Duplicated version-row mapping** — `listVersions` (`src/notes.ts:616-623`) hand-maps the same five fields that `toVersionMeta` (lines 300-308) maps for `getVersion`; two shapes for one row type. The SQL metas query could select through `VersionRow` and share the mapper.
4. **Mixed size units across the module** — `checkBodySize` (`src/notes.ts:14-25`) counts UTF-16 characters (`body.length`, message says "characters") while the write log (line 420-428) records `bytesBefore`/`bytesAfter` (`Buffer.byteLength`); reconstructing a refused-oversize incident from log plus screenshot requires converting units mid-read.
5. **The 48-char cap is applied only to the base slug** — `src/projects.ts:43` slices, then lines 222-225 append `-n` unclamped, so the "caps at 48" behavior the test asserts is not an invariant of the collision path (evidence in P3-2). Either re-slice the suffixed slug or drop the cap claim to "base ≤ 48".

No dead exports found in the four scoped files: every export (`NoteRangeError.rev` included — consumed at `src/agent/tools/note.ts:104`) has a non-test consumer.

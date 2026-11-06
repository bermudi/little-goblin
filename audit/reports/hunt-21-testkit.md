> Audited 2026-10-23 18:39 local, at repo commit `9d4f861e` (tracked tree clean; only untracked audit/ notes).

# Hunt 21 — testkit, test-helpers, boundary tests, bunfig

Scope: `src/testkit.ts`, `src/testkit.test.ts`, `src/testkit/` (fake-api.ts,
fake-model.ts), `src/test-helpers/` (boot.ts, loopback-preload.ts,
turn-crash-child.ts, wake-crash-child.ts), `src/module-boundaries.test.ts`,
`src/channel-boundary.test.ts`, `bunfig.toml`.
Read-and-report only. One scratch probe was run (allowed exception):
`/tmp/hunt21-probe.test.ts` — Bun mkdtemp charset, `process.kill` error codes,
EPERM-preserve end-to-end. It is left in place per rules.

Verification context: typecheck and the full suite were run by the orchestrator
on this unchanged tree (4686 pass / 0 fail / 86 skip); not re-run here.

Severity summary: **P0: 0 · P1: 0 · P2: 0 · P3: 4** — plus 8 simplification
notes. The sweep — the highest-risk machinery in scope — traced clean on every
branch, and the critical EPERM/PID-reuse branch was verified empirically.

---

## 1. Findings (most severe first)

### P3-1 — fake-api: message-id space and `texts` index diverge after non-text sends; editMessageText write-back silently dropped

- **Where:** `src/testkit/fake-api.ts:46-51` (the `editMessageText` guard
  `id - 1 < texts.length`), with `:34` (`nextId`), `:39-44` (texts pushed only
  by sendMessage/sendRichMessage), `:52-59` (sendVoice/sendPhoto/sendDocument/
  sendAudio/sendAnimation/sendMediaGroup consume ids without pushing texts).
- **Violated rule:** hunt-21.txt → "What counts as a bug here":
  "fake-api/fake-model drifting from the real provider/Telegram shapes they
  claim to fake (pin verbatim behavior, don't invent)" — and the file's own
  contract, `fake-api.ts:13-16`: "editMessageText writes back by id — in-place
  edit, like the wire."
- **Trigger:** one FakeApi where any non-text send precedes a text send:
  `sendVoice` takes id 1 (no texts entry), `sendMessage` takes id 2 and pushes
  `texts[0]`. `editMessageText(chatId, 2, "final")` fails the guard
  (`2 - 1 = 1 < texts.length = 1` is false) — the call is recorded in `calls`
  and "succeeds" (`{message_id: 2}`), but `texts[0]` keeps the draft text. On
  the real wire the edit lands. Any test asserting delivered text after a
  voice/photo/document/media-group send in the same conversation observes a
  pre-edit body. Nit in the same guard: no `id - 1 >= 0` check, so `id: 0`
  writes the expando property `texts[-1]`.
- **Latent, not live:** no current test mixes `texts` assertions with non-text
  sends (grep over all `*.test.ts`: zero files match both `\.texts` and a
  non-text send method; `src/tg/mod.test.ts:400` overrides `sendVoice` with a
  local handler instead). It becomes P2 the day a voice+text+edit test relies
  on `texts`.
- **Test sketch:** `const f = fakeApi(); await f.api.sendVoice(1, blob); const
  { message_id } = await f.api.sendMessage(1, "draft"); await
  f.api.editMessageText(1, message_id, "final");
  expect(f.texts[0]).toBe("final");` — fails today (stays `"draft"`).

### P3-2 — boundary-test regexes have blind-spot import forms: violations that stay green

- **Where:** `src/module-boundaries.test.ts:15` (GRAMMY_IMPORT), `:18`
  (RUNTIME_IMPORT), `:19-20` (SIBLING_MOD_IMPORT); `src/channel-boundary.test.ts:23-24`.
- **Violated rule:** AGENTS.md → Guardrails: "Each external contract is known
  by one adapter. … module-boundaries.test.ts enforces the importable cases."
  hunt-21.txt → "What counts as a bug here": "boundary tests whose import
  lists have gone stale (enforcing nothing — a green test that can't fail)."
- **Gaps (all verified absent in the tree today, so the tests are accurate for
  the current tree but not for these violation forms):**
  1. Bare side-effect `import "grammy";` matches neither GRAMMY_IMPORT
     alternative (`\bfrom\s*` / `\bimport\s*\(`) — a grammy side-effect import
     outside src/tg and src/testkit stays green.
  2. Same form for the sibling rule: bare `import "./mod.ts";` escapes
     SIBLING_MOD_IMPORT (needs a `from` or `import(`).
  3. Bare `import "../runtime.ts";` escapes RUNTIME_IMPORT in
     `src/http/mod.ts`.
  4. channel-boundary's tg regex `/from ["'](?:\.\.?\/)*tg\//` has no
     dynamic-import form — `await import("../tg/mod.ts")` inside any
     CHANNEL_NEUTRAL module stays green (module-boundaries' regexes do cover
     `import(`; the channel test does not).
  5. channel-boundary's grammy regex `from ["']grammy["']` is exact-match —
     `from "grammy/types"` stays green, while GRAMMY_IMPORT covers subpaths
     (`grammy(?:\/[^"']*)?`).
- **Test sketch:** append `import "grammy";` to any non-tg/non-testkit
  non-test file, or `await import("../tg/mod.ts")` to a CHANNEL_NEUTRAL file,
  and run the two boundary suites — both stay green.

### P3-3 — crash-child helpers accept unknown MODE silently (fail-loud violation)

- **Where:** `src/test-helpers/turn-crash-child.ts:27-30` (env validated for
  presence only) with fallthrough at `:103-107`; `src/test-helpers/
  wake-crash-child.ts:20-23` with `:38` (`if (MODE === "committed")` —
  anything else silently behaves as "recorded").
- **Violated rule:** AGENTS.md → Guardrails: "Fail loud. Never swallow
  exceptions; every failure surfaces with enough context to debug it."
- **Trigger:** a typo'd MODE (e.g. `MODE=complete-then-stal`) in the parent
  test: turn-crash-child's `doStream` falls through to the default hang
  profile (first call returns the tool-call stream, second never answers), so
  the parent silently tests the wrong stall point — the kill lands on a
  different journal state than the test's name and assertions claim.
  wake-crash-child with a typo silently skips the commit leg.
- **Test sketch / shape of the fix:** the files already throw on missing env
  (`throw new Error("DB_PATH/MARKER_PATH/MODE are required")`) — extend the
  same guard to reject MODE values outside the documented set.

### P3-4 — testkit afterEach: one rmSync throw aborts the rest of the batch and skips the GOBLIN_HOME restore

- **Where:** `src/testkit.ts:56-65` — `for (const d of trackedDirs.splice(0))
  rmSync(d, { recursive: true, force: true });` followed by root release and
  env restore, all unguarded.
- **Violated rule:** AGENTS.md → Guardrails "Fail loud" and → Tests (the
  preload + hook is the anti-ENOSPC machinery: "without it, full-suite runs
  leaked ~86k mkdtemp dirs until /tmp hit ENOSPC").
- **Trigger:** any rmSync error other than ENOENT (`force` swallows only
  ENOENT — e.g. EACCES/EPERM from an exotic fixture state) on one tracked
  dir. Because `splice(0)` empties `trackedDirs` before the loop, the
  remaining dirs are never removed *and* never retried by a later afterEach —
  they leak despite the hook having "run" — and lines 58-64 (fixture-root
  release, `GOBLIN_HOME` restore) are skipped, so every later test in the
  process runs with `GOBLIN_HOME` pointing into a half-deleted tree.
  Rare on a Linux tmpdir for owner-owned files (which is why this is P3, not
  P2), but the degradation compounds exactly like the incident the hook
  exists to prevent.
- **Sketch:** wrap each removal (or at least the env restore) in try/finally;
  a regression test would need to inject a failing rmSync, which is why this
  is reported from reading, not a run.

---

## 2. Checked and found clean (later passes can skip)

**The stale sweep — every branch (highest-risk item, per brief):**
- Liveness (`testkit.ts:72-79`): kill-succeeds → preserve; ESRCH → dead;
  EPERM and every other error → preserve (fail-safe direction). Verified
  empirically on Bun 1.4.4 (`/tmp/hunt21-probe.test.ts`): dead-pid kill →
  `code: "ESRCH"`; pid-1 kill → `code: "EPERM"`; end-to-end, a stale root
  named with pid 1 (alive, root-owned) is PRESERVED and a dead-pid stale root
  is removed. The brief's P1 candidate (PID-reuse/EPERM branch deleting a
  live process's fixtures) is disproven. PID reuse by a live process yields
  kill-succeed or EPERM → preserve in both cases (conservative leak, correct
  per ruling).
- Age gate (`testkit.ts:96,104`): `mtimeMs >= cut` preserves a root exactly
  STALE_MS old; only strictly-older-than-1h roots are candidates. No
  off-by-one; residual sub-millisecond float fuzz on the boundary is
  inconsequential. Order (age before liveness) is safe; both under one try
  with ENOENT-silent / other-logged handling (`:107-111`).
- Namespace and pattern (`testkit.ts:70,98-101`): `^goblin-test-fixtures-
  ([1-9]\d*)-[A-Za-z0-9]{6}$` — pid ≥ 1 enforced, exactly 6 alnum chars.
  Empirically, 400/400 Bun `mkdtempSync` suffixes match the pattern, so the
  sweep covers every root `fixtureRootDir()` can create (self-heal not
  silently degraded). Malformed names, `goblin-tr-*` legacy, and foreign
  scratch are preserved (pinned by testkit.test.ts:82-112).
- Symlinks: `Dirent.isDirectory()` is false for symlinks → skipped before any
  stat/rm; never followed (pinned by testkit.test.ts:114-129).
- Concurrency: the sweep runs once per process at preload; a concurrently
  running suite's root is young (age gate) and/or owner-alive (liveness gate)
  — both preserve. The multi-file child test's own sweep cannot take the
  parent's root (young + alive).

**Fixture namespace containment:** every helper hands out paths under the
per-process root — `tmpDir` (:118-122), `useHome` (:125-133), `tmpDb`
(:136-138), `openTestStore` (:141-148). No helper returns a path outside
`goblin-test-fixtures-<pid>-*`. All `bootChild` callers pass `tmpDir()`
bases (src/boot.test.ts:45,68,90,192,213,237), so boot homes ride the same
tracked cleanup. `useHome` save/restore is correct across repeated calls and
across undefined-vs-set env.

**Global-hook wiring (the 2026-10-22 incident shape):** the only non-test
files registering module-level hooks are `src/testkit.ts:56` and
`src/subagents/testing.ts:1058` — both in bunfig.toml's `[test]` preload;
the preload list diverges from nothing (both files exist; no other hook-
registering helper exists). No scoped test-helper registers its own hooks.
The multi-file regression test (testkit.test.ts:139-180) is real: it can
fail (a hook regression leaves `goblin-test-fixtures-<childPid>-*` behind),
its victims import the same preloaded module instance, and the child runs
from the repo root so bunfig applies.

**Model-fake shape conformance:** `src/testkit/fake-model.ts` is typed
directly against the installed `@ai-sdk/provider` v4 (usage nested
inputTokens/outputTokens objects, `FinishReason {unified, raw}`,
`StreamResult {stream, request?, response?}` — verified against
node_modules/@ai-sdk/provider/dist/index.d.ts) and typecheck passes.
`src/testkit.ts`'s `fakeModel` (double-cast, so untypechecked) mirrors those
shapes field-for-field — framing (stream-start/text-start/text-end/finish),
usage objects, abort handling between deltas. `scriptedModel`'s attempt
dispatch matches its documented variants (verbatim array, provider reject,
read error, cancel-error-with-open-stream, drive/free-form, paced) and
unknown-arm objects crash loudly (TypeError on `attempt.parts`). All
testkit.ts model-fake exports have live consumers (fakeModel: 5 files,
pauseFakeModelAtDelta: 2, recordingModel: 1, fakeGenerateModel: 1).

**TurnSink conformance:** RecordingSink/HeadlessSink/ParkedDoneSink match
`runtime.ts:60-78` — `onStreamChunk` presence is the lane discriminator
(runtime checks `sink.onStreamChunk !== undefined`), and runtime awaits
`onDone` (`runtime.ts:619`), so ParkedDoneSink's gate genuinely holds the
drain loop. RecordingSink's no-arg `setAuthorityCheck` is a legal
parameter-omitting implementation used as an admission signal.

**fake-api surface vs code under test:** the faked methods exist with
matching argument orders at the call sites — `sendMessage(chatId, text,
other)` (delivery.ts:676), `sendRichMessage(chatId, {markdown}, other)`
(delivery.ts:1012,1032 — the fake's `{markdown}` extraction is correct),
`editMessageText(chatId, mid, text)` (delivery.ts:717), `answerGuestQuery`
returning `{inline_message_id}` (guest.ts:289-307 reads exactly that). The
draft methods (`sendMessageDraft`/`sendRichMessageDraft`/`editMessageText-
Inline`) fall to the ack-`true` default, which is shape-compatible because
delivery/guest discard their results (verified delivery.ts:590-618, 608).
Synchronous recording (calls/texts populated before promise resolution)
matches the documented contract for sync callers; `failOn`/handler throws
become rejections, `before` defers as documented.

**Boundary tests vs the actual tree:** all nine CHANNEL_NEUTRAL files exist;
no unlisted non-test file outside src/tg imports `tg/` or grammy (only
src/index.ts, the composition root, and fake-api's type-only import).
module-boundaries' exempt sets match reality exactly: the only non-test
runtime importers of `./mod.ts` are the four SIBLING_EXEMPT files
(verified), and `src/memory/forget.ts` is the sanctioned `import type`
cycle-breaker. `src/http/mod.ts` is runtime-free directly and transitively
(operator/check/app-dist/auth import no runtime at value level; the other
http runtime references to runtime.ts are type-only and erased).

**Crash children exercise real paths:** both import the real `openStore`,
`openTurnJournal`/`openWakeStore`, and real `Runtime.submit`, stage a genuine
mid-flight stall, and never exit on their own — the parent SIGKILLs at the
documented boundary. Env contract validated for presence; `setLogFile(null)`
is a valid log.ts call.

**loopback-preload coverage:** production source has no non-fetch egress
door (no `Bun.fetch`, `http.request`, `https.request`, `net.connect`,
`Bun.connect`, `tls.connect` outside tests — grep), so patching
`globalThis.fetch` covers all egress (grammy, AI SDK, catalog warmers).
Blocking is conservative-safe: unparseable and non-loopback URLs are
rejected; loopback detection misses only exotic loopback spellings (trailing-
dot `localhost.`, `0.0.0.0`, decimal IPv4), all of which get *blocked*, the
safe direction.

**Suite-size invariant (DESIGN.md → Test posture):** 202 test files vs 212
non-test source modules (excluding testkit/test-helpers) — suite smaller
than src/, holds.

---

## 3. Couldn't verify / leads not traced to a written source

- **Open-stream step semantics in turn-crash-child:** whether the Vercel AI
  SDK finishes a model-call step upon the `finish` stream part while the
  ReadableStream stays deliberately open (`parts()` at :58-64) — plan-only
  and overflow-stall modes depend on it. Not statically decidable without
  the SDK's stream loop; the crash tests that drive it are green (out of
  scope, their hunts) which is evidence but not proof of the intended
  semantics.
- **Bun's single-process test premise** (the foundation of the preload fix)
  is taken from AGENTS.md → Tests and the orchestrator's green full-suite
  run; not independently verified here. Related note (not a finding): if a
  future Bun ran test files in worker processes, testkit.test.ts:173-176's
  leak check — filtering by the spawned runner's pid — would go vacuous,
  because fixture roots would be named with worker pids it never checks.
- **Sweep environment sensitivity:** mkdtemp charset and kill error codes
  verified for the installed Bun 1.4.4 only; a Bun upgrade could change
  either (charset change would silently narrow the sweep's coverage —
  pattern would no longer match self-created roots; kill-code change toward
  misclassification is not plausible but wasn't tested on other versions).
- **P3-4's triggering error:** no portable way to make `rmSync` throw
  mid-batch from a scratch file without touching the suite; reported from
  code shape, labeled accordingly.
- Scratch probe left at `/tmp/hunt21-probe.test.ts` (rules: no /tmp
  deletions). No leaked `goblin-test-fixtures-*` roots were observed during
  this hunt's own runs.

---

## 4. Simplifications & code smells (operator-added section; P3-level, evidence-backed)

1. **`messageIdBase` is dead and a trap** — `src/testkit/fake-api.ts:28,34`:
   zero callers repo-wide (grep). Worse, its only possible effect breaks the
   fake's own invariant: with base B, the first text message gets id B+1 but
   lands at `texts[0]`, and the write-back guard `id - 1 < texts.length`
   fails for every message until B+1 texts accumulate — with a non-zero base
   the edit write-back is dead for all messages. Delete the option (or make
   the guard base-aware if it's ever needed).
2. **Two parallel fake-model families with duplicated framing** —
   `src/testkit.ts:201-328` (fakeModel/pauseFakeModelAtDelta/recordingModel/
   fakeGenerateModel, untyped via `as unknown as LanguageModel`) vs
   `src/testkit/fake-model.ts` (scriptedModel/textModel/generateModel, fully
   typed as `LanguageModelV4`). The v4 stream framing — stream-start,
   text-start/id "t1", text-deltas, text-end, finish with the nested usage
   objects — is written out verbatim in both (testkit.ts:225-248 vs
   fake-model.ts:47-77). Both families are alive (5 vs 12+ consumer files),
   so this is consolidation, not deletion: moving the gated/abort semantics
   (beforeDelta) into fake-model.ts and re-exporting would delete the one
   untyped duplicate of the provider wire shapes (the typed file is checked
   by `bun run typecheck`; the testkit.ts one is not).
3. **`STALE_MS` export has no external consumers** — `src/testkit.ts:68`:
   used only internally (line 96) and by no test (grep). Un-export it.
4. **Duplicated `sleep`** — `src/testkit/fake-model.ts:12` redefines the
   `sleep` already exported from `src/testkit.ts:152`.
5. **Dead loopback branch** — `src/test-helpers/loopback-preload.ts:15`
   (`h === "[::1]"`): WHATWG `URL.hostname` strips IPv6 brackets, so
   hostname is `"::1"` (caught by the line above) and never `"[::1]"`.
6. **Misleading headers** — `src/testkit/fake-api.ts:2` and
   `src/testkit/fake-model.ts:1` say "only *.test.ts files import this
   directory", but `src/http/app-testing.ts:10-11` (a non-test file) imports
   both `../testkit/fake-model.ts` and `../testkit.ts`. Nothing production
   reaches it (only test files import app-testing.ts — verified), so the
   *intent* holds; the sentence as written does not.
7. **`lines()` isn't all lines** — `src/test-helpers/boot.ts:163-167,173`:
   stdout is newline-split into `lines`, but stderr is accumulated as raw
   decoded *chunks* and appended by `lines()` as if lines. Consumers only
   `join("\n")` them into diagnostics today, but any line-based consumer
   gets multi-line blobs. Split stderr the same way as stdout.
8. **Overbroad exempt matching** — `src/module-boundaries.test.ts:52-54`:
   GRAMMY_EXEMPT_DIRS matches ANY path segment named `tg` or `testkit`, so a
   future `src/<anything>/tg/foo.ts` or `src/<anything>/testkit/foo.ts`
   would be silently exempt from the grammy rule. Matching the leading
   segment(s) of the repo-relative path would be tighter. (Related
   micro-smell: `boot.ts:177-188` rescans and re-JSON.parses every collected
   line on each 25ms poll to find the listening port — O(n²) over a
   debug-level log; track it once found.)

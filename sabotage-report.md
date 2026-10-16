# Sabotage drill — does the test suite catch real faults?

**19 saboteurs — 7 KILLED by the suite, 1 TYPECHECK-ONLY, 11 SURVIVED
(of which 9 killed by new tests added here, 2 accepted gaps).**

Run date 2026-10-16, against `2efe868` (`main`), in a disposable copy at
`/home/user/goblin-sabotage` (`cp -a` of the working tree incl. `.git`,
`bun install --frozen-lockfile`). All mutation and all runs happened in the
copy; the real tree received only the tests listed under
[New tests](#new-tests-added-to-the-real-tree) and this report.

## Method and baseline

- **Baseline first (unmutated copy):** `bun test` → exit 0 — *3371 pass,
  54 skip, 0 fail, 13486 expect() calls, 3425 tests across 175 files,
  258.87 s*. `bun run typecheck` → exit 0. (runs/… receipts below.)
- **One logical change per saboteur**, applied as exact line edits against
  `2efe868` (`sabotage-work/saboteurs.py`), then the full `bun test` and
  `bun run typecheck`, then `git -C /home/user/goblin-sabotage checkout -- .`
  before the next mutant. Every verdict below comes from a run that happened.
- **Verdicts:** `KILLED` = the suite fails under the mutant; `TYPECHECK-ONLY`
  = suite green but `tsc` fails (a different detector); `SURVIVED` = both green.
- Every mutant was type-preserving except S19 (by construction); all others
  keep `bun run typecheck` at exit 0 (see per-saboteur receipts).

> **Suite-health note.** `src/agent/tools/fetch.test.ts` →
> *"oversized stream with no content-length is refused and cancelled mid-download"*
> is flaky in this environment: it failed once in 7 clean-tree runs of that
> file (and passes 6/6 in isolation). It also failed inside two first-pass
> mutant runs (S12, S17) whose other results were green. Those two verdicts
> were re-run before being recorded — S12 and S17 are `SURVIVED` on the
> re-run, not killed by that flake. Preserved receipt:
> `sabotage-work/runs/S12.run1.test.log`. A red CI run on this test alone is
> not a real signal.

## Verdict table

| # | Category | Saboteur | file:line | Verdict |
|---|----------|----------|-----------|---------|
| S01 | boundary validation | `z.strictObject` → `z.object` (persisted inbox payload) | `src/tg/inbox.ts:26` | SURVIVED → killed |
| S02 | boundary validation | `recallTimeoutMs` floor `min(100)` → `min(0)` | `src/config.ts:329` | SURVIVED → killed |
| S03 | boundary validation | tool arg `limit` drops `.positive()` | `src/agent/tools/read.ts:207` | SURVIVED → killed |
| S04 | error handling | every realpath failure → `"source not found"` | `src/box-files.ts:57-62` | SURVIVED → killed |
| S05 | error handling | every `readdir` failure → empty catalog | `src/stateview.ts:88-91` | SURVIVED → killed |
| S06 | error handling | JSON5 error drops the `:line` context | `src/config.ts:936-940` | **KILLED** |
| S07 | durable writes | drop `fsyncSync(fd)` | `src/durable.ts:229` | SURVIVED → **accepted gap** |
| S08 | durable writes | in-place rewrite instead of `rename(2)` | `src/durable.ts:252-260` | **KILLED** |
| S09 | durable writes | drop mode preservation (`fchmodSync`) | `src/durable.ts:219` | **KILLED** |
| S10 | telegram boundary | plain send drops `message_thread_id` | `src/tg/delivery.ts:906` | **KILLED** |
| S11 | telegram boundary | outage notice drops `message_thread_id` | `src/tg/notify.ts:105` | **KILLED** |
| S12 | telegram boundary | grammy type surface leaks into `conversation.ts` | `src/conversation.ts:6` | SURVIVED → killed |
| S13 | logic | `MAX_LINES` 2000 → 1000 | `src/agent/tools/read.ts:9` | **KILLED** |
| S14 | logic | loop cut threshold 20 → 21 | `src/loop-detect.ts:21` | **KILLED** |
| S15 | logic | drop the `..` guard in `resolveDistFile` | `src/http/app-dist.ts:41` | SURVIVED → **accepted gap (equivalent)** |
| S16 | logic | size gate `>` → `>=` (8 MiB boundary) | `src/agent/tools/read.ts:49` | SURVIVED → killed |
| S17 | logging | delete the `delivered plain` boundary line | `src/tg/delivery.ts:1439-1454` | SURVIVED → killed |
| S18 | logging | delete the `app stream finish` line | `src/http/app-channel.ts:635` | SURVIVED → killed |
| S19 | wire types (app/) | `ConfigResponse.searchKinds` renamed | `src/http/operator-wire.ts:22` | **TYPECHECK-ONLY** |

Reading the table: 11 of 19 faults were invisible to `bun test`. Nine are now
covered by tests that were re-verified to kill their mutant; two are accepted
gaps (S07, S15) with reasons below.

---

## Per-saboteur log

Receipts referenced as `runs/<id>.test.log` live in
`/home/user/sabotage-work/runs/` (gzipped at cleanup). "exit 0" lines are the
suite's own summary in the unmutated copy.

### S01 — boundary validation: persisted inbox payload becomes permissive — SURVIVED → killed

`src/tg/inbox.ts:26`

```diff
-const payloadSchema = z.strictObject({
+const payloadSchema = z.object({
```

- **Invariant:** zod at the boundary; a persisted inbox row is strict — an
  unknown key means the journal and the reader disagree and must fail loud,
  not be silently stripped.
- **Expected observable failure:** `pending()` / `commitBatch()` throw for a
  row whose `payload_json` carries an extra key.
- **Verdict: SURVIVED.** `bun test` exit 0 — *3371 pass, 54 skip, 0 fail,
  3425 tests across 175 files*; `bun run typecheck` exit 0.
  Receipt: `runs/S01.test.log`.
- **Resolution: killed by a new test.** `src/tg/inbox.test.ts` →
  *"an unknown key in a persisted payload fails loudly — strict, not stripped"*.
  Re-verified in the copy with the mutant re-applied: exit 1, 1 fail —
  *"(fail) an unknown key in a persisted payload fails loudly — strict, not
  stripped"*, 3434 tests / 176 files. Receipt: `runs/S01.reverify.test.log`.

### S02 — boundary validation: memory timeout floor collapsed — SURVIVED → killed

`src/config.ts:329`

```diff
-recallTimeoutMs: z.number().int().min(100).max(10_000).default(MEMORY_DEFAULTS.recallTimeoutMs),
+recallTimeoutMs: z.number().int().min(0).max(10_000).default(MEMORY_DEFAULTS.recallTimeoutMs),
```

- **Invariant:** zod at the config boundary; a configured timeout below the
  floor is refused at boot with the config path, not accepted and pushed to
  the provider.
- **Expected observable failure:** `parseConfig`/`loadConfig` throw for
  `memory.recallTimeoutMs` below 100.
- **Verdict: SURVIVED.** exit 0 — *3371 pass, 54 skip, 0 fail*; typecheck
  exit 0. The neighbouring `searchTimeoutMs` floor/ceiling rows exist; the
  recall floor had no row. Receipt: `runs/S02.test.log`.
- **Resolution: killed by a new test.** `src/config.test.ts` (memory
  `throwRows` table) → *"goblin.json5 > memory recallTimeoutMs has a floor"*
  (`recallTimeoutMs: 99`). Re-verified: exit 1, 1 fail — *"(fail) goblin.json5
  > memory recallTimeoutMs has a floor"*. Receipt:
  `runs/S02.reverify.test.log`.

### S03 — boundary validation: `read_file` `limit` accepts non-positive values — SURVIVED → killed

`src/agent/tools/read.ts:207`

```diff
-			limit: z.number().int().positive().optional(),
+			limit: z.number().int().optional(),
```

- **Invariant:** tool arguments are validated by the tool's schema before
  `execute` (the SDK path: `safeValidateTypes` against `inputSchema`).
- **Expected observable failure:** a tool call with `limit: 0` / `limit: -1`
  is rejected instead of running the window arithmetic with it.
- **Verdict: SURVIVED.** exit 0; typecheck exit 0. No test validated the read
  tool's schema (the file's tests all page with legal limits).
  Receipt: `runs/S03.test.log`.
- **Resolution: killed by a new test.** `src/agent/tools/read.test.ts` →
  *"a limit that cannot page is refused at the schema, not coerced"* — drives
  the real contract via `safeValidateTypes({ value, schema: t.inputSchema })`
  (the same helper `src/agent/tools/script.ts` uses). Re-verified: exit 1,
  1 fail — *"(fail) read_file > a limit that cannot page is refused at the
  schema, not coerced"*. Receipt: `runs/S03.reverify.test.log`.

### S04 — error handling: non-ENOENT `realpath` failures swallowed into "not found" — SURVIVED → killed

`src/box-files.ts:57-62`

```diff
-	} catch (err) {
-		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
-			return { error: `source not found: ${from}` };
-		}
-		throw err;
+	} catch {
+		return { error: `source not found: ${from}` };
```

- **Invariant:** `ENOENT` means null; everything else propagates with context
  (AGENTS.md → Fail loud). Here EACCES/ELOOP/ESTALE would be reported to the
  model as "the file isn't there".
- **Expected observable failure:** an import path that exists but cannot be
  resolved (symlink loop) throws instead of returning a result.
- **Verdict: SURVIVED.** exit 0; typecheck exit 0. Receipt: `runs/S04.test.log`.
- **Resolution: killed by a new test.** `src/box-files.test.ts` →
  *"an unresolvable source propagates — a symlink loop is not 'not found'"*
  (`loop-a → loop-b → loop-a`, `realpath` fails `ELOOP`). Re-verified: exit 1,
  1 fail — *"(fail) resolveImport > an unresolvable source propagates — a
  symlink loop is not 'not found'"*. Receipt: `runs/S04.reverify.test.log`.

### S05 — error handling: skill catalog hides every readdir failure as "empty" — SURVIVED → killed

`src/stateview.ts:88-91`

```diff
-	} catch (e) {
-		if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
-		throw e;
+	} catch {
+		return [];
```

- **Invariant:** only `ENOENT` degrades to empty (`stateview.ts` header);
  EACCES/ENOTDIR are real failures, not a skill-less home.
- **Expected observable failure:** a skills path that is not a directory
  (`ENOTDIR`) makes `listSkillDir`/`listSkills` throw.
- **Verdict: SURVIVED.** exit 0; typecheck exit 0. Note the pre-existing
  EACCES tests (`stateview.test.ts`) exercise the *stat* path inside
  `listFilesUnder`, not this top-level `readdir` catch — the mutant slipped
  between them. Receipt: `runs/S05.test.log`.
- **Resolution: killed by a new test.** `src/stateview.test.ts` →
  *"a skills path that is not a directory fails loud, not as an empty
  catalog"* (a file at the skills path; `readdirSync` → `ENOTDIR`).
  Re-verified: exit 1 — *"(fail) listSkills > a skills path that is not a
  directory fails loud, not as an empty catalog"* (this run also carried the
  known fetch flake; the new test is the detector attributed here).
  Receipt: `runs/S05.reverify.test.log`.

### S06 — error handling: JSON5 parse error loses the line context — KILLED

`src/config.ts:936-940`

```diff
-		const line =
-			typeof err === "object" && err !== null && "lineNumber" in err ? err.lineNumber : undefined;
-		const location =
-			typeof line === "number" && Number.isSafeInteger(line) && line > 0 ? `:${line}` : "";
-		throw new Error(`${paths.config()}${location}: invalid JSON5`);
+		// The parser message can quote config content; the path alone is safe.
+		throw new Error(`${paths.config()}: invalid JSON5`);
```

- **Invariant:** fail loud **with context** — the operator gets the config
  path *and* the line.
- **Verdict: KILLED.** `bun test` exit 1 — *3371 pass, 54 skip, 1 fail*;
  *"(fail) config parser safety > JSON5 syntax errors retain only a safe
  numeric line"*. Receipt: `runs/S06.test.log`.

### S07 — durable writes: the file `fsync` removed — SURVIVED → accepted gap

`src/durable.ts:229`

```diff
-		fsyncSync(fd);
```

- **Invariant:** whole-file state = tmp + **fsync** + rename + directory fsync.
  Without it a crash after `rename` can leave an empty/partial file whose name
  is the new content.
- **Expected observable failure:** none reachable through the filesystem API —
  the write still returns correct bytes, the mode/times/atomicity tests still
  pass. Detecting the missing sync needs a fault-injection seam inside
  `src/durable.ts` (out of scope: this drill changes tests only) or an
  `strace`-level harness.
- **Verdict: SURVIVED.** exit 0 — *3371 pass, 54 skip, 0 fail*; typecheck
  exit 0. Receipt: `runs/S07.test.log`.
- **Resolution: accepted gap.** Reason: the sync has no observable effect in a
  process that does not crash; a test that "kills" it would have to assert the
  syscall, not a behavior. The parts of the durable ritual that *are*
  observable — atomic replace (S08) and exact mode preservation (S09) — are
  killed by existing tests, so the gap is narrow, not the whole ritual.

### S08 — durable writes: rewrite in place instead of tmp + rename — KILLED

`src/durable.ts:252-260` (plus `readFileSync`/`utimesSync`/`writeFileSync`
imports)

```diff
-			renameSync(tmp, path);
+			// In place: copy the staged bytes over the target rather than
+			// rename(2) — the existing inode is rewritten, not swapped.
+			writeFileSync(path, readFileSync(tmp), { mode });
+			unlinkSync(tmp);
+			if (options.times !== undefined) {
+				utimesSync(path, options.times.atime, options.times.mtime);
+			}
```

- **Invariant:** the replace is atomic — a reader, a hard link, or a crash
  never sees the target half-written.
- **Verdict: KILLED.** `bun test` exit 1 — *3371 pass, 54 skip, 2 fail*:
  *"(fail) claude > preserves existing keys, other projects, and file mode"*,
  *"(fail) codexCredentials — oauth refresh write-back > a merge read that
  stays unreadable still persists the rotated pair — loudly"*.
  Reproduced in isolation (mutant applied): `src/harness-trust.test.ts`
  → 17 pass / 1 fail, the same `claude > …` test. The second failure did not
  reproduce in its own file (`src/agent/codex/auth.test.ts` → 5 pass / 0 fail);
  only the harness-trust failure is attributed as the detector.
  Receipts: `runs/S08.test.log`, `runs/S08.diff`.
  *Prediction was survivor* — the suite kills this variant through the
  mode/merge-read paths rather than through an explicit atomicity assertion.

### S09 — durable writes: mode preservation dropped — KILLED

`src/durable.ts:219`

```diff
-		if (existed) fchmodSync(fd, mode);
```

- **Invariant:** an existing file keeps its exact bits (`0o664` under a
  `0o022` umask must not degrade to `0o644`), so a hardened state file never
  loosens on rewrite.
- **Verdict: KILLED.** exit 1 — *1 fail*: *"(fail) durableWriteFile — mode and
  tmp hygiene > preserves a group-writable mode the umask would otherwise
  strip"*. Receipt: `runs/S09.test.log`.

### S10 — telegram boundary: plain send loses the topic (`message_thread_id`) — KILLED

`src/tg/delivery.ts:906`

```diff
 							api.sendMessage(conv.chatId, out, {
-								...(conv.threadId !== null ? { message_thread_id: conv.threadId } : {}),
 								...(idx === 0 && replyTo !== undefined
```

- **Invariant:** a send target is the conversation's chat **and** thread; in a
  forum topic a missing `message_thread_id` posts the reply outside the topic.
- **Expected observable failure:** every outbound chunk carries the summoning
  topic.
- **Verdict: KILLED.** exit 1 — *2 fail*: *"(fail) routeMemberGuestMessage >
  every member reply chunk stays in the summons' topic without changing guest
  identity"* and *"… member guest error details stay in logs, not in the
  shared room"*. `src/tg/delivery.test.ts` itself has zero
  `message_thread_id` assertions — the detectors live in the guest-routing
  suite. Receipt: `runs/S10.test.log`. *(Prediction was survivor.)*

### S11 — telegram boundary: outage notice loses the topic — KILLED

`src/tg/notify.ts:105`

```diff
-			addr.threadId !== null ? { message_thread_id: addr.threadId } : {},
+				{},
```

- **Invariant:** same send-target rule as S10, on the memory-outage path.
- **Verdict: KILLED.** exit 1 — *1 fail*: *"(fail) outage notice send > topic
  ids send into their thread; dm ids without one"*. Receipt: `runs/S11.test.log`.
- **Contrast:** the same class of fault *is* covered for `notify`, and was not
  covered for `delivery`'s own suite (see S10) — the coverage is module-local.

### S12 — telegram boundary: grammy's type surface leaks into a domain module — SURVIVED → killed

`src/conversation.ts:6`

```diff
+import type { Update } from "grammy/types";
+export type TelegramUpdateSurface = Update;
```

- **Invariant:** AGENTS.md — *only `src/tg/` knows grammy*; domain modules
  never see a Telegram context object. A type-only leak changes no runtime
  behavior, so no behavioral test can see it.
- **Expected observable failure:** none in behavior — only a static check can
  catch it.
- **Verdict: SURVIVED.** exit 0 — *3371 pass, 54 skip, 0 fail*; typecheck
  exit 0. Receipts: `runs/S12.test.log` (final re-run, green) and
  `runs/S12.run1.test.log` (the flaky first pass, kept for the record).
- **Resolution: killed by a new architecture test.**
  `src/module-boundaries.test.ts` → *"grammy is imported only under src/tg"*:
  scans production `.ts` files under `src/`, skipping the two sanctioned
  exempt dirs (`src/tg` — the owner; `src/testkit`, `src/test-helpers` — the
  test-only edge fakes that build the `Api` stub). Re-verified with the
  mutant re-applied: exit 1 — *"(fail) module boundaries > grammy is imported
  only under src/tg"*. Receipt: `runs/S12.reverify.test.log`.

### S13 — logic: line cap changed (2000 → 1000) — KILLED

`src/agent/tools/read.ts:9`

```diff
-const MAX_LINES = 2000;
+const MAX_LINES = 1000;
```

- **Invariant:** the read window pages at the documented 2000-line ceiling;
  the same constant bounds image sniffing's line walk.
- **Verdict: KILLED.** exit 1 — *2 fail*: *"(fail) read_file > byte-cap
  truncation emits complete lines plus a continuation notice"*, *"(fail)
  sniffImage — JPEG marker walk > the 2000-line ceiling caps short-line files
  before bytes do"*. Receipt: `runs/S13.test.log`.

### S14 — logic: loop-detector cut off by one (20 → 21) — KILLED

`src/loop-detect.ts:21`

```diff
-export const LOOP_DETECT_CUT = 20;
+export const LOOP_DETECT_CUT = 21;
```

- **Invariant:** an identical call+result warns at the 10th repeat and cuts at
  the 20th; A↔B alternation cuts at record 38.
- **Verdict: KILLED.** exit 1 — *2 fail*: *"(fail) loop detector > A/B
  alternation with stable results cuts — each side counts in the window"*,
  *"(fail) loop landings > repeat detector: identical call+result warns once
  at 10, cuts at 20"*. Receipt: `runs/S14.test.log`.

### S15 — logic: the `..` guard in the app-dist path resolver removed — SURVIVED → accepted gap (equivalent)

`src/http/app-dist.ts:41`

```diff
-	if (clean === "" || clean.split(/[/\\]/).includes("..")) return null;
+	if (clean === "") return null;
```

- **Invariant:** a static path under `/app/` never escapes `app/dist`.
- **Expected observable failure:** `GET /app/../<file>` 404s.
- **Verdict: SURVIVED.** exit 0; typecheck exit 0. The existing traversal test
  still passes because the *next* two lines (`resolve` + `startsWith(dist +
  sep)`) already refuse every escaping path — the dropped guard is redundant.
  Receipt: `runs/S15.test.log`.
- **Resolution: accepted gap (equivalent mutant).** Differential evidence: the
  real `serveAppDist` was driven with 14 hostile probe paths (`../secret.txt`,
  `..`, `assets/../../secret.txt`, `a/../../../etc/passwd`, `…/dist-evil/x`,
  dot-segment mixes, absolute and doubled slashes) with the mutant applied and
  clean — byte-identical responses (including `404 {"error":"not found"}` for
  every escape, and no leak of a file written beside `dist`). Outputs:
  `runs/equiv-app-dist.clean.txt`, `runs/equiv-app-dist.mutant.txt` (diff
  empty). No test can kill this mutant without asserting implementation
  internals, and a kill test would encode a redundant guard as required
  behavior. The containment invariant remains pinned by the existing test.

### S16 — logic: 8 MiB size gate off by one (`>` → `>=`) — SURVIVED → killed

`src/agent/tools/read.ts:49`

```diff
-		if (st.size > MAX_FILE_BYTES) {
+		if (st.size >= MAX_FILE_BYTES) {
```

- **Invariant:** `MAX_FILE_BYTES` is the largest readable file (the message
  says `max 8388608`), not the first refused one.
- **Expected observable failure:** a file of exactly 8 MiB reads; 8 MiB + 1
  refuses with "file too large".
- **Verdict: SURVIVED.** exit 0; typecheck exit 0 — the existing oversized-file
  test uses a 9 MiB sparse file, far from the boundary.
  Receipt: `runs/S16.test.log`.
- **Resolution: killed by a new test.** `src/agent/tools/read.test.ts` →
  *"a file exactly at the size cap is read; one byte more is refused"*.
  Re-verified: exit 1 — *"(fail) read_file > a file exactly at the size cap is
  read; one byte more is refused"*. Receipt: `runs/S16.reverify.test.log`.

### S17 — logging: the per-turn plain-delivery boundary line deleted — SURVIVED → killed

`src/tg/delivery.ts:1439-1454`

```diff
-			// Per-turn mode line (design/telegram.md): rich turns name
-			// their send in "delivered rich"; a plain turn — kill switch,
-			// non-DM, or a mid-turn degrade — must be identifiable too,
-			// not just per-message debug lines.
-			if (unsent === 0) {
-				const landed = chunks.filter((c) => c.id > 0).length;
-				if (landed > 0) {
-					log.info("delivered plain", {
-						conversation: conv.id,
-						chat: conv.chatId,
-						...(conv.threadId !== null ? { thread: conv.threadId } : {}),
-						messages: landed,
-						chars: rendered().length,
-					});
-				}
-			}
```

- **Invariant:** AGENTS.md → logging bar: every external boundary emits a line
  with the fields to explain it — delivery names send → chat/thread, so a
  screenshot plus the log file reconstructs what happened.
- **Expected observable failure:** a completed plain turn emits one
  `"delivered plain"` line carrying conversation, chat (and thread).
- **Verdict: SURVIVED.** exit 0 — *3371 pass, 54 skip, 0 fail*; typecheck
  exit 0. (`delivery.test.ts` captures log lines for other assertions but
  never asserted this boundary.) Receipt: `runs/S17.test.log`.
- **Resolution: killed by a new test.** `src/tg/delivery.test.ts` →
  *"a completed plain turn logs its delivery with the send target"* — drives a
  completed plain turn on a topic conversation and asserts the parsed line
  (`msg: "delivered plain"`, `conversation`, `chat`, `thread`, `messages`).
  Re-verified: exit 1 — *"(fail) delivery > a completed plain turn logs its
  delivery with the send target"*. Receipt: `runs/S17.reverify.test.log`.
  The assertion is coupled to the log message name; that coupling is the
  documented contract, not an implementation detail.

### S18 — logging: the app-channel stream-finish line deleted — SURVIVED → killed

`src/http/app-channel.ts:635`

```diff
-				log.info("app stream finish", { conversation: convId, outcome: done.kind });
```

- **Invariant:** same logging bar; the app door's turn end is a boundary that
  must be reconstructable from `goblin.log`.
- **Expected observable failure:** a finished app turn leaves one
  `"app stream finish"` line naming the conversation and outcome.
- **Verdict: SURVIVED.** exit 0; typecheck exit 0. Receipt: `runs/S18.test.log`.
- **Resolution: killed by a new test.** `src/http/app-channel.test.ts` →
  *"a finished turn logs the stream finish — the boundary the log file must
  reconstruct"* — runs a real chat turn over the listener with `setLogFile`
  pointed at the test home, then parses the log. Re-verified: exit 1 —
  *"(fail) app channel http > a finished turn logs the stream finish — the
  boundary the log file must reconstruct"*. Receipt:
  `runs/S18.reverify.test.log`.

### S19 — wire types: shared server/app contract field renamed — TYPECHECK-ONLY

`src/http/operator-wire.ts:22`

```diff
-	searchKinds: readonly string[];
+	searchKindList: readonly string[];
```

- **Invariant:** the app wire contract is one source (server types) compiled by
  both programs; a rename must break the build, not the running page.
- **Verdict: TYPECHECK-ONLY.** `bun test` exit 0 — *3371 pass, 54 skip, 0 fail*
  (types are erased at runtime, and the server still emits the old key);
  `bun run typecheck` **exit 2**:
  `src/http/operator.ts(545,5): error TS2561: Object literal may only specify
  known properties, but 'searchKinds' does not exist in type 'ConfigResponse'.
  Did you mean to write 'searchKindList'?`
  Receipts: `runs/S19.test.log`, `runs/S19.typecheck.log`.
- **Not counted as KILLED** — a different detector caught this class, and the
  drill's convention is to record it as such. This is the designed division of
  labor for the wire contract: typecheck for shape, tests for behavior.

---

## New tests added to the real tree

Nine tests across eight files, all green on the unmutated tree
(`bun test` → 3380 pass / 54 skip / 0 fail, 3434 tests / 176 files;
`bun run typecheck` → exit 0):

| Killing test | File | Kills |
|---|---|---|
| an unknown key in a persisted payload fails loudly — strict, not stripped | `src/tg/inbox.test.ts` | S01 |
| goblin.json5 > memory recallTimeoutMs has a floor | `src/config.test.ts` | S02 |
| a limit that cannot page is refused at the schema, not coerced | `src/agent/tools/read.test.ts` | S03 |
| a file exactly at the size cap is read; one byte more is refused | `src/agent/tools/read.test.ts` | S16 |
| an unresolvable source propagates — a symlink loop is not 'not found' | `src/box-files.test.ts` | S04 |
| a skills path that is not a directory fails loud, not as an empty catalog | `src/stateview.test.ts` | S05 |
| grammy is imported only under src/tg | `src/module-boundaries.test.ts` (new) | S12 |
| a completed plain turn logs its delivery with the send target | `src/tg/delivery.test.ts` | S17 |
| a finished turn logs the stream finish — the boundary the log file must reconstruct | `src/http/app-channel.test.ts` | S18 |

Each kill was re-verified in the copy with the mutant re-applied: the suite
went red and the named test was the failure (see the per-saboteur resolution
lines and `runs/*.reverify.test.log`).

## Accepted gaps

| # | Fault | Why no killing test |
|---|-------|---------------------|
| S07 | `fsyncSync(fd)` removed from the durable write | Unobservable without a crash or an fs-level fault injector; exposing it needs a seam inside `src/durable.ts`, which this drill may not change (tests + report only). The narrow gap is stated rather than papered over. |
| S15 | redundant `..` guard removed from `resolveDistFile` | Equivalent mutant: the remaining `resolve` + `startsWith(dist + sep)` containment check refuses every escaping path. Verified by differential probing (14 hostile paths, byte-identical clean vs mutant). A "kill" would assert a redundant guard, which is not a behavior. |

## What was NOT checked

- **Live drift checks were not run** by design: `GOBLIN_*_LIVE=1` suites
  (`src/*.live.test.ts`, `src/sandboxes.test.ts`, `src/sandbox.integration.test.ts`,
  `src/subagents.podman.test.ts`) touch live services/podman. They are the 54
  skips in every run above; no verdict here depends on them.
- **Modules/categories not sabotaged:** mail (`mail-*`), memory
  (`memory-*`, hindsight), subagents/herdr/desktops/sandboxes, scheduler,
  rolling-DM routing, auth (`src/auth.ts`), SQLite/WAL durability (a different
  mechanism than the file ritual, and not a listed category), HTTP auth/origin
  boundaries, and the app client's own logic (only the shared wire type was
  attacked). Category 5 (logic) and category 4 (telegram) were probed in one
  or two files each, not exhaustively.
- **No sabotage of `app/`** beyond S19, and no mutation-framework-grade
  enumeration: this is a hand-picked 19, so the survivor set is a sample of
  blind spots, not a coverage measurement.
- **Environment caveats:** runs happened as uid 1000 (`user`) on a 2-core
  sandbox, so root-only permission paths stay untested (the suite already
  `skipIf(uid === 0)`s them). One flaky test exists in the fetch suite (see the
  note at the top); its two spurious failures were identified and excluded from
  verdicts, and a red run of that test alone should not be trusted.
- **S15's equivalence** is asserted over the probe set in
  `runs/equiv-app-dist.*.txt`, not proven for all inputs.

## Receipts map

The receipt files below were scratch in the drill sandbox (`sabotage-work/`,
outside the repo, never committed); that sandbox's storage is ephemeral and
was reset after the drill, so the files are no longer retrievable — the
pass/fail lines and exit summaries quoted inline throughout this report are
their verbatim record. Paths as they existed during the drill:

- `sabotage-work/runs/S0x.diff` — the exact mutant diff as applied (git diff
  in the copy).
- `sabotage-work/runs/S0x.test.log[.gz]` — full `bun test` output for the
  mutant run (verdict).
- `sabotage-work/runs/S0x.typecheck.log[.gz]` — `bun run typecheck` for the
  mutant run.
- `sabotage-work/runs/S0x.reverify.test.log[.gz]` — the kill re-verification
  with the new tests committed in the copy.
- `sabotage-work/runs/S12.run1.test.log` — the preserved flaky first pass.
- `sabotage-work/runs/FINAL-real-tree.*.log` — the real tree's final
  `bun test` (exit 0) and `bun run typecheck` (exit 0).
- `sabotage-work/saboteurs.py` — the manifest (id → file:line edits,
  invariant, expectation), replayable with `sabotage-work/mutation.py`.

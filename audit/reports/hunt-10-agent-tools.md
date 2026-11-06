> Audited 2026-10-23 17:46 local, at repo commit `9d4f861e` (tracked tree clean; only untracked audit/ notes).

# Hunt 10 — agent tool layer (src/agent/tools/, src/agent/turn-tools.ts)

Read-and-report pass, 2026-10-23. Static reading only (per operator override:
the full suite and typecheck were already run green on this unchanged tree —
4686 pass / 0 fail / 86 skip; nothing was re-run except file reads). Governing
specs extracted as checklist: `design/tools.md` (Tools v1, Scripting, Vision,
Chat search), `design/web.md` (Web access), `DESIGN.md` → State layout /
Authority rule / Cache stability, AGENTS.md → Guardrails.

**Headline: no P0 or P1 found in the scoped tool layer.** The findings below
are a P2 recovery-edge defect and P3 hygiene items.

## 1. Findings

### P2-1 — script spill past read_file's 8 MiB ceiling: the footer names a paging call that refuses

- **Where:** `src/agent/tools/script.ts:310-325` (window + `trySpill(paths.scriptcache(), body)`
  with no size cap on `body`), `src/agent/tools/read.ts:11` (`MAX_FILE_BYTES = 8 * 1024 * 1024`),
  `src/agent/tools/read.ts:35-40` (refusal for larger files),
  `src/agent/tools/truncate.ts:30-35` (footer text promising `read_file` paging).
- **Rule violated:** `design/tools.md` → Scripting: "Output is bounded, and
  tainted output rides fenced. The raw output is windowed with the full text
  spilled and the footer naming the `read_file` call." and `design/web.md` →
  No silent dead ends: "overflow reads are footer-named with the exact
  `read_file` call — never a silent empty result."
- **What happens:** the windowed result is fine, but a script whose combined
  output (`text()` items + return value + error stacks joined at
  `script.ts:309`) exceeds 8 MiB spills a file `read_file` then refuses to
  open ("file too large … slice it with bash"). The named recovery in the
  footer is broken at exactly the sizes where recovery matters most; the
  script's own description (`script.ts:75`) repeats the same promise.
  Reachability is honest-but-real: nested tool results are individually
  bounded (fetch/bash ≈15k, read_file ≈64KB per call, ≤ `maxCalls` calls), so
  it takes deliberate in-VM accumulation (`text("x".repeat(9_000_000))`) or a
  pathological join — the 256 MB heap allows far more than 8 MiB, and the
  sweep (`SPILL_KEEP_BYTES`, `script.ts:95`) will happily retain such files.
- **Not silent** (read_file's own error names bash), hence P2, not higher.
- **Test sketch:** run the script tool with `code: text("x".repeat(9_000_000))`;
  assert the footer either names a file `read_file` accepts, or names the
  bash fallback instead of `read_file`.

### P3-1 — fetch text-overflow spill: same ceiling, narrower edge

- **Where:** `src/agent/tools/fetch.ts:228` (`text` decoded from a body capped
  at `DOWNLOAD_CAP` = 8 MiB), `fetch.ts:300-309` (`full = header + title +
  text` spilled), `read.ts:11/35`.
- **Rule:** same "No silent dead ends" clause — "overflow reads are
  footer-named with the exact `read_file` call".
- **Edge:** the spill file is header+title+text, so a page whose extracted
  text lands within a few dozen bytes of the 8 MiB download cap produces a
  file just over `MAX_FILE_BYTES`; `read_file` refuses and the footer's named
  paging path fails. Narrower than P2-1 because extracted text is rarely that
  large; same shape though. Also note the footer's char count
  (`truncatedFooter(file, extracted.text.length)`) counts `text` only while
  the saved file additionally contains the `Source:` header and title — the
  "full text (N chars) saved to" line is slightly wrong for every spill, not
  just the oversized one (cosmetic, `truncate.ts:34`).

### P3-2 — `transcribe` is scriptable; the doc says model-calling tools are out

- **Where:** `src/agent/tools/script.ts:28-39` (`SCRIPT_CALLABLE` includes
  `"transcribe"`).
- **Rule:** `design/tools.md` → opening: "`memory_reflect` … stays out of the
  script tool's callable set **because it invokes a model**"; Scripting →
  "agent-spawning and model-calling tools are out". `vision` (also
  model-calling) is correctly absent; `transcribe` invokes the configured
  transcription model per call.
- **Reading:** transcripts are mechanical media→text, so the inclusion is
  defensible — but the doc states the rule bluntly and records no exception
  for `transcribe`. Either the ruling needs a recorded carve-out or the list
  is wrong. Flagging as invariant hygiene, not as exploitable behavior
  (billing/latency exposure only, bounded by `maxCalls`).

### P3-3 — unknown content-type + non-HTML binary returns mojibake text instead of refusing

- **Where:** `src/agent/tools/fetch.ts:237` — `if (TEXTUAL.test(contentType) || contentType === "")`
  returns the lossily-decoded body as text whenever the server sends no
  content-type; the HTML sniff (`fetch.ts:230-233`) only catches
  `<!doctype/html` prefixes.
- **Rule:** `design/web.md` → "No silent dead ends … an unsupported type …
  refuses with its named recovery". A binary payload served without a
  content-type is an unsupported type in practice, but rides as garbage text
  (fenced, budgeted — harmless, just wrong-shaped) instead of the
  `binary`-kind refusal with its `bash`/`send_file` recovery.
- **Trigger:** any URL whose response omits `Content-Type` and whose body
  isn't HTML (e.g. a raw tarball behind a lazy static server).

### P3-4 — bash spill sits at read_file's ceiling with zero bytes of margin

- **Where:** `src/proc.ts:231-234` caps stdout and stderr **per stream** at
  `maxOutput` (bash passes `MAX_CAPTURE` = 4 MiB, `src/agent/tools/bash.ts:10,34`),
  `bash.ts:37` concatenates → up to exactly 8 MiB = `MAX_FILE_BYTES`; `read.ts:35`
  refuses only strictly-greater sizes. The invariant lives in bash.ts's own
  comment ("4 MiB keeps the spill inside read_file's 8 MiB ceiling") and holds
  by one comparison operator. Any bump of `MAX_CAPTURE`, a second concat
  source, or a future `>=` in read.ts breaks a recovery path silently.
  Recorded as hygiene: encode the relation (a test asserting
  `2 * MAX_CAPTURE <= MAX_FILE_BYTES`) rather than relying on arithmetic
  coincidence.

### P3-5 — ui input repair may not persist to what the client renders (lead, cross-hunt)

- **Where:** `src/agent/tools/ui.ts:9-28` — `validate` normalizes then returns
  `parsed.data`; `src/agent/tools/ui-schema.ts:232-259` infers missing `type`
  fields. The repaired value is what `execute` sees; whether the tool-call
  input part stored in the event (and thus what the app renderer reads) is
  the raw provider args or the validated value depends on AI SDK
  `parseToolCall` semantics I did not trace end-to-end. If raw args persist,
  every repaired block (the GLM "choices as bare strings" case the code
  documents at `ui-schema.ts:198`) renders as nothing client-side while the
  model believes it showed an interface. Client renderers are hunt 8's
  surface — handing the lead over rather than chasing it.

## 2. Checked and clean (later passes can skip)

- **Path handling has no confinement rule to violate.** `paths.ts:4-6`
  (`resolvePath`) deliberately allows absolute paths; every file tool's
  description says "relative to the working directory or absolute", and
  `design/web.md`'s no-SSRF ruling establishes the pattern ("the boundary is
  the tool set, same as `bash`"). DESIGN.md → State layout ("workspace/ …
  every tool runs there") is a cwd statement, not a jail. `..`, absolute
  paths, and symlinked leaves are all sanctioned surface for the personal
  toolset; the *guest* surfaces are fenced by construction (verified below).
- **Special-file refusal before I/O** — read (`read.ts:29-34`), send
  (`send.ts:58-62`), transcribe (`transcribe.ts:36-40`), vision
  (`vision.ts:61-65`) all refuse device/FIFO/socket per design/tools.md →
  "Special files … are refused before any I/O". `speak` inherits it via
  `readTextFile` + the `.txt/.md` extension gate (`speak.ts:44`).
- **Symlink-aware writes** — `paths.ts:20-37` (`writeThroughTarget`: dangling
  link fails loud, managed file written through) + `durable.ts:168-185`
  (`resolveLeaf`) and mode-preserving tmp+fsync+rename with directory fsync
  (`durable.ts:187-266`) — matches AGENTS.md → Guardrails exactly.
- **Sandbox/desktop file crossing is properly jailed** — `src/box-files.ts`:
  lexical `..` refused before fs touch (`:47`), realpath both sides, FD-pinned
  export dir with `O_NOFOLLOW` + `/proc/self/fd` revalidation, size caps.
  The sandbox and desktop tools only ever pass bytes through it.
- **boundedRun always settles** (`src/proc.ts`): deadline → SIGTERM → 1s grace
  → SIGKILL → 1s grace → honest `null`; cap overflow kills via the shared
  `onOutputCap`; post-exit 250 ms drain cut cancels readers so an orphan
  pipe-holder can't hang the promise. Abort listener bookkeeping is correct.
- **Bash offloads, never truncates** per the 2026-10-14 ruling: tail-heavy
  window (`windowText(combined, 15_000, 0.25)`), full output spilled
  content-addressed to the never-pruned bashcache, footer names the
  `read_file` call, capture-cap kills the process and the result then says
  the saved file is incomplete (`bash.ts:40-56`). Timeout clamped to 10 min.
- **Script tool invariants** (design/tools.md → Scripting): callable set is
  `SCRIPT_CALLABLE ∩ assembled-after-guest-filtering` (`script.ts:358`,
  `turn-tools.ts:287-298`); memory_reflect/herdr/delegate/subagent/speak/
  send_file/mail/responsibility/program/vision/image all absent for the
  documented reasons; nested calls run the live `execute` under
  `AbortSignal.any([vmSignal, turn signal])` (`script.ts:234-242`); taint
  latches at *dispatch* (`if (name === "fetch" || name === "search")`,
  `script.ts:233`) and tainted output rides `fenceUntrusted("web", …)` with
  status and footer outside the fence; first violation trips the shared
  interrupt *in the worker before posting* (`script-worker.ts:76-112` —
  verified against the pinned upstream that call args are posted as a JSON
  *string*, `pi-codemode/dist/runtime/vm.js:216-226`, so the 1 MiB arg cap
  is measured on the right thing); queued calls dropped when dead; worker
  bounds (8 posted / 1 MiB args / maxCalls ≤ 500) match the description, and
  `config.ts:408` caps `scripting.maxCalls` at the same 500 the worker
  header schema accepts; the acquire/release waiter accounting in
  `script.ts:147-172` is race-free (abort of a queued waiter splices without
  releasing; acquire rejects before the `try` whose `finally` releases);
  scriptcache sweep keeps newest-32/256 MiB and never touches bashcache or
  webcache (design: scriptcache temporary, the others never pruned).
- **Fetch invariants** (design/web.md): fallback walk advances only on
  transport/HTTP/auth failures and a structured refusal (`Rejected` return,
  not throw) stops the walk (`fetch.ts:335-366`); `served_by`-style note
  `(extracted via …)` rides outside the fence as trusted framing while
  title+text ride inside `<web>` (`fetch.ts:285-310`); PDFs are saved
  content-addressed (url+bytes hash, `fetch.ts:317-320`) and rendered as a
  native `file` part only when the catalog takes PDFs **and**
  `carries("application/pdf","tool-result")`, with trusted framing and a
  size re-check against `INLINE_ITEM_MAX_BYTES` (`fetch.ts:380-436`); URL-keyed
  text-overflow cache is the sanctioned recovery-aid case; auth resolved
  lazily at point of use, never in tool env (`fetch.ts:350`, `search.ts:296`);
  HTML goes through linkedom+Readability text extraction (no raw markup, no
  script/iframe content in results), empty extraction refuses with the
  browser-skill pointer; HTTP schema is `^https?://`; loopback/LAN left legal
  per the recorded no-SSRF ruling.
- **Search invariants** (design/web.md): one tool, config-driven provider
  chain, list order = walk order, empty result set stops the walk
  (`search.ts:319-337`), fallback note appended outside the fence
  (`search.ts:340-344,377`), hits+titles+snippets fenced (`fenceHits`), no
  provider knob mirroring (recency-in-query stated in the description), ddg
  is the documented keyless html-scrape with href-unwrap and an 8 MiB cap.
- **History search invariants** (design/tools.md → Chat search): plain terms
  quoted into AND phrases in the store (`conversation.ts:533-541 toFtsQuery`
  — `"` stripped before quoting, so no FTS syntax reaches MATCH);
  memory-excluded conversations filtered in SQL at query time
  (`conversation.ts:1073 c.memory_excluded = 0`); excluded callers refused
  except `context` on their own id (`history.ts:95-98,115-117` — the
  2026-10-14 exception); context rows rendered with the compaction
  serializer's projection, windowed per event, fenced as historical data
  (`history.ts:175-186`); `toolCallId`+`offset` exact paging of one stored
  tool result, fenced (`history.ts:118-159`). Search snippets
  (`history.ts:108-110`) are unfenced but extract only text/data parts
  (`memory/mod.ts:56 messageText`) — tool-result parts never enter them, so
  the "fenced as historical data" mandate (which exists because projection
  may strip a tool result's fence) is not violated.
- **No tool can address an arbitrary chat.** No schema in the scoped set
  carries a chat id / phone / username: `speak` and `send_file` hand bytes to
  the per-turn delivery sink closures; `program`'s DM arm uses
  `sendPrivate` built from `operatorIds()` (`program.ts:68-91`), never model
  input; `delegate`'s address comes from the runtime `pin(name)` closure
  (`delegate.ts:309`); `herdr` targets pane ids in the operator's own
  `default` session, regex-validated (`herdr.ts:7-11`); mail routes through
  the human-approval draft (`mail.ts`); `responsibility` sends ride the
  preflight-bound guarded edge with authority re-checks around every await
  (`responsibility.ts:141-145,254-257` etc.). Hook URLs never reach a tool
  result (`program.ts:385-387` throws if one tries).
- **Root schemas stay flat** (the Sep 28 mail lesson): mail, history, note,
  sandbox, program, delegate, subagent, desktop, herdr all use the flat
  object + `superRefine` re-parse of an internal discriminated union —
  exactly the documented pattern.
- **Tool results are text**: script (`toModelOutput` → text) and fetch
  (text/json/content-with-file-part, probe-verified path) are the only
  shapers; no tool returns image bytes (generate_image returns paths;
  read_file sniffs images and refuses with the vision/Telegram guidance).
- **Guest fencing is constructed, not promised** (`src/tg/guest.ts:613-645`):
  guest-persona (sandbox) conversations keep only `search` — so "no sandbox
  `fetch`" (ruling 2026-10-09) holds by absence; the personal guest turn's
  exclusion list matches "minus everything that pins, reaches beyond the
  chat, or changes medium"; `script` is refiltered after composition so it
  composes only the already-filtered set.
- **Every tool call is logged with reconstructable fields**: generic
  `tool call` line (conversation, tool, 200-char arg) in `turn/stream.ts:646`,
  nested script calls logged by `script.ts:225-230` with parent id, plus
  per-boundary lines (web fetch/search, herdr tool, responsibility tool,
  history searched/context, bash output spilled, memory searched, ui shown,
  program created). Special-file refusals, spills, and refusals all carry
  their explaining fields.
- **read_file caps and notices**: 2000 lines / 64 KiB with correct
  continue-offset notices for all three stop causes, per-line 2000-char
  clamp with a do-not-quote warning, first-line-overflow pre-check with a
  bash one-liner, offset-beyond-EOF error, negative-offset tail semantics —
  all consistent with the description.
- **Zod at every boundary** — all input schemas are zod (ui wraps zod in
  `jsonSchema` with a validating transform, still parsed); no `any` in the
  scoped files (casts are `unknown`→narrowed shapes).

## 3. Couldn't verify / leads

- **P3-5 (ui repair persistence)** — needs the AI SDK's `parseToolCall` →
  stored tool-input part semantics, plus the app renderer's read path (hunt
  8). Labeled as lead; the tool-side validation itself is sound.
- **pi-codemode worker internals** beyond the call-arg shape: that no
  upstream path bypasses the patched `port.postMessage` (e.g. a second port
  or structured-clone path). The pinned-dependency ruling covers this by
  version pinning and the script tests exercise it; I read `vm.js`'s bridge
  as the single poster but did not exhaustively audit the dependency.
- **`herdr` pane-id format** (`^w[0-9A-Z]+:p[0-9A-Z]+$`, `herdr.ts:7`) is
  presumably herdr's wire format; verifying it against the live herdr is a
  GOBLIN_HERDR_LIVE probe I did not run (out of engagement). Tests pin it.
- **`responsibility`/`subagent`/`delegate` machinery semantics** (store
  invariants, lifecycle truth) — explicitly out of scope (hunts 9/11/12);
  I verified only the tool-layer contracts above.
- **`windowText`/`truncateTail` UTF-16 slicing** can split surrogate pairs at
  window/page edges (history `payload.slice(off, off+8000)`, `read.ts` line
  clamp handles it, `windowText` mostly does not) — one mojibake character
  at boundaries; too small to file, noted for completeness.

## 4. Simplifications & code smells (P3, evidence-backed)

1. **Duplicated capped-stream readers.** `fetch.ts:168-195 readBodyCapped`
   and `web.ts:77-107 readBytesCapped` are the same algorithm with slightly
   different return shapes; `web.ts` already exports the general one. Fold
   `readBodyCapped` into it (the `{tooLarge:true, seen}` variant can be
   derived).
2. **Duplicated `postJson`.** `fetch.ts:66-84` and `search.ts:65-82` differ
   only in timeout and returned status; one shared helper in `web.ts` would
   carry both.
3. **Dead-in-production `baseUrl` plumbing.** `fetch.ts:88` (extractors),
   `fetch.ts:197` (`localExtract`), `search.ts:42-47/284` (`AdapterOpts`,
   `bindSearch`, `runSearchChain`) all accept `baseUrl` that no production
   caller passes — only tests inject it. Either it's a test seam worth a
   comment, or it's dead weight on every signature.
4. **Dead export.** `toolNames` (`tools/mod.ts:71-73`) has no caller —
   `runtime.ts:1086` uses `Object.keys(rawTools)` directly.
5. **Dead defensive branch.** `note.ts:207-209` guards
   `input.rev !== undefined`, but `replaceSchema` (`note.ts:49`) makes `rev`
   required, so the parsed value always has it.
6. **Double `channelOf` computation.** `turn-tools.ts:116` computes
   `channel` and `turn-tools.ts:284` recomputes `channelOf(conv.id) === "app"`
   — the `channel` variable is in scope.
7. **Inconsistent invalid-arg ergonomics.** `note.ts:129-137`,
   `subagent.ts:132-137`, `desktop.ts:147-152` return friendly `{error}`
   strings from a safeParse; `history.ts:94`, `mail.ts:58`, `sandbox.ts:78`,
   `program.ts:194`, `herdr.ts:69`, `delegate.ts:273`, `responsibility.ts:140`
   use bare `.parse` (throwing zod's aggregate message). The boundary schema
   catches everything first, so behavior is identical in practice — but two
   patterns for the same job invites drift. Likewise, `herdr` is the only
   multi-action tool using `z.strictObject` at the root; the others strip
   unknown keys silently.
8. **Misleading name-adjacent comment drift**: `truncate.ts:91`'s
   `[… N bytes of earlier output skipped]` counts `droppedBytes` from
   `keptBytes` which excludes the `…` prefix's own bytes — the notice can
   undercount by one ellipsis. Cosmetic.
9. **`responsibility.ts:27-30` envelope probe** builds a throwaway object
   (`grounded:false`, `omittedEvidence:1000`) purely to measure JSON length,
   then rebuilds the real values — works, but a `JSON.stringify` of the
   shape's keys with placeholders would make the intent obvious (the real
   `omittedEvidence` is a count, the probe's 1000 is a size guess).

— end of report —

# Reference review — goblin v2 vs openclaw / hermes-agent / pi-mono

> Reviewed 2026-10-31 → 11-01 at `56db0c3cbb1ab0f07e91bdce1c28f757c10df643`. Tracked
> tree clean; untracked: `audit/` notes only. Read-and-report: no source edits, no
> services touched, no `*.live.test.ts`, no auth material read.
>
> References read **on disk** (sandbox allowed it): `~/build/testing/openclaw/`,
> `~/build/testing/hermes-agent/`, `~/build/pi-mono/`. Every reference cited below is
> read-verified unless labelled otherwise. Runtime evidence comes from
> `~/goblin/state/goblin.log` (67 822 lines, 2026-09-17 → 2026-11-01), read with `jq`/`rg`.
>
> Tests run: `bun test src/agent/tools/script.test.ts src/turn/retry-guard.test.ts
> src/turn/overflow.test.ts` → 53 pass / 0 fail.
>
> Built past, not over: `arch-audit.md` (A1–A3 fixed, re-verified in
> `audit/optimization.md` Part 0), `audit/optimization.md` F1–F14,
> `audit/reports/SUMMARY.md`. Where a finding touches the same code, it says so.

## Verdict

goblin's turn engine borrowed pi's *timing* rules (step-boundary compaction,
overflow-compact-and-continue) but not the mechanism that makes them cheap in pi:
**every step lands in the transcript as it completes.** goblin lands the reply once,
at the end of the turn, and has grown four subsystems to stand in for the missing
record: the turn journal plus operator resume, overflow/pre-empt recovery packages,
wake ownership hooks, and a recovery guard keyed by tool name. That one seam is the
top finding. The suite-to-source ratio is concentrated on that same seam (F7).

The other findings are narrower: the chat model has no fallback chain, though
search, fetch and transcription all have one, and the log shows a 50-minute
manual failover. Tool policy is spread across string lists. The subagent run state
lives in two stores. And an overflow never teaches goblin the real window.

| # | Finding | Flow | Ref | Cost | Confidence |
|---|---|---|---|---|---|
| F1 | The in-flight turn is not in the transcript; four subsystems compensate | A, B | pi coding-agent, pi-durable | L | read-verified |
| F2 | The chat turn is the one model call with no fallback chain; quota and per-minute 429 are both treated as transient | A | hermes, openclaw | M | read-verified + log |
| F3 | Tool policy is matched by name in consumers; nested `script` calls are fenced only because tool objects are mutated in place | A | pi-durable, openclaw, pi coding-agent | M | read-verified |
| F4 | A submit's outcome is not durable; wake delivery reconstructs it from run-row hooks | A, C | pi-durable | M | read-verified (design), inferred (size of the win) |
| F5 | Subagent run lifecycle is split between `subagent_runs` and pi-durable storage | D | pi-durable | M | read-verified (duplication), inferred (simplification) |
| F6 | An overflow never teaches goblin the real context window | A | hermes | S | read-verified; provider bodies unverified |
| F7 | Tests are 1.37× source, and the excess sits on the F1/F4 seam | all | (DESIGN.md → Test posture) | — | measured |

---

## F1 — The in-flight turn is not in the transcript; four subsystems compensate

**Flow:** A (stream → delivery → crash recovery), B (conversation store).

**What goblin does today.**
- The reply is appended **once**, at landing: `landAttempt` → `deps.append([reply], …)`
  (`src/turn/finish.ts:144`), and it runs only on success (`src/runtime.ts:1372-1403`).
  The generic error rail stamps the run `error/failed` and notifies the sinks. No partial
  reply lands (`src/runtime.ts:1535-1552`). DESIGN.md:215-216 records "a fenced or failed
  turn leaves its user message unanswered."
- A per-step durable copy of the turn **does already exist**, but only as a side record.
  `onStepEnd` checkpoints `partial: ModelMessage[]` into the journal row
  (`src/turn/stream.ts:546-551`). The model view never reads it: `src/turn/view.ts` and
  `admission.ts` have no journal dependency, and `/resume` refuses any run that is not
  `interrupted` (`design/runtime-turn.md:120-122`).
- `streamRetries: 0` because "the SDK buffers tool parts until the attempt ends cleanly,
  so blanket step retries would redo completed work" (`src/turn/stream.ts:505-506`).
- The design admits the cost twice: "the in-flight reply isn't stored until the turn
  ends, so it isn't compactable" (`design/model.md:281-284`); "the live turn's own growth
  is never foldable (only stored history is)" (`design/compaction.md:200-209`).

Four subsystems exist to compensate:
1. **Turn journal and operator resume**: `turn-journal.ts` (881), `turn-resume.ts`
   (782), `turn/retry-guard.ts` (130). Resume seeds rebuild the partial and the loop
   state, and a guard refuses re-asked calls by `name:argsHash`
   (`src/turn/retry-guard.ts:60-130`).
2. **Pre-empt rides the overflow rail.** A step-boundary fold is implemented as a
   thrown `PreemptSignal` (`src/turn/stream.ts:356-369`). It is re-raised as a
   `PreemptCompactError` (`src/turn/overflow.ts:73-86,123-136`) and restarts the turn as
   a new attempt. That attempt carries a 17-field `TurnRecovery` package
   (`src/turn/overflow.ts:11-36`) and opens a new journal row that inherits the old one
   (`src/runtime.ts:1159-1203,1513-1523`).
3. **Wake ownership hooks**: F4.
4. **A recovery guard keyed by tool name**: F3.

**Concrete consequences for this deployment:**
- **A turn that fails mid-loop leaves its completed work invisible to the next turn.**
  Example: steps 1–14 write files or send mail, step 15 gets a 5xx/overloaded, and the
  turn errors. The operator says "continue". The new turn's view has the unanswered user
  message and none of the 14 results, and the recovery guard does not apply to a fresh
  turn, so effectful calls repeat with no fence. The log has this exact failure class:
  `codex stream response.failed … server_is_overloaded` at 2026-10-26T01:52:51Z.
- **A long agentic turn cannot fold itself.** Only history before the turn's earliest
  member can fold (`foldCeiling`, `src/runtime.ts:662-668`). When one turn's own tool
  output fills the window, the turn lands tools-off or fails, even though the
  "no step budget" ruling (`design/model.md:239-306`) says long turns are the point.
- **Bug pressure sits here.** Bug-hunt P1 #2 (journal id reuse) is in this seam. So is
  the 2026-10-22 `preRunFailure` patch (`design/runtime-turn.md:222-228`). 31 `fix`
  commits since 2026-10-01 touch the journal/resume/wake/overflow files.

**The reference mechanism.**
- **pi coding-agent persists every message as it completes.** On `message_end`
  (assistant **and** `toolResult`) it calls `sessionManager.appendMessage`
  (`packages/coding-agent/src/core/agent-session.ts:1147-1166`). Everything else follows
  from that:
  - Threshold compaction runs **inside the request hook**. It projects the session,
    compacts, re-projects and continues, with no abort and no new attempt
    (`agent-session.ts:776-785`, `787-844`).
  - Compaction can cut **inside** the current turn and summarize the split prefix
    (`compaction/compaction.ts:427-499` `isSplitTurn`, `890-917`, `980-1004`
    `generateTurnPrefixSummary`).
  - A retryable error omits only the failed assistant message, backs off, and calls
    `agent.continue()` over the persisted transcript. Completed tool results stay put
    (`agent-session.ts:1988-1992`, `3769-3773`, `3822-3862`).
- **pi-durable (already a goblin dependency)** commits every model turn and tool result
  "before anything is shown" (README → Concepts, lines 92-100). A tool call's intent is
  committed before `execute()`. After a crash, a non-`replay: "safe"` tool is not re-run:
  "the model gets an `interrupted` error result with the output committed so far"
  (README:277). The ambiguous state becomes a transcript fact the model can read, not
  an operator queue.
- openclaw does the same at tool granularity. Each tool's terminal result is appended
  under the transcript write lease after revalidating the attempt
  (`src/agents/embedded-agent-runner/run/attempt-stream-prepare.ts:424-438`).

**Why it is better.** One record serves four needs: what the model sees, what crash
recovery reads, what compaction can fold, and what a retry continues from. goblin
keeps two partial records: the journal's `partial` and the in-memory `UIMessage`. On
top of those it keeps a third reconstruction, the recovery package, for each of those
needs.

**Shape of the better design (direction).**
- Promote the journal's per-step checkpoint into the event stream. Append step events
  (the assistant step plus its tool results) as each `onStepEnd` lands, still
  append-only, so cache stability holds: the request for N+1 is N plus a tail. Make the
  final `UIMessage` a projection of those events, or the existing reply row written at
  landing.
- Mark a failed or fenced turn's steps as such, so the next turn sees "these ran, then
  the turn died" instead of an unanswered message. This replaces the
  successor-burst-merge rewrite in DESIGN.md's sanctioned list.
- Pre-empt then becomes "fold, then return the compacted `messages` from
  `prepareStep`". There is no throw, no new attempt and no `TurnRecovery`. The fold may
  include the turn's own completed steps, with a split-turn summary as in pi.
- Mid-turn transient retry becomes "re-drive from the view", within the 1min
  `maxRetries: 0` ruling, which stays per provider.
- Boot stays notice-only and resume stays an operator decision (DESIGN.md:160-164). A
  resume becomes "continue from the transcript". The model sees an interrupted call as
  an `interrupted` tool result, as in pi-durable, and per-call operator decisions shrink
  to the tools that are not replay-safe (F3).

**Cost / risk.** L. It touches the view builder, the anchor and ownership rules
(`design/runtime-turn.md` → Admission semantics), compaction's cut rule (it needs a
split-turn summary), the app's history rendering and `turn-resume.ts`. It needs new
rulings in DESIGN.md (failed-turn shape) and `design/compaction.md`. Staging: land step
events read-only first (alongside the journal), switch the view next, then retire the
recovery package and the pre-empt throw.

**Confidence:** read-verified, both sides. The size of the deletion is inferred.

---

## F2 — The chat turn is the one model call with no fallback chain; quota and per-minute 429 are both treated as transient

**Flow:** A (model stream, providers).

**What goblin does today.**
- An explicit, ordered fallback chain already exists for search and fetch
  (`src/config.ts:914-924`, ruled in `design/web.md:20-30`, "borrowed from hermes'
  `search_with_failover`") and for transcription (`src/config.ts:729-811`,
  `design/asr.md:34-38`).
- The chat turn, the compaction summarizer (the conversation's own model) and the
  subagents (pinned to z.ai) have none. `buildStep` resolves exactly one ref
  (`src/agent/step.ts:40-46`).
- `isTransientTurnFailure` returns true for any 429 or rate-limit text
  (`src/agent/provider-errors.ts:178-197`). A multi-day quota exhaustion is
  "transient", exactly like a per-minute throttle.

**Log evidence** (2026-10-26, UTC):
```
01:52:51 model call failed codex/gpt-6.1-sol → turn failed: server_is_overloaded
02:33:32–02:33:59 config written via app ×6            ← operator hand-failover
02:37:12/14/19 model call failed zai/glm-5.3 ×3        ← SDK retried a quota wall
02:37:19 turn failed: "Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-28"
02:45:49 turn completed                                  ← second manual switch
```
On 10-27 and 10-28 the pre-empt summarizer (`codex/gpt-6.1-sol`) failed too
(`model call failed … compaction`). About 50 minutes of manual failover, and the SDK
spent its retries on a quota wall that resets in two days.

**The reference mechanism.**
- **hermes** classifies before retrying:
  - It arms an exponential primary cooldown only for rate-limit and billing reasons
    (60 s → 4 h cap) and walks the configured fallback chain
    (`agent/fallback_cooldown.py:13-29`).
  - It holds a lane for a time that depends on the reason: quota and billing for hours,
    a per-minute 429 for seconds (`agent/auxiliary_health.py:43-60`).
  - Auxiliary tasks walk the same chain (`agent/AGENTS.md` → Model and provider
    resolution).
- **openclaw** `runWithModelFallback` walks an explicit candidate chain
  (`src/agents/model-fallback-runner.ts:143-200`). Its `canFallbackAfterError` hook
  refuses to fall back "when a thrown attempt committed work that must not be replayed"
  (`:117-118`). That is the same zero-effect gate goblin's scheduler already computes
  (`modelCalls === 0`, `src/scheduler.ts:718`).

**Why it matters here.** The operator runs three paid lanes (z.ai coding plan, codex,
1min). The log shows each failing at least once. The turn is the most important call,
and it is the only one without the mechanism goblin already trusts for search.

**Shape.**
- Extend the `design/web.md` ruling to model refs: `model: ref | ref[]`, explicit order,
  operator-written, never inferred (this honours "never choose a model the operator has
  not specified").
- Advance only:
  - at admission, or
  - after a failure with `modelCalls === 0` and no tool dispatched (openclaw's
    `canFallbackAfterError`).
- Never fall back mid-loop. The model switch is already a sanctioned one-time cache
  rewrite (DESIGN.md → Cache stability).
- Split the classifier: `quota` (body says limit/exhausted/insufficient balance; hold
  the lane until the stated reset or for hours) versus `throttle` (short cooldown).
  Pass `maxRetries: 0` on `quota`.
- Name the serving ref in the finish metadata, as search already does
  ("via ddg — brave: HTTP 402").

**Cost / risk.** M.
- Interacts with snapshot-at-admission (the turn captures the *resolved* ref) and with
  thinking-profile clamps (a profile per candidate).
- The resume drift check refuses a model change (`design/runtime-turn.md:120-122`), so
  record the serving ref on the run row.
- Needs a `design/model.md` ruling.

**Confidence:** read-verified (both sides) and log-measured.

---

## F3 — Tool policy is matched by name in consumers; nested `script` calls are fenced only because tool objects are mutated in place

**Flow:** A (tool loop).

**What goblin does today.**
- **Policy lives in name lists, in the consumers:**
  - replay safety: `SAFE_READ_TOOLS` (`src/turn/retry-guard.ts:13-21`)
  - composability: `SCRIPT_CALLABLE` (`src/agent/tools/script.ts:29-41`)
  - guest allowlist: `SANDBOX_TOOLS` (`src/tg/guest.ts:613`)
  - untrusted output: `name === "fetch" || name === "search"` (`script.ts:242`)
  - writes files: `tool === "write_file" || "edit_file" || "script"`
    (`src/turn/stream.ts:766-768`)
  - nested expansion: `tool === "script"` (`stream.ts:741`)

  A new tool silently gets the default for every list it is not added to.
- **The authority fence and the crash journal wrap tools by reassigning
  `t.execute` on the shared objects** (`src/runtime.ts:724-801`). The reviewer
  confinement does the same (`src/reviewer.ts:733-749`, `794-808`).
- The `script` tool captures the *pre-fence* `ToolSet` (`script.ts:377-386`, built in
  `src/agent/turn-tools.ts:304-313`) and looks up `tools[name].execute` at call time
  (`script.ts:220-251`). Nested calls get the authority check, the journal row and the
  recovery guard only because `fenceTools` later mutated those same objects. A test pins
  that ordering accident: "nested calls look up execute at call time — a fence swapped
  in later still wraps them" (`src/agent/tools/script.test.ts:453-469`, passes). If
  `makeTools` returned copies, or `fenceTools` became pure, every nested call would
  bypass the epoch fence and the journal without a type error.

**The reference mechanism.**
- **pi-durable:** replay policy is declared on the tool (`readonly replay?: "safe" |
  "unsafe"`, `packages/durable/src/harness/types.ts:310`; enforced at
  `harness/tool.ts:186,306`). Nested calls go through the host:
  `api.executeTool()` makes each nested call "its own tool task… validated, runs the
  ToolTask hooks, keeps its own output limits and replay policy" (README:309-328). The
  codemode extension uses exactly that path (README:357-368).
- **pi coding-agent:** `_executeNestedToolCall(parentToolCallId, …)` runs nested calls
  through the same `beforeToolCall`/`afterToolCall` hooks as top-level calls
  (`agent-session.ts:730-763`).
- **openclaw:** tool metadata carries `replaySafe` and `sideEffecting`
  (`src/plugins/tool-metadata.ts:29-36`), and the runner reads it per call
  (`attempt-stream-prepare.ts:402`).

**Why it matters here.** The authority rule is the core invariant (DESIGN.md → The
authority rule). For the most powerful composite tool, it is held by object identity
and one test. F1's "interrupted, not re-run" recovery also needs a per-tool replay
declaration, not a three-name set.

**Shape.**
- Give goblin's tool factory a small declared descriptor:
  `{ replay: "safe"|"unsafe", output: "trusted"|"untrusted", writesFiles, scriptable,
  guest }`. Consumers read the descriptor and the name lists go.
- `fenceTools` returns a new `ToolSet` whose executes all route through one
  `dispatch(name, input, ctx)`. That pipeline carries authority, journal, guard,
  confinement and attribution as an ordered hook list.
- `script` receives `dispatch`, never a `ToolSet`.

**Cost / risk.** M: mechanical, but touches every tool. Low behavioural risk if the
descriptors are filled from today's lists first.

**Confidence:** read-verified.

---

## F4 — A submit's outcome is not durable; wake delivery reconstructs it from run-row hooks

**Flow:** A (delivery), C (proactivity: wakes, programs, responsibilities).

**What goblin does today.** `Runtime.submit` durably appends the message
(`src/runtime.ts:364-367`). Whether the submit was *answered* exists only as a sink
`onDone` callback. To get a durable answer, goblin adds:
- `runOwnership` hooks (`begin` / `members` / `end` / `preRunFailure`,
  `src/runtime.ts:199-220`), threaded through admission, steering
  (`src/turn/stream.ts:464`), overflow resume and the error rails
  (`src/runtime.ts:984-992,1185-1196`).
- A wake store and dispatcher that link a claimed wake to "the journal run that
  processes it", settle on the run's terminal stamp, and fail unlinked claims closed
  (`src/wake-dispatcher.ts:1-18`, `src/wake-store.ts:1-11`; 1 089 lines together).
- The design's "What must not change" list is mostly this protocol
  (`design/runtime-turn.md:205-228`), including the 2026-10-22 `preRunFailure` patch.
- The scheduler's retry ladder reads the volatile `TurnDone.transient/modelCalls`, so
  "restart ends the ladder" (`design/programs.md:92-100`).

**The reference mechanism.** In pi-durable a **Submission** is a durable record:
- `submit()` "durably admits your input and returns a Submission".
- `wait()` resolves `done` or `unanswered` with a reason (README:63-77, Concepts
  92-100).
- Queued inputs live in the `pi.inbox` doc. Steer and follow-up placement are
  submission properties (README → Busy Conversations, 497-520).
- `requestId` dedupes resubmission (README:832).

Ownership ("which run answered input X") is a property of the submission, written by
the engine. Observers do not reconstruct it.

**Why it matters here.** Every proactive path (programs, delegation notices,
responsibility follow-ups, subagent completions) enters through wakes. The hook
protocol is how a missed edge turns into a re-admission loop or a silently dropped
trigger (the `preRunFailure` case).

**Shape.**
- A `submissions` row per admitted event seq: `{seq, conversation, origin key,
  owned_by_run, state: queued|running|answered|unanswered(reason)}`.
- The runtime writes it in the same transactions that already write `beginRun`, the
  steer checkpoint (`src/turn/stream.ts:485-489`) and `finishRun`.
- Wakes, the scheduler ladder and resume then *query* it, and the four hooks go.
- Pairs naturally with F1: one durable unit of work.

**Cost / risk.** M. Same tables, fewer writers. Migrating claimed wakes needs care.

**Confidence:** read-verified for the design. That the hooks collapse to a query is
inferred.

---

## F5 — Subagent run lifecycle is split between `subagent_runs` and pi-durable storage

**Flow:** D (delegation).

**What goblin does today.** `design/subagents.md:80-84` says: "`subagent_runs` holds
**routing** while Pi Durable holds transcripts". The row now holds much more than
routing (`src/subagent-runs.ts:98-150`):
- `status`, `inputRev`, `inputIntent`, `inputMode`, `stopRequested`
- `inbox: string[]`, which duplicates pi's native `pi.inbox`
- `pendingApproval`, described as "only a routing mirror — this doc is truth"
  (`src/subagents/approval-gate.ts:23-25`)
- `inputRev` again inside the conversation-scoped `RunDoc`
  (`src/subagents/run-doc.ts:11-23`)

Keeping the two stores consistent needs an intent-before-submit protocol
(`inputIntent` plus a deterministic `requestId`, `src/subagents/admission.ts:196-231`).
Boot recovery then cross-checks the two stores branch by branch: "no Pi conversation
recorded", "Pi conversation missing after restart", intent present → readmit, outcome
rev match → finalize, submission present → monitor (`src/subagents/recovery.ts:108-170`).

**The reference mechanism.** pi-durable's intended pattern for host state is a
`defineDoc` document committed **in the same atomic commit** as entries and tasks.
`conversationCreated(tx, conversation)` seeds it in the commit that creates the
conversation (README → Your Own State, 721-760). Queued inputs are the built-in inbox.
Parked runs are `restartLimit`/`retryTask` (README:216). goblin already does this
correctly for the outcome (`RunDoc`) and the approval lease. The rest of the lifecycle
did not follow.

**Why it matters here.** Each field that lives in both stores adds a crash window and
a branch in boot recovery. The subagent suite is 7 521 test lines against 4 853 in
`src/subagents/`.

**Shape.**
- Shrink `subagent_runs` to what goblin must query without opening the harness:
  id, origin conversation, kind, pi ids, a coarse status for `maxRuns` and listing,
  `noticePending`.
- Move input revision and intent, stop intent, pending approval and the local inbox
  into the `RunDoc`, committed with the submit.
- Amend the "Run state is rows" ruling to say which fields the row owns.

**Cost / risk.** M. The live drift check pins the pi verbs. Bug-hunt 09 found this area
clean today, so this is debt reduction, not a fire.

**Confidence:** duplication read-verified. That recovery shrinks is inferred.

---

## F6 — An overflow never teaches goblin the real context window

**Flow:** A (overflow, compaction). **Extends `audit/optimization.md` F1** (catalog
denominator 1 000 000; config override proposed). Not a restatement.

**What goblin does today.**
- `isContextOverflow` recognises the error (`src/agent/provider-errors.ts:66-130`,
  function at `:117`).
- Recovery compacts once with half the tail (`src/runtime.ts:597`).
- The next turn's pressure arm and the app gauge still use the catalog number
  (`src/agent/step.ts:40-46`, `contextLimitDetailed`).
- So every long conversation on a lane whose real window is below the catalog pays one
  failed 400 plus one emergency fold per crossing.

**The reference mechanism.** hermes parses the limit a provider quotes in the error
("maximum context length is 32768", vLLM `max_model_len`, Gemini "supports up to N"),
accepts it only if it is lower than the current window, and persists it per
`model@base_url` (`agent/model_metadata.py:1174-1200` `save_context_length`,
`1269-1300` `parse_context_limit_from_error`, `get_context_length_from_provider_error`).
Its resolution order puts the explicit config override first and the learned cache
second, ahead of catalogs (`model_metadata.py:2162-2210`).

**Shape.**
- On a classified overflow with a parseable limit below the catalog's, record
  `{route, limit, source: "provider-error", at}` in state.
- Window resolution becomes `config override → learned → catalog`, with provenance
  logged (F1's step 1 already returns `source`).
- Never raise a learned value from an error. Clear it only on a model or route change.

**Cost / risk.** S. Whether z.ai's code-1261 body or the 1min 100k-character cap quote
a number is **unverified**. The 1min cap is in characters, so it would still need the
override.

**Confidence:** read-verified on both sides. Provider error bodies are unverified.

---

## F7 — Tests are 1.37× source, and the excess sits on the F1/F4 seam

**Flow:** all. DESIGN.md:309-316: "the suite stays smaller than `src/` — bigger is a
smell to fix, not a badge"; v1 died of the same ratio (DESIGN.md:9-12).

**Measured** (`git ls-files`, `wc -l`): `src/` production 75 334 lines, `src/` tests
102 832 (**1.37×**). The excess is concentrated where F1 and F4 compensate:

| Seam | Prod | Tests | Ratio |
|---|---|---|---|
| journal + resume + guard + overflow | 2 091 | 4 413 | 2.1× |
| `runtime.ts` / `runtime.test.ts` | 1 566 | 4 048 | 2.6× |
| wake store + dispatcher | 1 089 | 1 708 | 1.6× |
| `src/subagents/` (F5) | 4 853 | 7 521 | 1.5× |

These tests pin the shape of the workarounds: ownership seqs, recovery-package
fields, grant consumption, inherited spans. They do not pin product behaviour, which
is the "propping up a seam" pattern DESIGN.md warns about.

**Shape.** No test-deletion campaign. Delete these tests along with the code that F1,
F4 and F5 retire. Then make the ratio a checked number: add a one-line line-count
check to `scripts/function-size-audit.ts` or to doctor's repo mode, so the smell is
seen when it grows, not at audit time.

**Confidence:** measured. That these tests leave with the code is inferred.

---

## Clean bill — mechanisms to keep

These flows are equal to or ahead of all three references. Don't touch them.

- **Authority: one counter, one function.** The epoch is compared around every await,
  in `fenceTools`, in `prepareStep` and at delivery time (DESIGN.md → The authority
  rule; `src/runtime.ts:686-689`). openclaw does the same job with admitted-run-context
  revalidation across many owners (`src/agents/AGENTS.md` → Run Authority). goblin's
  version is smaller and fully covers this deployment. Keep it, and give it F3's
  structural dispatch.
- **Cache stability as an observed invariant.** The system prompt is frozen per
  conversation. Steering appends at `prepareStep`, and a short list of sanctioned
  rewrites is the only allowed churn. A request-prefix hash is logged per call.
  - openclaw and hermes state the same rule in prose (`openclaw/AGENTS.md` → Stable
    conversation context; `hermes/agent/AGENTS.md` → Message-flow invariants).
  - goblin *measures* it: 94.7 % cache-read share (optimization.md "Not worth it" #1).
  - The committed, byte-replayed pruning marker (`src/cache-pruning.ts`) is ahead of
    openclaw's TTL-marker pruning (`embedded-agent-runner/cache-ttl.ts`).
- **Compaction as pointer relocation over immutable events.** Exchange-complete cuts,
  absolute budgets, and a `history_search` recovery door. Equal to pi's session
  compaction and stricter than hermes, which falls back to a deterministic summary on
  repeated stalls (`hermes/agent/AGENTS.md` → Compression). goblin rejects that
  fallback (`design/compaction.md:284-287`), correctly. Keep it; F1 changes only *what*
  is foldable.
- **Loop bounds without a step cap.** The repeat detector (openclaw's
  `tool-loop-detection.ts` mechanism, 77 lines in `src/loop-detect.ts`), the system1
  watchdog and the context landing. hermes caps at `max_iterations` 500. goblin's
  bounds catch loops without truncating legitimate long turns.
- **Telegram intake and delivery.** A durable update inbox written in the handler
  (`handleMessageDurably`, `src/tg/mod.ts:1111`; `src/tg/inbox.ts`) and a flood-wait
  transformer honouring `retry_after` with jitter (`src/tg/flood-wait.ts`). That ack
  ordering follows grammy's sequential handling is inferred.
- **One adapter per external contract.** The adapter rule is enforced by
  `module-boundaries.test.ts`, plus env-gated live drift checks that pin verbatim wire
  behaviour (herdr, gws, podman, harness-trust). openclaw's guardrail tests do the same
  job at about 100× the surface.
- **Programs' durable grant gate.** Grant-shaped changes stage as `program_proposals`
  and activate only on an operator tap (`design/programs.md:26-73`). openclaw's
  standing orders ride an always-injected AGENTS.md. goblin's charter-is-the-row
  approach is cache-stable and keeps authority enforced outside the model.
- **pi-durable used as intended where it is used.**
  - deterministic `requestId` admission (`subagent:<id>:input:<rev>`)
  - a task-scoped approval lease doc keyed by the tool task
  - pi ids confined to `src/subagents/`

  F5 is about the remainder, not these.
- **One client, two doors.** The app imports server wire types into its own tsconfig
  program, so schema drift breaks typecheck. The live-chunk replay lasts only as long
  as the turn, which is the right scope for one process. A Redis-backed resumable
  stream would be scope.
- **Fail-loud classification of provider errors.** `provider-errors.ts` walks the
  whole error envelope and refuses to read a reasoning-required 400 as an overflow.
  F2 asks it to split *quota* from *throttle*; the walk itself is sound.

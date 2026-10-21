# Little Goblin — architectural evaluation

Repository: [bermudi/little-goblin](https://github.com/bermudi/little-goblin?utm_source=chatgpt.com) Reviewed revision: [`5e7977d`](https://github.com/bermudi/little-goblin/commit/5e7977d047b6f3c54f7de1656c819982812d26dc?utm_source=chatgpt.com) Scope: Static review of the architecture, implementation, and relevant tests against `DESIGN.md` and the design documents. No code changes or runtime tests performed.

## Verdict

I found three concerns worth investigating, two involving interrupted-turn recovery and one involving standing authority.

The architecture is considerably more deliberate than its individual implementations might suggest. Many apparent shortcuts have explicit owners, documented tradeoffs, and tests. I would not recommend a general architectural refactor.

| Rank | Finding                                                           | Evidence category                     | Expected cost |
| ---- | ----------------------------------------------------------------- | ------------------------------------- | ------------- |
| 1    | Tool replay confuses equivalent arguments with the same execution | Existing pressure + fragile extension | High          |
| 2    | Resumed turns can inherit the wrong causal anchor                 | Unowned invariant + fragile extension | Medium–high   |
| 3    | Standing-program authorization is enforced by model instructions  | Architectural mismatch                | Medium        |

## 1. Tool replay conflates call equivalence with execution identity

Runtime / turn journal / interrupted-turn recovery

Files: [`src/turn-journal.ts`](https://github.com/bermudi/little-goblin/blob/5e7977d047b6f3c54f7de1656c819982812d26dc/src/turn-journal.ts?utm_source=chatgpt.com#L697-L720), [`src/runtime.ts`](https://github.com/bermudi/little-goblin/blob/5e7977d047b6f3c54f7de1656c819982812d26dc/src/runtime.ts?utm_source=chatgpt.com#L535-L579), [`src/turn-resume.ts`](https://github.com/bermudi/little-goblin/blob/5e7977d047b6f3c54f7de1656c819982812d26dc/src/turn-resume.ts?utm_source=chatgpt.com#L222-L250)

What it does today

An interrupted run can be resumed without repeating effects the journal has already recorded.

The journal retains individual `toolCallId` values, but replay uses a different identity:

```
`${name}:${sha256(stableStringify(args))}`
```

Completed results sharing this identity form a FIFO queue. During the resumed turn, `fenceTools()` intercepts a newly generated tool call, looks up that key, removes the next recorded result, and returns it without executing the tool.

This is locally elegant: the model can regenerate calls without preserving their original IDs.

### Observed architectural pressure

The implementation has two distinct concepts of identity:

- The journal tracks executions by their individual call IDs.
- The replay mechanism identifies executions by tool name and arguments.

The conversion between them implicitly assumes that a newly emitted call with identical arguments is a repetition of an earlier execution.

That assumption is not generally valid for stateful tools.

Consider an interrupted turn that already executed:

```
read_file("config.json") → version A
```

After resumption, the agent modifies the file and then deliberately executes:

```
read_file("config.json") → ?
```

The new call has the same name and arguments as the old call. If its replay credit remains, the runtime returns version A instead of reading the modified file.

The same ambiguity applies to repeated commands and other operations where identical arguments have different meanings at different causal points.

This isn't an inference about how the journal might work. The FIFO behavior is explicitly tested in [`turn-journal.test.ts`](https://github.com/bermudi/little-goblin/blob/5e7977d047b6f3c54f7de1656c819982812d26dc/src/turn-journal.test.ts?utm_source=chatgpt.com#L634-L681). What is not established is that the correspondence remains sound when the resumed agent performs new work before repeating an old call.

### Predicted growth pressure

As recovery becomes more useful, resumed work will increasingly involve revisiting earlier observations, verifying effects, or reexecuting equivalent operations intentionally.

Those workflows need a distinction between:

1. Answering a historical call from recorded evidence.
2. Executing a new call that happens to have equivalent arguments.

Without that distinction, the journal's replay rules will accumulate exceptions for particular tools or execution sequences.

Direction: Give historical replay an explicit continuation identity or boundary rather than using argument equality as proof that a new invocation is old work. The journal already stores much of the required execution identity.

What would make this less serious: Evidence that resumed models never emit new same-argument calls after intervening work, or tests demonstrating that such calls cannot consume stale replay credits.

Assessment: Highest-priority investigation. It affects a correctness guarantee central to recovery: knowing which effects have and have not executed.

## 2. Interrupted-turn recovery can lose ownership of the original causal anchor

Turn admission / resume / response persistence

Files: [`src/turn-resume.ts`](https://github.com/bermudi/little-goblin/blob/5e7977d047b6f3c54f7de1656c819982812d26dc/src/turn-resume.ts?utm_source=chatgpt.com#L299-L325), [`src/turn/admission.ts`](https://github.com/bermudi/little-goblin/blob/5e7977d047b6f3c54f7de1656c819982812d26dc/src/turn/admission.ts?utm_source=chatgpt.com#L105-L132), [`src/turn/finish.ts`](https://github.com/bermudi/little-goblin/blob/5e7977d047b6f3c54f7de1656c819982812d26dc/src/turn/finish.ts?utm_source=chatgpt.com#L101-L168)

What it does today

A journaled run records the original `anchorSeq`.

When the operator resumes it, `turn-resume.ts` retrieves the triggering message to seed the new submission. But the actual turn admission then takes a fresh model-history snapshot and calculates its anchor from the latest user entry in that snapshot.

At completion, `landAttempt()` again derives the reply anchor from the owned model entries.

This is consistent with the general rule that a resumed turn is a fresh admission. The difficulty is that the interrupted run also claims continuity with an earlier exchange.

### Observed architectural pressure

Two ownership models coexist:

- The journal identifies which original user input the interrupted run was executing.
- Fresh turn admission identifies the newest user input in the current conversation.

They coincide when the operator resumes immediately. They need not coincide after subsequent conversation activity.

A concrete sequence:

1. Message A starts a turn, which crashes after recording some progress.
2. The operator continues the conversation. Message B receives a completed answer.
3. The operator resumes A's interrupted run.
4. The resumed attempt reads current history and can anchor its eventual response to B rather than A.

The persistence layer then uses that newly calculated anchor to place the response in causal history. The retention path also derives its source from the current model-view entries.

This makes recovery more than an execution concern: it can change attribution and the interpretation of which exchange was answered.

There is a related compaction interaction. `triggerMessage()` looks up the original input through `store.modelEntries()`, which excludes compacted history. If the message has been compacted away, the function substitutes a placeholder rather than recovering the original durable event, even though [`historyDetail()`](https://github.com/bermudi/little-goblin/blob/5e7977d047b6f3c54f7de1656c819982812d26dc/src/conversation.ts?utm_source=chatgpt.com#L1658-L1682)[ retains it](https://github.com/bermudi/little-goblin/blob/5e7977d047b6f3c54f7de1656c819982812d26dc/src/conversation.ts?utm_source=chatgpt.com#L1658-L1682).

### Predicted growth pressure

Resuming older runs after other successful activity is already possible. More extensive use of `/resume` would make the distinction between continuing a previous exchange and starting a new exchange informed by previous work increasingly important.

It would affect causal ordering, response attribution, and memory-retention provenance.

Direction: Define one explicit ownership rule for resumed turns. Either preserve the original exchange anchor or deliberately classify the resumed work as a new exchange, with the provenance of the old run separately recorded.

What would make this less serious: A product rule that permits resumption only when the interrupted run remains the latest unanswered exchange, enforced at admission. Alternatively, treating older-run resumption explicitly as new work rather than continuation.

Assessment: Worth addressing alongside finding 1. Both arise from the same architectural boundary: reconstructing a logical continuation as a fresh model invocation.

## 3. Standing-program authority has no independent grant boundary

Program tool / persistent scheduler / operator approval

Files: [`design/programs.md`](https://github.com/bermudi/little-goblin/blob/5e7977d047b6f3c54f7de1656c819982812d26dc/design/programs.md?utm_source=chatgpt.com#L79-L83), [`src/agent/tools/program.ts`](https://github.com/bermudi/little-goblin/blob/5e7977d047b6f3c54f7de1656c819982812d26dc/src/agent/tools/program.ts?utm_source=chatgpt.com#L159-L258), [`src/programs.ts`](https://github.com/bermudi/little-goblin/blob/5e7977d047b6f3c54f7de1656c819982812d26dc/src/programs.ts?utm_source=chatgpt.com#L435-L476), [`src/agent/turn-tools.ts`](https://github.com/bermudi/little-goblin/blob/5e7977d047b6f3c54f7de1656c819982812d26dc/src/agent/turn-tools.ts?utm_source=chatgpt.com#L133-L143)

Operative design

The programs specification says the agent may propose standing authority but cannot grant itself that authority. Creating a program or widening its charter requires the operator's explicit request.

That is a meaningful product boundary: a program grants recurring future work, not merely execution of one turn.

### Observed architectural pressure

The `program` tool's natural-language description repeats the requirement.

But the implementation of `create` immediately calls `programs.create()` when its fields validate. `update` passes a replacement charter directly to `programs.update()`.

The store validates structural properties such as trigger presence, cron syntax, and lateness constraints. It does not possess an independent authorization decision or a representation of what scope the operator approved.

Furthermore, `makeTurnTools()` mounts `program` for Telegram turns. Scheduled program executions use the ordinary runtime path, and the design explicitly permits firing turns to manage programs.

As a result, the effective grant boundary is model behavior: the agent must correctly interpret whether it received sufficient permission before issuing a tool call.

This is not evidence that the model has actually created unauthorized programs. It is evidence that the claimed invariant has no enforcement owner outside the model.

### Predicted growth pressure

A narrowly trusted, single-operator agent can rely on instructions for many behavioral conventions. Standing authority creates a harder case because mistakes persist into future executions.

More program triggers, richer charter edits, or additional agents capable of managing programs would widen the gap between what the model believes it may authorize and what the system can verify was authorized.

Direction: Separate proposing a new or widened grant from activating it. An operator approval of the resulting charter or scope would give the authorization invariant a durable owner. Ordinary rescheduling and edits within an approved scope can remain lightweight.

What would make this less serious: An explicit product decision that the grant rule is advisory rather than enforced, and that the operator accepts the model's ability to create recurring work under its existing tool privileges.

Assessment: Medium priority. This is an architectural mismatch, but its practical urgency depends on how strongly the product intends to guarantee operator-granted standing authority.

## Areas I would clear

I examined several implementations that initially looked suspicious but are better understood as deliberate constraints.

| Area                                    | Why I would not flag it                                                                                                                                                                                              |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In-memory live-stream replay            | The design explicitly ties replay to the lifetime of a running turn, with durable history serving as the fallback.                                                                                                   |
| Restart-lost schedule retry timers      | The scheduler explicitly bounds retries and accepts losing an in-process retry ladder on restart.                                                                                                                    |
| Subagent versus main-turn recovery      | They have different execution and durability models, with separately defined lifecycle owners. Their coexistence is not sufficient evidence of unnecessary duplication.                                              |
| Per-module SQLite schema initialization | There is a potential coordination cost, but the single-process deployment and explicit schema ownership make the current design defensible. I found no concrete cross-module migration failure to justify a finding. |
| Large modules and closure factories     | The recent owner decomposition addresses lifetime boundaries. File size alone does not establish architectural weakness.                                                                                             |

## Prioritization

I would investigate the two recovery findings together, because the same architectural question underlies both:

What exactly is being resumed: the historical execution, the historical request, or a new model turn that has access to the historical evidence?

Right now, parts of the implementation answer that question differently. The journal protects historical effects, admission reconstructs fresh conversation ownership, and replay uses argument equivalence to bridge the two.

Clarifying that contract would be more valuable than independently patching each edge case.

The standing-authority issue is separate. Its priority depends on whether Goblin's prohibition against self-granted programs is intended as a behavioral instruction or a guarantee.

Overall: Three defensible investigation targets, not a broad indictment of the architecture. Of these, the replay-identity issue has the clearest demonstrated code-level pressure. The other two merit targeted regression probes before committing to changes.


---

I'll start by exploring the repository structure and understanding the codebase.



I read the tree (352 `src/` files, ~137k lines, plus the 6.5k lines of `design/` spec), traced five candidate areas end to end, and wrote the review to `audit/architecture-review-2026-10-19.md`.

**Checks I ran on this tree (`5e7977d`):** `bun run typecheck` clean (both programs); `bun test` → 3903 pass / 83 skip / 0 fail across 211 files; then re-ran the five suites closest to the findings (prompt, turn-resume, compaction, runtime, tg/mod) → 239 pass / 0 fail. I installed bun (it wasn't on the box) to do it.

## Findings, ranked by expected architectural cost

**1. `buildStep(conv, {})` is a write, not a query — a no-op `/compact` freezes an empty tool list into the conversation's system prompt.** This one I reproduced, not just argued. `Runtime.doCompact` calls the step builder with no tools to read `step.contextWindow` (`src/runtime.ts:428` — that field is the *only* thing it uses; `step.system` is computed and thrown away, because `runCompaction` always passes its own `SUMMARY_SYSTEM`). But `buildStep` routes through `systemPromptFor`, which is cache-or-**create**: with no snapshot it builds one from `toolNames({}) === []` and persists it (`src/agent/prompt.ts:491-494`). The snapshot is only cleared when a compaction actually compacts, so a `noop` leaves `- Tools: .` frozen — and since `buildSystemPrompt` gates whole sections on tool presence, the memory framing goes with it. `audit/repro-compact-snapshot.ts` drives the real Runtime and prints it:

```
compact outcome: { kind: "noop", reason: "nothing worth compacting" }
frozen tool line: - Tools: . Paths are relative to the working
next turn tool line: - Tools: . Paths are relative to the working   ← called with 6 real tools
RESULT: snapshot poisoned (empty tool list froze)
```

Two operator doors reach it — `/compact` (`tg/commands.ts:198`) and the app's **Compact now** button (`app/src/ChatView.tsx:969`) — and both answer "nothing to compact", so there's no signal. The architectural part: `RuntimeDeps.buildStep` is typed as a query but has two consumers needing different things from it, and nobody owns "who may persist the snapshot".

**2. Sink capabilities are inferred from optional-method presence, and re-declared by hand for the resume path.** `claimableCount` keys queue policy off `sink.onStreamChunk !== undefined`; `makeResumeSinks.sinkHooks` restates the same fact as a channel-keyed literal (`turn-resume.ts:119-123`) that the tool-surface drift guard is calibrated against. `turn-resume.test.ts:788/802` pin the *table*, so drift against the real sinks stays green — and drifts wrong in both directions.

**3. `titleImplicit` means opposite things per channel.** Documented as "cleared by a successful auto-title" (`conversation.ts:122-124`); `titles.ts:81` obeys that, `app-chat.ts:310`, `spinoff.ts:93` and `forkToApp` do the reverse. Three of five writers falsify the only spec of the column.

**4. The two intake pipelines share no seam** for enrichments the code itself calls channel-neutral — transcription ("the same seam tg runs"), first-burst titling ("the tg lane's implicit-topic rule"), submit-failure handling. §3 is the proof of how far one pair has already drifted.

**5. Which conversation mutations must fence in-flight turns is decided per call site** — `setMeta` vs `applySettings`, with `memoryExcluded` already written through both doors. I found no live defect, and I say so: admission-time capture absorbs it today.

§6 records what I cleared rather than reported — the claim/coalescing rule, authority threading, cache pruning, the guest lane, the "only the app channel deletes" comment, and `health.ts expectedTables` — with the reason each is intentionally narrow rather than accidentally complex.

One thing I could not check: the poisoned prompt's effect on an actual model. The tool definitions still ride the request, so the damage is a model told it has no tools plus missing framing sections — inferred from the prompt bytes, not observed against a provider.


---

---
nospec: true
id: 0046
date: 2026-08-15
status: accepted
spine: false
builds_on: [0032, 0033]
---

# 0046: Runtime Authority Is Held, Not Re-Derived at Every Boundary

> **Amendment (2026-08-19):** Telegram admission settlement is also
> concentrated in `UpdateGate`. The approved next carve replaces
> caller-released update handles with `UpdateGate.runUpdate<T>`, which consumes
> an authoritative `AdmissionResult<T>` structural decision as specified below.

## Context

Eight consecutive fix commits (5646970…99fc1cd) repaired the same two failure modes at the runtime boundary: work silently lost across an await, and work reaching the wrong runtime generation. Admission is guarded by four independent flags — Telegram tracking in `bot.ts`, intake's `admit(kind)`, `ConversationRuntimeHost.admissionOpen`, and the scheduler's `claimsOpen` — each with its own bookkeeping: three in-flight Sets plus a per-update WeakMap in `bot.ts`, thirteen live-state collections in the host, and roughly sixty `isCurrent`-flavored authority checks spread across nine modules. `TurnDispatcher.getOrCreateRunner` re-checks identity around five named checkpoints plus a final no-await triple check; the prompt queue is a spliced promise chain whose cancellation once reached the runner and poisoned the next turn; shutdown ordering lives as comments in `index.ts`.

The fences multiplied because authority is scattered: no object owns "this conversation's runtime is generation N and admitting work," so every await between a check and a use is a race window, and every window grew its own fence. The completed inward-solidification pass barred "a single-check replacement for the dispatcher's asynchronous authority fences" — correct against naive fence removal, but it also locked in re-derivation as the pattern.

Meanwhile `AgentRunner` already implements the target discipline internally: `assertCurrent()`, `awaitCurrent()`, and `guardTool()` hold one closed-over authority and compare it before and after every await. The kernel boundary is the remaining place that discipline does not reach.

The decision owner ruled on both open questions: consolidate authority into held epochs, superseding the guardrail clause; and take this cycle ahead of ACP, because ACP adds new work sources and cancellation paths into exactly this machinery — external-agent cancellation already lives inside runtime disposal.

## Decision

Runtime admission, generation identity, queueing, and disposal for a Conversation SHALL be owned by one per-conversation runtime machine behind the `ConversationRuntimeHost` port. No other module keeps parallel admission, staleness, or disposal bookkeeping for runtimes.

Authority SHALL be held as epochs and compared at commit points, not re-derived at module boundaries. An epoch is the machine's monotonic per-conversation generation, bumped on every runtime registration, creation reservation, and invalidation. Every admitted work unit captures the epoch of the authority domain it depends on: runtime work (prompts, steers, scheduled turns) captures the runtime epoch; lifecycle commands capture the binding epoch, so same-binding runtime invalidation preserves acknowledged command order while fencing stale model work; a process admission epoch fences shutdown. A commit point compares the captured and current epoch in a synchronous section — before and after awaits that cross the boundary. This is the `assertCurrent`/`awaitCurrent` discipline generalized to the kernel boundary; it is not fence removal, and the superseded guardrail clause is replaced by this commit-point obligation.

The prompt queue SHALL be an explicit entry list driven by a serial executor. Callers declare one closed work intent; the runtime machine synchronously creates, stores, checks, and settles the corresponding authority. Queue entries SHALL NOT carry caller-supplied authority predicates. The machine-generated authority is passed into admitted work so it can repeat checks around awaits. Current-runtime work is tied to the registered runner at admission, binding work survives same-binding runtime replacement, and internal-runtime work is tied to one registration so replacement fences prior tickets while the prior runner remains owned as a draining generation until disposal settles. Bootstrap work starts under current binding and queue authority, then adopts and verifies the machine's current registered runner before model or user-visible effects. Warm scheduled work uses current-runtime authority; cold scheduled work uses bootstrap authority.

Immediate/no-wait runtime work SHALL use one transport-neutral machine admission path. In one synchronous section the machine checks all queue occupancy, selects cold bootstrap or warm current-runtime authority, and either installs an accepted entry or returns an explicit busy, closed, or fenced classification. Immediate work never waits behind prompts or commands. Accepted work uses the ordinary queue settlement, fencing, drain, and shutdown lifetime; cold work adopts the current registered runner before prompt or delivery, while warm work remains tied to the runner held at admission. Ordinary cold text and media install the same machine-owned bootstrap ticket before asynchronous preparation. Invalidating a RuntimeCreation cooperatively cancels each preparation await: any underlying detached promise remains rejection-observed and cannot reach registration. Transport adapters may provide sinks and delivery closures but do not inspect runner occupancy or coordinate prompting. One-shot delivery is initiated synchronously only after the final authority commit; its observed network promise is returned with settlement and remains UpdateGate/update-handler work, not queue or runtime-disposal work.

Telegram update admission settlement SHALL be owned by `UpdateGate`, not by
callers holding a release capability. `UpdateGate.runUpdate<T>` SHALL execute
each update boundary and consume an `AdmissionResult<T>` whose authority is
partitioned: runtime/delegated-run admission or attachment operations
authoritatively report handoff or structural rejection (`busy`, `fenced`, or
generic `rejected`); the gate authoritatively reports its own closure
(`closed`); the local adapter authoritatively reports `completed` for parsing
or other work it owns with no runtime operation (malformed updates,
topic-description changes, unknown commands, and like no-runtime paths).
Adapters may map structural results but SHALL NOT invent handoff or rejection
outcomes. The gate records exactly one structural decision per update: work
was handed off to a conversation runtime or delegated run, it was structurally
rejected, or it completed without runtime work. The decision is recorded at
the authoritative admission, attachment, or adapter commit; its separately
tracked completion may await steering, one-shot Telegram delivery, or delegated
work without holding the runtime-admission drain. A throw before a decision
becomes a failed-before-decision terminal gate state, releases the gate safety
net, and propagates; a later completion failure does not rewrite an already
recorded decision. Repeated internal finalization is idempotent, but missing or
contradictory decisions fail loud. Coalesced text transfers gate-private claims
into one buffer; one merged structural decision settles the entire claim group
atomically. No string parsing determines a rejection classification.

Cancelling queued work removes the entry and SHALL NOT touch the runner. The machine SHALL express overlapping generations — a replacement reserved while a prior generation's disposal still drains — as a current generation plus a drain set, not a flat state enum.

Process shutdown SHALL be one owned phase list in one coordinator: close the Telegram gate, drain buffered text to runtime admission, start runtime disposal before awaiting the Telegram drains, then stop polling and drain subsystems in order. The causal ordering that today lives in `index.ts` comments becomes data.

Scope: this assumes one process and event-loop serialization; no cross-process coordination is introduced. Persisted formats (filesystem state version 5), Telegram-visible behavior, scheduler durability semantics, and the ownership rulings of decisions 0032, 0033, 0034, 0036, and 0045 are unchanged; the machine consumes their stores and authorities. Delegated-work durability, Surface lifecycle reachability, and inner-life remain parked.

Supersession: the second inward-solidification guardrail clause "a single-check replacement for the dispatcher's asynchronous authority fences" is superseded in full by this decision's commit-point discipline. The rest of that guardrail — no plugin registry, no dynamic tool discovery, no SQLite-only persistence, no speculative provider interfaces — stands.

Sequencing: this seam, including machine-held work authority, guest runtime
admission, and Telegram admission settlement concentration, consolidates
before ACP lands under decision 0044. Settlement concentration is the next
bounded cycle.

## Consequences

The recurring bug classes become structurally impossible or trivially visible: cancel can no longer reach a runner, admission settlement can no longer leak (one terminal decision settles per gate-owned claim, and repeated internal finalization is idempotent), promise-chain splicing disappears, and shutdown ordering becomes testable data instead of comment archaeology. The machine's transitions are enumerable, so seeded interleaving tests can assert what prose cannot: no work executes after its epoch bumps, no ticket leaks, shutdown always terminates.

The cost concentrates in test migration, not production code: roughly 6,200 lines of choreography tests across five suites pin current behavior, and each suite's intent must survive the reduction of scattered checks to epoch commits. The expected net effect on production code is deletion — drains, meta flags, retry loops, and the steer observation window go away.

The binding-epoch axis keeps preserved-command semantics without preserving stale runners: `/model` mid-queue keeps its acknowledged order across invalidation, while a concurrent `/resume` drops queued commands as stale — both pinned by existing tests that must survive. `ConversationRuntimeHost`'s public port stays; dispatcher, lifecycle, scheduler, and bot migrate atomically with the interface change per repository practice. Telemetry keeps structured identity (conversation, surface, generation) at every transition, per the fail-loud rule.

// The attempt's terminal rails (design/runtime-turn.md → The attempt
// loop): what an attempt that threw does next — journal fault, fence,
// overflow resume, model fallback, or terminal error. The runtime picks
// the rail; each rail reads only the named scope below — no Runtime, no
// lane, no captured local.

import type { CompactionOutcome } from "./agent/compaction.ts";
import {
	exhaustedMessage,
	type FallbackMiss,
	failureClass,
	missReason,
} from "./agent/model-fallback.ts";
import {
	isContentFilter,
	isContextOverflow,
	isTransientTurnFailure,
	quotaExhausted,
} from "./agent/provider-errors.ts";
import { log } from "./log.ts";
import type { ClaimedTurn } from "./runtime-lanes.ts";
import type { AdmissionSnapshot } from "./turn/admission.ts";
import {
	type ContextOverflowError,
	PreemptCompactError,
	recoverFromOverflow,
	type TurnRecovery,
	terminalFailureMessage,
} from "./turn/overflow.ts";
import type { RunRecord } from "./turn/run-record.ts";
import type { TurnDone } from "./turn/sink.ts";
import type { TurnState } from "./turn/state.ts";
import { emitChunk, type LiveChunks } from "./turn/stream.ts";
import type { ToolAuthority } from "./turn/tool-authority.ts";
import { replyFromWire } from "./turn/unlanded-progress.ts";
import type { TurnJournal } from "./turn-journal.ts";

// Terminal outcomes have settled their sinks; continuations carry
// recovery and membership into the next attempt. Membership is data on
// the decision, not a closure over a queue that may have changed.
export type AttemptOutcome =
	| { kind: "done" }
	| { kind: "resume"; recovery: TurnRecovery; turns: ClaimedTurn[] };

export type AttemptRecall = NonNullable<TurnRecovery["memory"]>;

// What the attempt learned on its way to a landing. Each field is
// written where it becomes true; a rail reads whatever was reached
// before the throw.
export interface AttemptProgress {
	// Recall's result once it ran. An overflow or fallback resume reuses
	// it: reissuing recall would spend memory quota twice for one
	// logical turn.
	memory: AttemptRecall;
	// The tool authority seam once opened — it holds the run id and the
	// ownership-begun fact.
	authority: ToolAuthority | undefined;
	// The filter retry budget, carried into a possible continuation.
	filterRetryUsed: boolean;
	// Set when the engine withheld a zero-effect error off the wire for
	// a possible fallback; the error rail emits it if none follows.
	errorHeld: boolean;
}

// One attempt from admission to its terminal stamp, as the rails see it.
export interface AttemptScope {
	convId: string;
	// The members. A steer that joins mid-run is pushed here, so every
	// terminal notification reaches it.
	turns: ClaimedTurn[];
	recovery: TurnRecovery | undefined;
	// Spans all attempts of the logical turn and its late subscribers.
	live: LiveChunks;
	snapshot: AdmissionSnapshot;
	recallVersion: number | null;
	// Admission's owned inputs plus recovery's; the engine adds folded steers.
	ownedInputSeqs: Set<number>;
	admissionExchangeExcluded: boolean;
	state: TurnState;
	controller: AbortController;
	record: RunRecord;
	journal: TurnJournal | undefined;
	progress: AttemptProgress;
	sourceInputSeq(): number | null;
	// The live wire's end and every member's one terminal notification.
	notifyAll(done: TurnDone): Promise<void>;
	announcePreRunFailure(err: unknown): void;
	shuttingDown(): boolean;
	compact(reason: "overflow" | "preempt"): Promise<CompactionOutcome>;
	checkAuthority(): void;
	holdsAuthority(): boolean;
}

// The aborted outcome's cause: a shutdown fence must read as a
// restart, not an operator stop. Other fences have several sources
// (stop, settings change, correction, navigation roll) — the wording
// stays neutral rather than naming one that may not apply.
function fencedCause(a: AttemptScope): string {
	return a.shuttingDown()
		? "the process was shutting down"
		: "stopped by /stop, superseded by a settings change, or fenced by an operator action";
}

// The crash journal is the only record of what the turn's tools did —
// when it cannot write, the turn dies as an error (never 'fenced', never
// completed, never a fallback advance) so no reported failure can invite
// a repeat of an unjournaled effect.
export async function journalFaultRail(a: AttemptScope, fault: unknown): Promise<AttemptOutcome> {
	a.controller.abort();
	log.error("turn aborted — the turn journal cannot write", fault, {
		conversation: a.convId,
		epoch: a.snapshot.epoch,
	});
	a.announcePreRunFailure(fault);
	a.record.stampRun("error", "failed");
	await a.notifyAll({
		kind: "error",
		message: terminalFailureMessage(fault, a.recovery !== undefined),
		modelCalls: a.state.snapshot().modelCalls,
	});
	return { kind: "done" };
}

export async function fencedRail(a: AttemptScope, err: unknown): Promise<AttemptOutcome> {
	// Abort even an epoch-fenced provider call; otherwise it may keep
	// generating into an abandoned stream and consume provider capacity.
	a.controller.abort();
	log.info("turn fenced", { conversation: a.convId, epoch: a.snapshot.epoch, error: String(err) });
	a.announcePreRunFailure(err);
	if (a.shuttingDown()) {
		// #471 — a shutdown fence is a crash for the journal: the row
		// stays 'running' and nothing is recorded here. The next open
		// reclassifies it 'interrupted' and records its unlanded
		// progress in the same transaction — the boot notice and
		// the history record both reach it (#594).
		a.record.leaveRunning();
	} else {
		// What already ran stays transcript — the sanctioned post-fence
		// state write, before the stamp wake settling reads.
		a.record.recordUnlandedProgress(
			{ kind: "aborted", cause: fencedCause(a) },
			await replyFromWire(a.live.chunks),
		);
		a.record.stampRun("fenced", "undelivered");
	}
	await a.notifyAll({ kind: "fenced" });
	return { kind: "done" };
}

// Recover once: compact the failed attempt and resume with its partial
// so completed tools are not repeated. A second overflow follows the
// terminal error path. The failed attempt's run id rides the recovery:
// the continuation's row inherits its settled calls.
export async function overflowRail(
	a: AttemptScope,
	err: ContextOverflowError,
): Promise<AttemptOutcome> {
	const { conv, epoch, turnStartMs } = a.snapshot;
	const outcome = await recoverFromOverflow({
		convId: a.convId,
		epoch,
		failure: err,
		conversation: conv,
		memory: a.progress.memory,
		startedAt: turnStartMs,
		live: a.live,
		filterRetryUsed: a.progress.filterRetryUsed,
		failedRunId: a.progress.authority?.runId,
		recallVersion: a.recallVersion,
		sourceInputSeq: a.sourceInputSeq(),
		members: a.turns,
		compact: () => a.compact(err instanceof PreemptCompactError ? "preempt" : "overflow"),
		assertAuthority: a.checkAuthority,
		holdsAuthority: a.holdsAuthority,
		signal: a.controller.signal,
	});
	if (outcome.kind === "resume") {
		// This attempt's row is done — the stream failed and its
		// output was withheld for recovery; the resume opens a
		// fresh row that inherits this row's settled calls, so a
		// crash of the continuation still resumes with them.
		// No pre-run announcement: the fresh run links its members
		// through its own begin.
		a.record.stampRun("error", "undelivered");
		outcome.recovery.ownedInputSeqs = [...a.ownedInputSeqs];
		outcome.recovery.admissionExchangeExcluded = a.admissionExchangeExcluded;
		// The continuation stays on the serving candidate and keeps
		// its fallback story (run-row configured ref, finish note).
		outcome.recovery.fallback = a.record.fallback.trail;
		return { kind: "resume", recovery: outcome.recovery, turns: outcome.members };
	}
	if (outcome.kind === "error") {
		a.record.recordUnlandedProgress(
			{ kind: "failed", failure: outcome.message },
			await replyFromWire(a.live.chunks),
		);
	} else if (outcome.kind === "fenced" && !a.shuttingDown()) {
		// A fence landing during recovery is still a fence: the
		// attempt's completed work stays transcript. A shutdown
		// fence skips the record — the next open's interrupted
		// rail owns it (#471).
		a.record.recordUnlandedProgress(
			{ kind: "aborted", cause: fencedCause(a) },
			await replyFromWire(a.live.chunks),
		);
	}
	a.announcePreRunFailure(err);
	if (outcome.kind === "fenced" && a.shuttingDown()) {
		a.record.leaveRunning();
	} else {
		a.record.stampRun(
			outcome.kind === "fenced" ? "fenced" : "error",
			outcome.kind === "fenced" ? "undelivered" : "failed",
		);
	}
	await a.notifyAll(
		outcome.kind === "fenced" ? { kind: "fenced" } : { kind: "error", message: outcome.message },
	);
	return { kind: "done" };
}

// Any other escaping error: the model fallback walk when it may
// advance, else the terminal error.
export async function errorRail(a: AttemptScope, err: unknown): Promise<AttemptOutcome> {
	const { convId, recovery, turns, live, state, record } = a;
	const { conv, turnStartMs } = a.snapshot;
	const { fallback } = record;
	// Abort provider work on any escaping error, not only on fencing; the
	// stream may still be producing after the chunk loop unwinds.
	a.controller.abort();
	// Zero effect: no model call completed and no tool was
	// dispatched under this run (design/model.md → Model fallback
	// list — openclaw's canFallbackAfterError gate). The probe is
	// a journal read: if it throws, the turn ends as a journal
	// fault before any fallback is considered.
	let journaledCalls = 0;
	try {
		const { journal } = a;
		const authority = a.progress.authority;
		if (journal !== undefined && authority !== undefined) {
			const id = authority.runId;
			journaledCalls = record.journaled(() => journal.callsFor(id)).length;
		}
	} catch (probeErr) {
		log.error("fallback gate could not read the turn journal", probeErr, {
			conversation: convId,
			cause: err instanceof Error ? err.message : String(err),
		});
		return await journalFaultRail(a, probeErr);
	}
	const zeroEffect = state.snapshot().modelCalls === 0 && journaledCalls === 0;
	// Quota is logged as its own class so a missing retry explains
	// itself: the scheduler ladder only re-fires transient failures.
	const quota = quotaExhausted(err);
	const errClass = failureClass(err);
	const miss: FallbackMiss = {
		ref: conv.model ?? "(no model)",
		reason: missReason(err),
		transient: isTransientTurnFailure(err),
	};
	// A content-filtered request already spent its one same-model
	// retry; the filter rule ends the turn, it never moves the
	// blocked request to another lane. Context overflow is never
	// a trigger either — it reaches here only when compaction is
	// not wired (no recovery to hand it to), and another lane
	// would face the same history (design/model.md).
	const next =
		zeroEffect && !isContentFilter(err) && !isContextOverflow(err) ? fallback.next() : undefined;
	if (next !== undefined && fallback.configured !== null) {
		log.warn("model fallback", {
			conversation: convId,
			from: miss.ref,
			to: next,
			failureClass: errClass,
			...(quota?.resetAt !== undefined ? { quotaResetAt: quota.resetAt } : {}),
			attempt: fallback.misses.length + 1,
			error: err instanceof Error ? err.message : String(err),
		});
		// Same hand-off as an overflow resume: this row ends
		// undelivered and the successor inherits it (it holds no
		// calls — zero effect — but owns the members' wakes).
		record.stampRun("error", "undelivered");
		return {
			kind: "resume",
			recovery: {
				conversation: { ...conv, model: next },
				partial: null,
				memory: a.progress.memory,
				seenText: false,
				toolCalls: [],
				digest: [],
				loop: state.snapshot(),
				startedAt: turnStartMs,
				live,
				filterRetryUsed: a.progress.filterRetryUsed,
				predecessorRun: a.progress.authority?.runId,
				recallVersion: a.recallVersion,
				sourceInputSeq: a.sourceInputSeq(),
				ownedInputSeqs: [...a.ownedInputSeqs],
				admissionExchangeExcluded: a.admissionExchangeExcluded,
				fallback: { configured: fallback.configured, tried: [...fallback.misses, miss] },
			},
			turns,
		};
	}
	// Only a fresh attempt's failure ends the walk; a
	// continuation failing reports its own error.
	const misses = fallback.fresh ? [...fallback.misses, miss] : [miss];
	log.error("turn failed", err, {
		conversation: convId,
		failureClass: errClass,
		...(quota?.resetAt !== undefined ? { quotaResetAt: quota.resetAt } : {}),
		...(misses.length > 1 ? { fallbacksTried: misses.map((m) => m.ref) } : {}),
	});
	// The stamps are what lets a trigger owner (a schedule fire) tell
	// a zero-call transport blip from a failure the provider already
	// spent work on; other error paths stay unstamped. After a
	// fallback walk, transient means every candidate's was.
	const done: TurnDone = {
		kind: "error",
		message:
			misses.length > 1
				? exhaustedMessage(misses)
				: terminalFailureMessage(err, recovery !== undefined),
		modelCalls: state.snapshot().modelCalls,
		transient: misses.every((m) => m.transient),
	};
	// A withheld error never reached the wire — the terminal
	// story goes out now, before the sinks settle.
	if (a.progress.errorHeld) emitChunk(convId, turns, live, { type: "error", errorText: done.message });
	record.recordUnlandedProgress({ kind: "failed", failure: done.message }, await replyFromWire(live.chunks));
	a.announcePreRunFailure(err);
	record.stampRun("error", "failed");
	await a.notifyAll(done);
	return { kind: "done" };
}

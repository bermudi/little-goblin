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

export type AttemptOutcome =
	| { kind: "done" }
	| { kind: "resume"; recovery: TurnRecovery; turns: ClaimedTurn[] };

export type AttemptRecall = NonNullable<TurnRecovery["memory"]>;

export interface AttemptProgress {
	memory: AttemptRecall;
	authority: ToolAuthority | undefined;
	filterRetryUsed: boolean;
	errorHeld: boolean;
}

export interface AttemptScope {
	convId: string;
	turns: ClaimedTurn[];
	recovery: TurnRecovery | undefined;
	live: LiveChunks;
	snapshot: AdmissionSnapshot;
	recallVersion: number | null;
	ownedInputSeqs: Set<number>;
	admissionExchangeExcluded: boolean;
	state: TurnState;
	controller: AbortController;
	record: RunRecord;
	journal: TurnJournal | undefined;
	progress: AttemptProgress;
	sourceInputSeq(): number | null;
	notifyAll(done: TurnDone): Promise<void>;
	announcePreRunFailure(err: unknown): void;
	shuttingDown(): boolean;
	compact(reason: "overflow" | "preempt"): Promise<CompactionOutcome>;
	checkAuthority(): void;
	holdsAuthority(): boolean;
}

function fencedCause(a: AttemptScope): string {
	return a.shuttingDown()
		? "the process was shutting down"
		: "stopped by /stop, superseded by a settings change, or fenced by an operator action";
}

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
	a.controller.abort();
	log.info("turn fenced", { conversation: a.convId, epoch: a.snapshot.epoch, error: String(err) });
	a.announcePreRunFailure(err);
	if (a.shuttingDown()) {
		a.record.leaveRunning();
	} else {
		a.record.recordUnlandedProgress(
			{ kind: "aborted", cause: fencedCause(a) },
			await replyFromWire(a.live.chunks),
		);
		a.record.stampRun("fenced", "undelivered");
	}
	await a.notifyAll({ kind: "fenced" });
	return { kind: "done" };
}

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
		a.record.stampRun("error", "undelivered");
		outcome.recovery.ownedInputSeqs = [...a.ownedInputSeqs];
		outcome.recovery.admissionExchangeExcluded = a.admissionExchangeExcluded;
		outcome.recovery.fallback = a.record.fallback.trail;
		return { kind: "resume", recovery: outcome.recovery, turns: outcome.members };
	}
	if (outcome.kind === "error") {
		a.record.recordUnlandedProgress(
			{ kind: "failed", failure: outcome.message },
			await replyFromWire(a.live.chunks),
		);
	} else if (outcome.kind === "fenced" && !a.shuttingDown()) {
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

export async function errorRail(a: AttemptScope, err: unknown): Promise<AttemptOutcome> {
	const { convId, recovery, turns, live, state, record } = a;
	const { conv, turnStartMs } = a.snapshot;
	const { fallback } = record;
	a.controller.abort();
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
	const quota = quotaExhausted(err);
	const errClass = failureClass(err);
	const miss: FallbackMiss = {
		ref: conv.model ?? "(no model)",
		reason: missReason(err),
		transient: isTransientTurnFailure(err),
	};
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
	const misses = fallback.fresh ? [...fallback.misses, miss] : [miss];
	log.error("turn failed", err, {
		conversation: convId,
		failureClass: errClass,
		...(quota?.resetAt !== undefined ? { quotaResetAt: quota.resetAt } : {}),
		...(misses.length > 1 ? { fallbacksTried: misses.map((m) => m.ref) } : {}),
	});
	const done: TurnDone = {
		kind: "error",
		message:
			misses.length > 1
				? exhaustedMessage(misses)
				: terminalFailureMessage(err, recovery !== undefined),
		modelCalls: state.snapshot().modelCalls,
		transient: misses.every((m) => m.transient),
	};
	if (a.progress.errorHeld) emitChunk(convId, turns, live, { type: "error", errorText: done.message });
	record.recordUnlandedProgress({ kind: "failed", failure: done.message }, await replyFromWire(live.chunks));
	a.announcePreRunFailure(err);
	record.stampRun("error", "failed");
	await a.notifyAll(done);
	return { kind: "done" };
}

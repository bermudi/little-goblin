// The attempt's journal run row — fault box, terminal stamp, unlanded-progress record — plus the model-fallback config the attempt serves; the run id, store, and ownership hooks stay injected.

import type { UIMessage } from "ai";
import {
	candidateRefs,
	type FallbackMiss,
	type FallbackTrail,
	nextCandidate,
} from "../agent/model-fallback.ts";
import type { ConversationStore } from "../conversation.ts";
import { log } from "../log.ts";
import type { TurnJournal } from "../turn-journal.ts";
import type { TurnRecovery } from "./overflow.ts";
import type { RunOwnershipHooks } from "./run-ownership.ts";
import {
	renderUnlandedTurnProgress,
	type UnlandedOutcome,
	unlandedProgressEvent,
} from "./unlanded-progress.ts";

// design/model.md → Model fallback list, resolved for this attempt.
export interface RunRecordFallback {
	// The trail an overflow continuation keeps; a fresh attempt has none.
	trail: FallbackTrail | undefined;
	// The operator's selection when a fallback serves — the resume drift
	// check compares this; resume runs on `model`.
	configured: string | null;
	// Only a fresh turn walks the list.
	fresh: boolean;
	misses: FallbackMiss[];
	next(): string | undefined;
}

export interface RunRecord {
	// A thrown journal write anywhere in the fence lands here — the
	// attempt's catch aborts the turn instead of letting the SDK report a
	// tool error the model could retry.
	readonly journalFault: { current: unknown };
	// The attempt's own journal reads and writes (run creation, the
	// recovery-guard read, the fallback gate's probe) classify a throw
	// exactly like a fenced tool's: a journal fault, never a model
	// failure — so it never advances the fallback walk.
	journaled<T>(op: () => T): T;
	stampRun(
		status: "fenced" | "completed" | "error",
		delivery: "delivered" | "undelivered" | "failed",
	): void;
	// A shutdown fence leaves the row 'running' on purpose (#471): for
	// the journal a graceful restart IS process death, so the next open
	// reclassifies it 'interrupted' and records its unlanded progress
	// itself — boot notices, /interrupted and /resume all reach it.
	// Seals the record so the attempt's finally guard cannot stamp over
	// the deliberate 'running'; no ownership end either — there is no
	// terminal stamp for the dispatcher to settle off.
	leaveRunning(): void;
	// `reply` is the wire-streamed partial (replyFromWire) — it donates
	// the event's id and rides its metadata; null when nothing streamed.
	recordUnlandedProgress(outcome: UnlandedOutcome, reply: UIMessage | null): void;
	// The reply landed durably — a failure past it must not also record a
	// progress event (the final reply is the record).
	markReplyLanded(): void;
	readonly fallback: RunRecordFallback;
}

export interface RunRecordDeps {
	journal: TurnJournal | undefined;
	store: ConversationStore;
	runOwnership?: RunOwnershipHooks | undefined;
	modelFallbacks?: (() => readonly string[]) | undefined;
	convId: string;
	epoch: number;
	convModel: string | null;
	recovery: TurnRecovery | undefined;
	// The engine's owned-input folds mutate this set; the unlanded-progress
	// anchor reads it at terminal time.
	ownedInputSeqs: Set<number>;
	// The attempt's run row — null until beginRun landed.
	runId(): string | null;
}

// The crash journal's per-attempt state: a fresh runId per attempt (an
// overflow resume opens a second row — the failed attempt keeps its own
// record), stamped terminal exactly once. The attempt's finally guard is
// the invariant's backstop: a begun row never escapes the attempt still
// 'running', whatever the escape path — except a shutdown fence, whose
// leaveRunning is the deliberate exception (#471).
export function openRunRecord(deps: RunRecordDeps): RunRecord {
	const { journal, store, convId, epoch, convModel, recovery, ownedInputSeqs } = deps;
	// design/model.md → Model fallback list. Only a fresh turn walks the
	// list: an operator resume, an overflow continuation, or anything
	// carrying a partial or prior tool calls stays on its model (never
	// mid-loop). A fallback attempt's recovery is fresh by construction.
	const trail: FallbackTrail | undefined = recovery?.fallback;
	const configured = trail?.configured ?? convModel;
	const fresh =
		recovery === undefined ||
		(trail !== undefined &&
			recovery.partial === null &&
			recovery.toolCalls.length === 0 &&
			recovery.resumedFrom === undefined &&
			recovery.overflowed !== true &&
			recovery.operatorRequest === undefined);
	const misses: FallbackMiss[] = trail?.tried ?? [];
	const fallback: RunRecordFallback = {
		trail,
		configured,
		fresh,
		misses,
		next: () => {
			if (!fresh || convModel === null || configured === null) return undefined;
			const list = deps.modelFallbacks?.() ?? [];
			if (list.length === 0) return undefined;
			return nextCandidate(candidateRefs(configured, list), [
				...misses.map((m) => m.ref),
				convModel,
			]);
		},
	};
	const journalFault: { current: unknown } = { current: undefined };
	const journaled = <T>(op: () => T): T => {
		try {
			return op();
		} catch (err) {
			if (journalFault.current === undefined) journalFault.current = err;
			throw err;
		}
	};
	// True once the row's fate is decided: stamped terminal, or left
	// 'running' on purpose by a shutdown fence. Both suppress the
	// attempt's finally guard — the second is the one 'running' a begun
	// row may legitimately escape with.
	let runStamped = false;
	const stampRun = (
		status: "fenced" | "completed" | "error",
		delivery: "delivered" | "undelivered" | "failed",
	) => {
		const id = deps.runId();
		if (journal === undefined || id === null || runStamped) return;
		journal.finishRun(id, status, delivery);
		runStamped = true;
		// The terminal stamp IS the durable acknowledgement a wake
		// waits on — the hook fires after the row lands so the
		// dispatcher's settle read never sees a live run by mistake.
		deps.runOwnership?.end(id, status, delivery);
	};
	// design/runtime-turn.md → Unlanded-turn progress: one system event
	// recording what a journaled turn whose reply never landed completed
	// — terminal error, fence, or (at journal open) process death — so
	// the next turn does not lose the work. Must run BEFORE the terminal
	// stamp — the stamp is what wake settling reads — and stays silent
	// when the reply already landed or nothing survived. The failed
	// outcome keeps its authority silence; the aborted one records past
	// the fence — that is its point (the sanctioned post-fence state
	// write, like the ⏹ superseded display stamp). An append failure
	// never changes the outcome.
	let replyLanded = false;
	const recordUnlandedProgress = (outcome: UnlandedOutcome, reply: UIMessage | null): void => {
		const id = deps.runId();
		if (journal === undefined || id === null || runStamped || replyLanded) return;
		if (outcome.kind === "failed" && store.get(convId)?.epoch !== epoch) return;
		try {
			const rendered = renderUnlandedTurnProgress({
				runId: id,
				outcome,
				calls: journal.callsFor(id),
				partial: journal.get(id)?.partial ?? null,
				reply,
			});
			if (rendered === null) return;
			// Anchored to the latest input this attempt consumed (folded steers
			// included, merely queued ones never) — the same value a completed
			// reply derives as finalAnchor — so editing a later input keeps it.
			let consumedAnchor: number | null = null;
			for (const seq of ownedInputSeqs) {
				if (consumedAnchor === null || seq > consumedAnchor) consumedAnchor = seq;
			}
			const event = unlandedProgressEvent(rendered.text, {
				kind: outcome.kind,
				runId: id,
				reply,
			});
			store.append(convId, [event], {
				anchorSeq: consumedAnchor,
			});
			log.info("unlanded-turn progress recorded", {
				outcome: outcome.kind,
				anchorSeq: consumedAnchor,
				conversation: convId,
				run: id,
				calls: rendered.calls,
				unknown: rendered.unknown,
				textChars: rendered.textChars,
				replyParts: reply?.parts.length ?? 0,
				eventId: event.id,
			});
		} catch (err) {
			log.error("unlanded-turn progress record failed — outcome still delivered", err, {
				conversation: convId,
				run: id,
				outcome: outcome.kind,
			});
		}
	};
	return {
		journalFault,
		journaled,
		stampRun,
		leaveRunning: () => {
			runStamped = true;
		},
		recordUnlandedProgress,
		markReplyLanded: () => {
			replyLanded = true;
		},
		fallback,
	};
}

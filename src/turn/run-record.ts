// The attempt's journal run row — fault box, terminal stamp, failed-progress record — plus the model-fallback config the attempt serves; the run id, store, and ownership hooks stay injected.

import { randomUUID } from "node:crypto";
import {
	candidateRefs,
	type FallbackMiss,
	type FallbackTrail,
	nextCandidate,
} from "../agent/model-fallback.ts";
import type { ConversationStore } from "../conversation.ts";
import { log } from "../log.ts";
import type { RuntimeDeps } from "../runtime.ts";
import { renderFailedTurnProgress } from "./failed-progress.ts";
import type { TurnRecovery } from "./overflow.ts";
import type { TurnJournal } from "../turn-journal.ts";

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
	recordFailedProgress(failure: string): void;
	// The reply landed durably — a failure past it must not also record a
	// progress event (the final reply is the record).
	markReplyLanded(): void;
	readonly fallback: RunRecordFallback;
}

export interface RunRecordDeps {
	journal: TurnJournal | undefined;
	store: ConversationStore;
	runOwnership?: RuntimeDeps["runOwnership"];
	modelFallbacks?: RuntimeDeps["modelFallbacks"];
	convId: string;
	epoch: number;
	convModel: string | null;
	recovery: TurnRecovery | undefined;
	// The engine's owned-input folds mutate this set; the failed-progress
	// anchor reads it at terminal time.
	ownedInputSeqs: Set<number>;
	// The attempt's run row — null until beginRun landed.
	runId(): string | null;
}

// The crash journal's per-attempt state: a fresh runId per attempt (an
// overflow resume opens a second row — the failed attempt keeps its own
// record), stamped terminal exactly once. The attempt's finally guard is
// the invariant's backstop: a begun row never escapes the attempt still
// 'running', whatever the escape path.
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
	// design/runtime-turn.md → Failed-turn progress: one system event
	// recording what a terminally failed journaled turn completed, so the
	// next turn does not lose the work. Must run BEFORE the terminal
	// stamp — the stamp is what wake settling reads — and stays silent
	// when the reply already landed, nothing survived, or this attempt
	// lost authority. An append failure never changes the outcome.
	let replyLanded = false;
	const recordFailedProgress = (failure: string): void => {
		const id = deps.runId();
		if (journal === undefined || id === null || runStamped || replyLanded) return;
		if (store.get(convId)?.epoch !== epoch) return;
		try {
			const rendered = renderFailedTurnProgress({
				runId: id,
				failure,
				calls: journal.callsFor(id),
				partial: journal.get(id)?.partial ?? null,
			});
			if (rendered === null) return;
			// Anchored to the latest input this attempt consumed (folded steers
			// included, merely queued ones never) — the same value a completed
			// reply derives as finalAnchor — so editing a later input keeps it.
			let consumedAnchor: number | null = null;
			for (const seq of ownedInputSeqs) {
				if (consumedAnchor === null || seq > consumedAnchor) consumedAnchor = seq;
			}
			store.append(
				convId,
				[{ id: randomUUID(), role: "system", parts: [{ type: "text", text: rendered.text }] }],
				{ anchorSeq: consumedAnchor },
			);
			log.info("failed-turn progress recorded", {
				anchorSeq: consumedAnchor,
				conversation: convId,
				run: id,
				calls: rendered.calls,
				unknown: rendered.unknown,
				textChars: rendered.textChars,
			});
		} catch (err) {
			log.error("failed-turn progress record failed — failure still delivered", err, {
				conversation: convId,
				run: id,
			});
		}
	};
	return {
		journalFault,
		journaled,
		stampRun,
		recordFailedProgress,
		markReplyLanded: () => {
			replyLanded = true;
		},
		fallback,
	};
}

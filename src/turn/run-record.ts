import type { Message } from "../message.ts";
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

export interface RunRecordFallback {
	trail: FallbackTrail | undefined;
	configured: string | null;
	fresh: boolean;
	misses: FallbackMiss[];
	next(): string | undefined;
}

export interface RunRecord {
	readonly journalFault: { current: unknown };
	journaled<T>(op: () => T): T;
	stampRun(
		status: "fenced" | "completed" | "error",
		delivery: "delivered" | "undelivered" | "failed",
	): void;
	leaveRunning(): void;
	recordUnlandedProgress(outcome: UnlandedOutcome, reply: Message | null): void;
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
	ownedInputSeqs: Set<number>;
	runId(): string | null;
}

export function openRunRecord(deps: RunRecordDeps): RunRecord {
	const { journal, store, convId, epoch, convModel, recovery, ownedInputSeqs } = deps;
	const trail: FallbackTrail | undefined = recovery?.fallback;
	const configured = trail?.configured ?? convModel;
	const fresh =
		recovery === undefined ||
		(trail !== undefined &&
			recovery.partial === null &&
			recovery.toolCalls.length === 0 &&
			recovery.overflowed !== true);
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
		deps.runOwnership?.end(id, status, delivery);
	};
	let replyLanded = false;
	const recordUnlandedProgress = (outcome: UnlandedOutcome, reply: Message | null): void => {
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

import type { Message } from "./message.ts";
import type { CompactionOutcome } from "./agent/compaction.ts";
import type { Conversation } from "./conversation-read.ts";
import { log } from "./log.ts";
import type { TurnSink } from "./turn/sink.ts";
import { endLive, type LiveChunks } from "./turn/stream.ts";

export interface QueuedTurn {
	seq: number | null;
	pending?: { id: string; mode: "steer" | "followUp" };
	message: Message;
	sink: TurnSink;
	doneSent: boolean;
	streamFailed?: boolean;
	release?: (() => void) | undefined;
}

export type ClaimedTurn = Omit<QueuedTurn, "seq" | "pending"> & { seq: number };

export interface QueuedCompact {
	conv: Conversation;
	reason: "manual" | "idle";
	focus?: string | undefined;
	resolve: (outcome: CompactionOutcome) => void;
	reject: (err: unknown) => void;
}

export type ConversationEvent =
	| { type: "turn-start" }
	| { type: "turn-end" }
	| { type: "pending" }
	| { type: "rewound"; messageId: string; replacedBy: string };

interface Lane {
	pending: QueuedTurn[];
	compacts: QueuedCompact[];
	running: boolean;
	controller: AbortController | null;
	compactController: AbortController | null;
	draining: Promise<void> | null;
	live: LiveChunks | null;
	admitted: Map<string, QueuedTurn[]>;
	activeTurn: Promise<void> | null;
}

function claimableCount(pending: QueuedTurn[], headStreams: boolean, headLeads: boolean): number {
	const start = headLeads ? 1 : 0;
	if (headStreams) return pending.length;
	const first = pending.findIndex((t, i) => i >= start && t.sink.delivery === "stream");
	return first === -1 ? pending.length : Math.min(pending.length, first);
}

function claimPending(
	lane: Lane,
	headStreams: boolean,
	headLeads = true,
	stopAtFollowUp = false,
): QueuedTurn[] {
	const count = claimableCount(lane.pending, headStreams, headLeads);
	if (!stopAtFollowUp) return lane.pending.splice(0, count);

	const prefix = lane.pending.splice(0, count);
	const claimed = prefix.filter((turn) => turn.pending?.mode !== "followUp");
	const followUps = prefix.filter((turn) => turn.pending?.mode === "followUp");
	lane.pending.unshift(...followUps);
	return claimed;
}

function hasClaimable(lane: Lane, headStreams: boolean): boolean {
	const count = claimableCount(lane.pending, headStreams, false);
	return lane.pending
		.slice(0, count)
		.some((turn) => turn.pending?.mode !== "followUp");
}

export class LaneRegistry {
	private lanes = new Map<string, Lane>();
	private subscribers = new Map<string, Set<(event: ConversationEvent) => void>>();

	subscribeConversation(convId: string, listener: (event: ConversationEvent) => void): () => void {
		let listeners = this.subscribers.get(convId);
		if (listeners === undefined) {
			listeners = new Set();
			this.subscribers.set(convId, listeners);
		}
		listeners.add(listener);
		return () => {
			listeners!.delete(listener);
			if (listeners!.size === 0) this.subscribers.delete(convId);
		};
	}

	emitConversation(convId: string, event: ConversationEvent): void {
		for (const listener of this.subscribers.get(convId) ?? []) {
			try {
				listener(event);
			} catch (err) {
				log.warn("conversation event listener failed", err, { conversation: convId, event: event.type });
			}
		}
	}

	conversationSubscriberCount(convId: string): number {
		return this.subscribers.get(convId)?.size ?? 0;
	}

	private lane(convId: string): Lane {
		let l = this.lanes.get(convId);
		if (!l) {
			l = {
				pending: [],
				compacts: [],
				running: false,
				controller: null,
				compactController: null,
				draining: null,
				live: null,
				admitted: new Map(),
				activeTurn: null,
			};
			this.lanes.set(convId, l);
		}
		return l;
	}

	beginDrain(convId: string): boolean {
		const lane = this.lane(convId);
		if (lane.running) return false;
		lane.running = true;
		return true;
	}

	endDrain(convId: string): void {
		const lane = this.lanes.get(convId)!;
		lane.running = false;
		lane.controller = null;
		lane.draining = null;
		if (lane.live !== null && !lane.live.ended) {
			log.error("live chunk log never ended — closing attach streams", undefined, {
				conversation: convId,
			});
			endLive(lane.live, { kind: "error", message: "turn ended without an outcome" }, convId);
		}
		lane.live = null;
		if (lane.pending.length === 0 && lane.compacts.length === 0) this.lanes.delete(convId);
	}

	startDraining(convId: string, begin: () => Promise<void>): void {
		const lane = this.lane(convId);
		if (!lane.running) lane.draining = begin();
	}

	enqueue(convId: string, turn: QueuedTurn): void {
		const lane = this.lane(convId);
		turn.release = () => {
			const holders = lane.admitted.get(turn.message.id);
			if (holders === undefined) return;
			const index = holders.indexOf(turn);
			if (index !== -1) holders.splice(index, 1);
			if (holders.length === 0) lane.admitted.delete(turn.message.id);
		};
		lane.pending.push(turn);
		const holders = lane.admitted.get(turn.message.id);
		if (holders === undefined) lane.admitted.set(turn.message.id, [turn]);
		else holders.push(turn);
	}

	enqueueCompact(job: QueuedCompact): void {
		this.lane(job.conv.id).compacts.push(job);
	}

	headStreams(convId: string): boolean {
		const lane = this.lane(convId);
		return lane.pending[0]?.sink.delivery === "stream";
	}

	claim(
		convId: string,
		headStreams: boolean,
		headLeads: boolean,
		onClaim: (turns: QueuedTurn[]) => void,
		stopAtFollowUp?: boolean,
	): ClaimedTurn[];
	claim(
		convId: string,
		headStreams: boolean,
		headLeads?: boolean,
	): QueuedTurn[];
	claim(
		convId: string,
		headStreams: boolean,
		headLeads = true,
		onClaim?: (turns: QueuedTurn[]) => void,
		stopAtFollowUp = false,
	): ClaimedTurn[] | QueuedTurn[] {
		const lane = this.lane(convId);
		const original = lane.pending.slice();
		const turns = claimPending(lane, headStreams, headLeads, stopAtFollowUp);
		try {
			onClaim?.(turns);
			if (onClaim !== undefined) {
				for (const turn of turns) {
					if (turn.seq === null || turn.pending !== undefined) {
						throw new Error(
							`lane claim did not materialize pending input ${turn.pending?.id ?? "?"}`,
						);
					}
				}
			}
		} catch (err) {
			lane.pending.splice(0, lane.pending.length, ...original);
			throw err;
		}
		if (onClaim === undefined) return turns;
		return turns as ClaimedTurn[];
	}

	removePending(convId: string, id: string): { turn: QueuedTurn; index: number } | null {
		const lane = this.lanes.get(convId);
		if (lane === undefined) return null;
		const index = lane.pending.findIndex((turn) => turn.pending?.id === id);
		if (index === -1) return null;
		const turn = lane.pending.splice(index, 1)[0];
		return turn === undefined ? null : { turn, index };
	}

	restorePending(convId: string, turn: QueuedTurn, index: number): void {
		this.lane(convId).pending.splice(index, 0, turn);
	}

	claimablePending(convId: string, headStreams: boolean): boolean {
		const lane = this.lanes.get(convId);
		return lane !== undefined && hasClaimable(lane, headStreams);
	}

	unrequeue(convId: string, steered: QueuedTurn[]): void {
		this.lane(convId).pending.unshift(...steered);
	}

	nextCompact(convId: string): QueuedCompact | undefined {
		return this.lanes.get(convId)?.compacts.shift();
	}

	hasActiveTurn(convId: string): boolean {
		const lane = this.lanes.get(convId);
		return lane !== undefined && (lane.running || lane.pending.length > 0);
	}

	busy(convId: string): boolean {
		const lane = this.lanes.get(convId);
		return (
			lane !== undefined && (lane.running || lane.pending.length > 0 || lane.compacts.length > 0)
		);
	}

	busyConversations(): string[] {
		return [...this.lanes.keys()].filter((convId) => this.busy(convId));
	}

	isAdmitted(convId: string, messageId: string, eventSeq?: number): boolean {
		return (
			this.lanes
				.get(convId)
				?.admitted.get(messageId)
				?.some((t) => !t.doneSent && (eventSeq === undefined || t.seq === eventSeq)) ?? false
		);
	}

	pendingIds(convId: string): Set<string> {
		const lane = this.lanes.get(convId);
		if (lane === undefined) return new Set();
		return new Set(
			lane.pending.flatMap((turn) => (turn.pending === undefined ? [] : [turn.pending.id])),
		);
	}

	pendingSeqs(convId: string): Set<number> {
		return new Set(
			this.lane(convId).pending.flatMap((t) => (t.seq === null ? [] : [t.seq])),
		);
	}

	pendingFloor(convId: string, activeFloor?: number): number | null {
		let ceiling = activeFloor ?? null;
		for (const t of this.lanes.get(convId)?.pending ?? []) {
			if (t.seq !== null && (ceiling === null || t.seq < ceiling)) ceiling = t.seq;
		}
		return ceiling;
	}

	liveOf(convId: string): LiveChunks | null {
		return this.lanes.get(convId)?.live ?? null;
	}

	conversationIds(): string[] {
		return [...this.lanes.keys()];
	}

	drainingPromises(): Promise<void>[] {
		const drains: Promise<void>[] = [];
		for (const lane of this.lanes.values()) {
			if (lane.draining) drains.push(lane.draining);
		}
		return drains;
	}

	registerController(convId: string, controller: AbortController | null): void {
		this.lane(convId).controller = controller;
	}

	releaseController(convId: string, controller: AbortController): void {
		const lane = this.lanes.get(convId);
		if (lane !== undefined && lane.controller === controller) lane.controller = null;
	}

	holdCompactController(convId: string, controller: AbortController): void {
		this.lane(convId).compactController = controller;
	}

	releaseCompactController(convId: string, controller: AbortController): void {
		const lane = this.lanes.get(convId);
		if (lane !== undefined && lane.compactController === controller) {
			lane.compactController = null;
		}
	}

	registerLive(convId: string, live: LiveChunks): void {
		this.lane(convId).live = live;
	}

	dropAll(convId: string): { stopped: boolean; turns: QueuedTurn[]; compacts: QueuedCompact[] } {
		const lane = this.lanes.get(convId);
		if (lane === undefined) return { stopped: false, turns: [], compacts: [] };
		const stopped =
			lane.pending.length > 0 ||
			lane.compacts.length > 0 ||
			lane.controller !== null ||
			lane.compactController !== null;
		const turns = lane.pending.splice(0);
		const compacts = lane.compacts.splice(0);
		lane.controller?.abort();
		lane.compactController?.abort();
		return { stopped, turns, compacts };
	}

	setActiveTurn(convId: string, turn: Promise<void> | null): void {
		this.lane(convId).activeTurn = turn;
	}

	activeTurn(convId: string): Promise<void> | null {
		return this.lanes.get(convId)?.activeTurn ?? null;
	}
}

// The lane registry: every per-conversation serial lane's state — the
// pending-turn queue, the queued compactions, the abort controllers, the
// live wire, the admission index — behind narrow synchronous operations.
// runtime.ts owns the policy around it (intake admission, the drain
// loop, the attempt loop, cancellation); this module owns the map. No
// method awaits — same-tick ordering (an idle-lane delete vs a late
// attachLiveChunks) is the contract. `Lane` is module-private: no
// turn/ module ever sees it (design/runtime-turn.md → Turn-module
// boundary).

import type { Message } from "./message.ts";
import type { CompactionOutcome } from "./agent/compaction.ts";
import type { Conversation } from "./conversation-read.ts";
import { log } from "./log.ts";
import type { TurnSink } from "./turn/sink.ts";
import { endLive, type LiveChunks } from "./turn/stream.ts";

export interface QueuedTurn {
	// A durable event seq when the input already entered history. A pending
	// app submit has null until claim atomically appends its history event.
	seq: number | null;
	// App input stays outside transcript history until a lane claim.
	pending?: { id: string; mode: "steer" | "followUp" };
	// The user input; pending app input is durable in its inbox row until claim.
	message: Message;
	sink: TurnSink;
	// Prevents a throwing sink from receiving a second terminal notification.
	// Drain's last-ditch handler can therefore safely settle the whole lane.
	doneSent: boolean;
	// A throwing stream sink is detached without killing the turn; remaining
	// sinks receive future chunks.
	streamFailed?: boolean;
	release?: (() => void) | undefined;
}

export type ClaimedTurn = Omit<QueuedTurn, "seq" | "pending"> & { seq: number };

// Compaction jobs run between turns so the preceding exchange is whole.
// A submit arriving during the job waits for the next drain pass.
export interface QueuedCompact {
	conv: Conversation;
	/** Optional operator focus for the summarizer (/compact <focus>, app focus body). */
	focus?: string | undefined;
	resolve: (outcome: CompactionOutcome) => void;
	reject: (err: unknown) => void;
}

export type ConversationEvent =
	| { type: "turn-start" }
	| { type: "turn-end" }
	| { type: "pending" };

interface Lane {
	pending: QueuedTurn[];
	compacts: QueuedCompact[];
	running: boolean;
	controller: AbortController | null;
	// Dedicated cancellation for an in-flight compaction summary. It is
	// registered before the first await so /stop cannot miss a pending build.
	compactController: AbortController | null;
	// Shutdown awaits the drain so terminal sink flushes finish.
	draining: Promise<void> | null;
	live: LiveChunks | null;
	admitted: Map<string, QueuedTurn[]>;
	// The turn currently holding the lane: set by drain around runTurn,
	// resolved once that runTurn has returned (history writes and terminal
	// sink notifications included, the crash guard either way). /stop hands
	// it out as `active` — the wait-for-the-record seam. A turn submitted
	// after the stop replaces it, so an old waiter never follows the new turn.
	activeTurn: Promise<void> | null;
}

// A streaming submit stays queued behind a headless turn so it can lead its
// own attempt. A streaming head may claim all pending work; a headless head
// claims only the leading non-streaming run.
// `headLeads` distinguishes the two claim contexts: the drain's claim
// promotes pending[0] to head, while wire/steer claims take members only.
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

// A read-only `claim` probe — same headStreams source filter, nothing
// spliced. The tool fence's steer gate (#477) asks whether the next
// model call would fold waiting input; consumption still belongs to
// the model-call boundary alone.
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

	// One drain pass per lane: false means a pass already holds it and
	// will pick up the newly queued work in its own loop.
	beginDrain(convId: string): boolean {
		const lane = this.lane(convId);
		if (lane.running) return false;
		lane.running = true;
		return true;
	}

	// Release the drain pass and drop the lane when idle. Fail closed if a
	// path leaves attached streams without an outcome — hanging an attach
	// request is worse than sending an explicit error.
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
		// Do not retain idle lanes for the process lifetime.
		if (lane.pending.length === 0 && lane.compacts.length === 0) this.lanes.delete(convId);
	}

	// Start a drain pass when the lane is idle; the promise is what
	// shutdown awaits for terminal sink flushes.
	startDraining(convId: string, begin: () => Promise<void>): void {
		const lane = this.lane(convId);
		if (!lane.running) lane.draining = begin();
	}

	// Queue an admitted turn on its lane and index it by client message
	// id. The release hook (the runtime's terminal notifyDone calls it)
	// drops a settled turn from the index — it must stop answering
	// isAdmitted probes.
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

	// The pending head's delivery mode — the drain claim's boundary.
	headStreams(convId: string): boolean {
		const lane = this.lane(convId);
		return lane.pending[0]?.sink.delivery === "stream";
	}

	// Splice the claimable prefix off the pending queue (claimableCount).
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

	// Whether the next member claim would take anything — the tool
	// fence's steer gate (#477). A missing lane means nothing waits.
	claimablePending(convId: string, headStreams: boolean): boolean {
		const lane = this.lanes.get(convId);
		return lane !== undefined && hasClaimable(lane, headStreams);
	}

	// Return unconverted steers to the queue head — they lead the next pass.
	unrequeue(convId: string, steered: QueuedTurn[]): void {
		this.lane(convId).pending.unshift(...steered);
	}

	// Pop the next queued compaction — the drain runs them between turns.
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

	// A live admission by client-visible id — loose matching for callers
	// that only carry the id. `eventSeq` tightens it to one durable
	// event: a different admitted event reusing the same client id must
	// not stand in for the seq the caller actually means.
	isAdmitted(convId: string, messageId: string, eventSeq?: number): boolean {
		return (
			this.lanes
				.get(convId)
				?.admitted.get(messageId)
				?.some((t) => !t.doneSent && (eventSeq === undefined || t.seq === eventSeq)) ?? false
		);
	}

	// Durable input seqs still queued — admission's pendingSeqs seam: the
	// view receives historical context and admitted inputs, never
	// still-pending ones.
	pendingSeqs(convId: string): Set<number> {
		return new Set(
			this.lane(convId).pending.flatMap((t) => (t.seq === null ? [] : [t.seq])),
		);
	}

	// Where completed history ends for a fold: the lowest seq whose reply
	// has not landed. While a turn runs, that is its earliest member — every
	// event at or after it is that exchange or input queued behind it. On an
	// idle lane it is the first still-queued input (its reply comes only
	// with its own turn). Events at or after the ceiling must never be
	// folded: their reply would anchor at or below the boundary and drop
	// out of the model view, unseen by the summary that replaced it.
	pendingFloor(convId: string, activeFloor?: number): number | null {
		let ceiling = activeFloor ?? null;
		for (const t of this.lanes.get(convId)?.pending ?? []) {
			if (t.seq !== null && (ceiling === null || t.seq < ceiling)) ceiling = t.seq;
		}
		return ceiling;
	}

	// The lane's live wire for attach replay — null when nothing streams.
	liveOf(convId: string): LiveChunks | null {
		return this.lanes.get(convId)?.live ?? null;
	}

	// Every conversation with a lane — shutdown stops each.
	conversationIds(): string[] {
		return [...this.lanes.keys()];
	}

	// The in-flight drain promises — shutdown awaits them so terminal
	// sink flushes finish.
	drainingPromises(): Promise<void>[] {
		const drains: Promise<void>[] = [];
		for (const lane of this.lanes.values()) {
			if (lane.draining) drains.push(lane.draining);
		}
		return drains;
	}

	// The running turn's abort slot; null clears it — /stop reads the
	// slot to decide whether a generating turn exists.
	registerController(convId: string, controller: AbortController | null): void {
		this.lane(convId).controller = controller;
	}

	// Clear the slot only when it still holds this controller — a
	// successor turn's controller must survive a predecessor's landing.
	releaseController(convId: string, controller: AbortController): void {
		const lane = this.lanes.get(convId);
		if (lane !== undefined && lane.controller === controller) lane.controller = null;
	}

	// A compaction summary's dedicated cancellation, registered before
	// the first await so /stop cannot miss a pending build.
	holdCompactController(convId: string, controller: AbortController): void {
		this.lane(convId).compactController = controller;
	}

	releaseCompactController(convId: string, controller: AbortController): void {
		const lane = this.lanes.get(convId);
		if (lane !== undefined && lane.compactController === controller) {
			lane.compactController = null;
		}
	}

	// The running turn's live wire — attach replay reads it until the
	// drain pass ends it.
	registerLive(convId: string, live: LiveChunks): void {
		this.lane(convId).live = live;
	}

	// Drop all queued work and abort both controllers. Returns what was
	// dropped so the caller settles sinks and resolves compaction
	// waiters; `stopped` says whether anything was queued or in flight.
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

	// The turn currently holding the lane — /stop hands the promise out
	// as `active`, the wait-for-the-record seam.
	setActiveTurn(convId: string, turn: Promise<void> | null): void {
		this.lane(convId).activeTurn = turn;
	}

	activeTurn(convId: string): Promise<void> | null {
		return this.lanes.get(convId)?.activeTurn ?? null;
	}
}

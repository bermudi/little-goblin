// Admission — fix what an attempt owns, sees, and answers
// (design/runtime-turn.md → phase 1). One synchronous pass: settings
// capture, the epoch (the turn's authority token), the resume claim,
// the ownership-bounded history snapshot (#82), the anchor, the
// steer-mark seed, the clock start. The snapshot is immutable input to
// the phases that follow, not state.

import type { UIMessage, UIMessageChunk } from "ai";
import type { Conversation } from "../conversation.ts";
import { log } from "../log.ts";

// A queued submit as admission sees it: identity for the ownership
// filter, streaming membership for the wire replay.
export interface AdmittedMember {
	message: UIMessage;
	sink: { onStreamChunk?(chunk: UIMessageChunk): void };
}

// The live wire as the membership seam replays it — runtime's wire log
// satisfies this structurally; admission sees only the chunks.
export interface LiveWire {
	chunks: UIMessageChunk[];
}

// The membership seam: claim the queued submits that may join this
// turn and replay the wire to streaming joiners — a client that
// submitted during a recovery window missed everything the failed
// attempt emitted (#96). Runtime-injected (queue policy never leaves
// runtime.ts); the steer path claims through the same mechanism.
export type ClaimQueued<M extends AdmittedMember = AdmittedMember> = (live: LiveWire) => M[];

export interface AdmissionDeps<M extends AdmittedMember = AdmittedMember> {
	convId: string;
	live: LiveWire;
	// Its epoch becomes the authority token, frozen for the whole
	// logical turn.
	getConversation(): Conversation | null;
	// Settings captured once per logical turn so edits affect only the
	// next turn; skipped on a resume — one settings copy per logical turn.
	captureConversation?: ((conv: Conversation) => Conversation) | undefined;
	// The member type is the caller's queue's — admission needs only the
	// AdmittedMember view of it.
	claimQueued: ClaimQueued<M>;
	// Read after the claim: claimed submits are owned, the rest queued-but-unowned.
	pendingIds(): ReadonlySet<string>;
	modelEntries(): { seq: number; message: UIMessage }[];
	now(): number;
}

// What a resume attempt carries in: the failed attempt's conversation
// (settings and epoch) and its clock start.
export interface AdmissionRecovery {
	conversation: Conversation;
	startedAt: number;
}

// Immutable input to recall, view assembly, and finish — everything
// derived from it per attempt is a value computed fresh, never stored
// back.
export interface AdmissionSnapshot<M extends AdmittedMember = AdmittedMember> {
	conv: Conversation;
	epoch: number;
	// The entries this attempt OWNS, oldest first. Bounded by ownership,
	// not durability (#82): a queued submit is durable history but not
	// this turn's input — snapshot it here and this turn would answer
	// and anchor it, then its successor turn would answer it again.
	entries: { seq: number; message: UIMessage }[];
	// The triggering user message's seq — recall blocks and the causal
	// view key off it. Null when the owned view holds no user message.
	anchorSeq: number | null;
	// Ownership high-water mark: the newest event this attempt answers.
	// Steering advances it; input this turn never saw stays above the
	// mark, so the reply never causally sorts after input it didn't read.
	steerMarkSeed: number;
	// Admission to done. A resume keeps the failed attempt's start.
	turnStartMs: number;
	// Claimed by the resume claim — the caller owns membership, so
	// appending them to its member list is its job.
	claimed: M[];
}

export type AdmissionOutcome<M extends AdmittedMember = AdmittedMember> =
	| { kind: "admitted"; snapshot: AdmissionSnapshot<M> }
	| { kind: "missing" }
	| { kind: "settings-failed"; message: string };

export function admitTurn<M extends AdmittedMember = AdmittedMember>(
	deps: AdmissionDeps<M>,
	recovery?: AdmissionRecovery,
): AdmissionOutcome<M> {
	let conv = deps.getConversation();
	if (conv === null) {
		// The sink contract still holds: the caller answers with exactly
		// one onDone per submit.
		log.error("turn for missing conversation", undefined, { conversation: deps.convId });
		return { kind: "missing" };
	}
	try {
		conv = recovery?.conversation ?? deps.captureConversation?.(conv) ?? conv;
	} catch (err) {
		log.error("turn settings admission failed", err, { conversation: deps.convId });
		return {
			kind: "settings-failed",
			message: err instanceof Error ? err.message : String(err),
		};
	}
	const epoch = conv.epoch;
	// A resume owns whatever queued while the overflow compaction ran:
	// those messages are already inside the fresh snapshot below, so
	// leaving them pending would steer them in a second time.
	const claimed = recovery === undefined ? [] : deps.claimQueued(deps.live);
	// Taken before any await: a /compact landing mid-turn cannot rewrite
	// what this attempt already sees — newer input steers in later, but
	// recall and the reply anchor read THIS snapshot.
	const queuedIds = deps.pendingIds();
	const entries = deps.modelEntries().filter((e) => !queuedIds.has(e.message.id));
	let anchorSeq: number | null = null;
	for (const e of entries) {
		if (e.message.role === "user" && (anchorSeq === null || e.seq > anchorSeq)) anchorSeq = e.seq;
	}
	let steerMarkSeed = 0;
	for (const e of entries) steerMarkSeed = Math.max(steerMarkSeed, e.seq);
	log.info("turn started", { conversation: deps.convId, epoch, history: entries.length });
	return {
		kind: "admitted",
		snapshot: {
			conv,
			epoch,
			entries,
			anchorSeq,
			steerMarkSeed,
			turnStartMs: recovery?.startedAt ?? deps.now(),
			claimed,
		},
	};
}

import type { UIMessage, UIMessageChunk } from "ai";
import type { Conversation } from "../conversation.ts";
import { log } from "../log.ts";

export interface AdmittedMember {
	message: UIMessage;
	/** The durable USER event seq this member carries; null for a non-user member. */
	inputSeq: number | null;
	sink: { onStreamChunk?(chunk: UIMessageChunk): void };
}

export interface LiveWire {
	chunks: UIMessageChunk[];
}

export type ClaimQueued<M extends AdmittedMember = AdmittedMember> = (live: LiveWire) => M[];

export interface AdmissionDeps<M extends AdmittedMember = AdmittedMember> {
	convId: string;
	live: LiveWire;
	getConversation(): Conversation | null;
	captureConversation?: ((conv: Conversation) => Conversation) | undefined;
	claimQueued: ClaimQueued<M>;
	/** Durable input seqs still queued — filtered OUT of the view until their own turn. */
	pendingSeqs(): ReadonlySet<number>;
	/**
	 * Durable user-input seqs this attempt owns — read AFTER claimQueued,
	 * which can add current members.
	 */
	ownedInputSeqs(): ReadonlySet<number>;
	modelEntries(): { seq: number; message: UIMessage }[];
	now(): number;
}

export interface AdmissionRecovery {
	conversation: Conversation;
	startedAt: number;
}

export interface AdmissionSnapshot {
	conv: Conversation;
	epoch: number;
	entries: { seq: number; message: UIMessage }[];
	anchorSeq: number | null;
	steerMarkSeed: number;
	// The durable user-input seqs this attempt owns — admitted user
	// entries whose seqs the members carry, after the still-queued seqs
	// are filtered out. Resume tells its inputs from foreign later ones.
	ownedInputSeqs: number[];
	turnStartMs: number;
}

export type AdmissionOutcome =
	| { kind: "admitted"; snapshot: AdmissionSnapshot }
	| { kind: "missing" }
	| { kind: "settings-failed"; message: string };

export function admitTurn<M extends AdmittedMember = AdmittedMember>(
	deps: AdmissionDeps<M>,
	recovery?: AdmissionRecovery,
): AdmissionOutcome {
	let conv = deps.getConversation();
	if (conv === null) {
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
	if (recovery !== undefined) deps.claimQueued(deps.live);
	const queuedSeqs = deps.pendingSeqs();
	// Pending inputs are excluded BY SEQ — duplicate UIMessage ids can
	// alias a queued member to a same-id historical entry, but their
	// durable seqs differ.
	const entries = deps.modelEntries().filter((e) => !queuedSeqs.has(e.seq));
	const owned = deps.ownedInputSeqs();
	let anchorSeq: number | null = null;
	for (const e of entries) {
		if (e.message.role === "user" && (anchorSeq === null || e.seq > anchorSeq)) anchorSeq = e.seq;
	}
	let steerMarkSeed = 0;
	for (const e of entries) steerMarkSeed = Math.max(steerMarkSeed, e.seq);
	// Only entries whose seq this attempt actually claimed are owned —
	// a historical user input admitted into the view is not this turn's
	// input just because it precedes it.
	const ownedInputSeqs = entries
		.filter((e) => e.message.role === "user" && owned.has(e.seq))
		.map((e) => e.seq);
	log.info("turn started", { conversation: deps.convId, epoch, history: entries.length });
	return {
		kind: "admitted",
		snapshot: {
			conv,
			epoch,
			entries,
			anchorSeq,
			steerMarkSeed,
			ownedInputSeqs,
			turnStartMs: recovery?.startedAt ?? deps.now(),
		},
	};
}

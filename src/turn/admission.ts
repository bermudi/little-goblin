import type { UIMessage, UIMessageChunk } from "ai";
import type { Conversation } from "../conversation.ts";
import { log } from "../log.ts";

export interface AdmittedMember {
	// The durable event seq of this member's appended message — client
	// message ids are neither unique nor trusted, so every ownership or
	// exclusion decision names the event by seq.
	seq: number;
	message: UIMessage;
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
	pendingSeqs(): ReadonlySet<number>;
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
	// The durable user-input seqs this attempt owns — the post-queuedIds
	// admission set, so resume can tell its inputs from foreign later ones.
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
	// Pending work leaves by its own seqs — a queued submit that reuses an
	// older event's message id must not hide that older event from the
	// admission set.
	const queuedSeqs = deps.pendingSeqs();
	const entries = deps.modelEntries().filter((e) => !queuedSeqs.has(e.seq));
	let anchorSeq: number | null = null;
	for (const e of entries) {
		if (e.message.role === "user" && (anchorSeq === null || e.seq > anchorSeq)) anchorSeq = e.seq;
	}
	let steerMarkSeed = 0;
	for (const e of entries) steerMarkSeed = Math.max(steerMarkSeed, e.seq);
	const ownedInputSeqs = entries.filter((e) => e.message.role === "user").map((e) => e.seq);
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

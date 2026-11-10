// Per-(conversation, model ref) native Claude SDK session records
// (#418): the claude-code engine keeps one persisted SDK session per
// key so the model retains its own thinking across turns. The runtime
// reads the record to resume the session and cut the prompt delta, and
// writes it only after the reply lands durably — an interrupted or
// failed turn never advances it, so the next attempt resumes at the
// last finished turn (the turn journal stays the crash authority).
// Native compaction rewrites head_uuid in place, keeping the seq cut.

import type { Database } from "bun:sqlite";
import { z } from "zod";
import { log } from "./log.ts";

const rowSchema = z.object({
	conversation_id: z.string(),
	model_ref: z.string(),
	session_id: z.string(),
	head_uuid: z.string(),
	seen_seq: z.number().int(),
	reply_seq: z.number().int().nullable(),
	updated_at: z.number(),
});

export interface ClaudeSessionRecord {
	conversationId: string;
	modelRef: string;
	sessionId: string;
	/** Last top-level assistant chain uuid — the resumeSessionAt anchor. */
	headUuid: string;
	/** Highest event seq whose content went into this session's prompt. */
	seenSeq: number;
	/** Seq of the reply this session produced on its last landing. */
	replySeq: number | null;
}

export interface ClaudeSessionStore {
	get(conversationId: string, modelRef: string): ClaudeSessionRecord | null;
	put(record: ClaudeSessionRecord): void;
	/** Remove the record; `reason` lands in the drop log line. */
	drop(conversationId: string, modelRef: string, reason: string): void;
}

export function openClaudeSessions(db: Database): ClaudeSessionStore {
	const row = db.query<z.input<typeof rowSchema>, [string, string]>(
		`SELECT conversation_id, model_ref, session_id, head_uuid, seen_seq, reply_seq, updated_at
		 FROM claude_sessions WHERE conversation_id = ? AND model_ref = ?`,
	);
	return {
		get(conversationId, modelRef) {
			const raw = row.get(conversationId, modelRef);
			if (raw === null) return null;
			const parsed = rowSchema.safeParse(raw);
			if (!parsed.success) {
				log.warn("claude session row failed validation — treated as absent", {
					conversation: conversationId,
					model: modelRef,
				});
				return null;
			}
			const r = parsed.data;
			return {
				conversationId: r.conversation_id,
				modelRef: r.model_ref,
				sessionId: r.session_id,
				headUuid: r.head_uuid,
				seenSeq: r.seen_seq,
				replySeq: r.reply_seq,
			};
		},
		put(record) {
			db.run(
				`INSERT OR REPLACE INTO claude_sessions
				 (conversation_id, model_ref, session_id, head_uuid, seen_seq, reply_seq, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					record.conversationId,
					record.modelRef,
					record.sessionId,
					record.headUuid,
					record.seenSeq,
					record.replySeq,
					Date.now(),
				],
			);
			log.info("claude session recorded", {
				conversation: record.conversationId,
				model: record.modelRef,
				session: record.sessionId,
				head: record.headUuid,
				seenSeq: record.seenSeq,
				replySeq: record.replySeq,
			});
		},
		drop(conversationId, modelRef, reason) {
			const dropped = db
				.query<{ session_id: string }, [string, string]>(
					`DELETE FROM claude_sessions
					 WHERE conversation_id = ? AND model_ref = ?
					 RETURNING session_id`,
				)
				.get(conversationId, modelRef);
			if (dropped === null) return;
			log.info("claude session dropped", {
				conversation: conversationId,
				model: modelRef,
				session: dropped.session_id,
				reason,
			});
		},
	};
}

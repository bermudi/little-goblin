import type { Database, Statement } from "bun:sqlite";
import { log } from "./log.ts";
import { silenceFollowup } from "./responsibility-followup.ts";
import {
	ReconciliationConflict,
	StaleAttachmentError,
	type Attachment,
	type AttachmentHealth,
	type AttachmentTarget,
} from "./responsibility-types.ts";
import {
	attRowSchema,
	type AttRow,
	opRowSchema,
	type OpRow,
	toAttachment,
	toOperation,
} from "./responsibility-schema.ts";

// The attachment rows of openResponsibilities (#466), moved out of its
// closure. Parent-owned state is read through live ctx accessors.
export interface AttachmentsDeps {
	db: Database;
	now(): string;
	qPlan: Statement<unknown, [string, string, string]>;
	qUnresolved: Statement<OpRow, [number, number]>;
	qUnresolvedForIdentity: Statement<
		OpRow,
		[string, string, string, string | null, string | null, string | null]
	>;
}

export function makeAttachments(deps: AttachmentsDeps) {
	const { db } = deps;
	const qAttach = db.prepare(
		`INSERT INTO attachments (responsibility_id, server, session, agent_name, pane_id, terminal_id, agent_session, kind, cwd, baseline_json, cursor_json, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const qAtts = db.query<AttRow, [string]>(
		"SELECT * FROM attachments WHERE responsibility_id = ? ORDER BY attachment_id",
	);
	const qAtt = db.query<AttRow, [number]>("SELECT * FROM attachments WHERE attachment_id = ?");
	const qAttHealth = db.prepare("UPDATE attachments SET health = ? WHERE attachment_id = ?");
	const qAttCursor = db.prepare("UPDATE attachments SET cursor_json = ? WHERE attachment_id = ?");
	const qAttDetach = db.prepare(
		"UPDATE attachments SET health = 'detached', detached_at = ?, unreachable_count = 0, unreachable_since = NULL WHERE attachment_id = ?",
	);
	const qAttReattach = db.prepare(
		`UPDATE attachments SET generation = generation + 1, server = ?, session = ?, agent_name = ?, pane_id = ?, terminal_id = ?, agent_session = ?, kind = ?, cwd = ?, baseline_json = ?, health = 'attached', cursor_json = ?, detached_at = NULL, unreachable_count = 0, unreachable_since = NULL WHERE attachment_id = ?`,
	);
	// The outage start pins on the first failure; the count drives the
	// declaration threshold surfaces share through toAttachment.
	const qAttUnreachable = db.query<{ unreachable_count: number }, [string, number]>(
		`UPDATE attachments SET unreachable_count = unreachable_count + 1,
			unreachable_since = COALESCE(unreachable_since, ?) WHERE attachment_id = ? RETURNING unreachable_count`,
	);
	const qAttUnreachClear = db.prepare(
		"UPDATE attachments SET unreachable_count = 0, unreachable_since = NULL WHERE attachment_id = ? AND unreachable_since IS NOT NULL",
	);
	// A live (non-detached) sibling already holding this dispatch
	// identity — a second binding for the same destination, the state
	// that lets an unresolved send on one row be bypassed by sending
	// through the other.
	const qLiveBindingForIdentity = db.query<
		AttRow,
		[string, string, string, string | null, string | null, string | null]
	>(
		`SELECT * FROM attachments WHERE responsibility_id = ? AND health != 'detached'
		   AND server = ? AND session = ?
		   AND terminal_id IS ? AND agent_session IS ? AND kind IS ?
		 ORDER BY attachment_id LIMIT 1`,
	);

	function requireAtt(attachmentId: number): Attachment {
		const row = qAtt.get(attachmentId);
		if (row === null) throw new Error(`attachment ${attachmentId} not found`);
		return toAttachment(attRowSchema.parse(row));
	}

	return {
		requireAtt,
		qLiveBindingForIdentity,
		methods: {
			attach(input: {
				responsibilityId: string;
				target: AttachmentTarget;
				baseline: unknown;
				cursor?: unknown;
			}) {
				// Check-and-insert in one transaction, mirroring prepareOperation:
				// a reconciliation landing between the read and the insert could
				// not be honored by a fresh bind that never saw it.
				let att!: Attachment;
				db.transaction(() => {
					const blocked = deps.qUnresolvedForIdentity.get(
						input.responsibilityId,
						input.target.server,
						input.target.session,
						input.target.terminalId,
						input.target.agentSession,
						input.target.kind,
					);
					if (blocked !== null) {
						throw new ReconciliationConflict(
							`attaching ${input.target.agentName} to ${input.target.server}/${input.target.session} skips reconciliation of ${blocked.operation_id} — an earlier send to this dispatch identity is unresolved`,
							toOperation(opRowSchema.parse(blocked)),
						);
					}
					// One live binding per dispatch identity: a second attachment
					// for the same destination could dispatch around the
					// unresolved-delivery fence that scopes to one row.
					const duplicate = qLiveBindingForIdentity.get(
						input.responsibilityId,
						input.target.server,
						input.target.session,
						input.target.terminalId,
						input.target.agentSession,
						input.target.kind,
					);
					if (duplicate !== null) {
						throw new Error(
							`attachment ${duplicate.attachment_id} already binds ${input.target.agentName} at ${input.target.server}/${input.target.session} — detach it or reattach instead of a second binding`,
						);
					}
					const ins = qAttach.run(
						input.responsibilityId,
						input.target.server,
						input.target.session,
						input.target.agentName,
						input.target.paneId,
						input.target.terminalId,
						input.target.agentSession,
						input.target.kind,
						input.target.cwd,
						JSON.stringify(input.baseline ?? null),
						input.cursor === undefined ? null : JSON.stringify(input.cursor),
						deps.now(),
					);
					att = requireAtt(Number(ins.lastInsertRowid));
				})();
				log.info("attachment bound", {
					attachment: att.attachmentId,
					responsibility: input.responsibilityId,
					agent: input.target.agentName,
					session: input.target.session,
					terminal: input.target.terminalId,
					agentSession: input.target.agentSession,
				});
				return att;
			},
			attachmentsFor: (responsibilityId: string) =>
				qAtts
					.all(responsibilityId)
					.map((r) => toAttachment(attRowSchema.parse(r))),
			getAttachment: (attachmentId: number) => {
				const row = qAtt.get(attachmentId);
				return row === null
					? null
					: toAttachment(attRowSchema.parse(row));
			},
			setHealth(attachmentId: number, health: AttachmentHealth) {
				qAttHealth.run(health, attachmentId);
				log.info("attachment health", { attachment: attachmentId, health });
			},
			markUnreachable(attachmentId: number, at: string) {
				return qAttUnreachable.get(at, attachmentId)!.unreachable_count;
			},
			clearUnreachable(attachmentId: number) {
				qAttUnreachClear.run(attachmentId);
			},
			updateCursor(attachmentId: number, cursor: unknown) {
				qAttCursor.run(JSON.stringify(cursor ?? null), attachmentId);
			},
			detach(attachmentId: number) {
				qAttDetach.run(deps.now(), attachmentId);
				log.info("attachment detached", { attachment: attachmentId });
			},
			reattach(
				attachmentId: number,
				target: AttachmentTarget,
				baseline: unknown,
				cursor?: unknown,
				expected?: Pick<Attachment, "generation" | "health" | "detachedAt">,
			) {
				// A reattach to the SAME dispatch identity is not a replacement —
				// it must not mint a fresh generation past an unresolved
				// delivery. A genuinely changed identity (new agent_session,
				// terminal, server…) is a deliberate adoption and proceeds.
				let out!: Attachment;
				// Immediate: the compare and the write hold one lock — a
				// deferred transaction could let a competing write land
				// between the snapshot check and the update.
				db.transaction(() => {
					const current = requireAtt(attachmentId);
					if (
						expected !== undefined &&
						(current.generation !== expected.generation ||
							current.health !== expected.health ||
							current.detachedAt !== expected.detachedAt)
					) {
						throw new StaleAttachmentError(
							`attachment ${attachmentId} changed while reattaching — the bound generation or lifecycle no longer matches the caller's snapshot`,
						);
					}
					const sameIdentity =
						current.target.server === target.server &&
						current.target.session === target.session &&
						current.target.terminalId === target.terminalId &&
						current.target.agentSession === target.agentSession &&
						current.target.kind === target.kind;
					if (sameIdentity) {
						const blocked = deps.qUnresolved.get(attachmentId, current.generation);
						if (blocked !== null) {
							throw new ReconciliationConflict(
								`attachment ${attachmentId} reattach to the same dispatch identity skips reconciliation of ${blocked.operation_id}`,
								toOperation(opRowSchema.parse(blocked)),
							);
						}
					}
					qAttReattach.run(
						target.server,
						target.session,
						target.agentName,
						target.paneId,
						target.terminalId,
						target.agentSession,
						target.kind,
						target.cwd,
						JSON.stringify(baseline ?? null),
						cursor === undefined ? null : JSON.stringify(cursor),
						attachmentId,
					);
					out = requireAtt(attachmentId);
					deps.qPlan.run(
						JSON.stringify(silenceFollowup(new Date())),
						deps.now(),
						out.responsibilityId,
					);
				}).immediate();
				log.info("attachment reattached", {
					attachment: attachmentId,
					generation: out.generation,
					agent: target.agentName,
					agentSession: target.agentSession,
				});
				return out;
			},
		},
	};
}

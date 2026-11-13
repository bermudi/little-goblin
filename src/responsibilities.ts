// Project-owned durable work — the records the handover loop stands
// on. A responsibility is not an agent run, a conversation, or a
// Program: it survives all three changing underneath it. Attachments
// bind explicitly selected Herdr agents to it by stable identity
// (terminal_id + agent_session when Herdr exposes one — never pane +
// kind alone, which a same-kind replacement inherits). Generations
// fence reattachment: an operation prepared under generation N dies
// against generation N+1 before it can dispatch. Managed prompt
// operations carry their own durable identity — an acknowledged op
// cannot send again under a new tool-call ID, and an uncertain one is
// never blindly resent. Every operation also snapshots its dispatch
// identity at prepare: the attachment row's copies are rewritten by
// reattach, so the unresolved-delivery fence reads where the send
// actually went, not where the row points now.
//
// Shares the conversation store's handle: attachments' cursor commits
// ride the observer's outer transaction with the work event + wake,
// and responsibility writes join handover/setup transactions. Same
// migrate-on-open discipline as the other stores.

import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { log } from "./log.ts";
import type { ProgramsStore } from "./programs.ts";
import {
	followupCommitmentSchema,
	silenceFollowup,
	type ResponsibilityFollowup,
} from "./responsibility-followup.ts";
import {
	missingEvidence,
	type ReportInput,
	type ReportReporter,
	type ResponsibilityReport,
	TERMINAL_REPORTS,
	toReport,
	reportInputSchema,
} from "./responsibility-reports.ts";
import {
	attRowSchema,
	type AttRow,
	ensureResponsibilitiesSchema,
	opRowSchema,
	type OpRow,
	respRowSchema,
	type RespRow,
	toAttachment,
	toOperation,
	toResponsibility,
} from "./responsibility-schema.ts";
import { responsibilityStage } from "./responsibility-stage.ts";
import {
	OP_EDGES,
	OPEN_STATUSES,
	type Attachment,
	type AttachmentHealth,
	type AttachmentTarget,
	ReconciliationConflict,
	type OperationState,
	type PromptOperation,
	type Responsibility,
	type ResponsibilityStatus,
	type SendRefusal,
	StaleAttachmentError,
	type Understanding,
	understandingSchema,
} from "./responsibility-types.ts";

export interface ResponsibilityStore {
	/** Idempotent on handoverKey: a duplicate handover returns the
	 *  existing responsibility instead of doubling the setup. */
	create(input: {
		projectId: string;
		coordinationConversationId: string;
		handoverKey: string;
		understanding: Understanding;
	}): { responsibility: Responsibility; created: boolean };
	get(id: string): Responsibility | null;
	forProject(projectId: string): Responsibility[];
	/** Statuses that still owe the operator follow-through. */
	open(): Responsibility[];
	setStatus(id: string, status: ResponsibilityStatus, opts?: { reason?: string }): void;
	/** Append a structured report. `done` refuses unless evidence covers
	 *  every completionEvidence entry; `done`/`dropped` close the
	 *  responsibility in the same transaction. A `waiting` report's
	 *  resumeWhen schedules the next review at the stated time — a
	 *  resumeWhen that does not parse to a time refuses. */
	report(
		id: string,
		input: ReportInput,
		reporter: ReportReporter,
		opts?: { sourceKey?: string; revision?: number | null },
	):
		| { report: ResponsibilityReport; responsibility: Responsibility; duplicate: boolean }
		| { refused: "closed" | "evidence-missing" | "waiting-time"; missing?: string[] };
	latestReport(id: string): ResponsibilityReport | null;
	reportsFor(id: string): ResponsibilityReport[];
	/** A correction — the durable operator event that bumps revision. */
	revise(id: string, understanding: Understanding): Responsibility;
	setFollowup(id: string, programId: string | null): void;
	/** Replace the next review; its stable token is the enqueue identity. */
	planFollowup(id: string, commitment: { dueAt: string; reason: string }): Responsibility;
	/** Advance only the plan that was durably enqueued; a newer plan wins. */
	consumeFollowup(id: string, token: string, at: Date): boolean;
	/** Meaningful developments cover a silence check, never an explicit promise. */
	deferSilenceFollowup(id: string, at: Date): void;
	setArmed(id: string, armed: boolean, reason: string | null): void;

	/** Bind a fresh attachment. Throws ReconciliationConflict when an
	 *  unresolved delivery to the same dispatch identity exists — a new
	 *  attachment id must not bypass the unresolved-delivery fence the
	 *  way a same-identity reattach cannot. */
	attach(input: {
		responsibilityId: string;
		target: AttachmentTarget;
		baseline: unknown;
		cursor?: unknown;
	}): Attachment;
	attachmentsFor(responsibilityId: string): Attachment[];
	getAttachment(attachmentId: number): Attachment | null;
	setHealth(attachmentId: number, health: AttachmentHealth): void;
	updateCursor(attachmentId: number, cursor: unknown): void;
	/** Detach marks the row; nothing about the Herdr workspace is touched. */
	detach(attachmentId: number): void;
	/** Deliberate reattachment: bumps generation so prepared operations
	 *  under the old generation refuse before dispatch. The supplied
	 *  baseline/cursor snapshot is the new generation's observation
	 *  reference — seeding the cursor keeps the observer from adopting
	 *  whatever it first sees as a silent baseline. `expected` is the
	 *  caller's pre-await snapshot of the row's binding generation and
	 *  lifecycle fields: if the row moved since (generation, health, or
	 *  detachedAt differ — a cursor refresh alone does not count), the
	 *  call throws StaleAttachmentError and writes nothing. */
	reattach(
		attachmentId: number,
		target: AttachmentTarget,
		baseline: unknown,
		cursor?: unknown,
		expected?: Pick<Attachment, "generation" | "health" | "detachedAt">,
	): Attachment;

	/** Prepare a managed send: validates the live responsibility and
	 *  attachment, snapshots generation + revision, or refuses by name.
	 *  While ANY operation on this attachment generation sits in 'sent'
	 *  or 'uncertain', a fresh prepare refuses 'delivery-uncertain' and
	 *  hands back the unresolved op — delivery was never confirmed, so
	 *  nothing may dispatch again until that op is reconciled. */
	prepareOperation(input: {
		responsibilityId: string;
		attachmentId: number;
		brief: string;
		journalRunId?: string | undefined;
		toolCallId?: string | undefined;
	}): { operation: PromptOperation } | { refused: SendRefusal; unresolved?: PromptOperation };
	getOperation(operationId: string): PromptOperation | null;
	operationsFor(responsibilityId: string): PromptOperation[];
	/** Re-check right before dispatch — the race the refusal names. */
	validateForSend(
		operationId: string,
		expectedState?: "prepared" | "sent",
	): { ok: true } | { refused: SendRefusal };
	claimForSend(operationId: string): { operation: PromptOperation } | { refused: SendRefusal };
	transitionOperation(
		operationId: string,
		to: OperationState,
		opts?: {
			refusal?: string;
			runId?: string;
			toolCallId?: string;
			outcome?: unknown;
			from?: OperationState;
		},
	): void;
	/** Evidence-based close of a sent/uncertain operation: 'delivered'
	 *  acknowledges, 'not_delivered' refuses — the prior outcome is
	 *  preserved under `prior` and the verdict/evidence/at recorded
	 *  under `reconciliation`. Replaying the identical verdict+evidence
	 *  is idempotent; any other resolution path or a conflicting
	 *  reconciliation throws ReconciliationConflict. */
	reconcileOperation(
		operationId: string,
		delivery: "delivered" | "not_delivered",
		evidence: string,
	): PromptOperation;
}

// The arm truth is the linked program, never the persisted flags: the
// program tool can disable or delete the follow-up behind the
// responsibility's back, and every armed reader — the app feed and the
// agent-facing status alike — must report what can actually fire.
export function armedView(
	resp: Responsibility,
	programs: Pick<ProgramsStore, "get"> | undefined,
): { armed: boolean; reason: string | null } {
	const linked =
		resp.followupProgramId === null || programs === undefined
			? null
			: programs.get(Number(resp.followupProgramId));
	const followup =
		linked !== null && linked.responsibilityId === resp.responsibilityId ? linked : null;
	const armed =
		followup !== null && followup.enabled && followup.cron !== null && resp.status === "active";
	return {
		armed,
		reason: armed
			? null
			: followup !== null
				? !followup.enabled
					? "follow-up program disabled"
					: followup.cron === null
						? "follow-up schedule missing"
						: `responsibility ${resp.status}`
				: resp.followupProgramId !== null
					? "follow-up program missing"
					: (resp.notArmedReason ?? "follow-up program not linked"),
	};
}

// deleteConversation's anchor check — the responsibilities whose
// coordination surface this conversation IS. Named here so the refusal
// is actionable, not a bare FK error from the row delete.
export function coordinationAnchors(
	db: Database,
	conversationId: string,
): { responsibilityId: string; status: string }[] {
	return db
		.query<{ responsibility_id: string; status: string }, [string]>(
			"SELECT responsibility_id, status FROM responsibilities WHERE coordination_conversation_id = ? ORDER BY created_at",
		)
		.all(conversationId)
		.map((r) => ({ responsibilityId: r.responsibility_id, status: r.status }));
}

export function openResponsibilities(db: Database): ResponsibilityStore {
	ensureResponsibilitiesSchema(db);

	const now = () => new Date().toISOString();

	const qResp = db.query<RespRow, [string]>(
		"SELECT * FROM responsibilities WHERE responsibility_id = ?",
	);
	const qRespByHandover = db.query<RespRow, [string]>(
		"SELECT * FROM responsibilities WHERE handover_key = ?",
	);
	const qRespForProject = db.query<RespRow, [string]>(
		"SELECT * FROM responsibilities WHERE project_id = ? ORDER BY created_at",
	);
	const qRespOpen = db.query<RespRow, []>(
		"SELECT * FROM responsibilities WHERE status IN ('active','paused') ORDER BY created_at",
	);
	const qInsertResp = db.prepare(
		`INSERT INTO responsibilities (responsibility_id, project_id, status, understanding_json, outcome, coordination_conversation_id, handover_key, created_at, updated_at, followup_json)
		 VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
	);
	const qRespStatus = db.prepare(
		"UPDATE responsibilities SET status = ?, updated_at = ?, closed_at = ? WHERE responsibility_id = ?",
	);
	const qRevise = db.prepare(
		"UPDATE responsibilities SET revision = revision + 1, understanding_json = ?, outcome = ?, updated_at = ? WHERE responsibility_id = ?",
	);
	const qFollowup = db.prepare(
		"UPDATE responsibilities SET followup_program_id = ?, updated_at = ? WHERE responsibility_id = ?",
	);
	const qPlan = db.prepare(
		"UPDATE responsibilities SET followup_json = ?, updated_at = ? WHERE responsibility_id = ?",
	);
	const qConsumePlan = db.prepare(
		"UPDATE responsibilities SET followup_json = ?, updated_at = ? WHERE responsibility_id = ? AND followup_json = ? AND status = 'active'",
	);
	const qArmed = db.prepare(
		"UPDATE responsibilities SET armed = ?, not_armed_reason = ?, updated_at = ? WHERE responsibility_id = ?",
	);
	const qInsertReport = db.prepare(
		`INSERT INTO responsibility_reports (responsibility_id, revision, reporter, state, reason, question, resume_when, evidence_json, source_key, purpose, artifacts_json, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
	);
	const qReportBySource = db.query<unknown, [string]>(
		"SELECT * FROM responsibility_reports WHERE source_key = ?",
	);
	const qLatestReport = db.query<unknown, [string]>(
		"SELECT * FROM responsibility_reports WHERE responsibility_id = ? ORDER BY report_id DESC LIMIT 1",
	);
	const qReports = db.query<unknown, [string]>(
		"SELECT * FROM responsibility_reports WHERE responsibility_id = ? ORDER BY report_id",
	);
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
		"UPDATE attachments SET health = 'detached', detached_at = ? WHERE attachment_id = ?",
	);
	const qAttReattach = db.prepare(
		`UPDATE attachments SET generation = generation + 1, server = ?, session = ?, agent_name = ?, pane_id = ?, terminal_id = ?, agent_session = ?, kind = ?, cwd = ?, baseline_json = ?, health = 'attached', cursor_json = ?, detached_at = NULL WHERE attachment_id = ?`,
	);
	const qInsertOp = db.prepare(
		`INSERT INTO prompt_operations (operation_id, responsibility_id, attachment_id, attachment_generation, responsibility_revision, dispatch_server, dispatch_session, dispatch_terminal_id, dispatch_agent_session, dispatch_kind, brief, state, journal_run_id, tool_call_id, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?)`,
	);
	const qOp = db.query<OpRow, [string]>("SELECT * FROM prompt_operations WHERE operation_id = ?");
	const qOpsFor = db.query<OpRow, [string]>(
		"SELECT * FROM prompt_operations WHERE responsibility_id = ? ORDER BY created_at",
	);
	// The unresolved-delivery guard: an operation that reached the wire
	// (sent) or lost its outcome (uncertain) blocks every new send to
	// the same attachment generation until reconciled.
	const qUnresolved = db.query<OpRow, [number, number]>(
		"SELECT * FROM prompt_operations WHERE attachment_id = ? AND attachment_generation = ? AND state IN ('sent','uncertain') ORDER BY created_at LIMIT 1",
	);
	// The same guard against the detach→attach route: a fresh bind mints
	// a new attachment id and generation, so only the operation's
	// dispatch identity (server, session, terminal, harness session,
	// kind) can recognize it as the same destination. The identity is
	// the operation's own snapshot — the attachment row's copies are
	// rewritten by every reattach, so reading them would re-key an
	// unresolved send onto whatever destination the row holds now.
	// `IS` keeps NULL identity fields comparable.
	const qUnresolvedForIdentity = db.query<
		OpRow,
		[string, string, string, string | null, string | null, string | null]
	>(
		`SELECT o.* FROM prompt_operations o
		 WHERE o.responsibility_id = ? AND o.state IN ('sent','uncertain')
		   AND o.dispatch_server IS ? AND o.dispatch_session IS ?
		   AND o.dispatch_terminal_id IS ? AND o.dispatch_agent_session IS ? AND o.dispatch_kind IS ?
		 ORDER BY o.created_at LIMIT 1`,
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
	const qOpClaim = db.prepare(
		`UPDATE prompt_operations SET state = 'sent', sent_at = ? WHERE operation_id = ? AND state = 'prepared'`,
	);
	const qOpTransition = db.prepare(
		`UPDATE prompt_operations SET state = ?, refusal = ?, journal_run_id = COALESCE(?, journal_run_id), tool_call_id = COALESCE(?, tool_call_id), sent_at = COALESCE(?, sent_at), outcome_json = COALESCE(?, outcome_json) WHERE operation_id = ? AND state = ?`,
	);

	function requireResp(id: string): Responsibility {
		const row = qResp.get(id);
		if (row === null) throw new Error(`responsibility ${id} not found`);
		return toResponsibility(respRowSchema.parse(row));
	}

	function requireAtt(attachmentId: number): Attachment {
		const row = qAtt.get(attachmentId);
		if (row === null) throw new Error(`attachment ${attachmentId} not found`);
		return toAttachment(attRowSchema.parse(row));
	}

	// The named pre-dispatch check — refuses rather than guessing at a
	// stale responsibility, a detached agent, or an old generation.
	function checkSendable(resp: Responsibility | null, att: Attachment | null): SendRefusal | null {
		if (resp === null) return "responsibility-missing";
		if (!OPEN_STATUSES.has(resp.status) || resp.status === "paused")
			return "responsibility-inactive";
		if (att === null || att.health === "detached") return "attachment-detached";
		if (att.health === "missing" || att.health === "identity_changed") return "attachment-detached";
		if (att.responsibilityId !== resp.responsibilityId) return "attachment-mismatch";
		return null;
	}

	const store: ResponsibilityStore = {
		create(input) {
			const understanding = understandingSchema.parse(input.understanding);
			const existing = qRespByHandover.get(input.handoverKey);
			if (existing !== null) {
				return { responsibility: toResponsibility(respRowSchema.parse(existing)), created: false };
			}
			const id = `resp-${randomUUID()}`;
			const ts = now();
			qInsertResp.run(
				id,
				input.projectId,
				JSON.stringify(understanding),
				understanding.outcome,
				input.coordinationConversationId,
				input.handoverKey,
				ts,
				ts,
				JSON.stringify(silenceFollowup(new Date(ts))),
			);
			log.info("responsibility created", {
				responsibility: id,
				project: input.projectId,
				coordination: input.coordinationConversationId,
			});
			return { responsibility: requireResp(id), created: true };
		},

		get: (id) => {
			const row = qResp.get(id);
			return row === null ? null : toResponsibility(respRowSchema.parse(row));
		},
		forProject: (projectId) =>
			qRespForProject.all(projectId).map((r) => toResponsibility(respRowSchema.parse(r))),
		open: () => qRespOpen.all().map((r) => toResponsibility(respRowSchema.parse(r))),

		setStatus(id, status, opts) {
			db.transaction(() => {
				const current = requireResp(id);
				const ts = now();
				const closed = OPEN_STATUSES.has(status) ? null : ts;
				qRespStatus.run(status, ts, closed, id);
				if (current.status !== status) {
					qPlan.run(JSON.stringify(silenceFollowup(new Date(ts))), ts, id);
				}
			}).immediate();
			log.info("responsibility status", { responsibility: id, status, reason: opts?.reason });
		},

		report(id, rawInput, reporter, opts) {
			// Every read re-parses strictly: an unvalidated row would make
			// this responsibility's reads throw for good.
			const input = reportInputSchema.parse(rawInput);
			let result:
				| { report: ResponsibilityReport; responsibility: Responsibility; duplicate: boolean }
				| { refused: "closed" | "evidence-missing" | "waiting-time"; missing?: string[] }
				| undefined;
			db.transaction(() => {
				const current = requireResp(id);
				if (opts?.sourceKey !== undefined) {
					const prior = qReportBySource.get(opts.sourceKey);
					if (prior !== null) {
						result = { report: toReport(prior), responsibility: current, duplicate: true };
						return;
					}
				}
				if (!OPEN_STATUSES.has(current.status)) {
					result = { refused: "closed" };
					return;
				}
				// resumeWhen schedules the review, so it must state a time —
				// a condition that isn't a time needs a planned commitment.
				if (
					input.state === "waiting" &&
					Number.isNaN(Date.parse(input.resumeWhen ?? ""))
				) {
					result = { refused: "waiting-time" };
					return;
				}
				if (input.state === "done") {
					const missing = missingEvidence(
						current.understanding.completionEvidence,
						input.evidence ?? [],
					);
					if (missing.length > 0) {
						result = { refused: "evidence-missing", missing };
						return;
					}
				}
				const ts = now();
				const priorLatest = qLatestReport.get(id);
				const operations = qOpsFor.all(id).map((r) => toOperation(opRowSchema.parse(r)));
				const heldBefore =
					responsibilityStage(
						current,
						priorLatest === null ? null : toReport(priorLatest),
						operations,
					).waitsFor === "operator";
				const row = qInsertReport.get(
					id,
					// A worker states against the revision its run started from:
					// a correction since then must overtake its claim.
					Math.min(current.revision, opts?.revision ?? current.revision),
					reporter,
					input.state,
					input.reason,
					input.question ?? null,
					input.resumeWhen ?? null,
					JSON.stringify(input.evidence ?? []),
					opts?.sourceKey ?? null,
					input.purpose ?? "status",
					JSON.stringify(input.artifacts ?? []),
					ts,
				);
				const report = toReport(row);
				if (TERMINAL_REPORTS.has(input.state)) {
					qRespStatus.run("completed", ts, ts, id);
					qPlan.run(JSON.stringify(silenceFollowup(new Date(ts))), ts, id);
				} else if (input.state === "waiting" && input.resumeWhen !== undefined) {
					// Waiting parks at the stated time: the resumeWhen is the
					// next review, not the hourly silence bound.
					const plan: ResponsibilityFollowup = {
						token: randomUUID(),
						kind: "commitment",
						dueAt: new Date(input.resumeWhen).toISOString(),
						reason: input.reason.slice(0, 2000),
					};
					qPlan.run(JSON.stringify(plan), ts, id);
				} else if (
					// The silence held while the operator owned the move; leaving
					// that stage starts a fresh bound instead of firing the
					// backstop that went overdue during the hold.
					heldBefore &&
					current.followup.kind === "silence" &&
					responsibilityStage(current, report, operations).waitsFor !== "operator"
				) {
					qPlan.run(JSON.stringify(silenceFollowup(new Date(ts))), ts, id);
				}
				result = { report, responsibility: requireResp(id), duplicate: false };
			}).immediate();
			const r = result!;
			if ("refused" in r) {
				log.warn("responsibility report refused", {
					responsibility: id,
					state: input.state,
					reporter,
					refused: r.refused,
					missing: r.missing,
				});
			} else {
				log.info("responsibility report", {
					responsibility: id,
					report: r.report.reportId,
					state: r.report.state,
					reporter,
					revision: r.report.revision,
					question: r.report.question !== null,
					evidence: r.report.evidence.length,
					purpose: r.report.purpose,
					artifacts: r.report.artifacts.length,
					status: r.responsibility.status,
					duplicate: r.duplicate,
					source: r.report.sourceKey,
				});
			}
			return r;
		},
		latestReport(id) {
			const row = qLatestReport.get(id);
			return row === null ? null : toReport(row);
		},
		reportsFor: (id) => qReports.all(id).map(toReport),

		revise(id, understanding) {
			const parsed = understandingSchema.parse(understanding);
			db.transaction(() => {
				const ts = now();
				qRevise.run(JSON.stringify(parsed), parsed.outcome, ts, id);
				qPlan.run(JSON.stringify(silenceFollowup(new Date(ts))), ts, id);
			}).immediate();
			log.info("responsibility revised", { responsibility: id });
			return requireResp(id);
		},

		setFollowup(id, programId) {
			qFollowup.run(programId, now(), id);
		},
		planFollowup(id, commitment) {
			const parsed = followupCommitmentSchema.parse(commitment);
			const current = requireResp(id);
			const dueAt = new Date(parsed.dueAt).toISOString();
			if (
				current.followup.kind === "commitment" &&
				current.followup.dueAt === dueAt &&
				current.followup.reason === parsed.reason
			)
				return current;
			const plan: ResponsibilityFollowup = {
				...parsed,
				dueAt,
				token: randomUUID(),
				kind: "commitment",
			};
			qPlan.run(JSON.stringify(plan), now(), id);
			log.info("responsibility follow-up planned", { responsibility: id, ...plan });
			return requireResp(id);
		},
		consumeFollowup(id, token, at) {
			const row = qResp.get(id);
			if (row === null) throw new Error(`responsibility ${id} not found`);
			const current = toResponsibility(respRowSchema.parse(row));
			if (current.followup.token !== token) return false;
			// Compare the original disk representation, not reserialized
			// JSON: key order and timestamp normalization are not identity.
			const next = silenceFollowup(at);
			const changed =
				qConsumePlan.run(JSON.stringify(next), at.toISOString(), id, row.followup_json).changes > 0;
			if (changed)
				log.info("responsibility follow-up consumed", { responsibility: id, token, next });
			return changed;
		},
		deferSilenceFollowup(id, at) {
			const current = requireResp(id);
			if (current.followup.kind === "silence")
				store.consumeFollowup(id, current.followup.token, at);
		},
		setArmed(id, armed, reason) {
			qArmed.run(armed ? 1 : 0, reason, now(), id);
			if (!armed)
				log.warn("responsibility follow-through not armed", { responsibility: id, reason });
		},

		attach(input) {
			// Check-and-insert in one transaction, mirroring prepareOperation:
			// a reconciliation landing between the read and the insert could
			// not be honored by a fresh bind that never saw it.
			let att!: Attachment;
			db.transaction(() => {
				const blocked = qUnresolvedForIdentity.get(
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
					now(),
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
		attachmentsFor: (responsibilityId) =>
			qAtts.all(responsibilityId).map((r) => toAttachment(attRowSchema.parse(r))),
		getAttachment: (attachmentId) => {
			const row = qAtt.get(attachmentId);
			return row === null ? null : toAttachment(attRowSchema.parse(row));
		},
		setHealth(attachmentId, health) {
			qAttHealth.run(health, attachmentId);
			log.info("attachment health", { attachment: attachmentId, health });
		},
		updateCursor(attachmentId, cursor) {
			qAttCursor.run(JSON.stringify(cursor ?? null), attachmentId);
		},
		detach(attachmentId) {
			qAttDetach.run(now(), attachmentId);
			log.info("attachment detached", { attachment: attachmentId });
		},
		reattach(attachmentId, target, baseline, cursor, expected) {
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
					const blocked = qUnresolved.get(attachmentId, current.generation);
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
				qPlan.run(JSON.stringify(silenceFollowup(new Date())), now(), out.responsibilityId);
			}).immediate();
			log.info("attachment reattached", {
				attachment: attachmentId,
				generation: out.generation,
				agent: target.agentName,
				agentSession: target.agentSession,
			});
			return out;
		},

		prepareOperation(input) {
			const resp = store.get(input.responsibilityId);
			const att = store.getAttachment(input.attachmentId);
			const refusal = checkSendable(resp, att);
			if (refusal !== null) return { refused: refusal };
			// Check-and-insert in one transaction: the unresolved-op read
			// and the new row are one atomic step, so a racing claim can
			// never interleave a dispatch between them.
			let prepared:
				| { operation: PromptOperation }
				| { refused: SendRefusal; unresolved: PromptOperation };
			db.transaction(() => {
				// The fence is the dispatch identity, not the row: a duplicate
				// binding of the same agent must not reach the wire around an
				// unresolved send on its sibling.
				const blocked =
					qUnresolved.get(att!.attachmentId, att!.generation) ??
					qUnresolvedForIdentity.get(
						input.responsibilityId,
						att!.target.server,
						att!.target.session,
						att!.target.terminalId,
						att!.target.agentSession,
						att!.target.kind,
					);
				if (blocked !== null) {
					prepared = {
						refused: "delivery-uncertain",
						unresolved: toOperation(opRowSchema.parse(blocked)),
					};
					return;
				}
				const operationId = `op-${randomUUID()}`;
				qInsertOp.run(
					operationId,
					input.responsibilityId,
					input.attachmentId,
					att!.generation,
					resp!.revision,
					att!.target.server,
					att!.target.session,
					att!.target.terminalId,
					att!.target.agentSession,
					att!.target.kind,
					input.brief,
					input.journalRunId ?? null,
					input.toolCallId ?? null,
					now(),
				);
				prepared = { operation: store.getOperation(operationId)! };
			})();
			if ("refused" in prepared!) {
				log.warn("prompt operation refused — unresolved delivery on this attachment", {
					responsibility: input.responsibilityId,
					attachment: input.attachmentId,
					unresolved: prepared!.unresolved.operationId,
				});
				return prepared!;
			}
			const op = prepared!.operation;
			log.info("prompt operation prepared", {
				operation: op.operationId,
				responsibility: input.responsibilityId,
				attachment: input.attachmentId,
				generation: op.attachmentGeneration,
				revision: op.responsibilityRevision,
			});
			return prepared!;
		},
		getOperation: (operationId) => {
			const row = qOp.get(operationId);
			return row === null ? null : toOperation(opRowSchema.parse(row));
		},
		operationsFor: (responsibilityId) =>
			qOpsFor.all(responsibilityId).map((r) => toOperation(opRowSchema.parse(r))),

		validateForSend(operationId, expectedState = "prepared") {
			const row = qOp.get(operationId);
			// A vanished operation row is row-level corruption or a foreign
			// id — its own refusal, never the responsibility's.
			if (row === null) return { refused: "operation-missing" as const };
			const op = toOperation(opRowSchema.parse(row));
			// Operations that must never dispatch — their outcome is already on
			// the record or someone refused them by name.
			if (op.state !== expectedState) return { refused: "already-terminal" as const };
			const resp = store.get(op.responsibilityId);
			const att = store.getAttachment(op.attachmentId);
			const base = checkSendable(resp, att);
			if (base !== null) return { refused: base };
			if (att!.generation !== op.attachmentGeneration) return { refused: "stale-generation" };
			if (resp!.revision !== op.responsibilityRevision) return { refused: "stale-revision" };
			return { ok: true };
		},

		claimForSend(operationId) {
			let out!: { operation: PromptOperation } | { refused: SendRefusal };
			db.transaction(() => {
				const check = store.validateForSend(operationId);
				if ("refused" in check) {
					out = check;
					return;
				}
				// Two ops prepared before the first claim both validated —
				// the claim is the second fence: once a sibling is sent or
				// uncertain, this prepared op can never dispatch. The fence is
				// the dispatch identity, not the row: a duplicate binding of
				// the same agent is fenced with its sibling's operations.
				const op = store.getOperation(operationId)!;
				// validateForSend just refused a missing attachment in this same
				// transaction — requireAtt's throw is the unreachable-branch alarm.
				const att = requireAtt(op.attachmentId);
				// The fence's candidate is the identity this op dispatches
				// to: its own prepare-time snapshot, which a generation match
				// (checked above) makes identical to the bound row's current
				// target. A pre-snapshot row falls back to that same read.
				const identity = op.dispatch ?? att.target;
				const blocked =
					qUnresolved.get(op.attachmentId, op.attachmentGeneration) ??
					qUnresolvedForIdentity.get(
						op.responsibilityId,
						identity.server,
						identity.session,
						identity.terminalId,
						identity.agentSession,
						identity.kind,
					);
				if (blocked !== null) {
					out = { refused: "delivery-uncertain" };
					return;
				}
				const res = qOpClaim.run(now(), operationId);
				if (res.changes !== 1) {
					out = { refused: "already-terminal" };
					return;
				}
				out = { operation: store.getOperation(operationId)! };
			})();
			if ("operation" in out) {
				log.info("prompt operation claimed for dispatch", {
					operation: operationId,
					responsibility: out.operation.responsibilityId,
					run: out.operation.journalRunId,
				});
			}
			return out;
		},

		transitionOperation(operationId, to, opts) {
			const row = qOp.get(operationId);
			if (row === null) throw new Error(`prompt operation ${operationId} not found`);
			const from = opRowSchema.parse(row).state;
			if (from === to) return;
			if (opts?.from !== undefined && from !== opts.from) {
				log.info("prompt operation transition skipped — claim already moved", {
					operation: operationId,
					expected: opts.from,
					actual: from,
				});
				return;
			}
			if (!OP_EDGES[from]!.has(to)) {
				throw new Error(
					`prompt operation ${operationId}: ${from} → ${to} is not a legal operation transition`,
				);
			}
			// 'sent' records the dispatch instant; the rest leave sent_at alone.
			const sentAt = to === "sent" ? now() : null;
			const res = qOpTransition.run(
				to,
				opts?.refusal ?? null,
				opts?.runId ?? null,
				opts?.toolCallId ?? null,
				sentAt,
				opts?.outcome === undefined ? null : JSON.stringify(opts.outcome),
				operationId,
				from,
			);
			if (res.changes !== 1) {
				throw new Error(`prompt operation ${operationId}: ${from} → ${to} raced a transition`);
			}
			log.info("prompt operation transition", {
				operation: operationId,
				state: to,
				refusal: opts?.refusal ?? null,
			});
		},

		reconcileOperation(operationId, delivery, evidence) {
			const trimmed = evidence.trim();
			if (trimmed === "") {
				throw new Error("reconciliation requires inspected evidence");
			}
			let out!: PromptOperation;
			db.transaction(() => {
				const row = qOp.get(operationId);
				if (row === null) {
					throw new Error(`prompt operation ${operationId} not found`);
				}
				const op = toOperation(opRowSchema.parse(row));
				const prior =
					typeof op.outcome === "object" && op.outcome !== null
						? (op.outcome as Record<string, unknown>)
						: null;
				const existing =
					prior !== null &&
					typeof prior.reconciliation === "object" &&
					prior.reconciliation !== null
						? (prior.reconciliation as Record<string, unknown>)
						: null;
				if (existing !== null) {
					// The recorded verdict is the evidence trail — replaying
					// it verbatim is the idempotent no-op; anything else is a
					// conflict the operator resolves, never an overwrite.
					if (existing.delivery === delivery && existing.evidence === trimmed) {
						out = op;
						return;
					}
					throw new ReconciliationConflict(
						`prompt operation ${operationId} already reconciled as ${String(existing.delivery)}`,
					);
				}
				if (op.state !== "sent" && op.state !== "uncertain") {
					throw new ReconciliationConflict(
						`prompt operation ${operationId} is ${op.state} — only sent/uncertain operations reconcile`,
					);
				}
				const to: OperationState = delivery === "delivered" ? "acknowledged" : "refused";
				// Private CAS — uncertain deliberately has no public edge
				// to a terminal state; only this evidence-gated write may
				// close an ambiguous delivery.
				const res = qOpTransition.run(
					to,
					to === "refused" ? "not-delivered" : null,
					null,
					null,
					null,
					JSON.stringify({
						prior: op.outcome,
						reconciliation: { delivery, evidence: trimmed, at: now() },
					}),
					operationId,
					op.state,
				);
				if (res.changes !== 1) {
					throw new ReconciliationConflict(
						`prompt operation ${operationId} reconciliation raced a settlement`,
						op,
					);
				}
				out = store.getOperation(operationId)!;
			})();
			log.info("prompt operation reconciled", {
				operation: operationId,
				delivery,
				state: out.state,
			});
			return out;
		},
	};
	return store;
}

// Project-owned durable work — the records the handover loop stands
// on. A responsibility is not an agent run, a conversation, or a
// Program: it survives all three changing underneath it. Attachments
// bind explicitly selected T3 Code threads to it by stable identity
// (the thread id — there is no same-thread replacement to inherit).
// Generations
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
	ensureResponsibilitiesSchema,
	opRowSchema,
	respRowSchema,
	type RespRow,
	toAttachment,
	toOperation,
	toResponsibility,
} from "./responsibility-schema.ts";
import { responsibilityStage } from "./responsibility-stage.ts";
import { makeOperations } from "./responsibility-operations.ts";
import { makeAttachments } from "./responsibility-attachments.ts";
import { workerSendRefusal } from "./responsibility-authority.ts";
import {
	OPEN_STATUSES,
	type Attachment,
	type AttachmentHealth,
	type AttachmentTarget,
	type OperationState,
	type PromptOperation,
	type Responsibility,
	type ResponsibilityStatus,
	type SendRefusal,
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
	 *  resumeWhen that is not a future ISO-8601 instant refuses. */
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
	/** One failed poll of the attachment's target — bumps the durable
	 *  consecutive count and pins the outage start; returns the count. */
	markUnreachable(attachmentId: number, at: string): number;
	/** A successful reconcile clears the outage bookkeeping. */
	clearUnreachable(attachmentId: number): void;
	updateCursor(attachmentId: number, cursor: unknown): void;
	/** Detach marks the row; nothing about the T3 thread is touched. */
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
	/** Boot sweep: every operation still `sent` belongs to a dead
	 *  process — the dispatch in-flight set is process-local and empty
	 *  at construction, so nobody owes these rows a settlement. Moves
	 *  each through the ordinary sent → uncertain transition and
	 *  returns the ids moved. */
	markCrashedSendsUncertain(): string[];
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

// A waiting report's resumeWhen schedules a concrete review, so the
// value must pin an instant — ISO-8601 with date, time and zone — and
// point forward. Date.parse alone is too loose (Bun accepts "2" and
// "Nov 5") and says nothing about the past.
const RESUME_TIME_RE =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
function isResumeTime(resumeWhen: string | undefined): boolean {
	if (resumeWhen === undefined || !RESUME_TIME_RE.test(resumeWhen)) return false;
	const ms = Date.parse(resumeWhen);
	return !Number.isNaN(ms) && ms > Date.now();
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
	function requireResp(id: string): Responsibility {
		const row = qResp.get(id);
		if (row === null) throw new Error(`responsibility ${id} not found`);
		return toResponsibility(respRowSchema.parse(row));
	}

	// The named pre-dispatch check — refuses rather than guessing at a
	// stale responsibility, a detached agent, or an old generation.
	function checkSendable(resp: Responsibility | null, att: Attachment | null): SendRefusal | null {
		const refusal = workerSendRefusal(resp);
		if (refusal !== null) return refusal;
		if (att === null || att.health === "detached") return "attachment-detached";
		if (att.health === "missing" || att.health === "identity_changed") return "attachment-detached";
		if (att.responsibilityId !== resp!.responsibilityId) return "attachment-mismatch";
		return null;
	}

	let store!: ResponsibilityStore;
	let attachments!: ReturnType<typeof makeAttachments>;
	const operations = makeOperations({
		db,
		now,
		requireAtt: (attachmentId) => attachments.requireAtt(attachmentId),
		checkSendable,
		store: () => store,
	});
	attachments = makeAttachments({
		db,
		now,
		qPlan,
		qUnresolved: operations.qUnresolved,
		qUnresolvedForIdentity: operations.qUnresolvedForIdentity,
	});
	store = {
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
				// resumeWhen schedules the review, so it must state a future
				// instant — a condition that isn't a time needs a planned
				// commitment instead.
				if (
					input.state === "waiting" &&
					!isResumeTime(input.resumeWhen)
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
				const operationsForStage = operations.qOpsFor.all(id).map((r) =>
					toOperation(opRowSchema.parse(r)),
				);
				const heldBefore =
					responsibilityStage(
						current,
						priorLatest === null ? null : toReport(priorLatest),
						operationsForStage,
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
					responsibilityStage(current, report, operationsForStage).waitsFor !== "operator"
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

		...operations.methods,

		...attachments.methods,
	};
	return store;
}

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
// never blindly resent.
//
// Shares the conversation store's handle: attachments' cursor commits
// ride the observer's outer transaction with the work event + wake,
// and responsibility writes join handover/setup transactions. Same
// migrate-on-open discipline as the other stores.

import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { log } from "./log.ts";

export type ResponsibilityStatus =
	| "active"
	| "waiting_for_operator"
	| "blocked"
	| "paused"
	| "completed"
	| "cancelled";

export type AttachmentHealth = "attached" | "missing" | "identity_changed" | "detached";

export type OperationState =
	| "prepared"
	| "sent"
	| "acknowledged"
	| "uncertain"
	| "refused"
	| "superseded";

// The correctable understanding — what the operator edits. `outcome`
// is denormalized onto the row for listing; the json carries the rest.
export const understandingSchema = z.object({
	outcome: z.string(),
	situation: z.string(),
	nextAction: z.string(),
	checkpoints: z.array(z.string()),
	completionEvidence: z.array(z.string()),
});
export type Understanding = z.infer<typeof understandingSchema>;

export interface Responsibility {
	responsibilityId: string;
	projectId: string;
	status: ResponsibilityStatus;
	revision: number;
	understanding: Understanding;
	outcome: string;
	coordinationConversationId: string;
	handoverKey: string | null;
	followupProgramId: string | null;
	armed: boolean;
	notArmedReason: string | null;
	createdAt: string;
	updatedAt: string;
	closedAt: string | null;
}

export interface AttachmentTarget {
	/** Herdr target grouping: the server/session the operator session lives under. */
	server: string;
	session: string;
	agentName: string;
	paneId: string | null;
	terminalId: string | null;
	agentSession: string | null;
	kind: string | null;
	cwd: string | null;
}

export interface Attachment {
	attachmentId: number;
	responsibilityId: string;
	generation: number;
	target: AttachmentTarget;
	/** Observed state at bind — the reference the observer diffs against. */
	baseline: unknown;
	health: AttachmentHealth;
	/** Persisted observation cursor — sequence keys namespaced by generation. */
	cursor: unknown;
	createdAt: string;
	detachedAt: string | null;
}

export interface PromptOperation {
	operationId: string;
	responsibilityId: string;
	attachmentId: number;
	attachmentGeneration: number;
	responsibilityRevision: number;
	brief: string;
	state: OperationState;
	refusal: string | null;
	journalRunId: string | null;
	toolCallId: string | null;
	sentAt: string | null;
	outcome: unknown;
	createdAt: string;
}

export type SendRefusal =
	| "responsibility-missing"
	| "responsibility-inactive"
	| "attachment-detached"
	| "attachment-mismatch"
	| "stale-generation"
	| "stale-revision"
	| "already-terminal";

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
	/** A correction — the durable operator event that bumps revision. */
	revise(id: string, understanding: Understanding): Responsibility;
	setFollowup(id: string, programId: string | null): void;
	setArmed(id: string, armed: boolean, reason: string | null): void;

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
	 *  under the old generation refuse before dispatch. */
	reattach(attachmentId: number, target: AttachmentTarget, baseline: unknown): Attachment;

	/** Prepare a managed send: validates the live responsibility and
	 *  attachment, snapshots generation + revision, or refuses by name. */
	prepareOperation(input: {
		responsibilityId: string;
		attachmentId: number;
		brief: string;
		journalRunId?: string | undefined;
		toolCallId?: string | undefined;
	}): { operation: PromptOperation } | { refused: SendRefusal };
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
}

const respRowSchema = z.object({
	responsibility_id: z.string(),
	project_id: z.string(),
	status: z.enum([
		"active",
		"waiting_for_operator",
		"blocked",
		"paused",
		"completed",
		"cancelled",
	]),
	revision: z.number(),
	understanding_json: z.string(),
	outcome: z.string(),
	coordination_conversation_id: z.string(),
	handover_key: z.string().nullable(),
	followup_program_id: z.string().nullable(),
	armed: z.number(),
	not_armed_reason: z.string().nullable(),
	created_at: z.string(),
	updated_at: z.string(),
	closed_at: z.string().nullable(),
});
type RespRow = z.infer<typeof respRowSchema>;

const attRowSchema = z.object({
	attachment_id: z.number(),
	responsibility_id: z.string(),
	generation: z.number(),
	server: z.string(),
	session: z.string(),
	agent_name: z.string(),
	pane_id: z.string().nullable(),
	terminal_id: z.string().nullable(),
	agent_session: z.string().nullable(),
	kind: z.string().nullable(),
	cwd: z.string().nullable(),
	baseline_json: z.string(),
	health: z.enum(["attached", "missing", "identity_changed", "detached"]),
	cursor_json: z.string().nullable(),
	created_at: z.string(),
	detached_at: z.string().nullable(),
});
type AttRow = z.infer<typeof attRowSchema>;

const opRowSchema = z.object({
	operation_id: z.string(),
	responsibility_id: z.string(),
	attachment_id: z.number(),
	attachment_generation: z.number(),
	responsibility_revision: z.number(),
	brief: z.string(),
	state: z.enum(["prepared", "sent", "acknowledged", "uncertain", "refused", "superseded"]),
	refusal: z.string().nullable(),
	journal_run_id: z.string().nullable(),
	tool_call_id: z.string().nullable(),
	sent_at: z.string().nullable(),
	outcome_json: z.string().nullable(),
	created_at: z.string(),
});
type OpRow = z.infer<typeof opRowSchema>;

function toResponsibility(r: RespRow): Responsibility {
	return {
		responsibilityId: r.responsibility_id,
		projectId: r.project_id,
		status: r.status,
		revision: r.revision,
		understanding: understandingSchema.parse(JSON.parse(r.understanding_json)),
		outcome: r.outcome,
		coordinationConversationId: r.coordination_conversation_id,
		handoverKey: r.handover_key,
		followupProgramId: r.followup_program_id,
		armed: r.armed === 1,
		notArmedReason: r.not_armed_reason,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		closedAt: r.closed_at,
	};
}

function toAttachment(r: AttRow): Attachment {
	return {
		attachmentId: r.attachment_id,
		responsibilityId: r.responsibility_id,
		generation: r.generation,
		target: {
			server: r.server,
			session: r.session,
			agentName: r.agent_name,
			paneId: r.pane_id,
			terminalId: r.terminal_id,
			agentSession: r.agent_session,
			kind: r.kind,
			cwd: r.cwd,
		},
		baseline: JSON.parse(r.baseline_json),
		health: r.health,
		cursor: r.cursor_json === null ? null : JSON.parse(r.cursor_json),
		createdAt: r.created_at,
		detachedAt: r.detached_at,
	};
}

function toOperation(r: OpRow): PromptOperation {
	return {
		operationId: r.operation_id,
		responsibilityId: r.responsibility_id,
		attachmentId: r.attachment_id,
		attachmentGeneration: r.attachment_generation,
		responsibilityRevision: r.responsibility_revision,
		brief: r.brief,
		state: r.state,
		refusal: r.refusal,
		journalRunId: r.journal_run_id,
		toolCallId: r.tool_call_id,
		sentAt: r.sent_at,
		outcome: r.outcome_json === null ? null : JSON.parse(r.outcome_json),
		createdAt: r.created_at,
	};
}

const OP_EDGES: Readonly<Record<OperationState, ReadonlySet<OperationState>>> = {
	prepared: new Set(["sent", "refused", "superseded"]),
	sent: new Set(["acknowledged", "uncertain", "refused"]),
	acknowledged: new Set(),
	uncertain: new Set(),
	refused: new Set(),
	superseded: new Set(),
};

const OPEN_STATUSES: ReadonlySet<ResponsibilityStatus> = new Set([
	"active",
	"waiting_for_operator",
	"blocked",
	"paused",
]);

export function openResponsibilities(db: Database): ResponsibilityStore {
	db.run(`
		CREATE TABLE IF NOT EXISTS responsibilities (
			responsibility_id TEXT PRIMARY KEY,
			project_id TEXT NOT NULL REFERENCES projects(id),
			status TEXT NOT NULL CHECK (status IN ('active','waiting_for_operator','blocked','paused','completed','cancelled')),
			revision INTEGER NOT NULL DEFAULT 1,
			understanding_json TEXT NOT NULL,
			outcome TEXT NOT NULL,
			coordination_conversation_id TEXT NOT NULL REFERENCES conversations(id),
			handover_key TEXT UNIQUE,
			followup_program_id TEXT,
			armed INTEGER NOT NULL DEFAULT 0,
			not_armed_reason TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			closed_at TEXT
		)`);
	db.run(`
		CREATE TABLE IF NOT EXISTS attachments (
			attachment_id INTEGER PRIMARY KEY AUTOINCREMENT,
			responsibility_id TEXT NOT NULL REFERENCES responsibilities(responsibility_id),
			generation INTEGER NOT NULL DEFAULT 1,
			server TEXT NOT NULL,
			session TEXT NOT NULL,
			agent_name TEXT NOT NULL,
			pane_id TEXT,
			terminal_id TEXT,
			agent_session TEXT,
			kind TEXT,
			cwd TEXT,
			baseline_json TEXT NOT NULL,
			health TEXT NOT NULL DEFAULT 'attached' CHECK (health IN ('attached','missing','identity_changed','detached')),
			cursor_json TEXT,
			created_at TEXT NOT NULL,
			detached_at TEXT
		)`);
	db.run(
		"CREATE INDEX IF NOT EXISTS attachments_resp ON attachments (responsibility_id, health)",
	);
	db.run(`
		CREATE TABLE IF NOT EXISTS prompt_operations (
			operation_id TEXT PRIMARY KEY,
			responsibility_id TEXT NOT NULL REFERENCES responsibilities(responsibility_id),
			attachment_id INTEGER NOT NULL REFERENCES attachments(attachment_id),
			attachment_generation INTEGER NOT NULL,
			responsibility_revision INTEGER NOT NULL,
			brief TEXT NOT NULL,
			state TEXT NOT NULL CHECK (state IN ('prepared','sent','acknowledged','uncertain','refused','superseded')),
			refusal TEXT,
			journal_run_id TEXT,
			tool_call_id TEXT,
			sent_at TEXT,
			outcome_json TEXT,
			created_at TEXT NOT NULL
		)`);

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
		"SELECT * FROM responsibilities WHERE status IN ('active','waiting_for_operator','blocked','paused') ORDER BY created_at",
	);
	const qInsertResp = db.prepare(
		`INSERT INTO responsibilities (responsibility_id, project_id, status, understanding_json, outcome, coordination_conversation_id, handover_key, created_at, updated_at)
		 VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
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
	const qArmed = db.prepare(
		"UPDATE responsibilities SET armed = ?, not_armed_reason = ?, updated_at = ? WHERE responsibility_id = ?",
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
		`UPDATE attachments SET generation = generation + 1, server = ?, session = ?, agent_name = ?, pane_id = ?, terminal_id = ?, agent_session = ?, kind = ?, cwd = ?, baseline_json = ?, health = 'attached', cursor_json = NULL, detached_at = NULL WHERE attachment_id = ?`,
	);
	const qInsertOp = db.prepare(
		`INSERT INTO prompt_operations (operation_id, responsibility_id, attachment_id, attachment_generation, responsibility_revision, brief, state, journal_run_id, tool_call_id, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?)`,
	);
	const qOp = db.query<OpRow, [string]>("SELECT * FROM prompt_operations WHERE operation_id = ?");
	const qOpsFor = db.query<OpRow, [string]>(
		"SELECT * FROM prompt_operations WHERE responsibility_id = ? ORDER BY created_at",
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
	function checkSendable(
		resp: Responsibility | null,
		att: Attachment | null,
	): SendRefusal | null {
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
			const closed = OPEN_STATUSES.has(status) ? null : now();
			qRespStatus.run(status, now(), closed, id);
			log.info("responsibility status", { responsibility: id, status, reason: opts?.reason });
		},

		revise(id, understanding) {
			const parsed = understandingSchema.parse(understanding);
			qRevise.run(JSON.stringify(parsed), parsed.outcome, now(), id);
			log.info("responsibility revised", { responsibility: id });
			return requireResp(id);
		},

		setFollowup(id, programId) {
			qFollowup.run(programId, now(), id);
		},
		setArmed(id, armed, reason) {
			qArmed.run(armed ? 1 : 0, reason, now(), id);
			if (!armed) log.warn("responsibility follow-through not armed", { responsibility: id, reason });
		},

		attach(input) {
			const ts = now();
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
				ts,
			);
			const att = requireAtt(Number(ins.lastInsertRowid));
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
		reattach(attachmentId, target, baseline) {
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
				attachmentId,
			);
			const att = requireAtt(attachmentId);
			log.info("attachment reattached", {
				attachment: attachmentId,
				generation: att.generation,
				agent: target.agentName,
				agentSession: target.agentSession,
			});
			return att;
		},

		prepareOperation(input) {
			const resp = store.get(input.responsibilityId);
			const att = store.getAttachment(input.attachmentId);
			const refusal = checkSendable(resp, att);
			if (refusal !== null) return { refused: refusal };
			const operationId = `op-${randomUUID()}`;
			qInsertOp.run(
				operationId,
				input.responsibilityId,
				input.attachmentId,
				att!.generation,
				resp!.revision,
				input.brief,
				input.journalRunId ?? null,
				input.toolCallId ?? null,
				now(),
			);
			const op = store.getOperation(operationId)!;
			log.info("prompt operation prepared", {
				operation: operationId,
				responsibility: input.responsibilityId,
				attachment: input.attachmentId,
				generation: op.attachmentGeneration,
				revision: op.responsibilityRevision,
			});
			return { operation: op };
		},
		getOperation: (operationId) => {
			const row = qOp.get(operationId);
			return row === null ? null : toOperation(opRowSchema.parse(row));
		},
		operationsFor: (responsibilityId) =>
			qOpsFor.all(responsibilityId).map((r) => toOperation(opRowSchema.parse(r))),

		validateForSend(operationId, expectedState = "prepared") {
			const row = qOp.get(operationId);
			if (row === null) return { refused: "responsibility-missing" as const };
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
	};
	return store;
}

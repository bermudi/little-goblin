// The responsibilities row layer: zod row schemas and mappers for the
// three tables, plus ensureResponsibilitiesSchema — the DDL and the
// migrate-on-open backfills every handle runs before use. The store
// (responsibilities.ts) parses through these; conversation-schema.ts
// re-ensures the tables on the shared conversation handle.

import type { Database } from "bun:sqlite";
import { z } from "zod";
import { log } from "./log.ts";
import { followupSchema, silenceFollowup } from "./responsibility-followup.ts";
import { ensureReportsSchema } from "./responsibility-reports.ts";
import { understandingSchema, type Attachment, type PromptOperation, type Responsibility } from "./responsibility-types.ts";

export const respRowSchema = z.object({
	responsibility_id: z.string(),
	project_id: z.string(),
	status: z.enum(["active", "paused", "completed", "cancelled"]),
	revision: z.number(),
	understanding_json: z.string(),
	outcome: z.string(),
	coordination_conversation_id: z.string(),
	handover_key: z.string().nullable(),
	followup_program_id: z.string().nullable(),
	followup_json: z.string(),
	armed: z.number(),
	not_armed_reason: z.string().nullable(),
	created_at: z.string(),
	updated_at: z.string(),
	closed_at: z.string().nullable(),
});
export type RespRow = z.infer<typeof respRowSchema>;

export const attRowSchema = z.object({
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
export type AttRow = z.infer<typeof attRowSchema>;

export const opRowSchema = z.object({
	operation_id: z.string(),
	responsibility_id: z.string(),
	attachment_id: z.number(),
	attachment_generation: z.number(),
	responsibility_revision: z.number(),
	dispatch_server: z.string().nullable(),
	dispatch_session: z.string().nullable(),
	dispatch_terminal_id: z.string().nullable(),
	dispatch_agent_session: z.string().nullable(),
	dispatch_kind: z.string().nullable(),
	brief: z.string(),
	state: z.enum(["prepared", "sent", "acknowledged", "uncertain", "refused", "superseded"]),
	refusal: z.string().nullable(),
	journal_run_id: z.string().nullable(),
	tool_call_id: z.string().nullable(),
	sent_at: z.string().nullable(),
	outcome_json: z.string().nullable(),
	created_at: z.string(),
});
export type OpRow = z.infer<typeof opRowSchema>;

export function toResponsibility(r: RespRow): Responsibility {
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
		followup: followupSchema.parse(JSON.parse(r.followup_json)),
		armed: r.armed === 1,
		notArmedReason: r.not_armed_reason,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		closedAt: r.closed_at,
	};
}

export function toAttachment(r: AttRow): Attachment {
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

export function toOperation(r: OpRow): PromptOperation {
	return {
		operationId: r.operation_id,
		responsibilityId: r.responsibility_id,
		attachmentId: r.attachment_id,
		attachmentGeneration: r.attachment_generation,
		responsibilityRevision: r.responsibility_revision,
		dispatch:
			r.dispatch_server === null || r.dispatch_session === null
				? null
				: {
						server: r.dispatch_server,
						session: r.dispatch_session,
						terminalId: r.dispatch_terminal_id,
						agentSession: r.dispatch_agent_session,
						kind: r.dispatch_kind,
					},
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

// Driven by openStore alongside the other companion schemas — the FK
// from coordination_conversation_id and deleteConversation's anchor
// check need the tables present on every conversation-store handle.
// openResponsibilities re-ensures for standalone opens; both are
// idempotent.
export function ensureResponsibilitiesSchema(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS responsibilities (
			responsibility_id TEXT PRIMARY KEY,
			project_id TEXT NOT NULL REFERENCES projects(id),
			-- waiting_for_operator/blocked are legacy: migrated to reports on
			-- open and never written. The CHECK keeps them because narrowing
			-- it means rebuilding an FK-referenced table.
			status TEXT NOT NULL CHECK (status IN ('active','waiting_for_operator','blocked','paused','completed','cancelled')),
			revision INTEGER NOT NULL DEFAULT 1,
			understanding_json TEXT NOT NULL,
			outcome TEXT NOT NULL,
			coordination_conversation_id TEXT NOT NULL REFERENCES conversations(id),
			handover_key TEXT UNIQUE,
			followup_program_id TEXT,
			followup_json TEXT,
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
	db.run("CREATE INDEX IF NOT EXISTS attachments_resp ON attachments (responsibility_id, health)");
	db.run(`
		CREATE TABLE IF NOT EXISTS prompt_operations (
			operation_id TEXT PRIMARY KEY,
			responsibility_id TEXT NOT NULL REFERENCES responsibilities(responsibility_id),
			attachment_id INTEGER NOT NULL REFERENCES attachments(attachment_id),
			attachment_generation INTEGER NOT NULL,
			responsibility_revision INTEGER NOT NULL,
			dispatch_server TEXT,
			dispatch_session TEXT,
			dispatch_terminal_id TEXT,
			dispatch_agent_session TEXT,
			dispatch_kind TEXT,
			brief TEXT NOT NULL,
			state TEXT NOT NULL CHECK (state IN ('prepared','sent','acknowledged','uncertain','refused','superseded')),
			refusal TEXT,
			journal_run_id TEXT,
			tool_call_id TEXT,
			sent_at TEXT,
			outcome_json TEXT,
			created_at TEXT NOT NULL
		)`);
	db.transaction(() => {
		const columns = db.query<{ name: string }, []>("PRAGMA table_info(responsibilities)").all();
		if (!columns.some((c) => c.name === "followup_json")) {
			db.run("ALTER TABLE responsibilities ADD COLUMN followup_json TEXT");
		}
		const rows = db
			.query<{ responsibility_id: string; created_at: string }, []>(
				"SELECT responsibility_id, created_at FROM responsibilities WHERE followup_json IS NULL",
			)
			.all();
		const fill = db.prepare(
			"UPDATE responsibilities SET followup_json = ? WHERE responsibility_id = ?",
		);
		for (const row of rows) {
			fill.run(JSON.stringify(silenceFollowup(new Date(row.created_at))), row.responsibility_id);
		}
		if (rows.length > 0) log.info("responsibility follow-up plans migrated", { rows: rows.length });
	}).immediate();
	// Same migrate-on-open pattern as wake_deliveries.claim_epoch:
	// CREATE covers a fresh database, ALTER fills an existing one. The
	// dispatch identity is snapshotted on the operation so the
	// unresolved-delivery fence compares where the send actually went —
	// reattach rewrites the attachment row's identity fields, so a join
	// would re-key an unresolved send onto whatever the row points at
	// now. Legacy rows backfill from the bound attachment: the same
	// read the fence made before the snapshot existed.
	// Introspection, the missing-column ALTERs, and the backfill are
	// ONE immediate transaction — a crash between an autocommitted
	// ALTER and the UPDATE once left a half-migrated table the
	// dispatch_server sentinel could never finish. Columns are checked
	// individually (not just the sentinel) so a partial schema
	// completes, and only rows never snapshotted backfill — server is
	// required on every attachment, so NULL marks "unsnapshotted" and
	// real snapshots are never rewritten on reopen or reattach.
	let addedColumns = 0;
	let backfilled = 0;
	db.transaction(() => {
		const opCols = new Set(
			(db.query("PRAGMA table_info(prompt_operations)").all() as { name: string }[]).map(
				(c) => c.name,
			),
		);
		for (const col of [
			"dispatch_server",
			"dispatch_session",
			"dispatch_terminal_id",
			"dispatch_agent_session",
			"dispatch_kind",
		]) {
			if (opCols.has(col)) continue;
			db.run(`ALTER TABLE prompt_operations ADD COLUMN ${col} TEXT`);
			addedColumns++;
		}
		const pending = (
			db
				.query<{ n: number }, []>(
					"SELECT COUNT(*) AS n FROM prompt_operations WHERE dispatch_server IS NULL",
				)
				.get() ?? { n: 0 }
		).n;
		if (pending === 0) return;
		db.run(`
			UPDATE prompt_operations SET
				dispatch_server = (SELECT server FROM attachments a WHERE a.attachment_id = prompt_operations.attachment_id),
				dispatch_session = (SELECT session FROM attachments a WHERE a.attachment_id = prompt_operations.attachment_id),
				dispatch_terminal_id = (SELECT terminal_id FROM attachments a WHERE a.attachment_id = prompt_operations.attachment_id),
				dispatch_agent_session = (SELECT agent_session FROM attachments a WHERE a.attachment_id = prompt_operations.attachment_id),
				dispatch_kind = (SELECT kind FROM attachments a WHERE a.attachment_id = prompt_operations.attachment_id)
			WHERE dispatch_server IS NULL`);
		backfilled = pending;
	}).immediate();
	if (addedColumns > 0 || backfilled > 0) {
		log.info("prompt operation dispatch identity migrated", {
			columnsAdded: addedColumns,
			rowsBackfilled: backfilled,
		});
	}
	ensureReportsSchema(db);
	migrateLegacyStatuses(db);
}

// Stored waiting/blocked statuses predate reports: each becomes an
// active row plus a migration report that keeps the operator-facing
// stage (blocked → waits on the operator) — one immediate transaction,
// so a crash leaves either the old status or the full pair.
function migrateLegacyStatuses(db: Database): void {
	let migrated = 0;
	db.transaction(() => {
		const rows = db
			.query<{ responsibility_id: string; status: string; revision: number }, []>(
				"SELECT responsibility_id, status, revision FROM responsibilities WHERE status IN ('waiting_for_operator','blocked')",
			)
			.all();
		const ts = new Date().toISOString();
		const insert = db.prepare(
			`INSERT INTO responsibility_reports (responsibility_id, revision, reporter, state, reason, evidence_json, created_at)
			 VALUES (?, ?, 'migration', 'blocked', ?, '[]', ?)`,
		);
		const activate = db.prepare(
			"UPDATE responsibilities SET status = 'active', updated_at = ? WHERE responsibility_id = ?",
		);
		for (const row of rows) {
			insert.run(row.responsibility_id, row.revision, `stored status was ${row.status}`, ts);
			activate.run(ts, row.responsibility_id);
		}
		migrated = rows.length;
	}).immediate();
	if (migrated > 0)
		log.info("responsibility legacy statuses migrated to reports", { rows: migrated });
}

// The subagent_runs table — goblin's routing half of a run
// (design/subagents.md → Run state is rows). Pi Durable's own storage
// holds transcripts; this table holds what survives it: origin,
// status, the Pi conversation/submission ids needed to reacquire a
// run after restart, durable input intent, terminal outcome, export
// results, and whether the settle notice still owes a wake.
//
// Additive like sandboxes/desktops: CREATE TABLE IF NOT EXISTS on the
// shared goblin.sqlite, own file because nothing else reads it.

import { Database } from "bun:sqlite";
import { z } from "zod";
import { log } from "./log.ts";

export type SubagentKind = "worker" | "computer";
export type SubagentStatus =
	| "queued"
	| "running"
	| "needs_input"
	| "done"
	| "failed"
	| "stopped";

// Bounds enforced by the owner before a row is ever written.
export const MAX_TASK_CHARS = 20_000;
export const MAX_MESSAGE_CHARS = 16_000;
export const MAX_RESULT_CHARS = 16_000;
export const MAX_INPUT_FILES = 20;

/** How the persisted input intent reached the row — the admission
 *  path differs: initial submits the task, resume reopens a parked
 *  run, steer rides a live conversation. */
export type InputMode = "initial" | "resume" | "steer";

/** One completed (or refused) export step — deterministic so a
 *  restart reuses the artifact instead of recopying the box file. */
export type ExportProgress = Record<string, { rel: string } | { error: string }>;

export interface SubagentRun {
	id: number;
	kind: SubagentKind;
	/** The conversation that owns this run — status/send/stop are
	 *  refused for any other. */
	conversationId: string;
	/** The origin's working dir, captured at start — imports and the
	 *  export landing zone resolve against it. */
	workspace: string;
	/** Computer runs only: the desktop name they bind. */
	desktop: string | null;
	piConversationId: string | null;
	piSubmissionId: string | null;
	task: string;
	/** Workspace paths requested at start (as given), imported to inbox. */
	files: string[];
	/** Absolute in-box paths of the imported files. */
	inbox: string[];
	/** The native toolCallId for admission idempotence. */
	requestId: string | null;
	/** Monotonic input counter — `subagent:<id>:input:<rev>` is the
	 *  deterministic Pi requestId so a crash-and-resubmit is a no-op. */
	inputRev: number;
	/** Input text persisted before admit; non-null = in flight. */
	inputIntent: string | null;
	/** Which admission the persisted intent belongs to. */
	inputMode: InputMode | null;
	status: SubagentStatus;
	/** Stop intent lands BEFORE the Pi abort — a late settlement or a
	 *  mid-admission step can never overwrite it. */
	stopRequested: boolean;
	result: string | null;
	question: string | null;
	error: string | null;
	exportedFiles: string[];
	exportErrors: string[];
	/** Per-source export outcomes, persisted as each file lands. */
	exportProgress: ExportProgress;
	finalScreenshot: string | null;
	/** Latest destructive sandbox lifecycle note the run hasn't seen —
	 *  replaced, never cleared before a tool result carries it. */
	lifecycleNote: string | null;
	/** A settle/question notice still owes a wake (retry on scan). */
	noticePending: boolean;
	/** Bumped per notice so a stale ack can't clear a newer one. */
	noticeRev: number;
	createdAt: number;
	updatedAt: number;
	finishedAt: number | null;
}

const runRowSchema = z.object({
	id: z.number(),
	kind: z.enum(["worker", "computer"]),
	conversation_id: z.string(),
	workspace: z.string(),
	desktop: z.string().nullable(),
	pi_conversation_id: z.string().nullable(),
	pi_submission_id: z.string().nullable(),
	task: z.string(),
	files: z.string(),
	inbox: z.string(),
	request_id: z.string().nullable(),
	input_rev: z.number(),
	input_intent: z.string().nullable(),
	input_mode: z.enum(["initial", "resume", "steer"]).nullable(),
	status: z.enum(["queued", "running", "needs_input", "done", "failed", "stopped"]),
	stop_requested: z.number(),
	result: z.string().nullable(),
	question: z.string().nullable(),
	error: z.string().nullable(),
	exported_files: z.string(),
	export_errors: z.string(),
	export_progress: z.string(),
	final_screenshot: z.string().nullable(),
	lifecycle_note: z.string().nullable(),
	notice_pending: z.number(),
	notice_rev: z.number(),
	created_at: z.number(),
	updated_at: z.number(),
	finished_at: z.number().nullable(),
});

const jsonArray = (s: string): string[] => z.array(z.string()).parse(JSON.parse(s));

function toRun(row: unknown): SubagentRun {
	const r = runRowSchema.parse(row);
	return {
		id: r.id,
		kind: r.kind,
		conversationId: r.conversation_id,
		workspace: r.workspace,
		desktop: r.desktop,
		piConversationId: r.pi_conversation_id,
		piSubmissionId: r.pi_submission_id,
		task: r.task,
		files: jsonArray(r.files),
		inbox: jsonArray(r.inbox),
		requestId: r.request_id,
		inputRev: r.input_rev,
		inputIntent: r.input_intent,
		inputMode: r.input_mode,
		status: r.status,
		stopRequested: r.stop_requested !== 0,
		result: r.result,
		question: r.question,
		error: r.error,
		exportedFiles: jsonArray(r.exported_files),
		exportErrors: jsonArray(r.export_errors),
		exportProgress: z
			.record(z.string(), z.union([z.object({ rel: z.string() }), z.object({ error: z.string() })]))
			.parse(JSON.parse(r.export_progress)),
		finalScreenshot: r.final_screenshot,
		lifecycleNote: r.lifecycle_note,
		noticePending: r.notice_pending !== 0,
		noticeRev: r.notice_rev,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		finishedAt: r.finished_at,
	};
}

export interface SubagentRunPatch {
	status?: SubagentStatus;
	piConversationId?: string | null;
	piSubmissionId?: string | null;
	inbox?: string[];
	inputRev?: number;
	inputIntent?: string | null;
	inputMode?: InputMode | null;
	stopRequested?: boolean;
	result?: string | null;
	question?: string | null;
	error?: string | null;
	exportedFiles?: string[];
	exportErrors?: string[];
	exportProgress?: ExportProgress;
	finalScreenshot?: string | null;
	lifecycleNote?: string | null;
	noticePending?: boolean;
	noticeRev?: number;
	finishedAt?: number | null;
}

export interface SubagentRuns {
	create(input: {
		kind: SubagentKind;
		conversationId: string;
		workspace: string;
		desktop?: string | null;
		task: string;
		files?: string[];
		requestId?: string | null;
	}): SubagentRun;
	get(id: number): SubagentRun | null;
	/** Sparse update; updated_at always bumps. */
	update(id: number, patch: SubagentRunPatch): SubagentRun;
	listFor(conversationId: string): SubagentRun[];
	/** The sandbox lease the owner exposes to sandboxes.ts: a live
	 *  worker run on this conversation (queued/running/needs_input). */
	workerLease(conversationId: string): { id: number; status: SubagentStatus } | null;
	/** Every row that outlives a process restart. */
	unfinished(): SubagentRun[];
	/** Rows still owing a settle/question notice. */
	pendingNotices(): SubagentRun[];
	/** Rows whose stop intent may still owe a Pi abort/join — stop
	 *  is confirmed stopped only after the abort lands. */
	pendingStops(): SubagentRun[];
	/** Clear the pending flag only while the row's noticeRev is still
	 *  `rev` — a reentrant notice can't let an older ack clear a newer
	 *  pending. Returns false when the rev moved on. */
	ackNotice(id: number, rev: number): boolean;
	/** Merge one export outcome into the persisted progress map. */
	recordExport(id: number, source: string, outcome: { rel: string } | { error: string }): SubagentRun;
	/** Persist a destructive lifecycle note onto the conversation's
	 *  live worker run — repeat-until-replaced delivery, never a
	 *  clear-before-send gap (design/subagents.md). */
	noteLifecycle(conversationId: string, note: string): void;
	byPiConversation(piConversationId: string): SubagentRun | null;
	close(): void;
}

export function openSubagentRuns(dbPath: string): SubagentRuns {
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec(`CREATE TABLE IF NOT EXISTS subagent_runs (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		kind TEXT NOT NULL,
		conversation_id TEXT NOT NULL,
		workspace TEXT NOT NULL,
		desktop TEXT,
		pi_conversation_id TEXT,
		pi_submission_id TEXT,
		task TEXT NOT NULL,
		files TEXT NOT NULL DEFAULT '[]',
		inbox TEXT NOT NULL DEFAULT '[]',
		request_id TEXT,
		input_rev INTEGER NOT NULL DEFAULT 0,
		input_intent TEXT,
		input_mode TEXT,
		status TEXT NOT NULL,
		stop_requested INTEGER NOT NULL DEFAULT 0,
		result TEXT,
		question TEXT,
		error TEXT,
		exported_files TEXT NOT NULL DEFAULT '[]',
		export_errors TEXT NOT NULL DEFAULT '[]',
		export_progress TEXT NOT NULL DEFAULT '{}',
		final_screenshot TEXT,
		lifecycle_note TEXT,
		notice_pending INTEGER NOT NULL DEFAULT 0,
		notice_rev INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		finished_at INTEGER
	)`);
	// The table predates columns — ALTER each missing one; CREATE only
	// covers a fresh database.
	const cols = new Set(
		(db.query("PRAGMA table_info(subagent_runs)").all() as { name: string }[]).map(
			(c) => c.name,
		),
	);
	for (const [col, ddl] of [
		["input_mode", "ALTER TABLE subagent_runs ADD COLUMN input_mode TEXT"],
		[
			"stop_requested",
			"ALTER TABLE subagent_runs ADD COLUMN stop_requested INTEGER NOT NULL DEFAULT 0",
		],
		[
			"export_progress",
			"ALTER TABLE subagent_runs ADD COLUMN export_progress TEXT NOT NULL DEFAULT '{}'",
		],
		[
			"notice_rev",
			"ALTER TABLE subagent_runs ADD COLUMN notice_rev INTEGER NOT NULL DEFAULT 0",
		],
	] as const) {
		if (!cols.has(col)) db.exec(ddl);
	}
	const qGet = db.query("SELECT * FROM subagent_runs WHERE id = ?");
	const qCreate = db.query(
		`INSERT INTO subagent_runs
			(kind, conversation_id, workspace, desktop, task, files, request_id, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
	);
	const qList = db.query(
		"SELECT * FROM subagent_runs WHERE conversation_id = ? ORDER BY id",
	);
	// The lease holder is the row furthest along, not the oldest: a
	// parked (needs_input) or resuming (queued with a persisted input
	// intent) run beats an ordinary queued second worker, so a queued
	// row never steals the lease the active run resumes onto.
	const qLease = db.query(
		`SELECT * FROM subagent_runs
		 WHERE conversation_id = ? AND kind = 'worker'
		   AND status IN ('queued','running','needs_input')
		 ORDER BY
		   CASE WHEN status != 'queued' OR input_intent IS NOT NULL THEN 0 ELSE 1 END,
		   id`,
	);
	const qUnfinished = db.query(
		"SELECT * FROM subagent_runs WHERE status IN ('queued','running','needs_input') ORDER BY id",
	);
	const qNotices = db.query("SELECT * FROM subagent_runs WHERE notice_pending != 0 ORDER BY id");
	const qStops = db.query(
		`SELECT * FROM subagent_runs
		 WHERE stop_requested != 0 AND status != 'stopped' ORDER BY id`,
	);
	const qAck = db.query(
		"UPDATE subagent_runs SET notice_pending = 0, updated_at = ? WHERE id = ? AND notice_rev = ?",
	);
	const qProgress = db.query(
		"UPDATE subagent_runs SET export_progress = ?, updated_at = ? WHERE id = ?",
	);
	const qByPi = db.query("SELECT * FROM subagent_runs WHERE pi_conversation_id = ?");

	return {
		create(input) {
			const now = Date.now();
			const changes = qCreate.run(
				input.kind,
				input.conversationId,
				input.workspace,
				input.desktop ?? null,
				input.task,
				JSON.stringify(input.files ?? []),
				input.requestId ?? null,
				now,
				now,
			);
			return toRun(qGet.get(Number(changes.lastInsertRowid)));
		},
		get: (id) => {
			const row = qGet.get(id);
			return row === null ? null : toRun(row);
		},
		update(id, patch) {
			const sets: string[] = ["updated_at = ?"];
			const vals: (string | number | null)[] = [Date.now()];
			const put = (col: string, v: string | number | null) => {
				sets.push(`${col} = ?`);
				vals.push(v);
			};
			if (patch.status !== undefined) put("status", patch.status);
			if (patch.piConversationId !== undefined) put("pi_conversation_id", patch.piConversationId);
			if (patch.piSubmissionId !== undefined) put("pi_submission_id", patch.piSubmissionId);
			if (patch.inbox !== undefined) put("inbox", JSON.stringify(patch.inbox));
			if (patch.inputRev !== undefined) put("input_rev", patch.inputRev);
			if (patch.inputIntent !== undefined) put("input_intent", patch.inputIntent);
			if (patch.inputMode !== undefined) put("input_mode", patch.inputMode);
			if (patch.stopRequested !== undefined) put("stop_requested", patch.stopRequested ? 1 : 0);
			if (patch.result !== undefined) put("result", patch.result);
			if (patch.question !== undefined) put("question", patch.question);
			if (patch.error !== undefined) put("error", patch.error);
			if (patch.exportedFiles !== undefined) put("exported_files", JSON.stringify(patch.exportedFiles));
			if (patch.exportErrors !== undefined) put("export_errors", JSON.stringify(patch.exportErrors));
			if (patch.exportProgress !== undefined) put("export_progress", JSON.stringify(patch.exportProgress));
			if (patch.finalScreenshot !== undefined) put("final_screenshot", patch.finalScreenshot);
			if (patch.lifecycleNote !== undefined) put("lifecycle_note", patch.lifecycleNote);
			if (patch.noticePending !== undefined) put("notice_pending", patch.noticePending ? 1 : 0);
			if (patch.noticeRev !== undefined) put("notice_rev", patch.noticeRev);
			if (patch.finishedAt !== undefined) put("finished_at", patch.finishedAt);
			vals.push(id);
			db.query(`UPDATE subagent_runs SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
			return toRun(qGet.get(id));
		},
		listFor: (conv) => qList.all(conv).map(toRun),
		workerLease(conv) {
			const holder = qLease.all(conv).map(toRun)[0];
			return holder === undefined ? null : { id: holder.id, status: holder.status };
		},
		unfinished: () => qUnfinished.all().map(toRun),
		pendingNotices: () => qNotices.all().map(toRun),
		pendingStops: () => qStops.all().map(toRun),
		ackNotice(id, rev) {
			return qAck.run(Date.now(), id, rev).changes > 0;
		},
		recordExport(id, source, outcome) {
			const row = qGet.get(id);
			if (row === null) throw new Error(`no subagent run #${id}`);
			const cur = toRun(row).exportProgress;
			cur[source] = outcome;
			qProgress.run(JSON.stringify(cur), Date.now(), id);
			return toRun(qGet.get(id));
		},
		noteLifecycle(conv, note) {
			const holder = qLease.all(conv).map(toRun)[0];
			// A stopped/stopping run never gains a note — its tools are
			// already fenced and the message would arrive nowhere.
			if (holder === undefined || holder.stopRequested) return;
			db.query("UPDATE subagent_runs SET lifecycle_note = ?, updated_at = ? WHERE id = ?").run(
				note,
				Date.now(),
				holder.id,
			);
			log.info("subagent lifecycle note persisted", { run: holder.id });
		},
		byPiConversation: (piConv) => {
			const row = qByPi.get(piConv);
			return row === null ? null : toRun(row);
		},
		close: () => db.close(),
	};
}

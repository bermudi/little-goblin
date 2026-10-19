// Rows survive goblin restarts in the shared WAL file while the herdr
// unit keeps the panes alive; the watcher lives in delegation-lifecycle.ts.

import { Database } from "bun:sqlite";
import { z } from "zod";
import { SQLITE_BUSY_TIMEOUT_MS } from "./sqlite.ts";

export type DelegationStatus =
	| "starting"
	| "running"
	| "needs_input"
	| "done"
	| "failed"
	| "stopped";

export interface Delegation {
	id: number;
	name: string;
	harness: string;
	cwd: string;
	task: string;
	// Pinned Telegram address — notices land where it was delegated.
	chatId: number;
	threadId: number | null;
	// Pinned app conversation instead — a spin-off wakes its own
	// background turn; chat_id/thread_id are the 0/NULL fillers then.
	appConversation: string | null;
	agentName: string;
	workspaceId: string;
	paneId: string;
	status: DelegationStatus;
	// herdr target label (config `delegation.machines` key) — null =
	// goblin's own local session; every herdr call resolves its adapter
	// through this.
	target: string | null;
	// state_change_seq observed right after the last prompt — null while
	// pending: the post-prompt read failed and the watcher captures the
	// current seq before applying any verdict.
	baselineSeq: number | null;
	promptedAt: string;
	// The task text was never delivered — the launch parked on a startup
	// dialog; the watcher delivers it on the first seq advance past the park.
	promptPending: boolean;
	createdAt: string;
	finishedAt: string | null;
}

export interface CreateDelegation {
	name: string;
	harness: string;
	cwd: string;
	task: string;
	address: { chatId: number; threadId: number | null };
	appConversation?: string;
	target?: string | null;
}

export interface DelegationsStore {
	// Inserts status "starting" with empty launch ids — the row goes
	// running via markRunning only once the prompt has landed.
	create(input: CreateDelegation, now?: Date): Delegation;
	bindLaunch(
		id: number,
		launch: { agentName: string; workspaceId: string; paneId: string },
	): Delegation | null;
	// A null baseline records the pending posture: the post-prompt read
	// failed and the watcher captures on its next scan. Null return means
	// a `stop` won the race while herdr was launching.
	markRunning(id: number, baselineSeq: number | null, promptedAt: Date): Delegation | null;
	// needs_input + prompt_pending + the park-time seq baseline,
	// atomically — the watcher owes the prompt only on an advance past
	// that point. Null = the park-time read failed; the next scan
	// captures before delivering anything.
	markParked(id: number, baselineSeq: number | null): void;
	// Record the seq the scan finally observes, under the same CAS as
	// every watcher write — a send/stop that landed mid-get wins and its
	// own baseline stands. False means superseded.
	captureBaseline(
		id: number,
		expect: { status: DelegationStatus; promptedAt: string },
		seq: number,
	): boolean;
	// Compare-and-set: apply the transition only if the row is still
	// exactly what the scan read — a tool-side send/stop that landed
	// mid-notice wins and is never overwritten.
	transitionIf(
		id: number,
		expect: { status: DelegationStatus; promptedAt: string },
		to: DelegationStatus,
		baseline?: number,
		now?: Date,
	): boolean;
	setStatus(id: number, status: DelegationStatus, now?: Date): void;
	get(id: number): Delegation | null;
	list(): Delegation[];
	// Rows the watcher still owes a verdict: running + needs_input.
	active(): Delegation[];
	// A `starting` row across a restart means goblin died mid-start.
	starting(): Delegation[];
	close(): void;
}

const delegationSchema = z.object({
	id: z.number(),
	name: z.string(),
	harness: z.string(),
	cwd: z.string(),
	task: z.string(),
	chat_id: z.number(),
	thread_id: z.number().nullable(),
	app_conversation: z.string().nullable(),
	agent_name: z.string(),
	workspace_id: z.string(),
	pane_id: z.string(),
	status: z.enum(["starting", "running", "needs_input", "done", "failed", "stopped"]),
	target: z.string().nullable(),
	baseline_seq: z.number().nullable(),
	prompted_at: z.string(),
	prompt_pending: z.number(),
	created_at: z.string(),
	finished_at: z.string().nullable(),
});

const TERMINAL: ReadonlySet<DelegationStatus> = new Set(["done", "failed", "stopped"]);

function rowToDelegation(row: unknown): Delegation {
	const r = delegationSchema.parse(row);
	return {
		id: r.id,
		name: r.name,
		harness: r.harness,
		cwd: r.cwd,
		task: r.task,
		chatId: r.chat_id,
		threadId: r.thread_id,
		appConversation: r.app_conversation,
		agentName: r.agent_name,
		workspaceId: r.workspace_id,
		paneId: r.pane_id,
		status: r.status,
		target: r.target,
		baselineSeq: r.baseline_seq,
		promptedAt: r.prompted_at,
		promptPending: r.prompt_pending === 1,
		createdAt: r.created_at,
		finishedAt: r.finished_at,
	};
}

// `g<id>-<slug>` in herdr's agent-name charset ([a-z][a-z0-9_-]{0,31}).
export function agentNameFor(id: number, name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return `g${id}-${slug || "delegation"}`.slice(0, 32);
}

// One column list for the fresh-table CREATE and the NOT NULL → nullable
// rebuild below: NULL baseline_seq is the baseline-pending posture.
const DELEGATIONS_COLUMNS = `
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL,
		harness TEXT NOT NULL,
		cwd TEXT NOT NULL,
		task TEXT NOT NULL,
		chat_id INTEGER NOT NULL,
		thread_id INTEGER,
		agent_name TEXT NOT NULL,
		workspace_id TEXT NOT NULL,
		pane_id TEXT NOT NULL,
		status TEXT NOT NULL,
		target TEXT,
		baseline_seq INTEGER,
		prompted_at TEXT NOT NULL,
		created_at TEXT NOT NULL,
		finished_at TEXT,
		app_conversation TEXT,
		prompt_pending INTEGER NOT NULL DEFAULT 0`;

export function openDelegations(dbPath: string): DelegationsStore {
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
	db.exec(`CREATE TABLE IF NOT EXISTS delegations (${DELEGATIONS_COLUMNS})`);
	// Rows predating the app-conversation pin — additive column, no
	// rebuild. NULL = Telegram-pinned like always.
	const cols = new Set(
		db
			.query<{ name: string }, []>("PRAGMA table_info(delegations)")
			.all()
			.map((c) => c.name),
	);
	if (!cols.has("app_conversation")) {
		db.exec("ALTER TABLE delegations ADD COLUMN app_conversation TEXT");
	}
	// Predates startup-park launches: the prompt could be owed forever
	// when a first-run dialog blocked the send. 0 = delivered.
	if (!cols.has("prompt_pending")) {
		db.exec("ALTER TABLE delegations ADD COLUMN prompt_pending INTEGER NOT NULL DEFAULT 0");
	}
	// Predates machine targets: NULL = own local session.
	if (!cols.has("target")) {
		db.exec("ALTER TABLE delegations ADD COLUMN target TEXT");
	}
	// Predates the baseline-pending posture: baseline_seq was NOT NULL, so
	// a failed post-prompt read had to record some pre-prompt number — a
	// stale comparison the next poll could turn into a spurious done. NULL
	// now means pending; ALTER TABLE cannot drop a NOT NULL, so this is
	// the one rebuild migration.
	const baselineCol = db
		.query<{ name: string; notnull: number }, []>("PRAGMA table_info(delegations)")
		.all()
		.find((c) => c.name === "baseline_seq");
	if (baselineCol !== undefined && baselineCol.notnull === 1) {
		db.exec("BEGIN IMMEDIATE");
		try {
			db.exec(`CREATE TABLE delegations_migrated (${DELEGATIONS_COLUMNS})`);
			db.exec(`INSERT INTO delegations_migrated
				(id, name, harness, cwd, task, chat_id, thread_id, agent_name, workspace_id, pane_id, status, target, baseline_seq, prompted_at, created_at, finished_at, app_conversation, prompt_pending)
				SELECT id, name, harness, cwd, task, chat_id, thread_id, agent_name, workspace_id, pane_id, status, target, baseline_seq, prompted_at, created_at, finished_at, app_conversation, prompt_pending
				FROM delegations`);
			db.exec("DROP TABLE delegations");
			db.exec("ALTER TABLE delegations_migrated RENAME TO delegations");
			db.exec("COMMIT");
		} catch (err) {
			db.exec("ROLLBACK");
			throw err;
		}
	}

	const qGet = db.query("SELECT * FROM delegations WHERE id = ?");
	const qList = db.query("SELECT * FROM delegations ORDER BY id");
	const qActive = db.query(
		"SELECT * FROM delegations WHERE status IN ('running','needs_input') ORDER BY id",
	);
	const qStarting = db.query("SELECT * FROM delegations WHERE status = 'starting' ORDER BY id");
	const qInsert = db.query(`INSERT INTO delegations
		(name, harness, cwd, task, chat_id, thread_id, agent_name, workspace_id, pane_id, status, target, baseline_seq, prompted_at, created_at, finished_at, app_conversation)
		VALUES (?, ?, ?, ?, ?, ?, '', '', '', 'starting', ?, 0, ?, ?, NULL, ?)`);
	const qBind = db.query(
		"UPDATE delegations SET agent_name = ?, workspace_id = ?, pane_id = ? WHERE id = ?",
	);
	const qRunning = db.query(
		"UPDATE delegations SET baseline_seq = ?, prompted_at = ?, status = 'running', finished_at = NULL, prompt_pending = 0 WHERE id = ? AND status != 'stopped'",
	);
	const qParked = db.query(
		"UPDATE delegations SET status = 'needs_input', prompt_pending = 1, baseline_seq = ? WHERE id = ? AND status != 'stopped'",
	);
	// Same CAS shape as qTransition, baseline only — plus the pending
	// guard (baseline_seq IS NULL), so a send that landed mid-get in the
	// same millisecond still keeps its own baseline.
	const qCaptureBaseline = db.query(
		"UPDATE delegations SET baseline_seq = ? WHERE id = ? AND status = ? AND prompted_at = ? AND baseline_seq IS NULL",
	);
	const qTransition = db.query(
		`UPDATE delegations SET status = ?, finished_at = ?,
			baseline_seq = COALESCE(?, baseline_seq)
		WHERE id = ? AND status = ? AND prompted_at = ?`,
	);
	const qStatus = db.query("UPDATE delegations SET status = ?, finished_at = ? WHERE id = ?");

	return {
		create({ name, harness, cwd, task, address, appConversation, target }, now = new Date()) {
			const ts = now.toISOString();
			const res = qInsert.run(
				name,
				harness,
				cwd,
				task,
				address.chatId,
				address.threadId,
				target ?? null,
				ts,
				ts,
				appConversation ?? null,
			);
			return rowToDelegation(qGet.get(Number(res.lastInsertRowid)));
		},
		bindLaunch(id, launch) {
			qBind.run(launch.agentName, launch.workspaceId, launch.paneId, id);
			const row = qGet.get(id);
			return row === null ? null : rowToDelegation(row);
		},
		markRunning(id, baselineSeq, promptedAt) {
			qRunning.run(baselineSeq, promptedAt.toISOString(), id);
			const row = qGet.get(id);
			if (row === null) return null;
			const d = rowToDelegation(row);
			return d.status === "running" ? d : null;
		},
		markParked(id, baselineSeq) {
			qParked.run(baselineSeq, id);
		},
		captureBaseline(id, expect, seq) {
			const res = qCaptureBaseline.run(seq, id, expect.status, expect.promptedAt);
			return res.changes > 0;
		},
		transitionIf(id, expect, to, baseline, now = new Date()) {
			const res = qTransition.run(
				to,
				TERMINAL.has(to) ? now.toISOString() : null,
				baseline ?? null,
				id,
				expect.status,
				expect.promptedAt,
			);
			return res.changes > 0;
		},
		setStatus(id, status, now = new Date()) {
			qStatus.run(status, TERMINAL.has(status) ? now.toISOString() : null, id);
		},
		get(id) {
			const row = qGet.get(id);
			return row === null ? null : rowToDelegation(row);
		},
		list() {
			return qList.all().map(rowToDelegation);
		},
		active() {
			return qActive.all().map(rowToDelegation);
		},
		starting() {
			return qStarting.all().map(rowToDelegation);
		},
		close() {
			db.close();
		},
	};
}

// The delegations table (DESIGN.md, "Delegation"). State is rows in
// goblin.sqlite, own connection, same WAL file as the programs and
// conversation stores — rows survive goblin restarts while the herdr
// unit keeps the panes alive. Pure rows: the watcher that polls them
// lives in delegation-lifecycle.ts, and the delegate tool reaches the
// table only through it — this module is the durable store both write
// through.

import { Database } from "bun:sqlite";
import { z } from "zod";

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
	/** Pinned Telegram address — notices land where it was delegated. */
	chatId: number;
	threadId: number | null;
	agentName: string;
	workspaceId: string;
	paneId: string;
	status: DelegationStatus;
	/** state_change_seq observed right after the last prompt. */
	baselineSeq: number;
	promptedAt: string;
	createdAt: string;
	finishedAt: string | null;
}

export interface CreateDelegation {
	name: string;
	harness: string;
	cwd: string;
	task: string;
	address: { chatId: number; threadId: number | null };
}

export interface DelegationsStore {
	/** Inserts status "starting" with empty launch ids — the watcher
	 *  never touches it; the row goes running via markRunning only
	 *  once the prompt has landed. */
	create(input: CreateDelegation, now?: Date): Delegation;
	bindLaunch(
		id: number,
		launch: { agentName: string; workspaceId: string; paneId: string },
	): Delegation | null;
	/** Launch completed: baseline + prompt timestamp + status running
	 *  in one UPDATE. Returns the row, or null when a `stop` won the
	 *  race while herdr was launching (a stopped row stays stopped). */
	markRunning(id: number, baselineSeq: number, promptedAt: Date): Delegation | null;
	/** Watcher-side compare-and-set: apply the transition only if the
	 *  row is still exactly what the scan read (same status and
	 *  prompted_at) — a tool-side send/stop that landed while the
	 *  notice was in flight wins and is never overwritten. baseline,
	 *  when given, folds a park-time re-baseline into the same UPDATE. */
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
	/** Rows the watcher still owes a verdict: running + needs_input. */
	active(): Delegation[];
	/** Everything that can still consume a herdr slot — the start
	 *  tool's concurrency cap: starting + running + needs_input. */
	live(): Delegation[];
	/** Rows stuck mid-launch — only meaningful to a fresh watcher:
	 *  a `starting` row across a restart means goblin died mid-start. */
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
	agent_name: z.string(),
	workspace_id: z.string(),
	pane_id: z.string(),
	status: z.enum(["starting", "running", "needs_input", "done", "failed", "stopped"]),
	baseline_seq: z.number(),
	prompted_at: z.string(),
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
		agentName: r.agent_name,
		workspaceId: r.workspace_id,
		paneId: r.pane_id,
		status: r.status,
		baselineSeq: r.baseline_seq,
		promptedAt: r.prompted_at,
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

export function openDelegations(dbPath: string): DelegationsStore {
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec(`CREATE TABLE IF NOT EXISTS delegations (
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
		baseline_seq INTEGER NOT NULL DEFAULT 0,
		prompted_at TEXT NOT NULL,
		created_at TEXT NOT NULL,
		finished_at TEXT
	)`);

	const qGet = db.query("SELECT * FROM delegations WHERE id = ?");
	const qList = db.query("SELECT * FROM delegations ORDER BY id");
	const qActive = db.query(
		"SELECT * FROM delegations WHERE status IN ('running','needs_input') ORDER BY id",
	);
	const qLive = db.query(
		"SELECT * FROM delegations WHERE status IN ('starting','running','needs_input') ORDER BY id",
	);
	const qStarting = db.query(
		"SELECT * FROM delegations WHERE status = 'starting' ORDER BY id",
	);
	const qInsert = db.query(`INSERT INTO delegations
		(name, harness, cwd, task, chat_id, thread_id, agent_name, workspace_id, pane_id, status, baseline_seq, prompted_at, created_at, finished_at)
		VALUES (?, ?, ?, ?, ?, ?, '', '', '', 'starting', 0, ?, ?, NULL)`);
	const qBind = db.query(
		"UPDATE delegations SET agent_name = ?, workspace_id = ?, pane_id = ? WHERE id = ?",
	);
	const qRunning = db.query(
		"UPDATE delegations SET baseline_seq = ?, prompted_at = ?, status = 'running', finished_at = NULL WHERE id = ? AND status != 'stopped'",
	);
	const qTransition = db.query(
		`UPDATE delegations SET status = ?, finished_at = ?,
			baseline_seq = COALESCE(?, baseline_seq)
		WHERE id = ? AND status = ? AND prompted_at = ?`,
	);
	const qStatus = db.query(
		"UPDATE delegations SET status = ?, finished_at = ? WHERE id = ?",
	);

	return {
		create({ name, harness, cwd, task, address }, now = new Date()) {
			const ts = now.toISOString();
			const res = qInsert.run(
				name, harness, cwd, task, address.chatId, address.threadId, ts, ts,
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
		live() {
			return qLive.all().map(rowToDelegation);
		},
		starting() {
			return qStarting.all().map(rowToDelegation);
		},
		close() {
			db.close();
		},
	};
}

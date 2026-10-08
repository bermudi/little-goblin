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
	/** Pinned app conversation instead — a spin-off (or an app-native
	 *  delegation) wakes its own background turn; chat_id/thread_id
	 *  are the 0/NULL fillers then (design/app.md → Spin-off). */
	appConversation: string | null;
	agentName: string;
	workspaceId: string;
	paneId: string;
	status: DelegationStatus;
	/** herdr target label (config `delegation.machines` key) — null =
	 *  goblin's own local session, the default target. IDs and agent
	 *  names are scoped per server, so every herdr call resolves its
	 *  adapter through this. */
	target: string | null;
	/** state_change_seq observed right after the last prompt. */
	baselineSeq: number;
	promptedAt: string;
	/** The task text was never delivered — the launch parked on a
	 *  startup dialog before `agent prompt` could run. The watcher
	 *  delivers it on the first seq advance past the park. */
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
	/** Set by a spin-off launch — the row pins the app conversation
	 *  and address carries the 0/NULL fillers. */
	appConversation?: string;
	/** Target label; omitted/null = own local session. */
	target?: string | null;
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
	 *  in one UPDATE — also clears a pending task prompt (the deliverer
	 *  writes prompted_at exactly once). Returns the row, or null when
	 *  a `stop` won the race while herdr was launching. */
	markRunning(id: number, baselineSeq: number, promptedAt: Date): Delegation | null;
	/** The launch parked on a startup dialog before the task could be
	 *  prompted: needs_input + prompt_pending + the park-time seq
	 *  baseline, atomically — the watcher owes the prompt only on an
	 *  advance past that point. */
	markParked(id: number, baselineSeq: number): void;
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
	/** Rows stuck mid-launch — only meaningful to a fresh watcher:
	 *  a `starting` row across a restart means goblin died mid-start. */
	starting(): Delegation[];
	/** One-shot upgrade (single-machine era → targets): under
	 *  delegation.machine, EVERY live row ran on that machine —
	 *  stamp the translated label onto rows that predate the target
	 *  column so NULL (own local session) never misroutes remote
	 *  work. Returns how many rows moved. */
	retargetLegacyLiveRows(label: string): number;
	/** Live rows still carrying NULL target — used only to warn when
	 *  no legacy machine block explains them (they are assumed
	 *  local, the pre-machines meaning). */
	liveRowsWithNullTarget(): number;
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
	baseline_seq: z.number(),
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
		target TEXT,
		baseline_seq INTEGER NOT NULL DEFAULT 0,
		prompted_at TEXT NOT NULL,
		created_at TEXT NOT NULL,
		finished_at TEXT,
		app_conversation TEXT
	)`);
	// Existing DBs predate the spin-off pin — additive column, no rebuild
	// (design/app.md → Spin-off). NULL = Telegram-pinned like always.
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
	// Predates machine targets: rows always meant the own local session.
	// NULL = own local session (design/delegation.md, "Targets").
	if (!cols.has("target")) {
		db.exec("ALTER TABLE delegations ADD COLUMN target TEXT");
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
		retargetLegacyLiveRows(label) {
			const r = db.run(
				"UPDATE delegations SET target = ? WHERE target IS NULL AND status IN ('starting','running','needs_input')",
				[label],
			);
			return r.changes;
		},
		liveRowsWithNullTarget() {
			const row = db
				.query(
					"SELECT COUNT(*) AS n FROM delegations WHERE target IS NULL AND status IN ('starting','running','needs_input')",
				)
				.get() as { n: number } | null;
			return row?.n ?? 0;
		},
		close() {
			db.close();
		},
	};
}

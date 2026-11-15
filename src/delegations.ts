// Rows survive goblin restarts in the shared WAL file while the herdr
// unit keeps the panes alive; the watcher lives in delegation-watcher.ts.

import { Database } from "bun:sqlite";
import { z } from "zod";
import { SQLITE_BUSY_TIMEOUT_MS } from "./sqlite.ts";
import { log } from "./log.ts";
import { githubIssueSchema, prReadinessSchema, readinessKey, type GithubIssue, type PrReadiness } from "./pr-readiness.ts";

export type DelegationStatus =
	| "starting"
	| "running"
	| "needs_input"
	| "done"
	| "failed"
	| "stopped";
export type DelegationVerdict = "done" | "needs input" | "failed" | "stopped";

export interface Delegation {
	id: number;
	name: string;
	harness: string;
	role: string;
	issue: GithubIssue | null;
	readiness: PrReadiness | null;
	readinessNotifiedKey: string | null;
	readinessVersion: number;
	readinessPendingVerdict: DelegationVerdict | null;
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
	// Linked responsibility: each settlement files a worker report on it.
	responsibilityId: string | null;
	// The revision the delegation started from; a later correction
	// overtakes its claim.
	responsibilityRevision: number | null;
	createdAt: string;
	finishedAt: string | null;
}

export interface CreateDelegation {
	name: string;
	harness: string;
	role?: string;
	issue?: GithubIssue;
	cwd: string;
	task: string;
	address: { chatId: number; threadId: number | null };
	appConversation?: string;
	target?: string | null;
	responsibilityId?: string | null;
	responsibilityRevision?: number | null;
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
	recordReadiness(id: number, expect: Delegation, readiness: PrReadiness, notified?: boolean, verdict?: DelegationVerdict): boolean;
	close(): void;
}

const delegationSchema = z.object({
	id: z.number(),
	name: z.string(),
	harness: z.string(),
	role: z.string(),
	issue_json: z.string().nullable(),
	readiness_json: z.string().nullable(),
	readiness_notified_key: z.string().nullable(),
	readiness_version: z.number().int().nonnegative(),
	readiness_pending_verdict: z.enum(["done", "needs input", "failed", "stopped"]).nullable(),
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
	responsibility_id: z.string().nullable(),
	responsibility_revision: z.number().nullable(),
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
		role: r.role,
		issue: r.issue_json === null ? null : githubIssueSchema.parse(JSON.parse(r.issue_json)),
		readiness: r.readiness_json === null ? null : prReadinessSchema.parse(JSON.parse(r.readiness_json)),
		readinessNotifiedKey: r.readiness_notified_key,
		readinessVersion: r.readiness_version,
		readinessPendingVerdict: r.readiness_pending_verdict,
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
		responsibilityId: r.responsibility_id,
		responsibilityRevision: r.responsibility_revision,
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
		prompt_pending INTEGER NOT NULL DEFAULT 0,
		responsibility_id TEXT,
		responsibility_revision INTEGER,
		role TEXT NOT NULL DEFAULT 'default',
		issue_json TEXT,
		readiness_json TEXT,
		readiness_notified_key TEXT,
		readiness_version INTEGER NOT NULL DEFAULT 0,
		readiness_pending_verdict TEXT`;

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
	// Predates responsibility links: NULL = not linked.
	if (!cols.has("responsibility_id")) {
		db.exec("ALTER TABLE delegations ADD COLUMN responsibility_id TEXT");
	}
	if (!cols.has("responsibility_revision")) {
		db.exec("ALTER TABLE delegations ADD COLUMN responsibility_revision INTEGER");
	}
	if (!cols.has("role")) db.exec("ALTER TABLE delegations ADD COLUMN role TEXT NOT NULL DEFAULT 'default'");
	for (const column of ["issue_json", "readiness_json", "readiness_notified_key", "readiness_pending_verdict"]) {
		if (!cols.has(column)) db.exec(`ALTER TABLE delegations ADD COLUMN ${column} TEXT`);
	}
	if (!cols.has("readiness_version"))
		db.exec("ALTER TABLE delegations ADD COLUMN readiness_version INTEGER NOT NULL DEFAULT 0");
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
				(id, name, harness, cwd, task, chat_id, thread_id, agent_name, workspace_id, pane_id, status, target, baseline_seq, prompted_at, created_at, finished_at, app_conversation, prompt_pending, responsibility_id, responsibility_revision, role, issue_json, readiness_json, readiness_notified_key, readiness_version, readiness_pending_verdict)
				SELECT id, name, harness, cwd, task, chat_id, thread_id, agent_name, workspace_id, pane_id, status, target, baseline_seq, prompted_at, created_at, finished_at, app_conversation, prompt_pending, responsibility_id, responsibility_revision, role, issue_json, readiness_json, readiness_notified_key, readiness_version, readiness_pending_verdict
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
		(name, harness, cwd, task, chat_id, thread_id, agent_name, workspace_id, pane_id, status, target, baseline_seq, prompted_at, created_at, finished_at, app_conversation, responsibility_id, responsibility_revision, role, issue_json)
		VALUES (?, ?, ?, ?, ?, ?, '', '', '', 'starting', ?, 0, ?, ?, NULL, ?, ?, ?, ?, ?)`);
	const qBind = db.query(
		"UPDATE delegations SET agent_name = ?, workspace_id = ?, pane_id = ? WHERE id = ?",
	);
	const qRunning = db.query(
		"UPDATE delegations SET baseline_seq = ?, prompted_at = ?, status = 'running', finished_at = NULL, prompt_pending = 0, readiness_json = NULL, readiness_notified_key = NULL, readiness_pending_verdict = NULL WHERE id = ? AND status != 'stopped'",
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
	const qReadiness = db.query(`UPDATE delegations SET readiness_json = ?, readiness_version = readiness_version + ?,
		readiness_notified_key = CASE WHEN ? THEN ? ELSE readiness_notified_key END,
		readiness_pending_verdict = CASE WHEN ? THEN NULL ELSE COALESCE(?, readiness_pending_verdict) END
		WHERE id = ? AND status = ? AND prompted_at = ? AND baseline_seq IS ?`);

	return {
		create(
			{
				name,
				harness,
				role,
				issue,
				cwd,
				task,
				address,
				appConversation,
				target,
				responsibilityId,
				responsibilityRevision,
			},
			now = new Date(),
		) {
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
				responsibilityId ?? null,
				responsibilityRevision ?? null,
				role ?? "default",
				issue === undefined ? null : JSON.stringify(issue),
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
		recordReadiness(id, expect, readiness, notified = false, verdict) {
			const row = qGet.get(id);
			const previous = row === null ? null : rowToDelegation(row);
			const prior = previous?.readiness ?? null;
			const changed = prior === null || readinessKey(prior) !== readinessKey(readiness);
			const saved = qReadiness.run(JSON.stringify(readiness), changed ? 1 : 0, notified ? 1 : 0, readinessKey(readiness),
				notified ? 1 : 0, verdict ?? null,
				id, expect.status, expect.promptedAt, expect.baselineSeq).changes > 0;
			if (saved && (changed || notified && previous?.readinessNotifiedKey !== readinessKey(readiness))) {
				log.info("delegation readiness recorded", {
					delegation: id, version: (previous?.readinessVersion ?? 0) + (changed ? 1 : 0),
					notified, kind: readiness.result.kind,
				});
			}
			return saved;
		},
		close() {
			db.close();
		},
	};
}

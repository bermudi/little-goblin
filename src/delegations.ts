// The delegations table + watcher (DESIGN.md, "Delegation"). State is
// rows in goblin.sqlite, own connection, same WAL file as the jobs and
// conversation stores — rows survive goblin restarts while the herdr
// unit keeps the panes alive, so a watcher opened over an existing DB
// resumes tracking.
//
// The watcher is the scheduler's twin: an in-process ticker scanning
// running/needs_input rows and polling herdr for their state. Done =
// status idle|done AND state_change_seq advanced past the baseline
// recorded right after prompting (a fresh prompt is idle before it's
// working). Blocked → needs_input, notified once — the row status IS
// the once. Gone → failed. An idle agent that never advanced its seq
// 90 s after prompting is needs_input — the generic defense against
// startup dialogs (codex's trust prompt reports as idle).

import { Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { log } from "./log.ts";
import type { Herdr } from "./herdr.ts";

export type DelegationStatus = "running" | "needs_input" | "done" | "failed" | "stopped";

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
	/** Inserts status "running" with empty launch ids — bindLaunch fills
	 *  them once herdr answers (the agent name derives from the row id). */
	create(input: CreateDelegation, now?: Date): Delegation;
	bindLaunch(
		id: number,
		launch: { agentName: string; workspaceId: string; paneId: string },
	): Delegation | null;
	/** Record a prompt landing: new seq baseline + prompt timestamp. */
	markPrompted(id: number, baselineSeq: number, now?: Date): void;
	/** Move the seq baseline without touching prompted_at — parking a
	 *  row re-baselines it so "did anything happen since" still works. */
	setBaseline(id: number, seq: number): void;
	setStatus(id: number, status: DelegationStatus, now?: Date): void;
	get(id: number): Delegation | null;
	list(): Delegation[];
	/** Rows the watcher still owes a verdict: running + needs_input. */
	active(): Delegation[];
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
	status: z.enum(["running", "needs_input", "done", "failed", "stopped"]),
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
	const qInsert = db.query(`INSERT INTO delegations
		(name, harness, cwd, task, chat_id, thread_id, agent_name, workspace_id, pane_id, status, baseline_seq, prompted_at, created_at, finished_at)
		VALUES (?, ?, ?, ?, ?, ?, '', '', '', 'running', 0, ?, ?, NULL)`);
	const qBind = db.query(
		"UPDATE delegations SET agent_name = ?, workspace_id = ?, pane_id = ? WHERE id = ?",
	);
	const qPrompted = db.query(
		"UPDATE delegations SET baseline_seq = ?, prompted_at = ? WHERE id = ?",
	);
	const qBaseline = db.query(
		"UPDATE delegations SET baseline_seq = ? WHERE id = ?",
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
		markPrompted(id, baselineSeq, now = new Date()) {
			qPrompted.run(baselineSeq, now.toISOString(), id);
		},
		setBaseline(id, seq) {
			qBaseline.run(seq, id);
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
		close() {
			db.close();
		},
	};
}

// ---------- watcher ----------

export interface DelegationWatcherDeps {
	delegations: DelegationsStore;
	herdr: Herdr;
	/** Directory holding per-delegation report dirs (<dir>/<id>/report.md). */
	delegationsDir: string;
	/** Submit a notice into the delegation's pinned conversation; true = landed. */
	wake(address: { chatId: number; threadId: number | null }, text: string): boolean;
}

export interface DelegationWatcher {
	/** One scan now — also the test door; production runs it on a timer. */
	tick(): Promise<void>;
	stop(): void;
}

const TICK_MS = 15_000;
// A fresh prompt sits idle before it's working — give the harness this
// long to move the seq before calling it stuck on a startup dialog.
const STALL_MS = 90_000;
const REPORT_CAP = 16 * 1024;
const TAIL_LINES = 80;

export function startDelegationWatcher(
	deps: DelegationWatcherDeps,
	tickMs = TICK_MS,
): DelegationWatcher {
	// Ticks must not overlap — herdr calls are async, so a slow pass
	// would stack another scan on top. Sharing the in-flight promise
	// gives await-tick callers (tests) a completed scan, not a skipped one.
	let current: Promise<void> | null = null;
	const scan = (): Promise<void> => {
		if (current !== null) return current;
		current = (async () => {
			try {
				for (const d of deps.delegations.active()) {
					// One bad row must not take the scan down with it — but
					// it surfaces as an error line, never a swallow.
					try {
						await check(deps, d);
					} catch (err) {
						log.error("delegation check failed", err, {
							delegation: d.id,
							name: d.name,
						});
					}
				}
			} finally {
				current = null;
			}
		})();
		return current;
	};
	const timer = setInterval(() => {
		void scan();
	}, tickMs);
	void scan(); // boot catch-up: rows persisted while down are just "active"
	return { tick: scan, stop: () => clearInterval(timer) };
}

// The notice body: the report file when the agent wrote one (capped),
// else the screen tail — the two channels, in that order (DESIGN.md).
async function reportBody(
	deps: DelegationWatcherDeps,
	d: Delegation,
	agentGone = false,
): Promise<string> {
	const reportPath = join(deps.delegationsDir, String(d.id), "report.md");
	try {
		const size = statSync(reportPath).size;
		if (size > REPORT_CAP) {
			const head = readFileSync(reportPath, "utf8").slice(0, REPORT_CAP);
			return `${head}\n\n… full report at ${reportPath}`;
		}
		return readFileSync(reportPath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	// No report — the screen is the fallback channel. Agent first, then
	// the pane (which outlives the agent); a known-gone agent skips the
	// doomed read.
	if (!agentGone) {
		try {
			return await deps.herdr.readAgent(d.agentName, TAIL_LINES);
		} catch (err) {
			log.warn("delegation agent read failed — falling back to pane", {
				delegation: d.id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	try {
		return await deps.herdr.readPane(d.paneId, TAIL_LINES);
	} catch (err) {
		return `(screen unreadable: ${err instanceof Error ? err.message : String(err)})`;
	}
}

async function notify(
	deps: DelegationWatcherDeps,
	d: Delegation,
	verdict: "done" | "needs input" | "failed",
	opts: { extra?: string; agentGone?: boolean } = {},
): Promise<void> {
	const body = await reportBody(deps, d, opts.agentGone ?? false);
	const extra = opts.extra;
	const text = `[delegation: ${d.name} · ${verdict}]${extra ? ` ${extra}` : ""}\n${body}`;
	const landed = deps.wake({ chatId: d.chatId, threadId: d.threadId }, text);
	if (!landed) {
		log.error("delegation notice failed to submit", undefined, {
			delegation: d.id,
			name: d.name,
		});
	}
}

function transition(
	deps: DelegationWatcherDeps,
	d: Delegation,
	to: DelegationStatus,
): void {
	deps.delegations.setStatus(d.id, to);
	log.info("delegation transition", {
		delegation: d.id,
		name: d.name,
		from: d.status,
		to,
	});
}

async function check(deps: DelegationWatcherDeps, d: Delegation): Promise<void> {
	const info = await deps.herdr.get(d.agentName);
	if (info === null) {
		// Agent gone — pane closed or process exited. The pane may still
		// hold the exit text; readPane is the fallback channel here.
		transition(deps, d, "failed");
		await notify(deps, d, "failed", { extra: "(agent gone)", agentGone: true });
		return;
	}

	if (d.status === "needs_input") {
		// Parked rows get one question: did anything happen since the
		// park? An operator answering through `herdr session attach`
		// never shows as "working" to a 15 s poll, but it always moves
		// the seq — so seq advance, not a status glimpse, is the signal.
		if (info.state_change_seq <= d.baselineSeq) return;
		transition(deps, d, "running");
		// Fall through — the running rules apply in the same tick (a
		// parked row that already finished reads done right away).
	}

	// running:
	if (info.agent_status === "blocked") {
		transition(deps, d, "needs_input");
		// Re-baseline at the park point: what matters from here is what
		// happens after this block, not before it.
		deps.delegations.setBaseline(d.id, info.state_change_seq);
		await notify(deps, d, "needs input");
		return;
	}
	if (info.agent_status === "idle" || info.agent_status === "done") {
		// A report written after the last prompt is itself a completion
		// signal: an agent that finished before the post-prompt baseline
		// get already folded its done transition into baseline_seq —
		// without this it would sit idle until the stall rule mislabels
		// it stuck. The freshness check is what lets `send` reuse a
		// finished delegation: the old report predates the new prompt.
		const reportPath = join(deps.delegationsDir, String(d.id), "report.md");
		let freshReport = false;
		try {
			freshReport = statSync(reportPath).mtimeMs > Date.parse(d.promptedAt);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
		if (info.state_change_seq > d.baselineSeq || freshReport) {
			transition(deps, d, "done");
			await notify(deps, d, "done");
			return;
		}
		if (
			info.agent_status === "idle" &&
			Date.now() - Date.parse(d.promptedAt) > STALL_MS
		) {
			transition(deps, d, "needs_input");
			deps.delegations.setBaseline(d.id, info.state_change_seq);
			await notify(deps, d, "needs input", {
				extra: "(agent never started working — likely stuck on a startup dialog)",
			});
		}
	}
	// working / unknown / idle-at-baseline: still in flight.
}

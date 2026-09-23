// The jobs table — scheduled standing orders (DESIGN.md, "Scheduled
// work"). State is rows in goblin.sqlite, never files: a job's
// instructions are the job's state. Own connection, same WAL file as
// the conversation store. Recurrence is 5-field cron in the server's
// local timezone, validated here at the boundary — an invalid
// expression never becomes a row.

import { Database } from "bun:sqlite";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";

export interface Job {
	id: number;
	name: string;
	cron: string;
	prompt: string;
	/** Pinned Telegram address — replies land where the job was born. */
	chatId: number;
	threadId: number | null;
	enabled: boolean;
	createdAt: string;
	lastRun: string | null;
	/** ISO timestamp of the next fire, computed from the cron. */
	nextRun: string;
}

export interface JobAddress {
	chatId: number;
	threadId: number | null;
}

export interface CreateJob {
	name: string;
	cron: string;
	prompt: string;
	address: JobAddress;
}

// Patches are partial; cron (when present) re-validates.
export interface JobPatch {
	name?: string;
	cron?: string;
	prompt?: string;
	enabled?: boolean;
}

export interface JobsStore {
	create(input: CreateJob, now?: Date): Job;
	update(id: number, patch: JobPatch, now?: Date): Job | null;
	remove(id: number): boolean;
	get(id: number): Job | null;
	list(): Job[];
	/** Enabled jobs whose next_run is at or before `now` (boot catch-up
	 *  is this same query — a fire missed while down is just "due"). */
	due(now: Date): Job[];
	/** Record a run and advance to the next future occurrence. */
	markRan(id: number, now: Date): void;
	close(): void;
}

// Validate + compute. Throws with cron-parser's own message — the tool
// boundary surfaces it to the model, so it must be human-readable.
export function nextFire(cron: string, from: Date): Date {
	// cron-parser accepts 1–6 fields (a 6th being seconds); the contract
	// here is exactly 5 (min hour dom month dow). Check before parsing —
	// "*/5 * * * * *" would otherwise silently mean every five seconds.
	if (cron.trim().split(/\s+/).length !== 5) {
		throw new Error(
			`invalid cron "${cron}": expected exactly 5 fields (min hour dom month dow)`,
		);
	}
	try {
		return CronExpressionParser.parse(cron, { currentDate: from }).next().toDate();
	} catch (err) {
		throw new Error(`invalid cron "${cron}": ${(err as Error).message}`);
	}
}

const jobSchema = z.object({
	id: z.number(),
	name: z.string(),
	cron: z.string(),
	prompt: z.string(),
	chat_id: z.number(),
	thread_id: z.number().nullable(),
	enabled: z.number(),
	created_at: z.string(),
	last_run: z.string().nullable(),
	next_run: z.string(),
});

function rowToJob(row: unknown): Job {
	const parsed = jobSchema.parse(row);
	return {
		id: parsed.id,
		name: parsed.name,
		cron: parsed.cron,
		prompt: parsed.prompt,
		chatId: parsed.chat_id,
		threadId: parsed.thread_id,
		enabled: parsed.enabled === 1,
		createdAt: parsed.created_at,
		lastRun: parsed.last_run,
		nextRun: parsed.next_run,
	};
}

export function openJobs(dbPath: string): JobsStore {
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec(`CREATE TABLE IF NOT EXISTS jobs (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL,
		cron TEXT NOT NULL,
		prompt TEXT NOT NULL,
		chat_id INTEGER NOT NULL,
		thread_id INTEGER,
		enabled INTEGER NOT NULL DEFAULT 1,
		created_at TEXT NOT NULL,
		last_run TEXT,
		next_run TEXT NOT NULL
	)`);

	const qGet = db.query("SELECT * FROM jobs WHERE id = ?");
	const qList = db.query("SELECT * FROM jobs ORDER BY id");
	const qDue = db.query(
		"SELECT * FROM jobs WHERE enabled = 1 AND next_run <= ? ORDER BY next_run",
	);
	const qInsert = db.query(`INSERT INTO jobs
		(name, cron, prompt, chat_id, thread_id, enabled, created_at, last_run, next_run)
		VALUES (?, ?, ?, ?, ?, 1, ?, NULL, ?)`);
	const qUpdate = db.query(
		"UPDATE jobs SET name = ?, cron = ?, prompt = ?, enabled = ?, next_run = ? WHERE id = ?",
	);
	const qMark = db.query("UPDATE jobs SET last_run = ?, next_run = ? WHERE id = ?");
	const qDelete = db.query("DELETE FROM jobs WHERE id = ?");

	return {
		create({ name, cron, prompt, address }, now = new Date()) {
			const next = nextFire(cron, now); // throws on a bad expression
			const res = qInsert.run(
				name, cron, prompt, address.chatId, address.threadId,
				now.toISOString(), next.toISOString(),
			);
			return rowToJob(qGet.get(Number(res.lastInsertRowid)));
		},
		update(id, patch, now = new Date()) {
			const current = qGet.get(id);
			if (current === null) return null;
			const before = rowToJob(current);
			const cron = patch.cron ?? before.cron;
			const enabled = patch.enabled ?? before.enabled;
			// Recompute from `now` whenever anything recurrence-shaped moved —
			// a new cron, or a re-enable: occurrences skipped while disabled
			// are skipped, not owed (boot catch-up is for downtime only). Any
			// other patch leaves the scheduled occurrence untouched.
			const next =
				patch.cron !== undefined || (enabled && !before.enabled)
					? nextFire(cron, now).toISOString()
					: before.nextRun;
			qUpdate.run(patch.name ?? before.name, cron, patch.prompt ?? before.prompt, enabled ? 1 : 0, next, id);
			return rowToJob(qGet.get(id));
		},
		remove(id) {
			return qDelete.run(id).changes > 0;
		},
		get(id) {
			const row = qGet.get(id);
			return row === null ? null : rowToJob(row);
		},
		list() {
			return qList.all().map(rowToJob);
		},
		due(now) {
			return qDue.all(now.toISOString()).map(rowToJob);
		},
		markRan(id, now) {
			// The job row is the source of truth for cron — read it fresh so
			// an edit that landed between fire and mark still advances on the
			// *current* expression.
			const row = qGet.get(id);
			if (row === null) return;
			const job = rowToJob(row);
			qMark.run(now.toISOString(), nextFire(job.cron, now).toISOString(), id);
		},
		close() {
			db.close();
		},
	};
}

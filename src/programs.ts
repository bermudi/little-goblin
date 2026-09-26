// The programs table — standing orders (DESIGN.md, "Programs"). A
// program is standing authority for one concern: a charter plus the
// triggers that wake it (a 5-field cron in server-local time, and
// later a webhook whose sha256 lives in hook_hash). State is rows in
// goblin.sqlite, never files: a program's instructions are the
// program's state. Own connection, same WAL file as the conversation
// store. Cron validates here at the boundary — an invalid expression
// never becomes a row — and a program always has at least one
// trigger.
//
// Legacy: on open, rows in the superseded `jobs` table copy in once
// (prompt → charter); `jobs` itself is never modified or dropped.

import { Database } from "bun:sqlite";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import { log } from "./log.ts";

export interface Program {
	id: number;
	name: string;
	charter: string;
	/** 5-field cron, or null for hook-only programs. */
	cron: string | null;
	/** sha256 of the webhook token — unused until webhook delivery lands. */
	hookHash: string | null;
	/** Pinned Telegram address — replies land where the program was born. */
	chatId: number;
	threadId: number | null;
	enabled: boolean;
	createdAt: string;
	lastRun: string | null;
	/** ISO timestamp of the next fire, or null without a cron. */
	nextRun: string | null;
}

export interface ProgramAddress {
	chatId: number;
	threadId: number | null;
}

export interface CreateProgram {
	name: string;
	charter: string;
	cron?: string | null;
	hookHash?: string | null;
	address: ProgramAddress;
}

// Patches are partial; cron (when present) re-validates. undefined
// leaves a field alone; null clears it.
export interface ProgramPatch {
	name?: string;
	charter?: string;
	cron?: string | null;
	hookHash?: string | null;
	enabled?: boolean;
}

export interface ProgramsStore {
	create(input: CreateProgram, now?: Date): Program;
	update(id: number, patch: ProgramPatch, now?: Date): Program | null;
	remove(id: number): boolean;
	get(id: number): Program | null;
	list(): Program[];
	/** Enabled cron programs whose next_run is at or before `now`
	 *  (boot catch-up is this same query — a fire missed while down is
	 *  just "due"). Hook-only programs are never due. */
	due(now: Date): Program[];
	/** Record a run; advances next_run only when a cron is set. */
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

// The load-bearing invariant: a program with no trigger can never
// wake — it would be a row that does nothing.
function requireTrigger(cron: string | null, hookHash: string | null): void {
	if (cron === null && hookHash === null) {
		throw new Error("a program needs at least one trigger — set a cron or a hook");
	}
}

const programSchema = z.object({
	id: z.number(),
	name: z.string(),
	charter: z.string(),
	cron: z.string().nullable(),
	hook_hash: z.string().nullable(),
	chat_id: z.number(),
	thread_id: z.number().nullable(),
	enabled: z.number(),
	created_at: z.string(),
	last_run: z.string().nullable(),
	next_run: z.string().nullable(),
});

function rowToProgram(row: unknown): Program {
	const parsed = programSchema.parse(row);
	return {
		id: parsed.id,
		name: parsed.name,
		charter: parsed.charter,
		cron: parsed.cron,
		hookHash: parsed.hook_hash,
		chatId: parsed.chat_id,
		threadId: parsed.thread_id,
		enabled: parsed.enabled === 1,
		createdAt: parsed.created_at,
		lastRun: parsed.last_run,
		nextRun: parsed.next_run,
	};
}

export function openPrograms(dbPath: string): ProgramsStore {
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec(`CREATE TABLE IF NOT EXISTS programs (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL,
		charter TEXT NOT NULL,
		cron TEXT,
		hook_hash TEXT,
		chat_id INTEGER NOT NULL,
		thread_id INTEGER,
		enabled INTEGER NOT NULL DEFAULT 1,
		created_at TEXT NOT NULL,
		last_run TEXT,
		next_run TEXT
	)`);
	copyLegacyJobs(db);

	const qGet = db.query("SELECT * FROM programs WHERE id = ?");
	const qList = db.query("SELECT * FROM programs ORDER BY id");
	const qDue = db.query(
		"SELECT * FROM programs WHERE enabled = 1 AND cron IS NOT NULL AND next_run <= ? ORDER BY next_run",
	);
	const qInsert = db.query(`INSERT INTO programs
		(name, charter, cron, hook_hash, chat_id, thread_id, enabled, created_at, last_run, next_run)
		VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, ?)`);
	const qUpdate = db.query(
		"UPDATE programs SET name = ?, charter = ?, cron = ?, hook_hash = ?, enabled = ?, next_run = ? WHERE id = ?",
	);
	const qMark = db.query("UPDATE programs SET last_run = ?, next_run = ? WHERE id = ?");
	const qDelete = db.query("DELETE FROM programs WHERE id = ?");

	return {
		create({ name, charter, cron = null, hookHash = null, address }, now = new Date()) {
			requireTrigger(cron, hookHash);
			const next = cron === null ? null : nextFire(cron, now).toISOString();
			const res = qInsert.run(
				name, charter, cron, hookHash, address.chatId, address.threadId,
				now.toISOString(), next,
			);
			return rowToProgram(qGet.get(Number(res.lastInsertRowid)));
		},
		update(id, patch, now = new Date()) {
			const current = qGet.get(id);
			if (current === null) return null;
			const before = rowToProgram(current);
			const cron = patch.cron !== undefined ? patch.cron : before.cron;
			const hookHash =
				patch.hookHash !== undefined ? patch.hookHash : before.hookHash;
			requireTrigger(cron, hookHash);
			const enabled = patch.enabled ?? before.enabled;
			// Recompute from `now` whenever anything recurrence-shaped moved —
			// a new cron, or a re-enable: occurrences skipped while disabled
			// are skipped, not owed (boot catch-up is for downtime only). Any
			// other patch leaves the scheduled occurrence untouched.
			const next =
				patch.cron !== undefined || (enabled && !before.enabled)
					? cron === null
						? null
						: nextFire(cron, now).toISOString()
					: before.nextRun;
			qUpdate.run(
				patch.name ?? before.name,
				patch.charter ?? before.charter,
				cron,
				hookHash,
				enabled ? 1 : 0,
				next,
				id,
			);
			return rowToProgram(qGet.get(id));
		},
		remove(id) {
			return qDelete.run(id).changes > 0;
		},
		get(id) {
			const row = qGet.get(id);
			return row === null ? null : rowToProgram(row);
		},
		list() {
			return qList.all().map(rowToProgram);
		},
		due(now) {
			return qDue.all(now.toISOString()).map(rowToProgram);
		},
		markRan(id, now) {
			// The program row is the source of truth for cron — read it fresh
			// so an edit that landed between fire and mark still advances on
			// the *current* expression. Hook-only programs stamp last_run and
			// keep their null next_run.
			const row = qGet.get(id);
			if (row === null) return;
			const program = rowToProgram(row);
			const next =
				program.cron === null
					? program.nextRun
					: nextFire(program.cron, now).toISOString();
			qMark.run(now.toISOString(), next, id);
		},
		close() {
			db.close();
		},
	};
}

// One-shot upgrade path: the `jobs` table predates programs (DESIGN.md).
// If it exists and programs is still empty, every job copies across in
// a single transaction — same ids, prompt → charter — and `jobs` is
// left exactly as it was. Once programs has rows the copy never runs
// again, however many jobs rows remain.
function copyLegacyJobs(db: Database): void {
	const jobsTable = db
		.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jobs'")
		.get();
	if (jobsTable === null) return;
	const { n } = db
		.query("SELECT COUNT(*) AS n FROM programs")
		.get() as { n: number };
	if (n > 0) return;
	const copied = db.transaction((): number => {
		return db
			.query(`INSERT INTO programs
				(id, name, charter, cron, hook_hash, chat_id, thread_id, enabled, created_at, last_run, next_run)
				SELECT id, name, prompt, cron, NULL, chat_id, thread_id, enabled, created_at, last_run, next_run
				FROM jobs`)
			.run().changes;
	})();
	if (copied > 0) {
		log.info("legacy jobs copied into programs", { count: copied });
	}
}

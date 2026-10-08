// The programs table — standing orders (DESIGN.md, "Programs"). A
// program is standing authority for one concern: a charter plus the
// triggers that wake it (a 5-field cron in server-local time, a webhook
// whose sha256 lives in hook_hash, or a Gmail filter in
// mail_filter). State is rows in
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
	/** Gmail query waking the program on new matches, or null. */
	mailFilter: string | null;
	/** Mailbox history id checkpoint for the mail filter — the watcher's
	 *  cursor, null until the first poll baselines it. */
	mailHistoryId: string | null;
	/** Monotonic generation of filter/re-enable baseline invalidations. */
	mailRevision: number;
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
	mailFilter?: string | null;
	address: ProgramAddress;
}

// Patches are partial; cron (when present) re-validates. undefined
// leaves a field alone; null clears it.
export interface ProgramPatch {
	name?: string;
	charter?: string;
	cron?: string | null;
	hookHash?: string | null;
	mailFilter?: string | null;
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
	/** Stamp a hook-fired run — last_run only, next_run untouched. */
	markFired(id: number, now: Date): void;
	/** Set or clear the webhook token hash. Clearing the last trigger
	 *  throws — the trigger invariant holds here too. */
	setHook(id: number, hash: string | null): Program | null;
	/** Set or clear the Gmail filter. Clearing the last trigger throws;
	 *  setting a new filter resets the history cursor so the watcher
	 *  re-baselines instead of firing the mailbox's backlog. */
	setMailFilter(id: number, filter: string | null): Program | null;
	/** Advance the mail watcher's checkpoint — cursor only, no trigger
	 *  semantics. CAS on mail_revision: a filter edit or re-enable that
	 *  landed while a fire was mid-flight bumps the revision and
	 *  re-baselines, and the stale fire's checkpoint must not clobber
	 *  that (the invariant mail-watcher enforces at read time — this is
	 *  its write-time half). False = skipped. */
	setMailHistory(id: number, historyId: string, expectRevision: number): boolean;
	/** Baseline only if the original filter, cursor, enabled state and
	 *  revision still hold; one SQL write, safe across connections. */
	baselineMail(program: Program, historyId: string): boolean;
	/** Enabled programs carrying a mail filter — the watcher's scan. */
	withMailFilter(): Program[];
	/** Reverse lookup for the /hook route — returns the row regardless
	 *  of enabled; the route decides what disabled means. */
	findByHook(hash: string): Program | null;
	/** Rolling DM cutover (design/telegram.md → Rolling DM): programs
	 *  pinned to a DM topic (private chat + thread) re-pin to the bare
	 *  chat — DM topics are retired and replies land in the main chat.
	 *  Group topics and already-bare pins are untouched. Idempotent,
	 *  logged per program. */
	rePinDmTopics(): number;
	close(): void;
}

// Validate + compute. Throws with cron-parser's own message — the tool
// boundary surfaces it to the model, so it must be human-readable.
export function nextFire(cron: string, from: Date): Date {
	// cron-parser accepts 1–6 fields (a 6th being seconds); the contract
	// here is exactly 5 (min hour dom month dow). Check before parsing —
	// "*/5 * * * * *" would otherwise silently mean every five seconds.
	if (cron.trim().split(/\s+/).length !== 5) {
		throw new Error(`invalid cron "${cron}": expected exactly 5 fields (min hour dom month dow)`);
	}
	try {
		return CronExpressionParser.parse(cron, { currentDate: from }).next().toDate();
	} catch (err) {
		throw new Error(`invalid cron "${cron}": ${(err as Error).message}`);
	}
}

// The load-bearing invariant: a program with no trigger can never
// wake — it would be a row that does nothing.
function requireTrigger(
	cron: string | null,
	hookHash: string | null,
	mailFilter: string | null,
): void {
	if (cron === null && hookHash === null && mailFilter === null) {
		throw new Error("a program needs at least one trigger — set a cron, a hook, or a mail filter");
	}
}

const programSchema = z.object({
	id: z.number(),
	name: z.string(),
	charter: z.string(),
	cron: z.string().nullable(),
	hook_hash: z.string().nullable(),
	mail_filter: z.string().nullable(),
	mail_history_id: z.string().nullable(),
	mail_revision: z.number().int().nonnegative(),
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
		mailFilter: parsed.mail_filter,
		mailHistoryId: parsed.mail_history_id,
		mailRevision: parsed.mail_revision,
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
	// Check, create, and copy in one transaction: a failed copy (or a
	// crash) must not leave an empty programs table that prevents retry.
	// An existing table, even if empty, never re-copies deleted jobs.
	const copied = db.transaction((): number => {
		const isNewTable =
			db
				.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'programs'")
				.get() === null;
		db.exec(`CREATE TABLE IF NOT EXISTS programs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL,
			charter TEXT NOT NULL,
			cron TEXT,
			hook_hash TEXT,
			mail_filter TEXT,
			mail_history_id TEXT,
			mail_revision INTEGER NOT NULL DEFAULT 0,
			chat_id INTEGER NOT NULL,
			thread_id INTEGER,
			enabled INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL,
			last_run TEXT,
			next_run TEXT
		)`);
		const count = isNewTable ? copyLegacyJobs(db) : 0;
		// Existing DBs predate the mail trigger/revision — additive only.
		// Keep the legacy copy gated on table creation, never row count.
		const progCols = new Set(
			db
				.query<{ name: string }, []>("PRAGMA table_info(programs)")
				.all()
				.map((c) => c.name),
		);
		if (!progCols.has("mail_filter")) db.exec("ALTER TABLE programs ADD COLUMN mail_filter TEXT");
		if (!progCols.has("mail_history_id"))
			db.exec("ALTER TABLE programs ADD COLUMN mail_history_id TEXT");
		if (!progCols.has("mail_revision")) {
			db.exec("ALTER TABLE programs ADD COLUMN mail_revision INTEGER NOT NULL DEFAULT 0");
		}
		return count;
	})();
	if (copied > 0) {
		log.info("legacy jobs copied into programs", { count: copied });
	}

	const qGet = db.query("SELECT * FROM programs WHERE id = ?");
	const qList = db.query("SELECT * FROM programs ORDER BY id");
	const qDue = db.query(
		"SELECT * FROM programs WHERE enabled = 1 AND cron IS NOT NULL AND next_run <= ? ORDER BY next_run",
	);
	const qInsert = db.query(`INSERT INTO programs
		(name, charter, cron, hook_hash, mail_filter, mail_history_id, chat_id, thread_id, enabled, created_at, last_run, next_run)
		VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 1, ?, NULL, ?)`);
	const qUpdate = db.query(
		"UPDATE programs SET name = ?, charter = ?, cron = ?, hook_hash = ?, mail_filter = ?, mail_history_id = ?, mail_revision = mail_revision + ?, enabled = ?, next_run = ? WHERE id = ?",
	);
	const qMark = db.query("UPDATE programs SET last_run = ?, next_run = ? WHERE id = ?");
	const qFired = db.query("UPDATE programs SET last_run = ? WHERE id = ?");
	const qHook = db.query("UPDATE programs SET hook_hash = ? WHERE id = ?");
	const qMailFilter = db.query(
		"UPDATE programs SET mail_filter = ?, mail_history_id = ?, mail_revision = mail_revision + ? WHERE id = ?",
	);
	const qMailHistory = db.query(
		"UPDATE programs SET mail_history_id = ? WHERE id = ? AND mail_revision = ?",
	);
	const qBaselineMail = db.query(`UPDATE programs SET mail_history_id = ?
		WHERE id = ? AND enabled = 1 AND mail_revision = ?
		AND mail_filter IS ? AND mail_history_id IS ?`);
	const qWithMail = db.query(
		"SELECT * FROM programs WHERE enabled = 1 AND mail_filter IS NOT NULL ORDER BY id",
	);
	const qByHook = db.query("SELECT * FROM programs WHERE hook_hash = ?");
	const qDelete = db.query("DELETE FROM programs WHERE id = ?");

	// Reserve the writer before reading a row. A deferred transaction can
	// read a stale WAL snapshot and fail on write; without a transaction a
	// second connection can replace the filter/cursor between these steps.
	// Keep the return read inside the same transaction as the write.
	const update = db.transaction((id: number, patch: ProgramPatch, now: Date): Program | null => {
		const current = qGet.get(id);
		if (current === null) return null;
		const before = rowToProgram(current);
		const cron = patch.cron !== undefined ? patch.cron : before.cron;
		const hookHash = patch.hookHash !== undefined ? patch.hookHash : before.hookHash;
		const mailFilter = patch.mailFilter !== undefined ? patch.mailFilter : before.mailFilter;
		requireTrigger(cron, hookHash, mailFilter);
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
		// A changed filter or a re-enable resets the cursor — the new
		// query's backlog must not fire as if it just arrived, and mail
		// that landed while disabled is skipped, not owed (the cron
		// rule above: re-enable re-baselines from now).
		const filterChanged = patch.mailFilter !== undefined && patch.mailFilter !== before.mailFilter;
		const invalidated = filterChanged || (enabled && !before.enabled);
		const mailHistoryId = invalidated ? null : before.mailHistoryId;
		qUpdate.run(
			patch.name ?? before.name,
			patch.charter ?? before.charter,
			cron,
			hookHash,
			mailFilter,
			mailHistoryId,
			invalidated ? 1 : 0,
			enabled ? 1 : 0,
			next,
			id,
		);
		return rowToProgram(qGet.get(id));
	});
	const setMailFilter = db.transaction((id: number, filter: string | null): Program | null => {
		const row = qGet.get(id);
		if (row === null) return null;
		const program = rowToProgram(row);
		requireTrigger(program.cron, program.hookHash, filter);
		// A new filter re-baselines (see update); an unchanged one
		// keeps its cursor — a no-op set must not drop arrivals.
		const changed = filter !== program.mailFilter;
		qMailFilter.run(filter, changed ? null : program.mailHistoryId, changed ? 1 : 0, id);
		return rowToProgram(qGet.get(id));
	});

	return {
		create(
			{ name, charter, cron = null, hookHash = null, mailFilter = null, address },
			now = new Date(),
		) {
			requireTrigger(cron, hookHash, mailFilter);
			const next = cron === null ? null : nextFire(cron, now).toISOString();
			const res = qInsert.run(
				name,
				charter,
				cron,
				hookHash,
				mailFilter,
				address.chatId,
				address.threadId,
				now.toISOString(),
				next,
			);
			return rowToProgram(qGet.get(Number(res.lastInsertRowid)));
		},
		update(id, patch, now = new Date()) {
			return update.immediate(id, patch, now);
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
				program.cron === null ? program.nextRun : nextFire(program.cron, now).toISOString();
			qMark.run(now.toISOString(), next, id);
		},
		markFired(id, now) {
			qFired.run(now.toISOString(), id);
		},
		setHook(id, hash) {
			const row = qGet.get(id);
			if (row === null) return null;
			const program = rowToProgram(row);
			requireTrigger(program.cron, hash, program.mailFilter);
			qHook.run(hash, id);
			return rowToProgram(qGet.get(id));
		},
		setMailFilter(id, filter) {
			return setMailFilter.immediate(id, filter);
		},
		setMailHistory(id, historyId, expectRevision) {
			return qMailHistory.run(historyId, id, expectRevision).changes === 1;
		},
		baselineMail(program, historyId) {
			return (
				qBaselineMail.run(
					historyId,
					program.id,
					program.mailRevision,
					program.mailFilter,
					program.mailHistoryId,
				).changes === 1
			);
		},
		withMailFilter() {
			return qWithMail.all().map(rowToProgram);
		},
		findByHook(hash) {
			const row = qByHook.get(hash);
			return row === null ? null : rowToProgram(row);
		},
		rePinDmTopics() {
			const rows = db
				.query<{ id: number; name: string; chat_id: number; thread_id: number }, []>(
					"SELECT id, name, chat_id, thread_id FROM programs WHERE chat_id > 0 AND thread_id IS NOT NULL",
				)
				.all();
			for (const r of rows) {
				db.run("UPDATE programs SET thread_id = NULL WHERE id = ?", [r.id]);
				log.info("dm cutover re-pin", {
					program: r.id,
					name: r.name,
					chat: r.chat_id,
					fromThread: r.thread_id,
				});
			}
			return rows.length;
		},
		close() {
			db.close();
		},
	};
}

// One-shot upgrade path: the `jobs` table predates programs (DESIGN.md).
// Called inside the table-creation transaction only when `programs` is
// new. Copies same ids (prompt → charter) and leaves `jobs` untouched.
// A cron that no longer parses is skipped loudly rather than copied
// verbatim: a bad schedule on the row would refire (and re-fail) every
// tick once markRan advances past it (audit #21's reachable half).
function copyLegacyJobs(db: Database): number {
	const jobsTable = db
		.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jobs'")
		.get();
	if (jobsTable === null) return 0;
	const rows = db
		.query<
			{
				id: number;
				name: string;
				prompt: string;
				cron: string | null;
				chat_id: number;
				thread_id: number | null;
				enabled: number;
				created_at: string;
				last_run: string | null;
				next_run: string | null;
			},
			[]
		>(
			`SELECT id, name, prompt, cron, chat_id, thread_id, enabled, created_at, last_run, next_run FROM jobs`,
		)
		.all();
	let copied = 0;
	for (const r of rows) {
		try {
			if (r.cron !== null) nextFire(r.cron, new Date(r.last_run ?? r.created_at));
		} catch (err) {
			log.warn("legacy job skipped — unparsable cron", err, {
				job: r.id,
				name: r.name,
				cron: r.cron,
			});
			continue;
		}
		db.run(
			`INSERT INTO programs
			(id, name, charter, cron, hook_hash, chat_id, thread_id, enabled, created_at, last_run, next_run)
			VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
			[
				r.id,
				r.name,
				r.prompt,
				r.cron,
				r.chat_id,
				r.thread_id,
				r.enabled,
				r.created_at,
				r.last_run,
				r.next_run,
			],
		);
		copied++;
	}
	return copied;
}

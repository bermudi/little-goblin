// Cron runs in server-local time. Own connection, same WAL file as
// the conversation store. Cron validates at the boundary — an invalid
// expression never becomes a row — and a program always has at least
// one trigger.
//
// Legacy purge: a leftover `jobs` table copies into programs only when
// the programs table itself is being created — an existing table is
// the operator's truth, deletions included, so legacy rows beside it
// archive (never reactivate) and the table drops either way. One
// transaction, a re-run a no-op.

import { Database } from "bun:sqlite";
import { CronExpression, CronExpressionParser } from "cron-parser";
import { z } from "zod";
import { log } from "./log.ts";
import {
	openProgramProposals,
	type ProgramDraft,
	type ProgramPatchRequest,
	type ProgramProposals,
	type ProposalCore,
} from "./program-proposals.ts";
import { SQLITE_BUSY_TIMEOUT_MS } from "./sqlite.ts";
import {
	responsibilityTarget,
	responsibilityTargetOf,
	telegramAddressOf,
	telegramTarget,
	validTarget,
	type ConversationTarget,
} from "./targets.ts";

/** The destination union's other arm — the project responsibility this
 *  program checks in on. Exactly one of a real chat_id or a
 *  responsibility_id is set; create validates it. */
export type ProgramKind = "custom" | "followup";

export interface Program {
	id: number;
	name: string;
	charter: string;
	/** The durable identity of service-owned rows: the follow-up
	 *  check-in is kind "followup", everything the tool/operator mints
	 *  is "custom". Not patchable — it is what recovery matches on. */
	kind: ProgramKind;
	cron: string | null;
	/** null preserves fire-on-wake behavior. */
	maxLatenessMinutes: number | null;
	/** sha256 of the webhook token. */
	hookHash: string | null;
	mailFilter: string | null;
	/** Mailbox history id checkpoint for the mail filter — the watcher's
	 *  cursor, null until the first poll baselines it. */
	mailHistoryId: string | null;
	/** Monotonic generation of filter/re-enable baseline invalidations. */
	mailRevision: number;
	/** Canonical conversation address — replies land where the program was born. */
	target: string;
	/** Legacy transport projection derived from `target`; app rows use
	 *  0/null. Also 0 when the destination is a project responsibility:
	 *  Telegram chat ids are never 0, and every destination read branches
	 *  on responsibilityId first. */
	chatId: number;
	threadId: number | null;
	/** Destination union's other arm — the project responsibility this
	 *  program checks in on. Exactly one of a real chat_id or a
	 *  responsibility_id is set; create validates it. */
	responsibilityId: string | null;
	enabled: boolean;
	createdAt: string;
	lastRun: string | null;
	nextRun: string | null;
}

/** A program rule violation the model can act on — the trigger
 *  invariant or a lateness bound. The program tool translates it into
 *  an error result; every other store failure stays an exception and
 *  propagates. Identified by class, never by message text. */
export class ProgramRuleError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProgramRuleError";
	}
}

export type ProgramAddress =
	| { target: ConversationTarget }
	| { chatId: number; threadId: number | null };

export function programAddressTarget(address: ProgramAddress): ConversationTarget {
	return "target" in address ? address.target : telegramTarget(address.chatId, address.threadId);
}

// A program row's target is a real conversation address, or the resp:<id>
// pseudo-address a responsibility-destination row carries instead.
const isProgramTarget = (target: string): boolean =>
	validTarget(target) || responsibilityTargetOf(target) !== null;

export interface CreateProgram {
	name: string;
	charter: string;
	/** Only the responsibility service mints non-custom rows. */
	kind?: ProgramKind;
	cron?: string | null;
	maxLatenessMinutes?: number | null;
	hookHash?: string | null;
	mailFilter?: string | null;
	/** Exactly one destination: a Telegram address OR a project
	 *  responsibility. The service binds responsibility programs
	 *  itself — the tool's Telegram pin is untouched. */
	address?: ProgramAddress | undefined;
	responsibilityId?: string | undefined;
}

// Patches are partial; cron (when present) re-validates. undefined
// leaves a field alone; null clears it.
export interface ProgramPatch {
	name?: string;
	charter?: string;
	cron?: string | null;
	maxLatenessMinutes?: number | null;
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
	/** Programs bound to a responsibility, oldest first — the durable
	 *  identity recovery reads when a follow-up's create committed but
	 *  its link write never did. */
	forResponsibility(responsibilityId: string): Program[];
	/** Enabled cron programs whose next_run is at or before `now`
	 *  (boot catch-up is this same query — a fire missed while down is
	 *  just "due"). Hook-only programs are never due. */
	due(now: Date): Program[];
	/** Record a run; advances next_run only when a cron is set. */
	markRan(id: number, now: Date): void;
	/** Advance a stale schedule without recording a run that never fired. */
	advancePastDue(id: number, now: Date): string | null;
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
	/** Rolling DM cutover: programs pinned to a DM topic (private chat
	 *  + thread) re-pin to the bare chat — DM topics are retired and
	 *  replies land in the main chat. Group topics and already-bare
	 *  pins are untouched. Idempotent, logged per program. */
	rePinDmTopics(): number;
	/** Staged standing authority — proposals are never active rows;
	 *  only an operator decision activates them through this store's
	 *  own create/update. Same connection, same WAL file. */
	proposals: ProgramProposals;
	close(): void;
}

// Validate + compute. Throws with cron-parser's own message — the tool
// boundary surfaces it to the model, so it must be human-readable.
export function nextFire(cron: string, from: Date): Date {
	return parseCron(cron, from).next().toDate();
}

// The latest occurrence at or before `through`, walked forward from
// `firstMissed` — the due row's next_run, the first occurrence the
// scan owes. This is the occurrence whose lateness governs a
// coalesced catch-up fire. The walk must be the same forward steps
// that persist next_run and advance markRan: cron-parser's backward
// .prev() is a *different* sequence across DST transitions — it skips
// the spring-forward landing hour (an on-time catch-up reads a day,
// and a sparse annual cron years, late) and admits the fall-back
// repeated hour (a stale catch-up reads on-time).
//
// An unbounded walk is per-occurrence synchronous — an every-minute
// program a year overdue blocked the loop for seconds, stalling every
// later program plus all HTTP/Telegram work. So .prev() supplies the
// candidate and the forward sequence *proves* it: stepping onto it
// from a minute earlier must land exactly on it (a fall-back repeat
// prev admits but the forward sequence never produces fails here), and
// stepping forward must overshoot `through` (a spring-forward hour prev
// skipped fails there). Only when verification declines does the walk
// run — the common case costs three expression steps. The walk itself
// is capped: on truncation the last walked occurrence stands — earlier
// than the true latest, so lateness is over-measured and the result
// degrades toward a lateness-grace skip, never toward a stale fire.
//
// Every probe is a fresh parse. Sharing one `fields` object across
// calls is unsafe: the expression carries iterator state, and a
// .prev() on shared fields changes what a subsequent .next() admits
// across a fall-back boundary (it starts producing the repeat the
// pure-forward sequence never yields).
const MAX_CATCHUP_STEPS = 10_000;

export function latestFireAtOrBefore(cron: string, firstMissed: Date, through: Date): Date {
	if (firstMissed.getTime() > through.getTime()) {
		throw new Error(
			`latestFireAtOrBefore: first missed occurrence ${firstMissed.toISOString()} is after the scan time ${through.toISOString()}`,
		);
	}
	// prev() is exclusive of currentDate — +1ms makes it "at or before".
	// Verification asks the forward sequence to reproduce the
	// candidate: a fall-back repeat's predecessor steps over it while
	// a real member's lands on it; stepping forward must then overshoot
	// `through`, or a member sits between.
	try {
		const cand = parseCron(cron, new Date(through.getTime() + 1))
			.prev()
			.toDate();
		if (cand.getTime() >= firstMissed.getTime()) {
			const back = parseCron(cron, cand).prev().toDate();
			if (
				parseCron(cron, back).next().getTime() === cand.getTime() &&
				parseCron(cron, cand).next().getTime() > through.getTime()
			) {
				return cand;
			}
		}
	} catch (err) {
		// A boundary with no expressible occurrence (e.g. year bounds)
		// declines to the walk rather than failing the catch-up — but the
		// reason must surface: an unexpected throw here swallowed whole
		// would be indistinguishable from a cron-parser regression.
		log.warn("schedule catch-up probe declined — falling back to the forward walk", err, {
			cron,
			firstMissed: firstMissed.toISOString(),
			through: through.toISOString(),
		});
	}
	let latest = firstMissed.getTime();
	let at = firstMissed;
	for (let steps = 0; ; steps++) {
		const next = parseCron(cron, at).next();
		const nextMs = next.getTime();
		if (nextMs > through.getTime()) return new Date(latest);
		if (steps >= MAX_CATCHUP_STEPS) {
			log.warn("schedule catch-up walk truncated — lateness over-measured", {
				cron,
				firstMissed: firstMissed.toISOString(),
				steps,
			});
			return new Date(latest);
		}
		latest = nextMs;
		// A plain Date, never the returned CronDate: the CronDate copy
		// constructor carries the previous search's DST flags into the
		// next one, and only a fresh start reproduces nextFire's steps.
		at = next.toDate();
	}
}

// cron-parser accepts 1–6 fields (a 6th being seconds); the contract
// here is exactly 5 (min hour dom month dow). Check before parsing —
// "*/5 * * * * *" would otherwise silently mean every five seconds.
function parseCron(cron: string, currentDate: Date): CronExpression {
	if (cron.trim().split(/\s+/).length !== 5) {
		throw new Error(`invalid cron "${cron}": expected exactly 5 fields (min hour dom month dow)`);
	}
	try {
		return CronExpressionParser.parse(cron, { currentDate });
	} catch (err) {
		throw new Error(`invalid cron "${cron}": ${(err as Error).message}`);
	}
}

function validateLateness(cron: string | null, minutes: number | null): void {
	if (minutes !== null && (!Number.isSafeInteger(minutes) || minutes < 1)) {
		throw new ProgramRuleError("maxLatenessMinutes must be a positive safe integer or null");
	}
	if (minutes !== null && cron === null) {
		throw new ProgramRuleError("maxLatenessMinutes requires a cron trigger");
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
		throw new ProgramRuleError(
			"a program needs at least one trigger — set a cron, a hook, or a mail filter",
		);
	}
}

const programSchema = z.object({
	id: z.number(),
	name: z.string(),
	charter: z.string(),
	kind: z.enum(["custom", "followup"]),
	cron: z.string().nullable(),
	max_lateness_minutes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
	hook_hash: z.string().nullable(),
	mail_filter: z.string().nullable(),
	mail_history_id: z.string().nullable(),
	mail_revision: z.number().int().nonnegative(),
	target: z.string().refine(isProgramTarget),
	chat_id: z.number(),
	thread_id: z.number().nullable(),
	responsibility_id: z.string().nullable().default(null),
	enabled: z.number(),
	created_at: z.string(),
	last_run: z.string().nullable(),
	next_run: z.string().nullable(),
});

// The two timer-driven scans decode row by row: one row the schema
// rejects (drift between versions, a hand edit) must cost that row an
// error line per tick, not every other program its fire — the scheduler
// scan is a synchronous interval callback, so a throw there is an
// uncaught exception and a restart loop on the same row.
function decodeScan(rows: unknown[], scan: string): Program[] {
	const out: Program[] = [];
	for (const row of rows) {
		try {
			out.push(rowToProgram(row));
		} catch (err) {
			log.error("program row undecodable — skipped this scan", err, {
				scan,
				id: (row as { id?: unknown } | null)?.id,
			});
		}
	}
	return out;
}

function rowToProgram(row: unknown): Program {
	const parsed = programSchema.parse(row);
	const telegram = telegramAddressOf(parsed.target);
	return {
		id: parsed.id,
		name: parsed.name,
		charter: parsed.charter,
		kind: parsed.kind,
		cron: parsed.cron,
		// Rows from before the ≥1 floor may hold 0 — a grace smaller
		// than the 30s tick can never fire, so 0 reads as 1.
		maxLatenessMinutes:
			parsed.max_lateness_minutes === null ? null : Math.max(1, parsed.max_lateness_minutes),
		hookHash: parsed.hook_hash,
		mailFilter: parsed.mail_filter,
		mailHistoryId: parsed.mail_history_id,
		mailRevision: parsed.mail_revision,
		target: parsed.target,
		chatId: telegram?.chatId ?? 0,
		threadId: telegram?.threadId ?? null,
		responsibilityId: parsed.responsibility_id,
		enabled: parsed.enabled === 1,
		createdAt: parsed.created_at,
		lastRun: parsed.last_run,
		nextRun: parsed.next_run,
	};
}

export function openPrograms(dbPath: string): ProgramsStore {
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
	// Check, create, and purge in one transaction: a failed copy (or a
	// crash) must not leave a half-purged database that prevents retry.
	// The copy runs only when the programs table is being created — an
	// existing table is the operator's truth, deletions included, so
	// legacy rows beside it archive (never reactivate) and the table
	// drops either way. With `jobs` gone the whole block is a no-op, so
	// re-runs are safe. Returns null when there was nothing to purge.
	const purged = db.transaction((): { copied: number; archived: number } | null => {
		const creating =
			db
				.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'programs'")
				.get() === null;
		db.exec(`CREATE TABLE IF NOT EXISTS programs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL,
			charter TEXT NOT NULL,
			kind TEXT NOT NULL DEFAULT 'custom',
			cron TEXT,
			max_lateness_minutes INTEGER,
			hook_hash TEXT,
			mail_filter TEXT,
			mail_history_id TEXT,
			mail_revision INTEGER NOT NULL DEFAULT 0,
			target TEXT NOT NULL,
			chat_id INTEGER NOT NULL DEFAULT 0,
			thread_id INTEGER,
			responsibility_id TEXT,
			enabled INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL,
			last_run TEXT,
			next_run TEXT
		)`);
		// Existing DBs predate the mail trigger/revision and schedule
		// lateness grace — additive only.
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
		if (!progCols.has("max_lateness_minutes")) {
			db.exec("ALTER TABLE programs ADD COLUMN max_lateness_minutes INTEGER");
		}
		if (!progCols.has("target")) {
			db.exec("ALTER TABLE programs ADD COLUMN target TEXT");
			db.exec(`UPDATE programs SET target =
				CASE WHEN thread_id IS NULL THEN 'dm:' || chat_id
				     ELSE 'topic:' || chat_id || ':' || thread_id END
				WHERE target IS NULL`);
		}
		if (!progCols.has("responsibility_id")) {
			db.exec("ALTER TABLE programs ADD COLUMN responsibility_id TEXT");
		}
		if (!progCols.has("kind")) {
			// The follow-up's durable identity postdates the rows it was
			// minting: existing rows read custom, and recovery also matches
			// the exact legacy name convention.
			db.exec("ALTER TABLE programs ADD COLUMN kind TEXT NOT NULL DEFAULT 'custom'");
		}
		const jobsTable = db
			.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jobs'")
			.get();
		if (jobsTable === null) return null;
		// Creating: this open owns the cutover, so legacy rows become
		// programs (same ids, prompt → charter). Existing: the programs
		// rows already reflect operator deletions — copying would resurrect
		// deleted jobs as live, due schedules, so every legacy row archives
		// to recovery instead and nothing activates.
		const copied = creating ? copyLegacyJobs(db) : 0;
		const archived = creating ? 0 : archiveLegacyJobs(db);
		db.exec("DROP TABLE jobs");
		return { copied, archived };
	})();
	if (purged !== null) {
		log.info("legacy jobs table purged", { copied: purged.copied, archived: purged.archived });
	}

	const qGet = db.query("SELECT * FROM programs WHERE id = ?");
	const qList = db.query("SELECT * FROM programs ORDER BY id");
	const qByResp = db.query("SELECT * FROM programs WHERE responsibility_id = ? ORDER BY id");
	const qDue = db.query(
		"SELECT * FROM programs WHERE enabled = 1 AND cron IS NOT NULL AND next_run <= ? ORDER BY next_run",
	);
	const qInsert = db.query(`INSERT INTO programs
		(name, charter, kind, cron, max_lateness_minutes, hook_hash, mail_filter, mail_history_id, target, chat_id, thread_id, responsibility_id, enabled, created_at, last_run, next_run)
		VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 1, ?, NULL, ?)`);
	const qUpdate = db.query(
		"UPDATE programs SET name = ?, charter = ?, cron = ?, max_lateness_minutes = ?, hook_hash = ?, mail_filter = ?, mail_history_id = ?, mail_revision = mail_revision + ?, enabled = ?, next_run = ? WHERE id = ?",
	);
	const qMark = db.query("UPDATE programs SET last_run = ?, next_run = ? WHERE id = ?");
	const qAdvance = db.query("UPDATE programs SET next_run = ? WHERE id = ?");
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
		const maxLatenessMinutes =
			patch.maxLatenessMinutes !== undefined ? patch.maxLatenessMinutes : before.maxLatenessMinutes;
		const hookHash = patch.hookHash !== undefined ? patch.hookHash : before.hookHash;
		const mailFilter = patch.mailFilter !== undefined ? patch.mailFilter : before.mailFilter;
		requireTrigger(cron, hookHash, mailFilter);
		// A stored lateness is inert once the cron is gone — removing a
		// trigger must not trip on it. The requires-cron rule binds a
		// write that SETS the field; the merged value is checked whenever
		// the patch touches lateness at all.
		validateLateness(cron, patch.maxLatenessMinutes !== undefined ? maxLatenessMinutes : null);
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
			maxLatenessMinutes,
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

	// The one create path — fixtures, the proposal store's activation,
	// and any trusted caller all land here so the same validation
	// holds; the model-facing tool no longer reaches it directly.
	const core: ProposalCore = {
		get(id) {
			const row = qGet.get(id);
			return row === null ? null : rowToProgram(row);
		},
		create(
			{
				name,
				charter,
				kind = "custom",
				cron = null,
				maxLatenessMinutes = null,
				hookHash = null,
				mailFilter = null,
				address,
				responsibilityId,
			},
			now = new Date(),
		) {
			requireTrigger(cron, hookHash, mailFilter);
			validateLateness(cron, maxLatenessMinutes);
			// The destination union: exactly one arm — a conversation
			// address or a project responsibility. Responsibility rows
			// carry the resp:<id> pseudo-target; a real Telegram chat id
			// is never 0, and every destination read branches on
			// responsibilityId first.
			if ((address !== undefined) === (responsibilityId !== undefined)) {
				throw new ProgramRuleError(
					"a program needs exactly one destination: a chat address or a responsibility",
				);
			}
			const destination =
				address !== undefined
					? programAddressTarget(address)
					: responsibilityTarget(responsibilityId!);
			if (!isProgramTarget(destination)) {
				throw new ProgramRuleError(`invalid program destination "${destination}"`);
			}
			const telegram = telegramAddressOf(destination);
			const next = cron === null ? null : nextFire(cron, now).toISOString();
			const res = qInsert.run(
				name,
				charter,
				kind,
				cron,
				maxLatenessMinutes,
				hookHash,
				mailFilter,
				destination,
				telegram?.chatId ?? 0,
				telegram?.threadId ?? null,
				responsibilityId ?? null,
				now.toISOString(),
				next,
			);
			return rowToProgram(qGet.get(Number(res.lastInsertRowid)));
		},
		update(id, patch, now) {
			return update.immediate(id, patch, now ?? new Date());
		},
	};
	const proposals = openProgramProposals(db, {
		core,
		validateCreate(draft: ProgramDraft) {
			requireTrigger(draft.cron, draft.hook ? "proposed" : null, draft.mailFilter);
			validateLateness(draft.cron, draft.maxLatenessMinutes);
			if (draft.cron !== null) nextFire(draft.cron, new Date());
		},
		validateUpdate(current: Program, patch: ProgramPatchRequest) {
			const cron = patch.cron !== undefined ? patch.cron : current.cron;
			const hook = patch.hook === true || current.hookHash !== null;
			const mailFilter = patch.mailFilter !== undefined ? patch.mailFilter : current.mailFilter;
			requireTrigger(cron, hook ? "proposed" : null, mailFilter);
			// Same inert-lateness rule as update(): only a patch that sets
			// the field must still have a cron.
			if (patch.maxLatenessMinutes !== undefined) validateLateness(cron, patch.maxLatenessMinutes);
			if (typeof patch.cron === "string") nextFire(patch.cron, new Date());
		},
	});

	return {
		create: core.create,
		update: core.update,
		remove(id) {
			return qDelete.run(id).changes > 0;
		},
		get: core.get,
		list() {
			return qList.all().map(rowToProgram);
		},
		forResponsibility(responsibilityId) {
			return qByResp.all(responsibilityId).map(rowToProgram);
		},
		due(now) {
			return decodeScan(qDue.all(now.toISOString()), "due");
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
		advancePastDue(id, now) {
			const row = qGet.get(id);
			if (row === null) return null;
			const program = rowToProgram(row);
			if (program.cron === null) return null;
			const next = nextFire(program.cron, now).toISOString();
			qAdvance.run(next, id);
			return next;
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
			return decodeScan(qWithMail.all(), "mail");
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
				db.run("UPDATE programs SET thread_id = NULL, target = 'dm:' || chat_id WHERE id = ?", [
					r.id,
				]);
				log.info("dm cutover re-pin", {
					program: r.id,
					name: r.name,
					chat: r.chat_id,
					fromThread: r.thread_id,
				});
			}
			return rows.length;
		},
		proposals,
		close() {
			db.close();
		},
	};
}

// The purge's copy half, called only when the programs table is being
// created. Copies same ids (prompt → charter); INSERT OR IGNORE keeps it
// defensive — an id already in programs was copied in an earlier era,
// and the programs row is the truth. A cron that no longer parses is
// skipped loudly rather than copied verbatim: a bad schedule on the
// row would refire (and re-fail) every tick once markRan advances past
// it.
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
			// SQL copies every column (including unknown legacy fields) without
			// lossy JSON conversion. Preservation and DROP share the transaction;
			// a failed recovery write aborts the purge, never discards the job.
			db.exec("CREATE TABLE IF NOT EXISTS legacy_jobs_recovery AS SELECT * FROM jobs WHERE 0");
			db.run("INSERT INTO legacy_jobs_recovery SELECT * FROM jobs WHERE id = ?", [r.id]);
			log.warn("legacy job skipped — unparsable cron", err, {
				job: r.id,
				name: r.name,
				cron: r.cron,
				recoveryTable: "legacy_jobs_recovery",
			});
			continue;
		}
		copied += db.run(
			`INSERT OR IGNORE INTO programs
			(id, name, charter, cron, hook_hash, target, chat_id, thread_id, enabled, created_at, last_run, next_run)
			VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
			[
				r.id,
				r.name,
				r.prompt,
				r.cron,
				r.thread_id === null ? `dm:${r.chat_id}` : `topic:${r.chat_id}:${r.thread_id}`,
				r.chat_id,
				r.thread_id,
				r.enabled,
				r.created_at,
				r.last_run,
				r.next_run,
			],
		).changes;
	}
	return copied;
}

// The existing-table half: programs already reflects the operator's
// deletions, so nothing may activate. Every legacy row archives with its
// complete original columns (including unknown fields and blobs — the
// same preservation the unparsable-cron path uses) and the caller drops
// the table. A failed archive write aborts the purge, never discards.
function archiveLegacyJobs(db: Database): number {
	const jobs = db
		.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'legacy_jobs_recovery'")
		.get();
	const before =
		jobs === null
			? 0
			: (db.query("SELECT COUNT(*) AS n FROM legacy_jobs_recovery").get() as { n: number }).n;
	db.exec("CREATE TABLE IF NOT EXISTS legacy_jobs_recovery AS SELECT * FROM jobs WHERE 0");
	db.exec("INSERT INTO legacy_jobs_recovery SELECT * FROM jobs");
	const after = (db.query("SELECT COUNT(*) AS n FROM legacy_jobs_recovery").get() as { n: number })
		.n;
	const archived = after - before;
	log.info("legacy jobs archived without activating", {
		archived,
		recoveryTable: "legacy_jobs_recovery",
	});
	return archived;
}

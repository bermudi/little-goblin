// The programs table's invariants: cron validates at the boundary (an
// invalid expression never becomes a row), a program always has a
// trigger, next_run is always the next future occurrence, due() is the
// boot-catch-up query, rows survive a reopen, and the legacy `jobs`
// table copies across exactly once — and is never touched.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextFire, openPrograms, type ProgramsStore } from "./programs.ts";

let dirs: string[] = [];
function tmpdb(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-programs-"));
	dirs.push(dir);
	return join(dir, "goblin.sqlite");
}
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

function store(): ProgramsStore {
	return openPrograms(tmpdb());
}

// Fixed "now" so cron math is deterministic: 2026-09-20T10:00:00 local.
const NOW = new Date("2026-09-20T10:00:00");
const ADDRESS = { chatId: -100, threadId: 7 };

describe("nextFire", () => {
	test("computes the next occurrence after `from`", () => {
		expect(nextFire("30 8 * * *", NOW).getHours()).toBe(8);
		expect(nextFire("30 8 * * *", NOW).getDate()).toBe(21); // 10:00 → tomorrow
	});

	test("rejects a garbage expression with cron-parser's message", () => {
		expect(() => nextFire("not a cron", NOW)).toThrow("invalid cron");
		expect(() => nextFire("61 * * * *", NOW)).toThrow("invalid cron");
	});

	// cron-parser accepts 1–6 fields (the 6th being seconds) — the
	// contract is exactly 5, so a 6-field "*/5 * * * * *" would silently
	// mean every five seconds, and short forms get fields misread.
	test("rejects any expression that is not exactly 5 fields", () => {
		for (const bad of [
			"*/5 * * * * *", // 6: seconds — every 5s
			"0 */5 * * * *", // 6: seconds
			"* * * *", // 4
			"* * *", // 3
			"5 *", // 2
			"*", // 1
			"", // 0
		]) {
			expect(() => nextFire(bad, NOW)).toThrow(
				'expected exactly 5 fields (min hour dom month dow)',
			);
		}
	});

	test("accepts 5 fields regardless of whitespace padding", () => {
		expect(nextFire("  30   8 * * *  ", NOW).getHours()).toBe(8);
	});
});

describe("programs store", () => {
	test("create validates cron before a row exists; next_run is future", () => {
		const s = store();
		expect(() =>
			s.create({ name: "x", cron: "nope", charter: "c", address: ADDRESS }),
		).toThrow("invalid cron");
		expect(s.list()).toEqual([]);

		const p = s.create(
			{ name: "morning brief", cron: "30 8 * * *", charter: "brief me", address: ADDRESS },
			NOW,
		);
		expect(p.id).toBeGreaterThan(0);
		expect(p.enabled).toBe(true);
		expect(p.lastRun).toBeNull();
		expect(new Date(p.nextRun!).getTime()).toBeGreaterThan(NOW.getTime());
	});

	test("a program always has a trigger", () => {
		const s = store();
		expect(() =>
			s.create({ name: "x", charter: "c", address: ADDRESS }),
		).toThrow("at least one trigger");
		expect(s.list()).toEqual([]);

		// A hook alone is a valid trigger — the cron stays null.
		const hooked = s.create(
			{ name: "hooked", charter: "c", hookHash: "abc123", address: ADDRESS },
			NOW,
		);
		expect(hooked.cron).toBeNull();
		expect(hooked.nextRun).toBeNull();
		expect(s.due(new Date("2100-01-01"))).toEqual([]); // never cron-due

		// And the invariant can't be patched away: clearing the only
		// trigger is a readable error, not a dead row.
		expect(() => s.update(hooked.id, { hookHash: null })).toThrow(
			"at least one trigger",
		);
		expect(s.get(hooked.id)!.hookHash).toBe("abc123");
	});

	test("due() matches next_run; disabled and cron-less programs never due", () => {
		const s = store();
		const p = s.create(
			{ name: "x", cron: "* * * * *", charter: "c", address: ADDRESS },
			NOW,
		);
		expect(s.due(NOW)).toEqual([]); // next_run is strictly future
		// A fire missed while the process was down is just "due".
		const later = new Date(NOW.getTime() + 5 * 60_000);
		expect(s.due(later).map((x) => x.id)).toEqual([p.id]);

		const off = s.update(p.id, { enabled: false })!;
		expect(off.enabled).toBe(false);
		expect(s.due(later)).toEqual([]);
	});

	test("markRan records the run and advances to the next occurrence", () => {
		const s = store();
		const p = s.create(
			{ name: "x", cron: "0 * * * *", charter: "c", address: ADDRESS },
			NOW,
		);
		const ranAt = new Date("2026-09-20T11:00:00");
		s.markRan(p.id, ranAt);
		const after = s.get(p.id)!;
		expect(after.lastRun).toBe(ranAt.toISOString());
		expect(new Date(after.nextRun!).getHours()).toBe(12); // hourly, advanced
		expect(s.due(ranAt).map((x) => x.id)).toEqual([]);
	});

	test("markRan without a cron stamps last_run and keeps next_run null", () => {
		const s = store();
		const p = s.create(
			{ name: "hooked", charter: "c", hookHash: "abc123", address: ADDRESS },
			NOW,
		);
		s.markRan(p.id, new Date("2026-09-20T11:00:00"));
		const after = s.get(p.id)!;
		expect(after.lastRun).toBe("2026-09-20T11:00:00.000Z");
		expect(after.nextRun).toBeNull();
	});

	test("update re-validates a changed cron; remove is permanent", () => {
		const s = store();
		const p = s.create(
			{ name: "x", cron: "0 * * * *", charter: "c", address: ADDRESS },
			NOW,
		);
		expect(() => s.update(p.id, { cron: "bogus" })).toThrow("invalid cron");
		const patched = s.update(p.id, { name: "y", cron: "0 6 * * *" }, NOW)!;
		expect(patched.name).toBe("y");
		expect(new Date(patched.nextRun!).getHours()).toBe(6);

		expect(s.remove(p.id)).toBe(true);
		expect(s.remove(p.id)).toBe(false);
		expect(s.get(p.id)).toBeNull();
	});

	test("re-enabling recomputes next_run — skipped occurrences are not owed", () => {
		const s = store();
		const p = s.create(
			{ name: "x", cron: "0 * * * *", charter: "c", address: ADDRESS },
			NOW,
		);
		s.update(p.id, { enabled: false });
		// A day passes while disabled; the stale next_run (11:00 yesterday)
		// must not make the program instantly due the moment it's re-enabled.
		const reEnabledAt = new Date("2026-09-21T10:00:00");
		const on = s.update(p.id, { enabled: true }, reEnabledAt)!;
		expect(on.enabled).toBe(true);
		expect(new Date(on.nextRun!).getHours()).toBe(11); // next hourly from now
		expect(new Date(on.nextRun!).getDate()).toBe(21);
		expect(s.due(reEnabledAt)).toEqual([]);
	});

	test("update can clear the cron while a hook remains; next_run nulls", () => {
		const s = store();
		const p = s.create(
			{ name: "x", cron: "0 * * * *", charter: "c", hookHash: "h", address: ADDRESS },
			NOW,
		);
		const cleared = s.update(p.id, { cron: null })!;
		expect(cleared.cron).toBeNull();
		expect(cleared.nextRun).toBeNull();
		expect(s.due(new Date("2100-01-01"))).toEqual([]);
		// Still trigger-owned — clearing the hook too is refused.
		expect(() => s.setHook(p.id, null)).toThrow("at least one trigger");
	});

	test("setHook/findByHook/markFired — the webhook half of the store", () => {
		const s = store();
		const p = s.create(
			{ name: "x", cron: "0 * * * *", charter: "c", address: ADDRESS },
			NOW,
		);
		expect(s.setHook(999, "h")).toBeNull(); // missing row → null
		s.setHook(p.id, "deadbeef");
		expect(s.findByHook("deadbeef")!.id).toBe(p.id);
		expect(s.findByHook("nope")).toBeNull();

		const before = s.get(p.id)!.nextRun;
		s.markFired(p.id, new Date("2026-09-20T11:00:00"));
		const after = s.get(p.id)!;
		expect(after.lastRun).toBe("2026-09-20T11:00:00.000Z");
		expect(after.nextRun).toBe(before); // hook fires never touch the schedule
	});

	test("rows survive a reopen — same file, fresh connection", () => {
		const path = tmpdb();
		const a = openPrograms(path);
		const p = a.create(
			{ name: "x", cron: "* * * * *", charter: "c", address: ADDRESS },
			NOW,
		);
		a.close();
		const b = openPrograms(path);
		expect(b.get(p.id)!.charter).toBe("c");
		expect(b.get(p.id)!.threadId).toBe(7);
		b.close();
	});

	test("a pre-mail DB migrates in place — old rows read, new trigger works", () => {
		const path = tmpdb();
		const db = new Database(path);
		db.exec(`CREATE TABLE programs (
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
		db.query(`INSERT INTO programs
			(name, charter, cron, hook_hash, chat_id, thread_id, enabled, created_at, last_run, next_run)
			VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, ?)`)
			.run("old", "c", "0 9 * * *", null, -100, 7, NOW.toISOString(), "2026-09-21T09:00:00.000Z");
		db.close();

		const s = openPrograms(path);
		const old = s.list()[0]!;
		expect(old.mailFilter).toBeNull();
		expect(old.mailHistoryId).toBeNull();
		expect(old.cron).toBe("0 9 * * *");
		// And the new trigger works on the migrated table.
		s.setMailFilter(old.id, "from:bank");
		expect(s.get(old.id)!.mailFilter).toBe("from:bank");
		expect(s.withMailFilter()).toHaveLength(1);
		s.close();
	});
});

describe("mail trigger", () => {
	test("a mail filter is a trigger like cron and hook", () => {
		const s = store();
		const p = s.create(
			{ name: "bank watch", charter: "c", mailFilter: "from:bank", address: ADDRESS },
			NOW,
		);
		expect(p.mailFilter).toBe("from:bank");
		expect(p.mailHistoryId).toBeNull();
		expect(p.nextRun).toBeNull();
		expect(s.due(new Date("2100-01-01"))).toEqual([]); // never cron-due

		// Clearing the only trigger is refused, whichever it is.
		expect(() => s.update(p.id, { mailFilter: null })).toThrow("at least one trigger");
		expect(() => s.setMailFilter(p.id, null)).toThrow("at least one trigger");
		expect(s.get(p.id)!.mailFilter).toBe("from:bank");

		// A cron beside it makes the filter clearable.
		s.update(p.id, { cron: "0 9 * * *" });
		s.setMailFilter(p.id, null);
		expect(s.get(p.id)!.mailFilter).toBeNull();
	});

	test("changing the filter resets the cursor; a no-op keeps it", () => {
		const s = store();
		const p = s.create(
			{ name: "w", charter: "c", mailFilter: "from:a", address: ADDRESS },
			NOW,
		);
		s.setMailHistory(p.id, "12345", s.get(p.id)!.mailRevision);
		expect(s.get(p.id)!.mailHistoryId).toBe("12345");

		s.setMailFilter(p.id, "from:a"); // same filter — cursor survives
		expect(s.get(p.id)!.mailHistoryId).toBe("12345");
		expect(s.get(p.id)!.mailRevision).toBe(0);

		s.setMailFilter(p.id, "from:b"); // new query — re-baseline
		expect(s.get(p.id)!.mailFilter).toBe("from:b");
		expect(s.get(p.id)!.mailHistoryId).toBeNull();
		expect(s.get(p.id)!.mailRevision).toBe(1);

		s.setMailHistory(p.id, "999", s.get(p.id)!.mailRevision);
		s.update(p.id, { mailFilter: "from:c" }); // update path resets too
		expect(s.get(p.id)!.mailHistoryId).toBeNull();
		s.setMailHistory(p.id, "1000", s.get(p.id)!.mailRevision);
		s.update(p.id, { charter: "c2" }); // other patches leave it
		expect(s.get(p.id)!.mailHistoryId).toBe("1000");
		expect(s.get(p.id)!.mailRevision).toBe(2);
	});

	test("a second connection cannot change the filter between an edit's read and write", () => {
		const path = tmpdb();
		const a = openPrograms(path);
		const b = openPrograms(path);
		const p = a.create(
			{ name: "w", charter: "old", mailFilter: "from:a", address: ADDRESS },
			NOW,
		);
		a.setMailHistory(p.id, "123", 0);

		// patch.charter is read after update() has loaded the row. Without
		// a writer reservation b's filter edit succeeds here, then a's
		// stale whole-row write restores the old filter and cursor.
		let attempted = false;
		const patch = {
			get charter() {
				attempted = true;
				b.setMailFilter(p.id, "from:b");
				return "new";
			},
		};
		expect(() => a.update(p.id, patch)).toThrow(/locked|busy/i);
		expect(attempted).toBe(true);
		expect(a.get(p.id)).toMatchObject({
			charter: "old", mailFilter: "from:a", mailHistoryId: "123", mailRevision: 0,
		});

		// Once the failed edit rolls back, the other connection may write;
		// a later charter edit observes its filter, cursor and revision.
		b.setMailFilter(p.id, "from:b");
		b.setMailHistory(p.id, "456", b.get(p.id)!.mailRevision);
		expect(a.update(p.id, { charter: "new" })).toMatchObject({
			charter: "new", mailFilter: "from:b", mailHistoryId: "456", mailRevision: 1,
		});
		// A no-op filter set also must preserve that cursor/revision.
		expect(b.setMailFilter(p.id, "from:b")).toMatchObject({
			mailFilter: "from:b", mailHistoryId: "456", mailRevision: 1,
		});
		a.close();
		b.close();
	});

	test("re-enabling resets the cursor — mail while disabled is skipped, not owed", () => {
		const s = store();
		const p = s.create(
			{ name: "w", charter: "c", mailFilter: "from:a", address: ADDRESS },
			NOW,
		);
		s.setMailHistory(p.id, "12345", s.get(p.id)!.mailRevision);
		s.update(p.id, { enabled: false });
		// Disabling keeps the cursor — the watcher just doesn't scan it.
		expect(s.get(p.id)!.mailHistoryId).toBe("12345");
		expect(s.get(p.id)!.mailRevision).toBe(0);
		s.update(p.id, { enabled: true });
		// Re-enabling re-baselines: the disabled-period backlog never
		// fires (the cron rule — skipped, not owed).
		expect(s.get(p.id)!.mailHistoryId).toBeNull();
		expect(s.get(p.id)!.mailRevision).toBe(1);
	});

	test("withMailFilter scans enabled mail programs only", () => {
		const s = store();
		s.create({ name: "m", charter: "c", mailFilter: "from:a", address: ADDRESS }, NOW);
		s.create({ name: "c", charter: "c", cron: "0 9 * * *", address: ADDRESS }, NOW);
		const off = s.create(
			{ name: "off", charter: "c", cron: "0 9 * * *", mailFilter: "from:b", address: ADDRESS },
			NOW,
		);
		s.update(off.id, { enabled: false });
		expect(s.withMailFilter().map((p) => p.name)).toEqual(["m"]);
	});
});

// The superseded `jobs` table, built the way openJobs built it.
function createLegacyJobs(path: string, rows: number): void {
	const db = new Database(path);
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
	const q = db.query(`INSERT INTO jobs
		(name, cron, prompt, chat_id, thread_id, enabled, created_at, last_run, next_run)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
	for (let i = 0; i < rows; i++) {
		q.run(
			`job ${i + 1}`, "30 8 * * *", `prompt ${i + 1}`, -100, 7, i % 2,
			"2026-09-20T09:00:00.000Z", "2026-09-20T09:30:00.000Z",
			"2026-09-21T08:30:00.000Z",
		);
	}
	db.close();
}

describe("mail revision upgrade", () => {
	test("adds a default revision to existing rows without re-copying deleted jobs", () => {
		const path = tmpdb();
		createLegacyJobs(path, 1);
		const db = new Database(path);
		db.exec(`CREATE TABLE programs (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, charter TEXT NOT NULL,
			cron TEXT, hook_hash TEXT, mail_filter TEXT, mail_history_id TEXT,
			chat_id INTEGER NOT NULL, thread_id INTEGER, enabled INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL, last_run TEXT, next_run TEXT
		)`);
		db.query(`INSERT INTO programs
			(id, name, charter, mail_filter, mail_history_id, chat_id, enabled, created_at)
			VALUES (2, 'mail', 'watch', 'from:bank', '100', -100, 1, '2026-09-20')`).run();
		db.close();

		const a = openPrograms(path);
		expect(a.list().map((p) => p.id)).toEqual([2]); // no legacy resurrection
		const initial = a.get(2)!;
		expect(initial.mailRevision).toBe(0);
		expect(initial.mailHistoryId).toBe("100");
		const b = openPrograms(path); // migration is safe on repeat open
		b.setMailFilter(2, "from:new");
		expect(a.baselineMail(initial, "stale")).toBe(false);
		expect(a.get(2)).toMatchObject({ mailRevision: 1, mailHistoryId: null });
		b.close();
		a.close();
		const reopened = openPrograms(path);
		expect(reopened.get(2)).toMatchObject({ mailRevision: 1, mailHistoryId: null });
		expect(reopened.list()).toHaveLength(1);
		reopened.close();
	});
});

describe("legacy jobs copy", () => {
	test("failed copy rolls back table creation so the next boot can retry", () => {
		const path = tmpdb();
		createLegacyJobs(path, 2);
		const fixture = new Database(path);
		fixture.exec("ALTER TABLE jobs RENAME COLUMN prompt TO missing_prompt");
		fixture.close();

		// The copy statement fails after CREATE TABLE. Neither the table
		// nor a partial migration may survive the failed open.
		expect(() => openPrograms(path)).toThrow("no such column: prompt");
		const db = new Database(path);
		expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'programs'").get()).toBeNull();
		expect(db.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({ count: 2 });
		db.exec("ALTER TABLE jobs RENAME COLUMN missing_prompt TO prompt");
		db.close();

		const retried = openPrograms(path);
		expect(retried.list().map(({ id, charter }) => ({ id, charter }))).toEqual([
			{ id: 1, charter: "prompt 1" },
			{ id: 2, charter: "prompt 2" },
		]);
		retried.close();
	});

	test("jobs rows copy into programs once, keeping ids; jobs is untouched", () => {
		const path = tmpdb();
		createLegacyJobs(path, 2);

		const a = openPrograms(path);
		const list = a.list();
		expect(list).toHaveLength(2);
		expect(list[0]).toMatchObject({
			id: 1,
			name: "job 1",
			charter: "prompt 1",
			cron: "30 8 * * *",
			hookHash: null,
			chatId: -100,
			threadId: 7,
			enabled: false, // i % 2 on row 0
			lastRun: "2026-09-20T09:30:00.000Z",
			nextRun: "2026-09-21T08:30:00.000Z",
		});
		expect(list[1]).toMatchObject({ id: 2, enabled: true });
		a.close();

		// The copy ran at table creation — reopening never re-copies, so
		// deletes don't resurrect legacy rows — even deleting them all:
		// the gate is "programs table is new", not "programs is empty".
		const b = openPrograms(path);
		expect(b.remove(2)).toBe(true);
		expect(b.remove(1)).toBe(true);
		b.close();
		const c = openPrograms(path);
		expect(c.list()).toEqual([]);
		c.close();

		// `jobs` itself is never modified or dropped.
		const db = new Database(path);
		const jobs = db.query("SELECT * FROM jobs ORDER BY id").all() as {
			id: number;
			prompt: string;
		}[];
		expect(jobs).toHaveLength(2);
		expect(jobs[0]!.prompt).toBe("prompt 1");
		db.close();
	});

	test("an empty legacy table copies nothing and stays quiet", () => {
		const path = tmpdb();
		createLegacyJobs(path, 0);
		const s = openPrograms(path);
		expect(s.list()).toEqual([]);
		s.close();
	});

	test("no legacy table is the common path — plain open", () => {
		const s = store();
		s.create({ name: "x", cron: "0 9 * * *", charter: "c", address: ADDRESS });
		expect(s.list()).toHaveLength(1);
	});
});

describe("dm cutover re-pin (Rolling DM)", () => {
	// DM topics are retired: a program pinned to a private chat's thread
	// re-pins to the bare chat; group topics and already-bare pins are
	// untouched; the sweep is idempotent.
	test("private-chat thread pins re-pin to the bare chat, idempotently", () => {
		const s = store();
		const dmTopic = s.create(
			{ name: "dm topic", cron: "0 9 * * *", charter: "c", address: { chatId: 5, threadId: 42 } },
		);
		const bare = s.create(
			{ name: "bare dm", cron: "0 9 * * *", charter: "c", address: { chatId: 6, threadId: null } },
		);
		const group = s.create(
			{ name: "group topic", cron: "0 9 * * *", charter: "c", address: ADDRESS },
		);
		expect(s.rePinDmTopics()).toBe(1);
		expect(s.get(dmTopic.id)!.threadId).toBeNull();
		expect(s.get(dmTopic.id)!.chatId).toBe(5);
		expect(s.get(bare.id)!.threadId).toBeNull();
		expect(s.get(group.id)!.threadId).toBe(7);
		// A second sweep finds nothing left.
		expect(s.rePinDmTopics()).toBe(0);
		s.close();
	});
});

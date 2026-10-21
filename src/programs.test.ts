import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { setLogFile, setLogWriter } from "./log.ts";
import {
	latestFireAtOrBefore,
	nextFire,
	openPrograms,
	ProgramRuleError,
	type ProgramsStore,
} from "./programs.ts";
import { tmpDb } from "./testkit.ts";

function store(): ProgramsStore {
	return openPrograms(tmpDb("goblin-programs-"));
}

// Fixed "now" so cron math is deterministic: 2026-09-20T10:00:00 local.
const NOW = new Date("2026-09-20T10:00:00");
const ADDRESS = { chatId: -100, threadId: 7 };

// Cron semantics are zone-local (server time in production), so the
// DST tests pin the process to a zone with both transition kinds and
// restore it after. The assertion fails loud if the runtime ever
// stops honoring mid-process TZ changes — the expectations below are
// meaningless in the host zone.
function inZone<T>(zone: string, fn: () => T): T {
	const effective = Intl.DateTimeFormat().resolvedOptions().timeZone;
	process.env.TZ = zone;
	try {
		expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone);
		return fn();
	} finally {
		process.env.TZ = effective;
	}
}

describe("nextFire", () => {
	test("computes the next occurrence after `from`", () => {
		expect(nextFire("30 8 * * *", NOW).getHours()).toBe(8);
		expect(nextFire("30 8 * * *", NOW).getDate()).toBe(21); // 10:00 → tomorrow
	});

	test("latestFireAtOrBefore includes an occurrence exactly at the scan time", () => {
		const cron = "0 9 * * *";
		const scheduled = nextFire(cron, new Date("2026-09-19T10:00:00"));
		expect(latestFireAtOrBefore(cron, scheduled, scheduled).getTime()).toBe(scheduled.getTime());
		expect(
			latestFireAtOrBefore(cron, scheduled, new Date(scheduled.getTime() + 20 * 60_000)).getTime(),
		).toBe(scheduled.getTime());
	});

	test("latestFireAtOrBefore walks a catch-up to the latest missed occurrence", () => {
		const cron = "*/30 * * * *";
		const firstMissed = nextFire(cron, new Date("2026-09-20T07:05:00")); // 07:30
		const scan = new Date("2026-09-20T10:05:00");
		const latest = latestFireAtOrBefore(cron, firstMissed, scan);
		expect(latest.getTime()).toBe(new Date("2026-09-20T10:00:00").getTime());
	});

	// The grace anchor runs on the scan loop — a synchronous
	// occurrence-per-step walk starved every later program and HTTP
	// request for ~6.6s per year of an every-minute program's lateness.
	// The anchor must jump, not walk.
	test("latestFireAtOrBefore answers a two-year-old every-minute program without walking", () => {
		const through = new Date("2026-10-13T12:34:56Z");
		const firstMissed = nextFire("* * * * *", new Date("2024-10-13T12:00:00Z"));
		const t0 = performance.now();
		const latest = latestFireAtOrBefore("* * * * *", firstMissed, through);
		expect(latest.toISOString()).toBe("2026-10-13T12:34:00.000Z");
		// Generous bound — the unbounded walk measured ~13s for this gap.
		expect(performance.now() - t0).toBeLessThan(2000);
	});

	test("latestFireAtOrBefore rejects an anchor after the scan time", () => {
		const cron = "0 9 * * *";
		expect(() =>
			latestFireAtOrBefore(
				cron,
				new Date("2026-09-21T00:00:00Z"),
				new Date("2026-09-20T00:00:00Z"),
			),
		).toThrow("is after the scan time");
	});

	// A probe throw declines to the walk by design — but the reason
	// must be logged: an unexpected throw is indistinguishable from a
	// cron-parser regression otherwise.
	test("a declined catch-up probe logs the reason before the walk answers", () => {
		const captured: string[] = [];
		setLogFile("catchup-decline-test.log");
		setLogWriter((_p, line) => captured.push(line));
		let latest: Date;
		try {
			// through+1ms crosses Date's range — the candidate probe's parse
			// throws "unhandled timestamp", the walk answers instead.
			const firstMissed = nextFire("* * * * *", new Date("2026-09-20T09:00:00"));
			latest = latestFireAtOrBefore("* * * * *", firstMissed, new Date(8640000000000000));
		} finally {
			setLogFile(null);
			setLogWriter(null);
		}
		// The walk ran to its cap: last walked occurrence stands.
		expect(latest!.getTime()).toBeGreaterThan(0);
		const declined = captured
			.map((l) => JSON.parse(l) as Record<string, unknown>)
			.filter(
				(l) => l.msg === "schedule catch-up probe declined — falling back to the forward walk",
			);
		expect(declined).toHaveLength(1);
		expect(declined[0]).toMatchObject({ level: "warn", cron: "* * * * *" });
		expect(String(declined[0]!.error)).toContain("unhandled timestamp");
	});

	test("an invalid stored cron logs the decline, then still fails loud", () => {
		const captured: string[] = [];
		setLogFile("catchup-decline-bad-test.log");
		setLogWriter((_p, line) => captured.push(line));
		try {
			expect(() =>
				latestFireAtOrBefore("not a cron", new Date("2026-09-20T09:00:00"), NOW),
			).toThrow("invalid cron");
		} finally {
			setLogFile(null);
			setLogWriter(null);
		}
		const declined = captured
			.map((l) => JSON.parse(l) as Record<string, unknown>)
			.filter(
				(l) => l.msg === "schedule catch-up probe declined — falling back to the forward walk",
			);
		expect(declined).toHaveLength(1);
		expect(String(declined[0]!.error)).toContain("invalid cron");
	});

	// Around DST transitions cron-parser's backward lookup walks a
	// different occurrence sequence from the forward one that persists
	// next_run: it skips the spring-forward landing hour and admits the
	// fall-back repeated hour. The grace anchor must be the forward
	// sequence — the same steps markRan takes.
	describe("DST occurrence sequences (America/New_York)", () => {
		test("spring-forward: the landing-hour occurrence is the latest one, not yesterday's", () => {
			inZone("America/New_York", () => {
				const cron = "30 2 * * *"; // 02:30 doesn't exist on 2026-03-08
				// markRan's next_run after the Mar 7 fire — the landing hour.
				const nextRun = nextFire(cron, new Date("2026-03-07T07:30:05Z"));
				expect(nextRun.toISOString()).toBe("2026-03-08T07:30:00.000Z"); // 03:30 EDT
				const scan = new Date("2026-03-08T07:30:10Z"); // 10s after the landing fire
				expect(latestFireAtOrBefore(cron, nextRun, scan).toISOString()).toBe(
					"2026-03-08T07:30:00.000Z",
				); // 10s late — a backward lookup reads 24h
			});
		});

		test("fall-back: the repeated hour is not an occurrence — lateness measures to the first pass", () => {
			inZone("America/New_York", () => {
				const cron = "30 1 * * *"; // 01:30 happens twice on 2026-11-01
				const nextRun = nextFire(cron, new Date("2026-10-31T06:00:00Z"));
				expect(nextRun.toISOString()).toBe("2026-11-01T05:30:00.000Z"); // 01:30 EDT
				const scan = new Date("2026-11-01T06:35:00Z"); // 01:35 EST — past the repeated 01:30
				expect(latestFireAtOrBefore(cron, nextRun, scan).toISOString()).toBe(
					"2026-11-01T05:30:00.000Z",
				); // 65 min — a backward lookup reads 5
			});
		});

		test("a sparse annual cron whose only occurrence is in the spring-forward gap", () => {
			inZone("America/New_York", () => {
				const cron = "30 2 * 3 0#2"; // 2nd Sunday of March, 02:30 — the US gap
				const nextRun = nextFire(cron, new Date("2026-01-01T00:00:00Z"));
				expect(nextRun.toISOString()).toBe("2026-03-08T07:30:00.000Z"); // landing hour
				const scan = new Date("2026-03-08T07:35:00Z");
				expect(latestFireAtOrBefore(cron, nextRun, scan).toISOString()).toBe(
					"2026-03-08T07:30:00.000Z",
				); // 5 min — a backward lookup reads 20 years
			});
		});
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
				"expected exactly 5 fields (min hour dom month dow)",
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
		expect(() => s.create({ name: "x", cron: "nope", charter: "c", address: ADDRESS })).toThrow(
			"invalid cron",
		);
		expect(s.list()).toEqual([]);

		const p = s.create(
			{ name: "morning brief", cron: "30 8 * * *", charter: "brief me", address: ADDRESS },
			NOW,
		);
		expect(p.id).toBeGreaterThan(0);
		expect(p.enabled).toBe(true);
		expect(p.lastRun).toBeNull();
		expect(p.maxLatenessMinutes).toBeNull();
		expect(new Date(p.nextRun!).getTime()).toBeGreaterThan(NOW.getTime());
	});

	test("max lateness is per-program, nullable, and only applies to cron programs", () => {
		const s = store();
		const p = s.create(
			{
				name: "morning brief",
				cron: "30 8 * * *",
				maxLatenessMinutes: 90,
				hookHash: "also-triggered",
				charter: "brief me",
				address: ADDRESS,
			},
			NOW,
		);
		expect(p.maxLatenessMinutes).toBe(90);
		expect(s.update(p.id, { maxLatenessMinutes: null })!.maxLatenessMinutes).toBeNull();
		expect(s.update(p.id, { maxLatenessMinutes: 15 })!.maxLatenessMinutes).toBe(15);
		expect(() =>
			s.create({
				name: "hook",
				charter: "c",
				hookHash: "hash",
				maxLatenessMinutes: 5,
				address: ADDRESS,
			}),
		).toThrow("requires a cron trigger");
		// Removing the cron leaves a stored lateness inert — trigger
		// removal isn't refused over a field that no longer applies;
		// the requires-cron rule binds writes that SET lateness only.
		expect(s.update(p.id, { cron: null })!.cron).toBeNull();
		expect(s.get(p.id)!.maxLatenessMinutes).toBe(15);
		expect(() => s.update(p.id, { maxLatenessMinutes: 30 })).toThrow("requires a cron trigger");
		expect(() => s.update(p.id, { maxLatenessMinutes: -1 })).toThrow("positive");
		expect(() => s.update(p.id, { maxLatenessMinutes: 0 })).toThrow("positive");
		expect(() => s.update(p.id, { maxLatenessMinutes: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
			"safe integer",
		);
	});

	// The program tool routes these to an error result by identity — a
	// message-text match would break on any rewording, and a storage
	// failure whose message happened to contain the phrase would be
	// swallowed as a rule violation.
	test("rule violations are ProgramRuleError — everything else propagates as-is", () => {
		const s = store();
		expect(() =>
			s.create({
				name: "hook",
				charter: "c",
				hookHash: "h",
				maxLatenessMinutes: 5,
				address: ADDRESS,
			}),
		).toThrow(ProgramRuleError);
		expect(() => s.create({ name: "x", charter: "c", address: ADDRESS })).toThrow(ProgramRuleError);
		const p = s.create({ name: "hooked", charter: "c", hookHash: "abc123", address: ADDRESS }, NOW);
		expect(() => s.update(p.id, { hookHash: null })).toThrow(ProgramRuleError);
		expect(() => s.update(p.id, { maxLatenessMinutes: -1 })).toThrow(ProgramRuleError);
		// Cron validation is not a rule violation — it's the boundary's
		// own readable rejection.
		expect(() => s.update(p.id, { cron: "nope" })).not.toThrow(ProgramRuleError);
	});

	test("a program always has a trigger", () => {
		const s = store();
		expect(() => s.create({ name: "x", charter: "c", address: ADDRESS })).toThrow(
			"at least one trigger",
		);
		expect(s.list()).toEqual([]);

		const hooked = s.create(
			{ name: "hooked", charter: "c", hookHash: "abc123", address: ADDRESS },
			NOW,
		);
		expect(hooked.cron).toBeNull();
		expect(hooked.nextRun).toBeNull();
		expect(s.due(new Date("2100-01-01"))).toEqual([]); // never cron-due

		// The invariant can't be patched away either.
		expect(() => s.update(hooked.id, { hookHash: null })).toThrow("at least one trigger");
		expect(s.get(hooked.id)!.hookHash).toBe("abc123");
	});

	test("due() matches next_run; disabled and cron-less programs never due", () => {
		const s = store();
		const p = s.create({ name: "x", cron: "* * * * *", charter: "c", address: ADDRESS }, NOW);
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
		const p = s.create({ name: "x", cron: "0 * * * *", charter: "c", address: ADDRESS }, NOW);
		const ranAt = new Date("2026-09-20T11:00:00");
		s.markRan(p.id, ranAt);
		const after = s.get(p.id)!;
		expect(after.lastRun).toBe(ranAt.toISOString());
		expect(new Date(after.nextRun!).getHours()).toBe(12); // hourly, advanced
		expect(s.due(ranAt).map((x) => x.id)).toEqual([]);
	});

	test("advancePastDue moves the schedule without claiming a run happened", () => {
		const s = store();
		const p = s.create(
			{ name: "x", cron: "0 * * * *", charter: "c", address: ADDRESS },
			new Date("2026-09-20T08:00:00"),
		);
		const scan = new Date("2026-09-20T12:30:00");
		const next = s.advancePastDue(p.id, scan);
		const after = s.get(p.id)!;
		expect(next).toBe(after.nextRun);
		expect(new Date(after.nextRun!).getHours()).toBe(13);
		expect(after.lastRun).toBeNull();
		expect(s.due(scan)).toEqual([]);
	});

	test("markRan without a cron stamps last_run and keeps next_run null", () => {
		const s = store();
		const p = s.create({ name: "hooked", charter: "c", hookHash: "abc123", address: ADDRESS }, NOW);
		s.markRan(p.id, new Date("2026-09-20T11:00:00"));
		const after = s.get(p.id)!;
		expect(after.lastRun).toBe("2026-09-20T11:00:00.000Z");
		expect(after.nextRun).toBeNull();
	});

	test("update re-validates a changed cron; remove is permanent", () => {
		const s = store();
		const p = s.create({ name: "x", cron: "0 * * * *", charter: "c", address: ADDRESS }, NOW);
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
		const p = s.create({ name: "x", cron: "0 * * * *", charter: "c", address: ADDRESS }, NOW);
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
		const p = s.create({ name: "x", cron: "0 * * * *", charter: "c", address: ADDRESS }, NOW);
		expect(s.setHook(999, "h")).toBeNull();
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
		const path = tmpDb("goblin-programs-");
		const a = openPrograms(path);
		const p = a.create({ name: "x", cron: "* * * * *", charter: "c", address: ADDRESS }, NOW);
		a.close();
		const b = openPrograms(path);
		expect(b.get(p.id)!.charter).toBe("c");
		expect(b.get(p.id)!.threadId).toBe(7);
		b.close();
	});

	test("a pre-mail DB migrates in place — old rows read, new trigger works", () => {
		const path = tmpDb("goblin-programs-");
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
			VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, ?)`).run(
			"old",
			"c",
			"0 9 * * *",
			null,
			-100,
			7,
			NOW.toISOString(),
			"2026-09-21T09:00:00.000Z",
		);
		db.close();

		const s = openPrograms(path);
		const old = s.list()[0]!;
		expect(old.mailFilter).toBeNull();
		expect(old.mailHistoryId).toBeNull();
		expect(old.cron).toBe("0 9 * * *");
		expect(old.maxLatenessMinutes).toBeNull();
		s.setMailFilter(old.id, "from:bank");
		expect(s.get(old.id)!.mailFilter).toBe("from:bank");
		expect(s.withMailFilter()).toHaveLength(1);
		s.close();
	});

	// The two timer-driven scans tolerate a row the schema rejects: it is
	// an error line per scan, never a throw that takes every other
	// program's fire down with it (the scheduler scan runs from a
	// synchronous interval — a throw there is a process exit and a
	// restart loop on the same row).
	test("due() and withMailFilter() skip an undecodable row and keep the rest", () => {
		const path = tmpDb("goblin-programs-");
		const s = openPrograms(path);
		const good = s.create(
			{ name: "good", cron: "* * * * *", charter: "c", address: ADDRESS },
			new Date(NOW.getTime() - 10 * 60_000),
		);
		s.setMailFilter(good.id, "from:good");
		const bad = s.create(
			{ name: "bad", cron: "* * * * *", charter: "c", address: ADDRESS },
			new Date(NOW.getTime() - 10 * 60_000),
		);
		s.setMailFilter(bad.id, "from:bad");
		// A hand edit (or a column from another version) the schema rejects.
		const db = new Database(path);
		db.run("UPDATE programs SET target = 'not a target' WHERE id = ?", [bad.id]);
		db.close();
		expect(s.due(NOW).map((p) => p.id)).toEqual([good.id]);
		expect(s.withMailFilter().map((p) => p.id)).toEqual([good.id]);
		// Point reads stay strict — the caller fails loud on the bad row.
		expect(() => s.get(bad.id)).toThrow();
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
		const p = s.create({ name: "w", charter: "c", mailFilter: "from:a", address: ADDRESS }, NOW);
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
		const path = tmpDb("goblin-programs-");
		const a = openPrograms(path);
		const b = openPrograms(path);
		const p = a.create({ name: "w", charter: "old", mailFilter: "from:a", address: ADDRESS }, NOW);
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
			charter: "old",
			mailFilter: "from:a",
			mailHistoryId: "123",
			mailRevision: 0,
		});

		// After the failed edit rolls back, b's write lands; a later
		// charter edit observes its filter, cursor and revision.
		b.setMailFilter(p.id, "from:b");
		b.setMailHistory(p.id, "456", b.get(p.id)!.mailRevision);
		expect(a.update(p.id, { charter: "new" })).toMatchObject({
			charter: "new",
			mailFilter: "from:b",
			mailHistoryId: "456",
			mailRevision: 1,
		});
		// A no-op filter set also must preserve that cursor/revision.
		expect(b.setMailFilter(p.id, "from:b")).toMatchObject({
			mailFilter: "from:b",
			mailHistoryId: "456",
			mailRevision: 1,
		});
		a.close();
		b.close();
	});

	test("re-enabling resets the cursor — mail while disabled is skipped, not owed", () => {
		const s = store();
		const p = s.create({ name: "w", charter: "c", mailFilter: "from:a", address: ADDRESS }, NOW);
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

// The superseded `jobs` table in its openJobs shape.
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
			`job ${i + 1}`,
			"30 8 * * *",
			`prompt ${i + 1}`,
			-100,
			7,
			i % 2,
			"2026-09-20T09:00:00.000Z",
			"2026-09-20T09:30:00.000Z",
			"2026-09-21T08:30:00.000Z",
		);
	}
	db.close();
}

describe("mail revision upgrade", () => {
	test("adds a default revision to existing rows; legacy rows beside them archive, never activate", () => {
		const path = tmpDb("goblin-programs-");
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
		// The programs table already exists — it is the operator's truth,
		// so the leftover jobs row archives to recovery instead of
		// becoming a live program, and the jobs table still drops.
		expect(a.list().map((p) => p.id)).toEqual([2]);
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
		const check = new Database(path);
		expect(check.query("SELECT COUNT(*) AS n FROM legacy_jobs_recovery").get()).toEqual({ n: 1 });
		expect(
			check.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get(),
		).toBeNull();
		check.close();
	});
});

describe("legacy jobs purge", () => {
	test("unparsable jobs preserve complete recovery data before the legacy table drops", () => {
		const path = tmpDb("goblin-programs-");
		createLegacyJobs(path, 2);
		const fixture = new Database(path);
		fixture.exec("ALTER TABLE jobs ADD COLUMN recovery_blob BLOB");
		fixture.run("UPDATE jobs SET cron = ?, prompt = ?, recovery_blob = ? WHERE id = 1", [
			"not a cron",
			"Do not lose this standing instruction\nwith its full context",
			new Uint8Array([0, 255, 1]),
		]);
		const original = fixture.query("SELECT * FROM jobs WHERE id = 1").get();
		fixture.close();

		const programs = openPrograms(path);
		expect(programs.list().map((p) => p.id)).toEqual([2]);
		programs.close();
		const reopened = openPrograms(path);
		reopened.close();
		const check = new Database(path);
		expect(check.query("SELECT * FROM legacy_jobs_recovery").all()).toEqual([original]);
		expect(check.query("SELECT name FROM sqlite_master WHERE name = 'jobs'").get()).toBeNull();
		check.close();
	});

	test("failed preservation aborts the purge and retains every original job", () => {
		const path = tmpDb("goblin-programs-");
		createLegacyJobs(path, 2);
		const fixture = new Database(path);
		fixture.exec(`UPDATE jobs SET cron = 'bad cron' WHERE id = 2;
			CREATE TABLE legacy_jobs_recovery AS SELECT * FROM jobs WHERE 0;
			CREATE TRIGGER refuse_recovery BEFORE INSERT ON legacy_jobs_recovery
			BEGIN SELECT RAISE(ABORT, 'recovery write failed'); END;`);
		const original = fixture.query("SELECT * FROM jobs ORDER BY id").all();
		fixture.close();
		expect(() => openPrograms(path)).toThrow("recovery write failed");
		const check = new Database(path);
		expect(check.query("SELECT * FROM jobs ORDER BY id").all()).toEqual(original);
		expect(check.query("SELECT name FROM sqlite_master WHERE name = 'programs'").get()).toBeNull();
		check.exec("DROP TRIGGER refuse_recovery");
		check.close();
		const retried = openPrograms(path);
		expect(retried.list().map((p) => p.id)).toEqual([1]);
		retried.close();
	});

	test("failed copy rolls back the purge so the next boot can retry", () => {
		const path = tmpDb("goblin-programs-");
		createLegacyJobs(path, 2);
		const fixture = new Database(path);
		fixture.exec("ALTER TABLE jobs RENAME COLUMN prompt TO missing_prompt");
		fixture.close();

		// The copy statement fails after CREATE TABLE. Neither the table
		// nor a partial purge may survive the failed open.
		expect(() => openPrograms(path)).toThrow("no such column: prompt");
		const db = new Database(path);
		expect(
			db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'programs'").get(),
		).toBeNull();
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

	test("jobs rows copy in keeping ids, then the table drops; re-opens are no-ops", () => {
		const path = tmpDb("goblin-programs-");
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

		// `jobs` is gone — nothing left to copy or resurrect from.
		const db = new Database(path);
		expect(
			db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get(),
		).toBeNull();
		db.close();

		// Deletes survive re-opens: the table is gone, the copy can't re-run.
		const b = openPrograms(path);
		expect(b.remove(2)).toBe(true);
		expect(b.remove(1)).toBe(true);
		b.close();
		const c = openPrograms(path);
		expect(c.list()).toEqual([]);
		c.close();
	});

	test("a jobs row whose id already sits in programs is ignored, not duplicated", () => {
		const path = tmpDb("goblin-programs-");
		createLegacyJobs(path, 1);
		const db = new Database(path);
		db.exec(`CREATE TABLE programs (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, charter TEXT NOT NULL,
			cron TEXT, hook_hash TEXT, mail_filter TEXT, mail_history_id TEXT,
			chat_id INTEGER NOT NULL, thread_id INTEGER, enabled INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL, last_run TEXT, next_run TEXT
		)`);
		db.query(`INSERT INTO programs (id, name, charter, cron, chat_id, enabled, created_at)
			VALUES (1, 'kept', 'current charter', '0 9 * * *', -100, 1, '2026-09-25')`).run();
		db.close();

		const s = openPrograms(path);
		// The programs row is the truth; the stale jobs row must not
		// clobber it — it archives to recovery instead — and must not
		// fail the open either.
		expect(s.list()).toHaveLength(1);
		expect(s.get(1)).toMatchObject({ name: "kept", charter: "current charter" });
		s.close();
		const check = new Database(path);
		expect(
			check.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get(),
		).toBeNull();
		expect(check.query("SELECT COUNT(*) AS n FROM legacy_jobs_recovery").get()).toEqual({ n: 1 });
		check.close();
	});

	test("an empty legacy table drops with nothing copied", () => {
		const path = tmpDb("goblin-programs-");
		createLegacyJobs(path, 0);
		const s = openPrograms(path);
		expect(s.list()).toEqual([]);
		s.close();
		const db = new Database(path);
		expect(
			db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get(),
		).toBeNull();
		db.close();
	});

	test("legacy rows beside an existing programs table never resurrect deleted programs", () => {
		// The pre-purge shape: `jobs` was never dropped, `programs` already
		// reflects the operator's deletions (job 2's program is gone). The
		// open must archive the leftovers, not re-activate them — a revived
		// row with a past next_run would fire on the next scheduler tick.
		const path = tmpDb("goblin-programs-");
		createLegacyJobs(path, 2);
		const db = new Database(path);
		db.exec(`CREATE TABLE programs (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, charter TEXT NOT NULL,
			cron TEXT, hook_hash TEXT, mail_filter TEXT, mail_history_id TEXT,
			chat_id INTEGER NOT NULL, thread_id INTEGER, enabled INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL, last_run TEXT, next_run TEXT
		)`);
		db.query(`INSERT INTO programs
			(id, name, charter, cron, chat_id, thread_id, enabled, created_at, last_run, next_run)
			VALUES (1, 'job 1', 'prompt 1', '30 8 * * *', -100, 7, 0,
			'2026-09-20T09:00:00.000Z', '2026-09-20T09:30:00.000Z', '2026-09-21T08:30:00.000Z')`).run();
		db.close();

		const s = openPrograms(path);
		expect(s.list().map((p) => p.id)).toEqual([1]);
		expect(s.get(2)).toBeNull(); // the deleted job stays deleted
		expect(s.due(new Date("2026-09-22T10:00:00")).map((p) => p.id)).not.toContain(2);
		s.close();
		const check = new Database(path);
		// Both leftovers archive with complete rows; the table still drops.
		expect(check.query("SELECT COUNT(*) AS n FROM legacy_jobs_recovery").get()).toEqual({ n: 2 });
		expect(
			check.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get(),
		).toBeNull();
		check.close();
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
		const dmTopic = s.create({
			name: "dm topic",
			cron: "0 9 * * *",
			charter: "c",
			address: { chatId: 5, threadId: 42 },
		});
		const bare = s.create({
			name: "bare dm",
			cron: "0 9 * * *",
			charter: "c",
			address: { chatId: 6, threadId: null },
		});
		const group = s.create({
			name: "group topic",
			cron: "0 9 * * *",
			charter: "c",
			address: ADDRESS,
		});
		expect(s.rePinDmTopics()).toBe(1);
		expect(s.get(dmTopic.id)!.threadId).toBeNull();
		expect(s.get(dmTopic.id)!.chatId).toBe(5);
		expect(s.get(bare.id)!.threadId).toBeNull();
		expect(s.get(group.id)!.threadId).toBe(7);
		expect(s.rePinDmTopics()).toBe(0);
		s.close();
	});
});

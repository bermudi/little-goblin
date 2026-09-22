// The jobs table's invariants: cron validates at the boundary (an
// invalid expression never becomes a row), next_run is always the next
// future occurrence, due() is the boot-catch-up query, and rows
// survive a reopen (same file, own connection).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextFire, openJobs, type JobsStore } from "./jobs.ts";

let dirs: string[] = [];
function tmpdb(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-jobs-"));
	dirs.push(dir);
	return join(dir, "goblin.sqlite");
}
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

function store(): JobsStore {
	return openJobs(tmpdb());
}

// Fixed "now" so cron math is deterministic: 2026-09-20T10:00:00 local.
const NOW = new Date("2026-09-20T10:00:00");

describe("nextFire", () => {
	test("computes the next occurrence after `from`", () => {
		expect(nextFire("30 8 * * *", NOW).getHours()).toBe(8);
		expect(nextFire("30 8 * * *", NOW).getDate()).toBe(21); // 10:00 → tomorrow
	});

	test("rejects a garbage expression with cron-parser's message", () => {
		expect(() => nextFire("not a cron", NOW)).toThrow("invalid cron");
		expect(() => nextFire("61 * * * *", NOW)).toThrow("invalid cron");
	});
});

describe("jobs store", () => {
	test("create validates cron before a row exists; next_run is future", () => {
		const s = store();
		expect(() =>
			s.create({ name: "x", cron: "nope", prompt: "p", address: { chatId: 1, threadId: null } }),
		).toThrow("invalid cron");
		expect(s.list()).toEqual([]);

		const job = s.create(
			{ name: "morning brief", cron: "30 8 * * *", prompt: "brief me", address: { chatId: -100, threadId: 7 } },
			NOW,
		);
		expect(job.id).toBeGreaterThan(0);
		expect(job.enabled).toBe(true);
		expect(job.lastRun).toBeNull();
		expect(new Date(job.nextRun).getTime()).toBeGreaterThan(NOW.getTime());
	});

	test("due() matches next_run; disabled jobs are never due", () => {
		const s = store();
		const job = s.create(
			{ name: "x", cron: "* * * * *", prompt: "p", address: { chatId: 1, threadId: null } },
			NOW,
		);
		expect(s.due(NOW)).toEqual([]); // next_run is strictly future
		// A fire missed while the process was down is just "due".
		const later = new Date(NOW.getTime() + 5 * 60_000);
		expect(s.due(later).map((j) => j.id)).toEqual([job.id]);

		const off = s.update(job.id, { enabled: false })!;
		expect(off.enabled).toBe(false);
		expect(s.due(later)).toEqual([]);
	});

	test("markRan records the run and advances to the next occurrence", () => {
		const s = store();
		const job = s.create(
			{ name: "x", cron: "0 * * * *", prompt: "p", address: { chatId: 1, threadId: null } },
			NOW,
		);
		const ranAt = new Date("2026-09-20T11:00:00");
		s.markRan(job.id, ranAt);
		const after = s.get(job.id)!;
		expect(after.lastRun).toBe(ranAt.toISOString());
		expect(new Date(after.nextRun).getHours()).toBe(12); // hourly, advanced
		expect(s.due(ranAt).map((j) => j.id)).toEqual([]);
	});

	test("update re-validates a changed cron; remove is permanent", () => {
		const s = store();
		const job = s.create(
			{ name: "x", cron: "0 * * * *", prompt: "p", address: { chatId: 1, threadId: null } },
			NOW,
		);
		expect(() => s.update(job.id, { cron: "bogus" })).toThrow("invalid cron");
		const patched = s.update(job.id, { name: "y", cron: "0 6 * * *" }, NOW)!;
		expect(patched.name).toBe("y");
		expect(new Date(patched.nextRun).getHours()).toBe(6);

		expect(s.remove(job.id)).toBe(true);
		expect(s.remove(job.id)).toBe(false);
		expect(s.get(job.id)).toBeNull();
	});

	test("re-enabling recomputes next_run — skipped occurrences are not owed", () => {
		const s = store();
		const job = s.create(
			{ name: "x", cron: "0 * * * *", prompt: "p", address: { chatId: 1, threadId: null } },
			NOW,
		);
		s.update(job.id, { enabled: false });
		// A day passes while disabled; the stale next_run (11:00 yesterday)
		// must not make the job instantly due the moment it's re-enabled.
		const reEnabledAt = new Date("2026-09-21T10:00:00");
		const on = s.update(job.id, { enabled: true }, reEnabledAt)!;
		expect(on.enabled).toBe(true);
		expect(new Date(on.nextRun).getHours()).toBe(11); // next hourly from now
		expect(new Date(on.nextRun).getDate()).toBe(21);
		expect(s.due(reEnabledAt)).toEqual([]);
	});

	test("rows survive a reopen — same file, fresh connection", () => {
		const path = tmpdb();
		const a = openJobs(path);
		const job = a.create(
			{ name: "x", cron: "* * * * *", prompt: "p", address: { chatId: 1, threadId: 3 } },
			NOW,
		);
		a.close();
		const b = openJobs(path);
		expect(b.get(job.id)!.prompt).toBe("p");
		expect(b.get(job.id)!.threadId).toBe(3);
		b.close();
	});
});

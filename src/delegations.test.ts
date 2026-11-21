import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentNameFor, openDelegations } from "./delegations.ts";
import { prReadinessFixture } from "./test-helpers/pr-readiness.ts";

describe("agentNameFor", () => {
	test("slugifies into herdr's name charset, capped at 32", () => {
		expect(agentNameFor(3, "Fix the THING!!")).toBe("g3-fix-the-thing");
		expect(agentNameFor(12, "résumé — unicode ✨")).toMatch(/^g12-[a-z0-9_-]+$/);
		expect(agentNameFor(9, "x".repeat(60)).length).toBeLessThanOrEqual(32);
		expect(agentNameFor(4, "!!!")).toBe("g4-delegation");
	});
});

let dirs: string[] = [];
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});
function tmpdirPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-deleg-"));
	dirs.push(dir);
	return dir;
}

describe("delegations store", () => {
	test("readiness observations reopen without losing sources", () => {
		const path = join(tmpdirPath(), "goblin.sqlite");
		const first = openDelegations(path);
		const d = first.create({
			name: "old observation", harness: "codex", role: "lead",
			pr: { issue: { repository: "owner/repo", number: 7 }, checks: [] }, cwd: "/w", task: "build",
			address: { chatId: 0, threadId: null }, responsibilityId: "r1",
		});
		first.setStatus(d.id, "done");
		const observation = prReadinessFixture("green");
		first.recordReadiness(d.id, first.get(d.id)!, observation, true);
		first.close();
		const second = openDelegations(path);
		try {
			const saved = second.list()[0]!;
			expect(saved.readiness).toEqual(observation);
			expect(saved.readinessVersion).toBe(1);
			second.recordReadiness(saved.id, saved, prReadinessFixture("green"));
			expect(second.get(saved.id)?.readinessVersion).toBe(1);
			expect(second.get(saved.id)?.readiness?.result).toMatchObject({
				kind: "checked",
			});
		} finally { second.close(); }
	});

	test("legacy verifier observations are cleared and issue watches migrate with no required checks", () => {
		const path = join(tmpdirPath(), "legacy-readiness.sqlite");
		const db = new Database(path);
		db.exec(`CREATE TABLE delegations (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, harness TEXT NOT NULL,
			cwd TEXT NOT NULL, task TEXT NOT NULL, chat_id INTEGER NOT NULL, thread_id INTEGER,
			agent_name TEXT NOT NULL, workspace_id TEXT NOT NULL, pane_id TEXT NOT NULL,
			status TEXT NOT NULL, baseline_seq INTEGER, prompted_at TEXT NOT NULL,
			created_at TEXT NOT NULL, finished_at TEXT, app_conversation TEXT,
			prompt_pending INTEGER NOT NULL DEFAULT 0, responsibility_id TEXT,
			responsibility_revision INTEGER, role TEXT NOT NULL DEFAULT 'default',
			issue_json TEXT, readiness_json TEXT, readiness_notified_key TEXT,
			readiness_version INTEGER NOT NULL DEFAULT 0, readiness_pending_verdict TEXT
		)`);
		const oldObservation = {
			observedAt: "2026-11-20T00:00:00.000Z",
			issue: { repository: "owner/repo", number: 7 },
			source: "https://github.com/owner/repo/issues/7",
			result: { kind: "checked", pr: "https://github.com/owner/repo/pull/8",
				head: { sha: "a".repeat(40), source: "https://github.com/owner/repo/pull/8/commits/abc" },
				verifier: { verdict: "PASS", sha: "a".repeat(40), source: "https://github.com/owner/repo/pull/8#issuecomment-1",
					author: "worker", notes: "PASS", notesTruncated: false },
				ci: { state: "green", sha: "a".repeat(40), source: "https://github.com/owner/repo/pull/8/checks" },
				ready: true, reasons: [] },
		};
		db.query(`INSERT INTO delegations
			(name, harness, cwd, task, chat_id, thread_id, agent_name, workspace_id, pane_id,
			 status, baseline_seq, prompted_at, created_at, responsibility_id, role, issue_json,
			 readiness_json, readiness_notified_key, readiness_version, readiness_pending_verdict)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
			"legacy", "codex", "/w", "task", 0, null, "g1-legacy", "w", "p",
			"done", 2, "2026-11-20T00:00:00.000Z", "2026-11-20T00:00:00.000Z",
			"r1", "default", JSON.stringify({ repository: "owner/repo", number: 7 }),
			JSON.stringify(oldObservation), "old-notified", 4, "done",
		);
		db.close();
		const store = openDelegations(path);
		try {
			expect(store.get(1)).toMatchObject({
				pr: { issue: { repository: "owner/repo", number: 7 }, checks: [] },
				readiness: null, readinessNotifiedKey: null,
				readinessPendingVerdict: "done", readinessVersion: 4,
			});
		} finally { store.close(); }
	});

	test("lead identity and observations survive reopen; a new prompt fences old readiness", () => {
		const path = join(tmpdirPath(), "goblin.sqlite");
		const first = openDelegations(path);
		const row = first.create({
			name: "lead", harness: "codex", role: "lead",
			pr: { issue: { repository: "owner/repo", number: 7 }, checks: ["verify"] }, cwd: "/w", task: "build",
			address: { chatId: 0, threadId: null }, responsibilityId: "r1", responsibilityRevision: 1,
		});
		first.setStatus(row.id, "done");
		const done = first.get(row.id)!;
		const observation = prReadinessFixture();
		expect(first.recordReadiness(row.id, done, observation)).toBe(true);
		first.close();
		const second = openDelegations(path);
		try {
			expect(second.get(row.id)).toMatchObject({
				role: "lead", pr: { issue: { repository: "owner/repo", number: 7 }, checks: ["verify"] },
				readiness: observation, readinessNotifiedKey: null, readinessVersion: 1,
			});
			second.markRunning(row.id, 5, new Date(Date.now() + 1000));
			expect(second.recordReadiness(row.id, done, prReadinessFixture("green"), true)).toBe(false);
			expect(second.get(row.id)).toMatchObject({ readiness: null, readinessNotifiedKey: null });
		} finally { second.close(); }
	});


	// baseline_seq went nullable — NULL is the baseline-pending posture (a
	// failed post-prompt read never falls back to a pre-prompt value).
	// Legacy NOT NULL tables rebuild in place, rows intact.
	test("a NOT NULL baseline_seq table migrates to nullable; the pending posture round-trips", () => {
		const path = join(tmpdirPath(), "goblin.sqlite");
		const db = new Database(path);
		db.exec(`CREATE TABLE delegations (
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
			finished_at TEXT,
			app_conversation TEXT
		)`);
		db.exec(`INSERT INTO delegations
			(name, harness, cwd, task, chat_id, thread_id, agent_name, workspace_id, pane_id, status, baseline_seq, prompted_at, created_at, finished_at)
			VALUES ('old row', 'codex', '/w', 't', -100, 7, 'g1-old-row', 'w1', 'w1:p1', 'running', 3, '2026-10-07T00:00:00Z', '2026-10-07T00:00:00Z', NULL)`);
		db.exec("ALTER TABLE delegations ADD COLUMN responsibility_id TEXT");
		db.exec("ALTER TABLE delegations ADD COLUMN responsibility_revision INTEGER");
		db.exec("UPDATE delegations SET responsibility_id = 'r-old', responsibility_revision = 2");
		db.close();
		const store = openDelegations(path);
		try {
			expect(store.get(1)!.baselineSeq).toBe(3);
			expect(store.get(1)).toMatchObject({
				role: "default", pr: null, readiness: null,
				responsibilityId: "r-old", responsibilityRevision: 2,
			});
			const d = store.create({
				name: "pending",
				harness: "codex",
				cwd: "/w",
				task: "t",
				address: { chatId: 1, threadId: null },
			});
			store.markRunning(d.id, null, new Date());
			expect(store.get(d.id)!.baselineSeq).toBeNull();
			const row = store.get(d.id)!;
			expect(
				store.captureBaseline(d.id, { status: row.status, promptedAt: row.promptedAt }, 8),
			).toBe(true);
			expect(store.get(d.id)!.baselineSeq).toBe(8);
			// A stale expect (a send landed mid-scan) refuses to write.
			expect(
				store.captureBaseline(d.id, { status: row.status, promptedAt: "1970-01-01T00:00:00Z" }, 99),
			).toBe(false);
			expect(store.get(d.id)!.baselineSeq).toBe(8);
		} finally {
			store.close();
		}
		// Idempotent: a second open over the rebuilt table is a no-op.
		const again = openDelegations(path);
		try {
			expect(again.get(1)!.baselineSeq).toBe(3);
			expect(again.get(2)!.baselineSeq).toBe(8);
		} finally {
			again.close();
		}
	});

	test("app_conversation round-trips; unset reads null", () => {
		const store = openDelegations(join(tmpdirPath(), "goblin.sqlite"));
		const tg = store.create({
			name: "topic work",
			harness: "codex",
			cwd: "/w",
			task: "t",
			address: { chatId: -100, threadId: 7 },
		});
		expect(tg.appConversation).toBeNull();
		const app = store.create({
			name: "app work",
			harness: "codex",
			cwd: "/w",
			task: "t",
			address: { chatId: 0, threadId: null },
			appConversation: "app/spun-off",
		});
		expect(app.appConversation).toBe("app/spun-off");
		expect(app.chatId).toBe(0); // the fillers — the pin owns the target
		expect(store.get(app.id)!.appConversation).toBe("app/spun-off");
		store.close();
	});

	test("a row written before the column existed reads appConversation null", () => {
		const path = join(tmpdirPath(), "goblin.sqlite");
		// The pre-spin-off table shape — no app_conversation column.
		const db = new Database(path);
		db.exec(`CREATE TABLE delegations (
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
		db.exec(`INSERT INTO delegations
			(name, harness, cwd, task, chat_id, thread_id, agent_name, workspace_id, pane_id, status, baseline_seq, prompted_at, created_at, finished_at)
			VALUES ('old row', 'codex', '/w', 't', -100, 7, 'g1-old-row', 'w1', 'w1:p1', 'running', 3, 'x', 'x', NULL)`);
		db.close();
		const store = openDelegations(path);
		const row = store.get(1)!;
		expect(row.name).toBe("old row");
		expect(row.appConversation).toBeNull();
		expect(row.chatId).toBe(-100);
		expect(row.threadId).toBe(7);
		store.close();
	});
});

describe("responsibility link columns", () => {
	test("a table from before the link opens, and its rows read as unlinked", () => {
		const dbPath = join(mkdtempSync(join(tmpdir(), "goblin-deleglink-")), "goblin.sqlite");
		const db = new Database(dbPath);
		db.exec(`CREATE TABLE delegations (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, harness TEXT NOT NULL,
			cwd TEXT NOT NULL, task TEXT NOT NULL, chat_id INTEGER NOT NULL, thread_id INTEGER,
			agent_name TEXT NOT NULL, workspace_id TEXT NOT NULL, pane_id TEXT NOT NULL,
			status TEXT NOT NULL, target TEXT, baseline_seq INTEGER, prompted_at TEXT NOT NULL,
			created_at TEXT NOT NULL, finished_at TEXT, app_conversation TEXT,
			prompt_pending INTEGER NOT NULL DEFAULT 0)`);
		db.exec(`INSERT INTO delegations (name, harness, cwd, task, chat_id, agent_name, workspace_id,
			pane_id, status, prompted_at, created_at)
			VALUES ('old', 'codex', '/w', 't', 1, '', '', '', 'done', 'x', 'x')`);
		db.close();
		const store = openDelegations(dbPath);
		expect(store.get(1)?.responsibilityId).toBeNull();
		const linked = store.create({
			name: "new",
			harness: "codex",
			cwd: "/w",
			task: "t",
			address: { chatId: 1, threadId: null },
			responsibilityId: "r1",
			responsibilityRevision: 4,
		});
		expect(linked.responsibilityId).toBe("r1");
		expect(linked.responsibilityRevision).toBe(4);
		store.close();
	});
});

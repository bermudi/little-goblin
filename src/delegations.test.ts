import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentNameFor, openDelegations } from "./delegations.ts";

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
	test("legacy role and readiness columns are preserved and remain insert-compatible", () => {
		const path = join(tmpdirPath(), "goblin.sqlite");
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
		db.exec(`INSERT INTO delegations
			(name,harness,cwd,task,chat_id,agent_name,workspace_id,pane_id,status,baseline_seq,prompted_at,created_at,role,readiness_json)
			VALUES ('legacy','codex','/w','build',0,'g1-legacy','w','p','done',7,'x','x','lead','{"state":"old"}')`);
		db.close();
		const store = openDelegations(path);
		try {
			expect(store.get(1)).toMatchObject({ name: "legacy", harness: "codex", baselineSeq: 7 });
			const created = store.create({
				name: "new", harness: "pi", cwd: "/w", task: "new task",
				address: { chatId: 0, threadId: null },
			});
			expect(created.name).toBe("new");
		} finally { store.close(); }
		const check = new Database(path);
		const columns = check.query<{ name: string }, []>("PRAGMA table_info(delegations)").all().map((c) => c.name);
		expect(columns).toContain("role");
		expect(columns).toContain("readiness_json");
		expect(check.query<{ readiness_json: string }, [number]>("SELECT readiness_json FROM delegations WHERE id = ?").get(1)?.readiness_json).toBe('{"state":"old"}');
		check.close();
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

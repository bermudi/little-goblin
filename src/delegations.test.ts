// The delegation store's name contract: agent names must land in
// herdr's agent-name charset ([a-z][a-z0-9_-]{0,31}) regardless of
// what the operator or model put in the delegation name.

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

// The app-pinned pin (design/app.md → Spin-off): app_conversation
// round-trips, and rows written before the column existed read null.
describe("delegations store", () => {
	test("legacy machine-mode rows retarget onto the translated label; terminal rows stay NULL", () => {
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
		// Three machine-era rows: two live (running, starting), one
		// terminal. Under delegation.machine every LIVE row ran on the
		// machine — the migration must claim exactly those.
		const ins = db.prepare(`INSERT INTO delegations
			(name, harness, cwd, task, chat_id, thread_id, agent_name, workspace_id, pane_id, status, prompted_at, created_at)
			VALUES (?, 'codex', '/w', 't', 1, NULL, 'g1', 'w1', 'w1:p1', ?, '1970-01-01', '1970-01-01')`);
		ins.run("remote-live", "running");
		ins.run("remote-starting", "starting");
		ins.run("old-done", "done");
		db.close();
		// Opens through the migration (target column added).
		const store = openDelegations(path);
		try {
			expect(store.liveRowsWithNullTarget()).toBe(2);
			expect(store.retargetLegacyLiveRows("g7")).toBe(2);
			expect(store.get(1)?.target).toBe("g7");
			expect(store.get(2)?.target).toBe("g7");
			// Terminal rows are inert history — NULL (local) is fine.
			expect(store.get(3)?.target).toBeNull();
			expect(store.liveRowsWithNullTarget()).toBe(0);
			// Idempotent: a second pass moves nothing.
			expect(store.retargetLegacyLiveRows("g7")).toBe(0);
		} finally {
			store.close();
		}
	});

	// #95: baseline_seq went nullable — NULL is the baseline-pending
	// posture (a failed post-prompt read never falls back to a pre-prompt
	// value). Legacy NOT NULL tables rebuild in place, rows intact.
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
		db.close();
		const store = openDelegations(path);
		try {
			expect(store.get(1)!.baselineSeq).toBe(3); // the rebuild kept the row
			const d = store.create({
				name: "pending",
				harness: "codex",
				cwd: "/w",
				task: "t",
				address: { chatId: 1, threadId: null },
			});
			store.markRunning(d.id, null, new Date());
			expect(store.get(d.id)!.baselineSeq).toBeNull();
			// The watcher's capture lands under the same CAS shape.
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

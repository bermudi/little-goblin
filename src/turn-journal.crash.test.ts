// A real Runtime + real goblin.sqlite in a CHILD process, SIGKILLed at
// observable points; the parent reopens the store.

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { openStore } from "./conversation.ts";
import { setLogFile } from "./log.ts";
import { appendInterruptedProgress } from "./turn/unlanded-progress.ts";
import { openTurnJournal } from "./turn-journal.ts";

setLogFile(null);

const dir = mkdtempSync(join(tmpdir(), "goblin-turn-crash-"));
const children: Subprocess[] = [];

afterAll(() => {
	for (const c of children) c.kill(9);
	rmSync(dir, { recursive: true, force: true });
});

// A child that died before the signal can never send it: fail with its
// exit code (stderr is inherited) instead of waiting out the deadline.
async function until(child: Subprocess, fn: () => boolean, what: string, ms = 30_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (fn()) return;
		if (child.exitCode !== null) {
			throw new Error(`child exited ${child.exitCode} before: ${what}`);
		}
		await Bun.sleep(40);
	}
	throw new Error(`timed out waiting for: ${what}`);
}

// The journal must NOT be opened in the parent before the kill — its
// open reclassifies 'running', which is the very signal under test.
function probeCallState(db: Database): string[] {
	try {
		return db
			.query<{ state: string }, []>("SELECT state FROM turn_tool_calls")
			.all()
			.map((r) => r.state);
	} catch {
		return []; // table not created yet — the child is still booting
	}
}

function probeRunStatuses(db: Database): string[] {
	try {
		return db
			.query<{ status: string }, []>("SELECT status FROM turn_runs")
			.all()
			.map((r) => r.status);
	} catch {
		return [];
	}
}

function spawn(mode: string, name: string): { child: Subprocess; dbPath: string; marker: string } {
	const dbPath = join(dir, `${name}.sqlite`);
	const marker = join(dir, `${name}.marker`);
	const child = Bun.spawn(
		["bun", "run", join(import.meta.dir, "test-helpers/turn-crash-child.ts")],
		{
			env: { ...process.env, DB_PATH: dbPath, MARKER_PATH: marker, MODE: mode },
			stdout: "ignore",
			stderr: "inherit",
		},
	);
	children.push(child);
	return { child, dbPath, marker };
}

async function killAndReopen(child: Subprocess, dbPath: string) {
	child.kill(9);
	await child.exited;
	// 'running' at open means the process died mid-turn — the row must
	// come back 'interrupted'.
	const store = openStore(dbPath);
	const journal = openTurnJournal(store.db);
	return { store, journal };
}

// The production boot shape (index.ts): the open's reclassify records
// each killed run's progress in history inside the same transaction.
async function killAndReopenRecorded(child: Subprocess, dbPath: string) {
	child.kill(9);
	await child.exited;
	const store = openStore(dbPath);
	const journal = openTurnJournal(store.db, {
		onInterrupted: (run, calls) => appendInterruptedProgress(store, run, calls),
	});
	return { store, journal };
}

describe("turn journal — a real killed process", () => {
	test("kill after dispatch, before the result: call stays 'dispatched'", async () => {
		const { child, dbPath, marker } = spawn("hang-in-tool", "dispatched");
		await until(child, () => existsSync(marker), "tool dispatched in child");
		const { store, journal } = await killAndReopen(child, dbPath);
		try {
			const runs = journal.interrupted();
			expect(runs).toHaveLength(1);
			expect(runs[0]!.status).toBe("interrupted");
			expect(runs[0]!.finishedMs).not.toBeNull();
			const calls = journal.callsFor(runs[0]!.runId);
			expect(calls).toHaveLength(1);
			expect(calls[0]!.toolCallId).toBe("call-1");
			expect(calls[0]!.name).toBe("probe");
			expect(calls[0]!.state).toBe("dispatched");
			expect(calls[0]!.beganMs).not.toBeNull();
			expect(calls[0]!.settledMs).toBeNull();
		} finally {
			store.close();
		}
	}, 60_000);

	test("kill with a call never dispatched: the row stays 'planned'", async () => {
		// plan-only's execute-less call is journaled at the chunk seam
		// but nothing can ever dispatch it.
		const { child, dbPath, marker } = spawn("plan-only", "planned");
		const probe = new Database(dbPath);
		try {
			await until(child, () => probeCallState(probe).includes("planned"), "planned row in child");
		} finally {
			probe.close();
		}
		const { store, journal } = await killAndReopen(child, dbPath);
		try {
			const runs = journal.interrupted();
			expect(runs).toHaveLength(1);
			const calls = journal.callsFor(runs[0]!.runId);
			expect(calls).toHaveLength(1);
			expect(calls[0]!.state).toBe("planned");
			expect(calls[0]!.beganMs).toBeNull();
			expect(calls[0]!.settledMs).toBeNull();
		} finally {
			store.close();
		}
		// the tool has no execute — it could not have been entered.
		expect(existsSync(marker)).toBe(false);
	}, 60_000);

	test("kill after the result lands: call stays 'completed'", async () => {
		const { child, dbPath } = spawn("complete-then-stall", "completed");
		const probe = new Database(dbPath);
		try {
			await until(child, () => probeCallState(probe).includes("completed"), "completed row in child");
		} finally {
			probe.close();
		}
		const { store, journal } = await killAndReopen(child, dbPath);
		try {
			const runs = journal.interrupted();
			expect(runs).toHaveLength(1);
			const calls = journal.callsFor(runs[0]!.runId);
			expect(calls).toHaveLength(1);
			expect(calls[0]!.state).toBe("completed");
			expect(calls[0]!.result).toBe('{"ok":true}');
			expect(calls[0]!.beganMs).not.toBeNull();
			expect(calls[0]!.settledMs).not.toBeNull();
		} finally {
			store.close();
		}
	}, 60_000);

	test("a killed turn's completed steps land in history at reopen — nothing replays (#195)", async () => {
		const { child, dbPath } = spawn("complete-then-stall", "progress-recorded");
		const probe = new Database(dbPath);
		try {
			await until(child, () => probeCallState(probe).includes("completed"), "completed row in child");
		} finally {
			probe.close();
		}
		const { store, journal } = await killAndReopenRecorded(child, dbPath);
		try {
			const runs = journal.interrupted();
			expect(runs).toHaveLength(1);
			const run = runs[0]!;
			// The work that already happened is transcript: one system
			// event records the completed call, ended-aborted.
			const history = store.history(run.conversationId);
			expect(history.map((m) => m.role)).toEqual(["user", "system"]);
			const event = history[1]!.parts[0];
			expect(event).toMatchObject({ type: "text" });
			if (event?.type !== "text") return;
			expect(event.text).toContain("was interrupted");
			expect(event.text).toContain("probe");
			expect(event.text).toContain('completed: {"ok":true}');
			// Boot is notice-only: reopen begot no new run row, and the
			// completed step is never re-executed — resume alone may
			// continue it, fenced by the recovery guard.
			const rows = store.db
				.query<{ run_id: string; status: string }, []>("SELECT run_id, status FROM turn_runs")
				.all();
			expect(rows).toHaveLength(1);
			expect(rows[0]).toEqual({ run_id: run.runId, status: "interrupted" });
		} finally {
			store.close();
		}
	}, 60_000);

	test("a kill inside terminal delivery appends no 'no reply' event — the reply is the record", async () => {
		const { child, dbPath, marker } = spawn("reply-stall", "reply-stall");
		await until(child, () => existsSync(marker), "child stalled inside onDone");
		const { store, journal } = await killAndReopenRecorded(child, dbPath);
		try {
			const runs = journal.interrupted();
			expect(runs).toHaveLength(1);
			const run = runs[0]!;
			// The process died mid-delivery — 'interrupted' stays honest —
			// but the reply committed with its landed fact, so the boot
			// appends no false 'no final reply' event over it.
			expect(run.replyLanded).toBe(true);
			const history = store.history(run.conversationId);
			expect(history.map((m) => m.role)).toEqual(["user", "assistant"]);
		} finally {
			store.close();
		}
	}, 60_000);

	test("a killed overflow continuation carries the failed attempt's calls as inert evidence", async () => {
		const { child, dbPath } = spawn("overflow-stall", "overflow");
		// Wait for both: the overflowed attempt stamps error/undelivered
		// and the continuation opens its own row before stalling.
		const probe = new Database(dbPath);
		try {
			await until(child, () => {
				const statuses = probeRunStatuses(probe);
				return statuses.includes("error") && statuses.includes("running");
			}, "overflowed attempt terminal, continuation running");
		} finally {
			probe.close();
		}
		const { store, journal } = await killAndReopen(child, dbPath);
		try {
			const runs = journal.interrupted();
			expect(runs).toHaveLength(1);
			const continuation = runs[0]!;
			const calls = journal.callsFor(continuation.runId);
			// The failed attempt's evidence rides in namespaced by its
			// origin run — the continuation's own ids stay free.
			expect(calls).toHaveLength(1);
			expect(calls[0]!.toolCallId).toMatch(/:call-1$/);
			expect(calls[0]!.state).toBe("completed");
			expect(calls[0]!.result).toBe('{"ok":true}');

			// #594: nothing resumes the dead run — it stays 'interrupted'
			// forever, its inherited evidence readable but inert.
			expect(journal.get(continuation.runId)!.status).toBe("interrupted");
			expect(journal.successorOf(continuation.runId)).toBeNull();
			const rows = store.db
				.query<{ run_id: string }, []>("SELECT run_id FROM turn_runs")
				.all();
			expect(rows).toHaveLength(2); // the failed attempt + the killed continuation
		} finally {
			store.close();
		}
	}, 60_000);
});

// Turn-journal crash test: a real Runtime + real goblin.sqlite in a
// CHILD process, SIGKILLed at three observable points. The parent
// reopens the same store — the journal's open must reclassify the
// 'running' row 'interrupted' and the tool-call row must show exactly
// how far the killed turn got. Reuses the fake model edge; no external
// calls.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { Subprocess } from "bun";
import { openStore } from "./conversation.ts";
import { setLogFile } from "./log.ts";
import { openTurnJournal } from "./turn-journal.ts";

setLogFile(null);

const dir = mkdtempSync(join(tmpdir(), "goblin-turn-crash-"));
const children: Subprocess[] = [];

afterAll(() => {
	for (const c of children) c.kill(9);
	rmSync(dir, { recursive: true, force: true });
});

async function until(fn: () => boolean, what: string, ms = 30_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (fn()) return;
		await Bun.sleep(40);
	}
	throw new Error(`timed out waiting for: ${what}`);
}

// A raw connection for pre-kill polling — the journal itself must NOT
// be opened in the parent before the kill: its open reclassifies
// 'running', which is the very signal under test.
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

function spawn(mode: string, name: string): { child: Subprocess; dbPath: string; marker: string } {
	const dbPath = join(dir, `${name}.sqlite`);
	const marker = join(dir, `${name}.marker`);
	const child = Bun.spawn(["bun", "run", "src/test-helpers/turn-crash-child.ts"], {
		env: { ...process.env, DB_PATH: dbPath, MARKER_PATH: marker, MODE: mode },
		stdout: "ignore",
		stderr: "inherit",
	});
	children.push(child);
	return { child, dbPath, marker };
}

async function killAndReopen(child: Subprocess, dbPath: string) {
	child.kill(9);
	await child.exited;
	// A fresh open is the boot path: 'running' at open means the process
	// died mid-turn — the row must come back 'interrupted'.
	const store = openStore(dbPath);
	const journal = openTurnJournal(store.db);
	return { store, journal };
}

describe("turn journal — a real killed process", () => {
	test("kill after dispatch, before the result: call stays 'dispatched'", async () => {
		const { child, dbPath, marker } = spawn("hang-in-tool", "dispatched");
		await until(() => existsSync(marker), "tool dispatched in child");
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
		// plan-only's provider-executed call is journaled at the chunk
		// seam but the fence never dispatches it — the crash-time shape
		// of a call whose dispatch write never landed.
		const { child, dbPath, marker } = spawn("plan-only", "planned");
		const probe = new Database(dbPath);
		try {
			await until(() => probeCallState(probe).includes("planned"), "planned row in child");
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
		// provider-executed calls never reach our tools — execute could
		// not have been entered.
		expect(existsSync(marker)).toBe(false);
	}, 60_000);

	test("kill after the result lands: call stays 'completed'", async () => {
		const { child, dbPath } = spawn("complete-then-stall", "completed");
		const probe = new Database(dbPath);
		try {
			await until(() => probeCallState(probe).includes("completed"), "completed row in child");
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
});

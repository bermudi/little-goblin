// Wake-store crash test: a real goblin.sqlite written by the wake
// store in a CHILD process, SIGKILLed at two boundaries — after a
// record commits (pending wake) and after the trigger append commits
// (claimed wake with its history reference). The parent reopens the
// same store and must see exactly the last committed boundary: no
// partial row, and the recovery path appends the trigger once, never
// twice. No external calls.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import type { UIMessage } from "ai";
import { openStore, type ConversationStore } from "./conversation.ts";
import { setLogFile } from "./log.ts";
import { openWakeStore } from "./wake-store.ts";

setLogFile(null);

const dir = mkdtempSync(join(tmpdir(), "goblin-wake-crash-"));
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

function spawn(mode: string, name: string): { child: Subprocess; dbPath: string; marker: string } {
	const dbPath = join(dir, `${name}.sqlite`);
	const marker = join(dir, `${name}.marker`);
	const child = Bun.spawn(
		["bun", "run", join(import.meta.dir, "test-helpers/wake-crash-child.ts")],
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
	// A fresh open is the boot path.
	const store = openStore(dbPath);
	const wakes = openWakeStore(store.db);
	return { store, wakes };
}

// The dispatcher's append as tests drive it: the wake's stable message
// into history; `calls` proves whether an append ran at all.
function appendTrigger(store: ConversationStore, conversationId: string, calls: string[]) {
	return (t: { id: string; text: string }) => {
		calls.push(t.id);
		const message: UIMessage = {
			id: t.id,
			role: "user",
			parts: [{ type: "text", text: t.text }],
		};
		store.append(conversationId, [message]);
	};
}

describe("wake store — a real killed process", () => {
	test("kill after the record commits: the wake is pending and recovery appends once", async () => {
		const { child, dbPath, marker } = spawn("recorded", "recorded");
		await until(() => existsSync(marker), "record committed in child");
		const { store, wakes } = await killAndReopen(child, dbPath);
		try {
			const plan = wakes.reconcile(new Date().toISOString(), () => null);
			expect(plan.toAppend).toHaveLength(1);
			const rec = plan.toAppend[0]!;
			expect(rec.state).toBe("pending");
			expect(rec.historySeq).toBeNull();
			expect(store.historyEntries(rec.conversationId)).toHaveLength(0);
			// Boot's next move is the append — exactly one lands.
			const calls: string[] = [];
			const claimed = wakes.commit(rec.wakeId, appendTrigger(store, rec.conversationId, calls));
			expect(calls).toHaveLength(1);
			expect(claimed.state).toBe("claimed");
			expect(claimed.historySeq).toBe(1);
			expect(store.historyEntries(rec.conversationId)).toHaveLength(1);
		} finally {
			store.close();
		}
	}, 60_000);

	test("kill after the append commits, before any submit: claimed once, never re-appended", async () => {
		const { child, dbPath, marker } = spawn("committed", "committed");
		await until(() => existsSync(marker), "trigger commit in child");
		const { store, wakes } = await killAndReopen(child, dbPath);
		try {
			// The boot classification for a claimed wake whose run never
			// began: resubmit only — the trigger is already in history.
			const plan = wakes.reconcile(new Date().toISOString(), () => null);
			expect(plan.toResubmit).toHaveLength(1);
			const rec = plan.toResubmit[0]!;
			expect(rec.state).toBe("claimed");
			expect(rec.historySeq).toBe(1);
			expect(store.historyEntries(rec.conversationId)).toHaveLength(1);
			// A recovery commit must not append a second trigger.
			const calls: string[] = [];
			const again = wakes.commit(rec.wakeId, appendTrigger(store, rec.conversationId, calls));
			expect(calls).toHaveLength(0);
			expect(again.historySeq).toBe(1);
			expect(store.historyEntries(rec.conversationId)).toHaveLength(1);
		} finally {
			store.close();
		}
	}, 60_000);
});

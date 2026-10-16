// Turn journal boundary tests — the durable record a crash leaves
// behind: the three-state call lifecycle, the never-regress guards,
// the open-time reclassification, and the conversation cascade. A
// "crash" here is a second open* on the same file: rows still
// 'running' at open mean process death by construction.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { openStore } from "./conversation.ts";
import { setLogFile } from "./log.ts";
import { tmpDb } from "./testkit.ts";
import { openTurnJournal } from "./turn-journal.ts";

setLogFile(null);

function begunRun(journal: ReturnType<typeof openTurnJournal>, convId: string, runId = "run-1") {
	journal.beginRun({
		runId,
		conversationId: convId,
		epoch: 3,
		anchorSeq: 7,
		steerMark: 7,
		convSnapshot: { model: "z.ai/glm-5", thinking: "low" },
		toolNames: ["probe", "bash"],
		startedAt: "2026-10-11T00:00:00.000Z",
	});
	return runId;
}

describe("turn journal", () => {
	test("lifecycle: begin → planned → dispatched → completed", () => {
		const store = openStore(tmpDb("goblin-tj-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		const runId = begunRun(journal, conv.id);

		journal.noteToolInput(runId, "call-1", "probe", { q: 1 });
		journal.noteToolInput(runId, "call-2", "bash", { command: "ls" });
		journal.noteToolDispatch(runId, "call-1");
		journal.noteToolResult(runId, "call-1", { ok: true, out: "done" });
		journal.finishRun(runId, "completed", "delivered");

		const run = journal.get(runId);
		expect(run).not.toBeNull();
		expect(run!.status).toBe("completed");
		expect(run!.delivery).toBe("delivered");
		expect(run!.finishedMs).not.toBeNull();
		expect(run!.epoch).toBe(3);
		expect(run!.anchorSeq).toBe(7);
		expect(run!.toolNames).toEqual(["probe", "bash"]);
		expect(run!.convSnapshot).toEqual({ model: "z.ai/glm-5", thinking: "low" });
		expect(run!.calls).toEqual({ planned: 1, dispatched: 0, completed: 1, failed: 0 });

		const calls = journal.callsFor(runId);
		expect(calls).toHaveLength(2);
		const done = calls.find((c) => c.toolCallId === "call-1")!;
		expect(done.state).toBe("completed");
		expect(done.result).toBe('{"ok":true,"out":"done"}');
		expect(done.beganMs).not.toBeNull();
		expect(done.settledMs).not.toBeNull();
		expect(done.argsHash).toBe(
			createHash("sha256")
				.update(JSON.stringify({ q: 1 }))
				.digest("hex"),
		);
		const pending = calls.find((c) => c.toolCallId === "call-2")!;
		expect(pending.state).toBe("planned");
		expect(pending.beganMs).toBeNull();
		expect(pending.settledMs).toBeNull();
		store.close();
	});

	test("dispatch and results never regress a settled row", () => {
		const store = openStore(tmpDb("goblin-tj-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		const runId = begunRun(journal, conv.id);

		journal.noteToolInput(runId, "call-1", "probe", {});
		journal.noteToolDispatch(runId, "call-1");
		journal.noteToolResult(runId, "call-1", "first");
		// A late duplicate transition must not move the settled row.
		journal.noteToolDispatch(runId, "call-1");
		journal.noteToolError(runId, "call-1", new Error("late failure"));
		journal.noteToolResult(runId, "call-1", "second");

		const call = journal.callsFor(runId).find((c) => c.toolCallId === "call-1")!;
		expect(call.state).toBe("completed");
		expect(call.result).toBe('"first"');
		expect(call.error).toBeNull();

		// Errors settle too — a retry's success can't rewrite the failure.
		journal.noteToolInput(runId, "call-2", "probe", {});
		journal.noteToolDispatch(runId, "call-2");
		journal.noteToolError(runId, "call-2", new TypeError("boom"));
		journal.noteToolResult(runId, "call-2", "recovered");
		const failed = journal.callsFor(runId).find((c) => c.toolCallId === "call-2")!;
		expect(failed.state).toBe("failed");
		expect(failed.error).toBe("TypeError: boom");
		expect(failed.result).toBeNull();
		store.close();
	});

	test("a result upsert works when the planned row never landed", () => {
		const store = openStore(tmpDb("goblin-tj-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		const runId = begunRun(journal, conv.id);
		// The stream was cut before tool-input-available — the result
		// still records rather than throwing on the missing planned row.
		journal.noteToolResult(runId, "orphan", { ok: true });
		const call = journal.callsFor(runId).find((c) => c.toolCallId === "orphan")!;
		expect(call.state).toBe("completed");
		store.close();
	});

	test("reopening marks running rows interrupted; terminal rows are untouched", () => {
		const dbPath = tmpDb("goblin-tj-");
		const store = openStore(dbPath);
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		const live = begunRun(journal, conv.id, "run-live");
		const done = begunRun(journal, conv.id, "run-done");
		const fenced = begunRun(journal, conv.id, "run-fenced");
		journal.noteToolInput(live, "call-1", "probe", {});
		journal.noteToolDispatch(live, "call-1");
		journal.finishRun(done, "completed", "delivered");
		journal.finishRun(fenced, "fenced", "undelivered");
		store.close();

		// Process died mid-turn: a fresh open reclassifies 'running' only.
		const reopened = openStore(dbPath);
		const journal2 = openTurnJournal(reopened.db);
		expect(journal2.get(live)!.status).toBe("interrupted");
		expect(journal2.get(live)!.finishedMs).not.toBeNull();
		expect(journal2.get(done)!.status).toBe("completed");
		expect(journal2.get(fenced)!.status).toBe("fenced");

		const found = journal2.interrupted();
		expect(found).toHaveLength(1);
		expect(found[0]!.runId).toBe(live);
		expect(found[0]!.calls).toEqual({ planned: 0, dispatched: 1, completed: 0, failed: 0 });
		reopened.close();
	});

	test("checkpoint patches the nullable progress columns", () => {
		const store = openStore(tmpDb("goblin-tj-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		const runId = begunRun(journal, conv.id);
		journal.checkpoint(runId, { loopState: { modelCalls: 2 }, filterRetryUsed: true });
		journal.checkpoint(runId, { partial: [{ role: "assistant", content: "half" }] });
		const run = journal.get(runId)!;
		expect(run.loopState).toEqual({ modelCalls: 2 });
		expect(run.filterRetryUsed).toBe(true);
		expect(run.partial).toEqual([{ role: "assistant", content: "half" }]);
		store.close();
	});

	test("deleting a conversation cascades its runs and calls", () => {
		const store = openStore(tmpDb("goblin-tj-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		const runId = begunRun(journal, conv.id);
		journal.noteToolInput(runId, "call-1", "probe", {});
		store.deleteConversation(conv.id);
		expect(journal.get(runId)).toBeNull();
		expect(journal.callsFor(runId)).toEqual([]);
		store.close();
	});

	test("results bound at ~8000 chars and errors at ~1000, never stacks", () => {
		const store = openStore(tmpDb("goblin-tj-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		const runId = begunRun(journal, conv.id);
		journal.noteToolResult(runId, "big", { blob: "x".repeat(10_000) });
		const big = journal.callsFor(runId).find((c) => c.toolCallId === "big")!;
		expect(big.result!.length).toBeLessThanOrEqual(8_000);

		const err = new Error("m".repeat(2_000));
		err.stack = "STACK SHOULD NOT BE STORED";
		journal.noteToolError(runId, "bad", err);
		const bad = journal.callsFor(runId).find((c) => c.toolCallId === "bad")!;
		expect(bad.error!.length).toBeLessThanOrEqual(1_000);
		expect(bad.error).not.toContain("STACK SHOULD NOT BE STORED");
		store.close();
	});
});

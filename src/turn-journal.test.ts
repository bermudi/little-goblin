// A "crash" is a second open* on the same file: rows still 'running' at
// open mean process death by construction.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { openStore } from "./conversation.ts";
import { setLogFile } from "./log.ts";
import { tmpDb } from "./testkit.ts";
import { buildRetryGuard } from "./turn/retry-guard.ts";
import { appendInterruptedProgress } from "./turn/unlanded-progress.ts";
import { listRuns, listToolRuns, openTurnJournal, replayKey } from "./turn-journal.ts";

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

// Fixtures stamp the way openTurnJournal's reclassify leaves a killed
// 'running' row.
function interruptRun(store: ReturnType<typeof openStore>, runId: string) {
	store.db.run("UPDATE turn_runs SET status = 'interrupted' WHERE run_id = ?", [runId]);
}

describe("turn journal", () => {
	test("the tool read keeps a stamped row whatever its start time", () => {
		const store = openStore(tmpDb("goblin-tj-trajectory-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		const runId = begunRun(journal, conv.id, "r1");
		journal.noteToolDispatch(runId, "t6", "probe", {});
		store.db.run(
			"UPDATE turn_tool_calls SET began_ms = 10020, model_call_id = 'c-late' WHERE run_id = ? AND tool_call_id = 't6'",
			[runId],
		);
		expect(listToolRuns(store.db, conv.id, 15000, ["c-late"])).toHaveLength(1);
		expect(listToolRuns(store.db, conv.id, 15000, [])).toHaveLength(0);
		store.db.run(
			"UPDATE turn_tool_calls SET began_ms = 16000 WHERE run_id = ? AND tool_call_id = 't6'",
			[runId],
		);
		expect(listToolRuns(store.db, conv.id, 15000, [])).toHaveLength(0);
		store.db.run(
			"UPDATE turn_tool_calls SET model_call_id = NULL WHERE run_id = ? AND tool_call_id = 't6'",
			[runId],
		);
		expect(listToolRuns(store.db, conv.id, 15000, [])).toHaveLength(1);
		store.close();
	});

	test("the run read keeps a run that a listed tool belongs to", () => {
		const store = openStore(tmpDb("goblin-tj-trajectory-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		begunRun(journal, conv.id, "r1");
		store.db.run("UPDATE turn_runs SET started_ms = 10000 WHERE run_id = 'r1'");
		expect(listRuns(store.db, conv.id, 5000, 5000, ["r1"])).toHaveLength(1);
		expect(listRuns(store.db, conv.id, 5000, 5000, [])).toHaveLength(0);
		store.close();
	});

	test("the tool read keeps the newest rows and returns them oldest first", () => {
		const store = openStore(tmpDb("goblin-tj-trajectory-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		const runId = begunRun(journal, conv.id, "r1");
		for (let index = 0; index <= 2000; index++) {
			journal.noteToolDispatch(runId, `t${String(index).padStart(5, "0")}`, "probe", {});
		}
		const rows = listToolRuns(store.db, conv.id, 0, []);
		expect(rows).toHaveLength(2000);
		expect(rows[0]!.toolCallId).toBe("t00001");
		expect(rows[1999]!.toolCallId).toBe("t02000");
		store.close();
	});

	test("lifecycle: begin → planned → dispatched → completed", () => {
		const store = openStore(tmpDb("goblin-tj-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		const runId = begunRun(journal, conv.id);

		journal.noteToolInput(runId, "call-1", "probe", { q: 1 });
		journal.noteToolInput(runId, "call-2", "bash", { command: "ls" });
		journal.noteToolDispatch(runId, "call-1", "probe", { q: 1 });
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
		expect(run!.calls).toEqual({ planned: 1, dispatched: 0, completed: 1, failed: 0, resolved: 0 });

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

	test("dispatch stamps the emitting model call", () => {
		const store = openStore(tmpDb("goblin-tj-stamp-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db, { modelCallId: () => "call-x" });
		const runId = begunRun(journal, conv.id);
		journal.noteToolDispatch(runId, "call-tool", "probe", {});
		expect(journal.callsFor(runId)[0]).toMatchObject({
			modelCallId: "call-x",
			state: "dispatched",
			beganMs: expect.any(Number),
		});
		store.close();
	});

	test("dispatch without a stamp callback records null", () => {
		const store = openStore(tmpDb("goblin-tj-stamp-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		const runId = begunRun(journal, conv.id);
		journal.noteToolDispatch(runId, "call-tool", "probe", {});
		expect(journal.callsFor(runId)[0]!.modelCallId).toBeNull();
		store.close();
	});

	test("dispatch survives a failing stamp callback", () => {
		const store = openStore(tmpDb("goblin-tj-stamp-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db, {
			modelCallId: () => {
				throw new Error("offline");
			},
		});
		const runId = begunRun(journal, conv.id);
		journal.noteToolDispatch(runId, "call-tool", "probe", {});
		expect(journal.callsFor(runId)[0]).toMatchObject({
			modelCallId: null,
			state: "dispatched",
			beganMs: expect.any(Number),
		});
		store.close();
	});

	test("dispatch and results never regress a settled row", () => {
		const store = openStore(tmpDb("goblin-tj-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		const runId = begunRun(journal, conv.id);

		journal.noteToolInput(runId, "call-1", "probe", {});
		journal.noteToolDispatch(runId, "call-1", "probe", {});
		journal.noteToolResult(runId, "call-1", "first");
		journal.noteToolDispatch(runId, "call-1", "probe", {});
		journal.noteToolError(runId, "call-1", new Error("late failure"));
		journal.noteToolResult(runId, "call-1", "second");

		const call = journal.callsFor(runId).find((c) => c.toolCallId === "call-1")!;
		expect(call.state).toBe("completed");
		expect(call.result).toBe('"first"');
		expect(call.error).toBeNull();

		journal.noteToolInput(runId, "call-2", "probe", {});
		journal.noteToolDispatch(runId, "call-2", "probe", {});
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
		expect(journal.pendingBootNotices().interrupted).toEqual([]);
		const live = begunRun(journal, conv.id, "run-live");
		const done = begunRun(journal, conv.id, "run-done");
		const fenced = begunRun(journal, conv.id, "run-fenced");
		journal.noteToolInput(live, "call-1", "probe", {});
		journal.noteToolDispatch(live, "call-1", "probe", {});
		journal.finishRun(done, "completed", "delivered");
		journal.finishRun(fenced, "fenced", "undelivered");
		store.close();

		const reopened = openStore(dbPath);
		const journal2 = openTurnJournal(reopened.db);
		expect(journal2.get(live)!.status).toBe("interrupted");
		expect(journal2.get(live)!.finishedMs).not.toBeNull();
		expect(journal2.get(done)!.status).toBe("completed");
		expect(journal2.get(fenced)!.status).toBe("fenced");

		const found = journal2.interrupted();
		expect(found).toHaveLength(1);
		expect(found[0]!.runId).toBe(live);
		expect(found[0]!.calls).toEqual({
			planned: 0,
			dispatched: 1,
			completed: 0,
			failed: 0,
			resolved: 0,
		});

		expect(journal2.pendingBootNotices().interrupted).toHaveLength(1);
		const snap = journal2.pendingBootNotices().interrupted[0]!.run;
		expect(snap.runId).toBe(live);
		expect(snap.status).toBe("interrupted");
		expect(snap.finishedMs).not.toBeNull();
		expect(snap.calls).toEqual({
			planned: 0,
			dispatched: 1,
			completed: 0,
			failed: 0,
			resolved: 0,
		});

		begunRun(journal2, conv.id, "run-late");
		expect(journal2.pendingBootNotices().interrupted).toHaveLength(1);
		journal2.finishRun("run-late", "completed", "delivered");
		reopened.close();
	});

	test("an undelivered notice outlives opens; a new crash adds its own row (#579)", () => {
		const dbPath = tmpDb("goblin-tj-");
		const store = openStore(dbPath);
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		begunRun(journal, conv.id, "run-old");
		store.close();

		const reopened = openStore(dbPath);
		const journal2 = openTurnJournal(reopened.db);
		expect(journal2.pendingBootNotices().interrupted.map((n) => n.run.runId)).toEqual([
			"run-old",
		]);
		reopened.close();

		// No send ever landed — the debt survives the reopen untouched,
		// and the reclassify does not fire twice (no second row).
		const third = openStore(dbPath);
		const journal3 = openTurnJournal(third.db);
		expect(journal3.pendingBootNotices().interrupted.map((n) => n.run.runId)).toEqual([
			"run-old",
		]);
		expect(journal3.interrupted().map((r) => r.runId)).toEqual(["run-old"]);

		begunRun(journal3, conv.id, "run-new");
		third.close();

		const fourth = openStore(dbPath);
		const journal4 = openTurnJournal(fourth.db);
		expect(journal4.pendingBootNotices().interrupted.map((n) => n.run.runId)).toEqual([
			"run-old",
			"run-new",
		]);

		// Delivery claims exactly its row; the other debt stands.
		const claimed = journal4
			.pendingBootNotices()
			.interrupted.find((n) => n.run.runId === "run-old")!;
		expect(journal4.markBootNoticeDelivered(claimed.id)).toBe(true);
		expect(journal4.markBootNoticeDelivered(claimed.id)).toBe(false);
		expect(journal4.pendingBootNotices().interrupted.map((n) => n.run.runId)).toEqual([
			"run-new",
		]);
		fourth.close();
	});

	test("stranded counts land as durable notice rows owed to a later boot", () => {
		const dbPath = tmpDb("goblin-tj-");
		const store = openStore(dbPath);
		const dm = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		openTurnJournal(store.db);
		// The dead process accepted input it never answered.
		store.append(dm.id, [
			{ id: "u1", role: "user", parts: [{ type: "text", text: "stranded q" }] },
		]);
		store.close();

		const second = openStore(dbPath);
		const journal2 = openTurnJournal(second.db);
		expect(journal2.pendingBootNotices().stranded).toEqual([
			{ id: expect.any(Number), conversationId: dm.id, count: 1 },
		]);
		expect(journal2.pendingBootNotices().interrupted).toEqual([]);
		// The row is a debt, not a snapshot: it reads the same on every
		// open until a send claims it.
		expect(journal2.markBootNoticeDelivered(journal2.pendingBootNotices().stranded[0]!.id)).toBe(
			true,
		);
		expect(journal2.pendingBootNotices().stranded).toEqual([]);
		second.close();
	});

	test("the open hook appends interrupted progress atomically with the reclassify (#195)", () => {
		const dbPath = tmpDb("goblin-tj-");
		const store = openStore(dbPath);
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		const runId = begunRun(journal, conv.id);
		journal.noteToolInput(runId, "call-1", "probe", {});
		journal.noteToolDispatch(runId, "call-1", "probe", {});
		journal.noteToolResult(runId, "call-1", { ok: true });
		journal.checkpoint(runId, { partial: [{ role: "assistant", content: "halfway." }] });
		store.close();

		// A throwing append rolls the reclassify back with it — the row
		// stays 'running' and the next open retries both, so the record
		// can be neither lost nor duplicated.
		const failing = openStore(dbPath);
		let hookCalls = 0;
		expect(() =>
			openTurnJournal(failing.db, {
				onInterrupted: () => {
					hookCalls++;
					throw new Error("progress append exploded");
				},
			}),
		).toThrow("progress append exploded");
		expect(hookCalls).toBe(1);
		const stillRunning = failing.db
			.query<{ status: string }, [string]>("SELECT status FROM turn_runs WHERE run_id = ?")
			.get(runId);
		expect(stillRunning).toEqual({ status: "running" });
		failing.close();

		// The working hook records once; a later open finds nothing left.
		const reopened = openStore(dbPath);
		const journal2 = openTurnJournal(reopened.db, {
			onInterrupted: (run, calls) => appendInterruptedProgress(reopened, run, calls),
		});
		expect(journal2.get(runId)!.status).toBe("interrupted");
		const history = reopened.history(conv.id);
		expect(history.map((m) => m.role)).toEqual(["system"]);
		const event = history[0]!.parts[0];
		if (event?.type !== "text") throw new Error("progress event is not text");
		expect(event.text).toContain("was interrupted");
		expect(event.text).toContain('completed: {"ok":true}');
		expect(event.text).toContain("halfway.");
		reopened.close();

		const third = openStore(dbPath);
		const journal3 = openTurnJournal(third.db, {
			onInterrupted: (run, calls) => appendInterruptedProgress(third, run, calls),
		});
		expect(journal3.pendingBootNotices().interrupted.map((n) => n.run.runId)).toEqual([
			runId,
		]);
		expect(third.history(conv.id)).toHaveLength(1);
		third.close();
	});

	test("an interrupted run whose reply landed records no 'no reply' progress event", () => {
		const dbPath = tmpDb("goblin-tj-");
		const store = openStore(dbPath);
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		const runId = begunRun(journal, conv.id);
		journal.noteToolInput(runId, "call-1", "probe", {});
		journal.noteToolDispatch(runId, "call-1", "probe", {});
		journal.noteToolResult(runId, "call-1", { ok: true });
		// The reply and its landed fact commit together — a kill in the
		// delivery window leaves a durable reply behind the 'running' row.
		journal.noteReplyLanded(runId, 1);
		store.append(conv.id, [
			{ id: "a1", role: "assistant", parts: [{ type: "text", text: "the landed reply" }] },
		]);
		store.close();

		const reopened = openStore(dbPath);
		const journal2 = openTurnJournal(reopened.db, {
			onInterrupted: (run, calls) => appendInterruptedProgress(reopened, run, calls),
		});
		// The process still died mid-delivery — 'interrupted' stays honest —
		// but the landed reply IS the record: no 'no final reply' event.
		const run = journal2.get(runId)!;
		expect(run.status).toBe("interrupted");
		expect(run.replyLanded).toBe(true);
		expect(reopened.history(conv.id).map((m) => m.role)).toEqual(["assistant"]);
		reopened.close();
	});

	test("interrupted() lists every conversation's interrupted runs", () => {
		const store = openStore(tmpDb("goblin-tj-"));
		const a = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const b = store.resolve({ kind: "dm", chatId: 2 }, "/w");
		const journal = openTurnJournal(store.db);
		begunRun(journal, a.id, "run-a1");
		begunRun(journal, b.id, "run-b1");
		begunRun(journal, a.id, "run-a2");
		interruptRun(store, "run-a1");
		interruptRun(store, "run-b1");
		interruptRun(store, "run-a2");
		const idx = store.db
			.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='index'")
			.all()
			.map((r) => r.name);
		expect(idx).toContain("turn_runs_conv_status");
		// Equal started_ms ties break on run_id.
		expect(journal.interrupted().map((r) => r.runId)).toEqual(["run-a1", "run-a2", "run-b1"]);
		expect(journal.interrupted().filter((r) => r.conversationId === a.id).map((r) => r.runId)).toEqual([
			"run-a1",
			"run-a2",
		]);
		store.close();
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

	test("source_input_seq round-trips through begin and checkpoint", () => {
		const store = openStore(tmpDb("goblin-tj-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		journal.beginRun({
			runId: "run-src",
			conversationId: conv.id,
			epoch: 3,
			anchorSeq: 7,
			steerMark: 7,
			convSnapshot: { model: "z.ai/glm-5", thinking: "low" },
			toolNames: ["probe"],
			startedAt: "2026-10-11T00:00:00.000Z",
			sourceInputSeq: 7,
		});
		expect(journal.get("run-src")!.sourceInputSeq).toBe(7);
		journal.checkpoint("run-src", { sourceInputSeq: 9 });
		expect(journal.get("run-src")!.sourceInputSeq).toBe(9);
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

	test("resolved calls never regress — late stream writes cannot overwrite a decision", () => {
		const store = openStore(tmpDb("goblin-tj-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		const runId = begunRun(journal, conv.id);
		journal.noteToolInput(runId, "c1", "probe", {});
		journal.noteToolDispatch(runId, "c1", "probe", {});
		// Legacy resolved-* rows decode and stay terminal — nothing writes
		// them any more (#594), but a late stream write must not move one.
		store.db.run("UPDATE turn_tool_calls SET state = 'resolved-skip' WHERE run_id = ?", [runId]);
		journal.noteToolResult(runId, "c1", "late");
		journal.noteToolError(runId, "c1", new Error("late"));
		const call = journal.callsFor(runId).find((c) => c.toolCallId === "c1")!;
		expect(call.state).toBe("resolved-skip");
		expect(call.result).toBeNull();
		store.close();
	});

	test("dispatch journals the call's identity even without a stream row", () => {
		const store = openStore(tmpDb("goblin-tj-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		const runId = begunRun(journal, conv.id);
		// SDK pipeline committed before the input chunk landed — the row
		// must still carry full identity for the recovery guard.
		journal.noteToolDispatch(runId, "c1", "probe", { q: 9 });
		const call = journal.callsFor(runId)[0]!;
		expect(call.state).toBe("dispatched");
		expect(call.name).toBe("probe");
		expect(call.argsHash).not.toBe("");
		store.close();
	});

	test("inheritCalls carries settled history to the successor, never 'dispatched'", () => {
		const store = openStore(tmpDb("goblin-tj-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db, { modelCallId: () => "call-x" });
		const src = begunRun(journal, conv.id, "run-src");
		journal.noteToolInput(src, "done", "probe", { q: 1 });
		journal.noteToolDispatch(src, "done", "probe", { q: 1 });
		journal.noteToolResult(src, "done", { out: "landed" });
		journal.noteToolInput(src, "amb", "probe", { q: 2 });
		journal.noteToolDispatch(src, "amb", "probe", { q: 2 });
		journal.noteToolInput(src, "plan", "probe", { q: 3 });
		// A legacy resolved-skip row inherits as resolved evidence.
		store.db.run(
			"UPDATE turn_tool_calls SET state = 'resolved-skip' WHERE run_id = ? AND tool_call_id = 'amb'",
			[src],
		);

		const next = begunRun(journal, conv.id, "run-next");
		journal.inheritCalls(src, next);
		const calls = journal.callsFor(next);
		expect(calls.map((c) => c.toolCallId).sort()).toEqual([
			"run-src:amb",
			"run-src:done",
			"run-src:plan",
		]);
		expect(calls.find((c) => c.toolCallId === "run-src:done")!.result).toBe('{"out":"landed"}');
		expect(calls.find((c) => c.toolCallId === "run-src:done")!.modelCallId).toBe("call-x");
		expect(calls.find((c) => c.toolCallId === "run-src:amb")!.state).toBe("resolved-skip");
		journal.inheritCalls(src, next);
		expect(journal.callsFor(next)).toHaveLength(3);
		store.close();
	});

	test("legacy resumed/abandoned rows and resumed_from links still decode", () => {
		const dbPath = tmpDb("goblin-tj-");
		const store = openStore(dbPath);
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const j1 = openTurnJournal(store.db);
		j1.beginRun({
			runId: "old-run",
			conversationId: conv.id,
			epoch: 3,
			anchorSeq: 7,
			steerMark: 7,
			convSnapshot: {},
			toolNames: [],
			startedAt: "2026-10-11T00:00:00.000Z",
		});
		j1.beginRun({
			runId: "new-run",
			conversationId: conv.id,
			epoch: 3,
			anchorSeq: 7,
			steerMark: 7,
			convSnapshot: {},
			toolNames: [],
			startedAt: "2026-10-11T00:01:00.000Z",
		});
		// Rows an old operator-resume wrote: status 'resumed' on the source,
		// resumed_from naming it on the successor. Nothing writes these
		// now (#594) — they must still read for wake reconciliation.
		store.db.run("UPDATE turn_runs SET status = 'resumed' WHERE run_id = 'old-run'");
		store.db.run("UPDATE turn_runs SET resumed_from = 'old-run' WHERE run_id = 'new-run'");
		store.db.run("UPDATE turn_runs SET status = 'abandoned' WHERE run_id = 'new-run'");
		store.close();

		const reopened = openStore(dbPath);
		const journal = openTurnJournal(reopened.db);
		expect(journal.get("old-run")!.status).toBe("resumed");
		expect(journal.get("new-run")!.status).toBe("abandoned");
		expect(journal.successorOf("old-run")).toBe("new-run");
		expect(journal.successorOf("new-run")).toBeNull();
		reopened.close();
	});

	test("inheritFrom carries a terminal predecessor's settled calls into the new row", () => {
		const store = openStore(tmpDb("goblin-tj-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		const pred = begunRun(journal, conv.id, "run-pred");
		journal.noteToolInput(pred, "done", "probe", { q: 1 });
		journal.noteToolDispatch(pred, "done", "probe", { q: 1 });
		journal.noteToolResult(pred, "done", { out: "pred-ran" });
		journal.finishRun(pred, "error", "undelivered");

		const next = "run-cont";
		journal.beginRun({
			runId: next,
			conversationId: conv.id,
			epoch: 3,
			anchorSeq: 7,
			steerMark: 7,
			convSnapshot: { model: "z.ai/glm-5", thinking: "low" },
			toolNames: ["probe", "bash"],
			startedAt: "2026-10-11T00:00:00.000Z",
			inheritFrom: [pred],
		});
		expect(journal.callsFor(next).map((c) => c.toolCallId)).toEqual(["run-pred:done"]);
		expect(journal.callsFor(next).find((c) => c.toolCallId === "run-pred:done")!.result).toBe(
			'{"out":"pred-ran"}',
		);
		// The evidence link is part of the row's creation — a gone
		// predecessor refuses, never a best-effort copy.
		expect(() =>
			journal.beginRun({
				runId: "run-x",
				conversationId: conv.id,
				epoch: 3,
				anchorSeq: 7,
				steerMark: 7,
				convSnapshot: {},
				toolNames: [],
				startedAt: "2026-10-11T00:00:00.000Z",
				inheritFrom: ["missing-run"],
			}),
		).toThrow(/is gone/);
		expect(journal.get("run-x")).toBeNull();
		store.close();
	});

	test("a tool-call id reused across an inherited span journals the fresh execution", () => {
		const store = openStore(tmpDb("goblin-tj-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		// Attempt A completes call_0. Providers that number tool-call ids
		// per response (llama.cpp-style openai-compatible servers) hand
		// the continuation's fresh execution the same id verbatim.
		const a = begunRun(journal, conv.id, "run-a");
		journal.noteToolInput(a, "call_0", "probe", { n: 1 });
		journal.noteToolDispatch(a, "call_0", "probe", { n: 1 });
		journal.noteToolResult(a, "call_0", { old: true });
		journal.finishRun(a, "error", "undelivered");

		journal.beginRun({
			runId: "run-b",
			conversationId: conv.id,
			epoch: 3,
			anchorSeq: 7,
			steerMark: 7,
			convSnapshot: { model: "z.ai/glm-5", thinking: "low" },
			toolNames: ["probe"],
			startedAt: "2026-10-11T00:01:00.000Z",
			inheritFrom: [a],
		});
		journal.noteToolInput("run-b", "call_0", "probe", { n: 2 });
		journal.noteToolDispatch("run-b", "call_0", "probe", { n: 2 });
		journal.noteToolResult("run-b", "call_0", { fresh: true });

		const calls = journal.callsFor("run-b");
		// A's evidence keeps its recorded outcome under its namespaced id.
		const inherited = calls.find((c) => c.toolCallId === "run-a:call_0")!;
		expect(inherited.state).toBe("completed");
		expect(inherited.result).toBe('{"old":true}');
		// B's own execution is journaled under the id the provider sent —
		// never silently swallowed by A's terminal inherited row.
		const fresh = calls.find((c) => c.toolCallId === "call_0")!;
		expect(fresh.state).toBe("completed");
		expect(fresh.result).toBe('{"fresh":true}');
		expect(fresh.argsHash).not.toBe(inherited.argsHash);
		expect(calls).toHaveLength(2);
		store.close();
	});

	test("a replayed refusal journals fresh under a colliding id", () => {
		const store = openStore(tmpDb("goblin-tj-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		// The recovery fence refuses a re-ask matching inherited evidence
		// and journals the synthetic answer under the id the provider
		// sent — the inherited row must keep its own recorded outcome.
		const a = begunRun(journal, conv.id, "run-a");
		journal.noteToolInput(a, "c1", "probe", { q: 1 });
		journal.noteToolDispatch(a, "c1", "probe", { q: 1 });
		journal.noteToolResult(a, "c1", { old: true });
		journal.finishRun(a, "error", "undelivered");

		journal.beginRun({
			runId: "run-b",
			conversationId: conv.id,
			epoch: 3,
			anchorSeq: 7,
			steerMark: 7,
			convSnapshot: { model: "z.ai/glm-5", thinking: "low" },
			toolNames: ["probe"],
			startedAt: "2026-10-11T00:01:00.000Z",
			inheritFrom: [a],
		});
		journal.noteToolResult("run-b", "c1", { error: "conflict" }, { replayed: true });

		const calls = journal.callsFor("run-b");
		const refused = calls.find((c) => c.toolCallId === "c1")!;
		expect(refused.state).toBe("completed");
		expect(refused.replayed).toBe(true);
		expect(refused.result).toBe('{"error":"conflict"}');
		const inherited = calls.find((c) => c.toolCallId === "run-a:c1")!;
		expect(inherited.replayed).toBe(false);
		expect(inherited.result).toBe('{"old":true}');
		store.close();
	});

	test("a replayed result journals with provenance and buys no execution credit", () => {
		const store = openStore(tmpDb("goblin-tj-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		const runId = begunRun(journal, conv.id);
		journal.noteToolInput(runId, "c-exec", "probe", { q: 1 });
		journal.noteToolDispatch(runId, "c-exec", "probe", { q: 1 });
		journal.noteToolResult(runId, "c-exec", { out: "real" });
		// The re-ask rides the same chunk/dispatch seams as the real call,
		// so the row must carry full identity — without it the guard's
		// synthetic-row skip could pass on the row's empty name.
		journal.noteToolInput(runId, "c-replay", "probe", { q: 1 });
		journal.noteToolDispatch(runId, "c-replay", "probe", { q: 1 });
		journal.noteToolResult(runId, "c-replay", { out: "real" }, { replayed: true });
		const calls = journal.callsFor(runId);
		const executed = calls.find((c) => c.toolCallId === "c-exec")!;
		const replayed = calls.find((c) => c.toolCallId === "c-replay")!;
		expect(replayed.replayed).toBe(true);
		expect(executed.replayed).toBe(false);
		// The guard's skip must come from the replayed flag, not a missing
		// name or hash.
		expect(replayed.state).toBe("completed");
		expect(replayed.name).toBe("probe");
		expect(replayed.argsHash).toBe(executed.argsHash);
		const next = begunRun(journal, conv.id, "run-next");
		journal.inheritCalls(runId, next);
		expect(journal.callsFor(next).find((c) => c.toolCallId === "run-1:c-replay")!.replayed).toBe(
			true,
		);
		// The recovery guard ignores synthetic replayed rows as history —
		// they are journaled answers, never executions.
		const entries = buildRetryGuard(journal.callsFor(next)).get(
			`${replayed.name}:${replayed.argsHash}`,
		)!;
		expect(entries.map((e) => e.toolCallId)).toEqual(["run-1:c-exec"]);
		store.close();
	});

	test("the guard sees executions and legacy decisions by signature, FIFO in row order", () => {
		const store = openStore(tmpDb("goblin-tj-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		const runId = begunRun(journal, conv.id);
		// completed — a recorded execution.
		journal.noteToolInput(runId, "c-done", "probe", { q: 1 });
		journal.noteToolDispatch(runId, "c-done", "probe", { q: 1 });
		journal.noteToolResult(runId, "c-done", { out: "first" });
		// Legacy resolved-* rows — written by the removed decision path,
		// stamped here the way old databases carry them.
		journal.noteToolInput(runId, "c-asserted", "probe", { q: 2 });
		journal.noteToolDispatch(runId, "c-asserted", "probe", { q: 2 });
		journal.noteToolInput(runId, "c-nonote", "probe", { q: 3 });
		journal.noteToolDispatch(runId, "c-nonote", "probe", { q: 3 });
		journal.noteToolInput(runId, "c-retry", "probe", { q: 4 });
		journal.noteToolDispatch(runId, "c-retry", "probe", { q: 4 });
		journal.noteToolInput(runId, "c-skip", "probe", { q: 5 });
		journal.noteToolDispatch(runId, "c-skip", "probe", { q: 5 });
		store.db.run(
			`UPDATE turn_tool_calls SET state = 'resolved-done', resolution_note = 'asserted output', resolved_ms = 1
			 WHERE run_id = ? AND tool_call_id IN ('c-asserted', 'c-nonote')`,
			[runId],
		);
		store.db.run(
			"UPDATE turn_tool_calls SET state = 'resolved-retry' WHERE run_id = ? AND tool_call_id = 'c-retry'",
			[runId],
		);
		store.db.run(
			"UPDATE turn_tool_calls SET state = 'resolved-skip' WHERE run_id = ? AND tool_call_id = 'c-skip'",
			[runId],
		);
		journal.noteToolInput(runId, "c-failed", "probe", { q: 6 });
		journal.noteToolError(runId, "c-failed", new Error("x"));
		journal.noteToolInput(runId, "c-planned", "probe", { q: 7 });
		// A second completed call with the same args queues behind the first.
		journal.noteToolInput(runId, "c-done2", "probe", { q: 1 });
		journal.noteToolResult(runId, "c-done2", { out: "second" });

		const guard = buildRetryGuard(journal.callsFor(runId));
		expect(guard.size).toBe(6);
		// Same-signature executions keep row order — the FIFO of evidence.
		expect(guard.get(replayKey("probe", { q: 1 }))!.map((e) => e.toolCallId)).toEqual([
			"c-done",
			"c-done2",
		]);
		expect(guard.get(replayKey("probe", { q: 4 }))![0]!.state).toBe("resolved-retry");
		expect(guard.get(replayKey("probe", { q: 4 }))![0]!.resolutionNote).toBeNull();
		expect(guard.get(replayKey("probe", { q: 2 }))![0]!.resolutionNote).toBe("asserted output");
		expect(guard.get(replayKey("probe", { q: 5 }))![0]!.state).toBe("resolved-skip");
		expect(guard.get(replayKey("probe", { q: 6 }))![0]!.state).toBe("failed");
		// planned is intent, not execution — invisible to the fence.
		expect(guard.get(replayKey("probe", { q: 7 }))).toBeUndefined();
		store.close();
	});

	test("call args store a bounded preview while the hash keeps the full canonical", () => {
		const store = openStore(tmpDb("goblin-tj-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		const runId = begunRun(journal, conv.id);

		journal.noteToolInput(runId, "small", "probe", { q: 1 });
		const small = journal.callsFor(runId).find((c) => c.toolCallId === "small")!;
		expect(small.args).toEqual({ q: 1 });
		expect(small.argsHash).toBe(
			createHash("sha256")
				.update(JSON.stringify({ q: 1 }))
				.digest("hex"),
		);

		const huge = { content: "x".repeat(1_000_000) };
		const hashOf = (v: unknown) => replayKey("probe", v).slice("probe:".length);
		journal.noteToolInput(runId, "big-in", "probe", huge);
		journal.noteToolDispatch(runId, "big-disp", "probe", huge);
		for (const id of ["big-in", "big-disp"]) {
			const raw = store.db
				.query<{ args: string }, [string, string]>(
					"SELECT args FROM turn_tool_calls WHERE run_id = ? AND tool_call_id = ?",
				)
				.get(runId, id)!;
			expect(raw.args.length).toBeLessThanOrEqual(8_000);
			expect(raw.args).toContain("[truncated]");
			const call = journal.callsFor(runId).find((c) => c.toolCallId === id)!;
			expect(typeof call.args).toBe("string");
			expect(call.args as string).toContain("[truncated]");
			expect(call.argsHash).toBe(hashOf(huge));
		}

		const a = { pad: "p".repeat(9_000), tail: "a" };
		const b = { pad: "p".repeat(9_000), tail: "b" };
		journal.noteToolInput(runId, "pa", "probe", a);
		journal.noteToolInput(runId, "pb", "probe", b);
		const pa = journal.callsFor(runId).find((c) => c.toolCallId === "pa")!;
		const pb = journal.callsFor(runId).find((c) => c.toolCallId === "pb")!;
		expect(pa.argsHash).not.toBe(pb.argsHash);
		expect(pa.args).toEqual(pb.args);

		journal.noteToolResult(runId, "big-in", { out: "landed" });

		const next = begunRun(journal, conv.id, "run-next");
		journal.inheritCalls(runId, next);
		const inh = journal.callsFor(next).find((c) => c.toolCallId === "run-1:big-in")!;
		expect(inh.argsHash).toBe(hashOf(huge));
		expect(inh.args as string).toContain("[truncated]");

		store.db.run("UPDATE turn_tool_calls SET args = ? WHERE run_id = ? AND tool_call_id = ?", [
			JSON.stringify(huge),
			runId,
			"big-disp",
		]);
		const legacy = journal.callsFor(runId).find((c) => c.toolCallId === "big-disp")!;
		expect(typeof legacy.args).toBe("string");
		expect((legacy.args as string).length).toBeLessThanOrEqual(8_000);
		expect(legacy.args as string).toContain("[truncated]");
		expect(legacy.argsHash).toBe(hashOf(huge));

		store.db.run("UPDATE turn_tool_calls SET args = ? WHERE run_id = ? AND tool_call_id = ?", [
			'{"unclosed',
			runId,
			"small",
		]);
		expect(journal.callsFor(runId).find((c) => c.toolCallId === "small")!.args).toBe('{"unclosed');
		store.close();
	});

	test("a corrupt run row decodes tolerantly — reads survive it alongside healthy rows", () => {
		const dbPath = tmpDb("goblin-tj-");
		const store = openStore(dbPath);
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		begunRun(journal, conv.id, "run-bad");
		begunRun(journal, conv.id, "run-shape");
		begunRun(journal, conv.id, "run-good");
		store.db.run("UPDATE turn_runs SET conv_snapshot = ? WHERE run_id = ?", ["{nope", "run-bad"]);
		store.db.run("UPDATE turn_runs SET tool_names = ? WHERE run_id = ?", ["{nope", "run-bad"]);
		store.db.run("UPDATE turn_runs SET loop_state = ? WHERE run_id = ?", ["[unclosed", "run-bad"]);
		store.db.run("UPDATE turn_runs SET tool_names = ? WHERE run_id = ?", ['{"a":1}', "run-shape"]);

		const bad = journal.get("run-bad")!;
		expect(bad.toolNames).toBeNull();
		expect(typeof bad.convSnapshot).toBe("string");
		expect(typeof bad.loopState).toBe("string");
		expect(journal.get("run-shape")!.toolNames).toBeNull();
		expect(journal.get("run-good")!.toolNames).toEqual(["probe", "bash"]);
		expect(journal.interrupted()).toEqual([]);
		store.close();

		const reopened = openStore(dbPath);
		const j2 = openTurnJournal(reopened.db);
		const ids = ["run-bad", "run-good", "run-shape"];
		expect(
			j2
				.interrupted()
				.map((r) => r.runId)
				.sort(),
		).toEqual(ids);
		expect(j2.pendingBootNotices().interrupted.map((n) => n.run.runId).sort()).toEqual(ids);
		expect(j2.get("run-bad")!.toolNames).toBeNull();
		expect(j2.get("run-good")!.toolNames).toEqual(["probe", "bash"]);
		reopened.close();
	});

	test("an existing database gains the resume-era columns at open", () => {
		const dbPath = tmpDb("goblin-tj-");
		const store = openStore(dbPath);
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		// The pre-resume schema: no resumed_from, no resolution columns.
		store.db.run(`CREATE TABLE turn_runs (
			run_id TEXT PRIMARY KEY,
			conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
			epoch INTEGER NOT NULL,
			anchor_seq INTEGER,
			steer_mark INTEGER,
			conv_snapshot TEXT NOT NULL,
			tool_names TEXT NOT NULL,
			started_ms INTEGER NOT NULL,
			finished_ms INTEGER,
			status TEXT NOT NULL,
			delivery TEXT NOT NULL DEFAULT 'pending',
			partial TEXT,
			loop_state TEXT,
			filter_retry_used INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL
		)`);
		store.db.run(`CREATE TABLE turn_tool_calls (
			run_id TEXT NOT NULL REFERENCES turn_runs(run_id) ON DELETE CASCADE,
			tool_call_id TEXT NOT NULL,
			name TEXT NOT NULL,
			args TEXT NOT NULL,
			args_hash TEXT NOT NULL,
			state TEXT NOT NULL,
			result TEXT,
			error TEXT,
			began_ms INTEGER,
			settled_ms INTEGER,
			PRIMARY KEY (run_id, tool_call_id)
		)`);
		store.db.run(
			`INSERT INTO turn_runs (run_id, conversation_id, epoch, conv_snapshot, tool_names,
				started_ms, status, created_at)
			 VALUES ('old-run', ?, 1, '{}', '[]', 1, 'interrupted', '2026-10-11T00:00:00.000Z')`,
			[conv.id],
		);
		store.db.run(
			`INSERT INTO turn_tool_calls (run_id, tool_call_id, name, args, args_hash, state)
			 VALUES ('old-run', 'c1', 'probe', '{}', 'x', 'dispatched')`,
		);

		const journal = openTurnJournal(store.db);
		const run = journal.get("old-run")!;
		expect(run.calls.dispatched).toBe(1);
		expect(run.ownedInputSeqs).toBeNull();
		expect(run.replyLanded).toBe(false);
		const call = journal.callsFor("old-run")[0]!;
		expect(call.resolutionNote).toBeNull();
		expect(call.resolvedMs).toBeNull();
		expect(call.replayed).toBe(false);
		expect(call.retryFromKnown).toBe(false);
		// The resume-era columns exist for legacy rows to read; nothing
		// writes them any more (#594).
		const runCols = store.db
			.query<{ name: string }, []>("PRAGMA table_info(turn_runs)")
			.all()
			.map((c) => c.name);
		for (const col of ["resumed_from", "resume_request_seqs", "reply_landed", "reply_seq"]) {
			expect(runCols).toContain(col);
		}
		const callCols = store.db
			.query<{ name: string }, []>("PRAGMA table_info(turn_tool_calls)")
			.all()
			.map((c) => c.name);
		for (const col of [
			"resolution_note",
			"resolved_ms",
			"replayed",
			"retry_consumed",
			"retry_from_known",
			"origin_run",
		]) {
			expect(callCols).toContain(col);
		}
		store.close();
	});
});

// A "crash" is a second open* on the same file: rows still 'running' at
// open mean process death by construction.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { openStore } from "./conversation.ts";
import { setLogFile } from "./log.ts";
import { tmpDb } from "./testkit.ts";
import { openTurnJournal, replayKey, RESOLVED_DONE_EMPTY } from "./turn-journal.ts";

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
		expect(journal.interruptedAtOpen).toEqual([]);
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

		expect(journal2.interruptedAtOpen).toHaveLength(1);
		const snap = journal2.interruptedAtOpen[0]!;
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
		expect(journal2.interruptedAtOpen).toHaveLength(1);
		journal2.finishRun("run-late", "completed", "delivered");
		reopened.close();
	});

	test("the at-open snapshot fires once — later opens see only their own crashes", () => {
		const dbPath = tmpDb("goblin-tj-");
		const store = openStore(dbPath);
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		begunRun(journal, conv.id, "run-old");
		store.close();

		const reopened = openStore(dbPath);
		const journal2 = openTurnJournal(reopened.db);
		expect(journal2.interruptedAtOpen.map((r) => r.runId)).toEqual(["run-old"]);
		reopened.close();

		const third = openStore(dbPath);
		const journal3 = openTurnJournal(third.db);
		expect(journal3.interruptedAtOpen).toEqual([]);
		expect(journal3.interrupted().map((r) => r.runId)).toEqual(["run-old"]);

		begunRun(journal3, conv.id, "run-new");
		third.close();

		const fourth = openStore(dbPath);
		const journal4 = openTurnJournal(fourth.db);
		expect(journal4.interruptedAtOpen.map((r) => r.runId)).toEqual(["run-new"]);
		expect(
			journal4
				.interrupted()
				.map((r) => r.runId)
				.sort(),
		).toEqual(["run-new", "run-old"]);
		fourth.close();
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

	test("resolveCall lands the operator decision on a dispatched call only", () => {
		const store = openStore(tmpDb("goblin-tj-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		const runId = begunRun(journal, conv.id);
		journal.noteToolInput(runId, "c-done", "probe", { q: 1 });
		journal.noteToolDispatch(runId, "c-done", "probe", { q: 1 });
		journal.noteToolInput(runId, "c-retry", "probe", { q: 2 });
		journal.noteToolDispatch(runId, "c-retry", "probe", { q: 2 });
		journal.noteToolInput(runId, "c-skip", "probe", { q: 3 });
		journal.noteToolDispatch(runId, "c-skip", "probe", { q: 3 });
		journal.noteToolInput(runId, "c-planned", "probe", { q: 4 });
		journal.noteToolInput(runId, "c-settled", "probe", { q: 5 });
		journal.noteToolResult(runId, "c-settled", "ok");

		journal.resolveCall(runId, "c-done", "record-result", "the file was written");
		journal.resolveCall(runId, "c-retry", "authorize-retry", "rm is idempotent");
		journal.resolveCall(runId, "c-skip", "skip");

		const calls = journal.callsFor(runId);
		const done = calls.find((c) => c.toolCallId === "c-done")!;
		expect(done.state).toBe("resolved-done");
		expect(done.result).toBe('"the file was written"');
		expect(done.resolutionNote).toBe("the file was written");
		expect(done.resolvedMs).not.toBeNull();
		const retry = calls.find((c) => c.toolCallId === "c-retry")!;
		expect(retry.state).toBe("resolved-retry");
		expect(retry.result).toBeNull();
		expect(retry.resolutionNote).toBe("rm is idempotent");
		const skip = calls.find((c) => c.toolCallId === "c-skip")!;
		expect(skip.state).toBe("resolved-skip");
		expect(skip.result).toBeNull();
		expect(skip.resolutionNote).toBeNull();

		expect(() => journal.resolveCall(runId, "c-planned", "skip")).toThrow(/only 'dispatched'/);
		expect(() => journal.resolveCall(runId, "c-settled", "skip")).toThrow(/only 'dispatched'/);
		expect(() => journal.resolveCall(runId, "c-done", "skip")).toThrow(/only 'dispatched'/);
		expect(() => journal.resolveCall(runId, "missing", "skip")).toThrow(/no tool call/);
		expect(journal.get(runId)!.calls.resolved).toBe(3);
		store.close();
	});

	test("resolved calls never regress — late stream writes cannot overwrite a decision", () => {
		const store = openStore(tmpDb("goblin-tj-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		const runId = begunRun(journal, conv.id);
		journal.noteToolInput(runId, "c1", "probe", {});
		journal.noteToolDispatch(runId, "c1", "probe", {});
		journal.resolveCall(runId, "c1", "skip");
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
		// must still decide-and-refuse by identity.
		journal.noteToolDispatch(runId, "c1", "probe", { q: 9 });
		const call = journal.callsFor(runId)[0]!;
		expect(call.state).toBe("dispatched");
		expect(call.name).toBe("probe");
		expect(call.argsHash).not.toBe("");
		journal.resolveCall(runId, "c1", "skip", "not again");
		expect([...journal.skippedMap(runId).keys()]).toHaveLength(1);
		store.close();
	});

	test("inheritCalls carries settled history to the successor, never 'dispatched'", () => {
		const store = openStore(tmpDb("goblin-tj-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		const src = begunRun(journal, conv.id, "run-src");
		journal.noteToolInput(src, "done", "probe", { q: 1 });
		journal.noteToolDispatch(src, "done", "probe", { q: 1 });
		journal.noteToolResult(src, "done", { out: "landed" });
		journal.noteToolInput(src, "amb", "probe", { q: 2 });
		journal.noteToolDispatch(src, "amb", "probe", { q: 2 });
		journal.noteToolInput(src, "plan", "probe", { q: 3 });
		journal.resolveCall(src, "amb", "skip", "nope");

		const next = begunRun(journal, conv.id, "run-next");
		journal.inheritCalls(src, next);
		const calls = journal.callsFor(next);
		expect(calls.map((c) => c.toolCallId).sort()).toEqual(["amb", "done", "plan"]);
		expect(calls.find((c) => c.toolCallId === "done")!.result).toBe('{"out":"landed"}');
		expect(calls.find((c) => c.toolCallId === "amb")!.state).toBe("resolved-skip");
		expect(journal.replayMap(next).size).toBe(1);
		journal.inheritCalls(src, next);
		expect(journal.callsFor(next)).toHaveLength(3);
		store.close();
	});

	test("markRun moves only an interrupted run to resumed or abandoned", () => {
		const dbPath = tmpDb("goblin-tj-");
		const store = openStore(dbPath);
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const j1 = openTurnJournal(store.db);
		j1.beginRun({
			runId: "src",
			conversationId: conv.id,
			epoch: 3,
			anchorSeq: 7,
			steerMark: 7,
			convSnapshot: {},
			toolNames: [],
			startedAt: "2026-10-11T00:00:00.000Z",
		});
		j1.beginRun({
			runId: "done",
			conversationId: conv.id,
			epoch: 3,
			anchorSeq: 7,
			steerMark: 7,
			convSnapshot: {},
			toolNames: [],
			startedAt: "2026-10-11T00:00:00.000Z",
		});
		j1.finishRun("done", "completed", "delivered");
		// 'running' isn't resumable either — the crash reclassify comes first.
		expect(() => j1.markRun("src", "resumed")).toThrow(/only 'interrupted'/);
		expect(() => j1.markRun("done", "abandoned")).toThrow(/only 'interrupted'/);
		expect(() => j1.markRun("missing", "resumed")).toThrow(/no turn run/);
		store.close();

		const reopened = openStore(dbPath);
		const j2 = openTurnJournal(reopened.db);
		expect(j2.get("src")!.status).toBe("interrupted");
		j2.markRun("src", "resumed");
		expect(j2.get("src")!.status).toBe("resumed");
		expect(() => j2.markRun("src", "abandoned")).toThrow(/only 'interrupted'/);
		reopened.close();
	});

	test("resumed_from links the fresh run row to its interrupted source", () => {
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
		store.close();
		const reopened = openStore(dbPath);
		const journal = openTurnJournal(reopened.db);
		journal.beginRun({
			runId: "new-run",
			conversationId: conv.id,
			epoch: 3,
			anchorSeq: 7,
			steerMark: 7,
			convSnapshot: {},
			toolNames: [],
			startedAt: "2026-10-11T00:00:00.000Z",
			resumedFrom: "old-run",
		});
		expect(journal.get("new-run")!.resumedFrom).toBe("old-run");
		expect(journal.get("new-run")!.status).toBe("running");
		expect(journal.get("old-run")!.status).toBe("resumed");
		reopened.close();
	});

	test("a resume consumes its source atomically — creation, inheritance, and mark commit together", () => {
		const dbPath = tmpDb("goblin-tj-");
		const store = openStore(dbPath);
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const j1 = openTurnJournal(store.db);
		j1.beginRun({
			runId: "bad-run",
			conversationId: conv.id,
			epoch: 3,
			anchorSeq: 7,
			steerMark: 7,
			convSnapshot: {},
			toolNames: [],
			startedAt: "2026-10-11T00:00:00.000Z",
		});
		j1.finishRun("bad-run", "error", "failed");
		store.close();
		const reopened = openStore(dbPath);
		const journal = openTurnJournal(reopened.db);
		// The refusal rolls the successor row back with it — no
		// half-consumed pair can survive a crash between writes.
		expect(() =>
			journal.beginRun({
				runId: "half-run",
				conversationId: conv.id,
				epoch: 3,
				anchorSeq: 7,
				steerMark: 7,
				convSnapshot: {},
				toolNames: [],
				startedAt: "2026-10-11T00:00:00.000Z",
				resumedFrom: "bad-run",
			}),
		).toThrow(/'error' — refusing/);
		expect(journal.get("half-run")).toBeNull();
		expect(journal.get("bad-run")!.status).toBe("error");
		expect(() =>
			journal.beginRun({
				runId: "ghost-run",
				conversationId: conv.id,
				epoch: 3,
				anchorSeq: 7,
				steerMark: 7,
				convSnapshot: {},
				toolNames: [],
				startedAt: "2026-10-11T00:00:00.000Z",
				resumedFrom: "missing-run",
			}),
		).toThrow(/is gone/);
		expect(journal.get("ghost-run")).toBeNull();
		reopened.close();
	});

	test("a fault consuming the source rolls the whole resume back — row, inheritance, mark", () => {
		const dbPath = tmpDb("goblin-tj-");
		const store = openStore(dbPath);
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const j1 = openTurnJournal(store.db);
		j1.beginRun({
			runId: "source-run",
			conversationId: conv.id,
			epoch: 3,
			anchorSeq: 7,
			steerMark: 7,
			convSnapshot: {},
			toolNames: ["probe"],
			startedAt: "2026-10-11T00:00:00.000Z",
		});
		j1.noteToolInput("source-run", "c-1", "probe", { q: 1 });
		j1.noteToolDispatch("source-run", "c-1", "probe", { q: 1 });
		j1.noteToolResult("source-run", "c-1", { out: "landed" });
		store.close();

		const reopened = openStore(dbPath);
		const journal = openTurnJournal(reopened.db);
		try {
			// The fault lands on the write that consumes the source — past
			// the successor's insert — so a throw proves the whole
			// transaction rolled back.
			reopened.db.run(`CREATE TRIGGER fail_source_consumption
				BEFORE UPDATE OF status ON turn_runs
				WHEN OLD.run_id = 'source-run' AND NEW.status = 'resumed'
				BEGIN SELECT RAISE(ABORT, 'injected source-consumption failure'); END`);
			const begin = (): void =>
				journal.beginRun({
					runId: "successor-run",
					conversationId: conv.id,
					epoch: 3,
					anchorSeq: 7,
					steerMark: 7,
					convSnapshot: {},
					toolNames: ["probe"],
					startedAt: "2026-10-11T00:00:00.000Z",
					resumedFrom: "source-run",
				});
			expect(begin).toThrow(/injected source-consumption failure/);
			expect(journal.get("successor-run")).toBeNull();
			expect(journal.callsFor("successor-run")).toEqual([]);
			expect(journal.get("source-run")!.status).toBe("interrupted");
			expect(journal.callsFor("source-run")).toMatchObject([
				{ toolCallId: "c-1", name: "probe", state: "completed", result: '{"out":"landed"}' },
			]);
			reopened.db.run("DROP TRIGGER fail_source_consumption");
			begin();
			expect(journal.get("successor-run")).toMatchObject({
				status: "running",
				resumedFrom: "source-run",
			});
			expect(journal.get("source-run")!.status).toBe("resumed");
			expect(journal.callsFor("successor-run")).toMatchObject([
				{ toolCallId: "c-1", name: "probe", state: "completed" },
			]);
			expect(journal.replayMap("successor-run").get(replayKey("probe", { q: 1 }))).toEqual([
				{ out: "landed" },
			]);
		} finally {
			reopened.close();
		}
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
		expect(journal.callsFor(next).map((c) => c.toolCallId)).toEqual(["done"]);
		expect(journal.replayMap(next).get(replayKey("probe", { q: 1 }))).toEqual([
			{ out: "pred-ran" },
		]);
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

	test("a replayed result journals with provenance and adds no replay credit", () => {
		const store = openStore(tmpDb("goblin-tj-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		const runId = begunRun(journal, conv.id);
		journal.noteToolInput(runId, "c-exec", "probe", { q: 1 });
		journal.noteToolDispatch(runId, "c-exec", "probe", { q: 1 });
		journal.noteToolResult(runId, "c-exec", { out: "real" });
		// The re-ask rides the same chunk/dispatch seams as the real call,
		// so the row must carry full identity — without it the replayMap
		// credit skip could pass on the row's empty name.
		journal.noteToolInput(runId, "c-replay", "probe", { q: 1 });
		journal.noteToolDispatch(runId, "c-replay", "probe", { q: 1 });
		journal.noteToolResult(runId, "c-replay", { out: "real" }, { replayed: true });
		const calls = journal.callsFor(runId);
		const executed = calls.find((c) => c.toolCallId === "c-exec")!;
		const replayed = calls.find((c) => c.toolCallId === "c-replay")!;
		expect(replayed.replayed).toBe(true);
		expect(executed.replayed).toBe(false);
		// The credit skip must come from the replayed flag, not a missing
		// name or hash.
		expect(replayed.state).toBe("completed");
		expect(replayed.name).toBe("probe");
		expect(replayed.argsHash).toBe(executed.argsHash);
		expect(journal.replayMap(runId).get(replayKey("probe", { q: 1 }))).toEqual([{ out: "real" }]);
		const next = begunRun(journal, conv.id, "run-next");
		journal.inheritCalls(runId, next);
		expect(journal.callsFor(next).find((c) => c.toolCallId === "c-replay")!.replayed).toBe(true);
		expect(journal.replayMap(next).get(replayKey("probe", { q: 1 }))).toEqual([{ out: "real" }]);
		store.close();
	});

	test("replayMap carries completed and resolved-done outputs, FIFO per call", () => {
		const store = openStore(tmpDb("goblin-tj-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		const runId = begunRun(journal, conv.id);
		// completed — replays its recorded result.
		journal.noteToolInput(runId, "c-done", "probe", { q: 1 });
		journal.noteToolDispatch(runId, "c-done", "probe", { q: 1 });
		journal.noteToolResult(runId, "c-done", { out: "first" });
		// resolved-done — the operator's note is the result.
		journal.noteToolInput(runId, "c-asserted", "probe", { q: 2 });
		journal.noteToolDispatch(runId, "c-asserted", "probe", { q: 2 });
		journal.resolveCall(runId, "c-asserted", "record-result", "asserted output");
		// resolved-done without a note — the explicit empty marker.
		journal.noteToolInput(runId, "c-nonote", "probe", { q: 3 });
		journal.noteToolDispatch(runId, "c-nonote", "probe", { q: 3 });
		journal.resolveCall(runId, "c-nonote", "record-result");
		// retry and skip never replay; neither does failed/planned.
		journal.noteToolInput(runId, "c-retry", "probe", { q: 4 });
		journal.noteToolDispatch(runId, "c-retry", "probe", { q: 4 });
		journal.resolveCall(runId, "c-retry", "authorize-retry");
		journal.noteToolInput(runId, "c-skip", "probe", { q: 5 });
		journal.noteToolDispatch(runId, "c-skip", "probe", { q: 5 });
		journal.resolveCall(runId, "c-skip", "skip");
		journal.noteToolInput(runId, "c-failed", "probe", { q: 6 });
		journal.noteToolError(runId, "c-failed", new Error("x"));
		journal.noteToolInput(runId, "c-planned", "probe", { q: 7 });
		// A second completed call with the same args queues behind the first.
		journal.noteToolInput(runId, "c-done2", "probe", { q: 1 });
		journal.noteToolResult(runId, "c-done2", { out: "second" });

		const map = journal.replayMap(runId);
		expect(map.size).toBe(3);
		const sameKey = replayKey("probe", { q: 1 });
		expect(map.get(sameKey)).toEqual([{ out: "first" }, { out: "second" }]);
		expect(map.get(replayKey("probe", { q: 2 }))).toEqual(["asserted output"]);
		expect(map.get(replayKey("probe", { q: 3 }))).toEqual([RESOLVED_DONE_EMPTY]);
		expect(map.has(replayKey("probe", { q: 4 }))).toBe(false);
		expect(map.has(replayKey("probe", { q: 5 }))).toBe(false);
		expect(map.has(replayKey("probe", { q: 6 }))).toBe(false);
		expect(map.has(replayKey("probe", { q: 7 }))).toBe(false);
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
		expect(journal.replayMap(runId).get(replayKey("probe", huge))).toEqual([{ out: "landed" }]);

		const next = begunRun(journal, conv.id, "run-next");
		journal.inheritCalls(runId, next);
		const inh = journal.callsFor(next).find((c) => c.toolCallId === "big-in")!;
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
		expect(j2.interruptedAtOpen.map((r) => r.runId).sort()).toEqual(ids);
		expect(j2.get("run-bad")!.toolNames).toBeNull();
		expect(j2.get("run-good")!.toolNames).toEqual(["probe", "bash"]);
		reopened.close();
	});

	test("an existing database gains the resume columns at open", () => {
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
		expect(run.resumedFrom).toBeNull();
		expect(run.calls.dispatched).toBe(1);
		const call = journal.callsFor("old-run")[0]!;
		expect(call.resolutionNote).toBeNull();
		expect(call.resolvedMs).toBeNull();
		journal.resolveCall("old-run", "c1", "skip");
		expect(journal.callsFor("old-run")[0]!.state).toBe("resolved-skip");
		journal.markRun("old-run", "abandoned");
		expect(journal.get("old-run")!.status).toBe("abandoned");
		store.close();
	});
});

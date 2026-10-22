// "Interrupted" runs are fixture-stamped the way openTurnJournal's
// reclassify leaves them; assertions ride the real fence/admission path.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APICallError } from "@ai-sdk/provider";
import type { LanguageModel, UIMessage } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { openStore, type Conversation, type ConversationStore } from "./conversation.ts";
import { withScript } from "./agent/tools/script.ts";
import { setLogFile } from "./log.ts";
import { Runtime, type RuntimeDeps, type TurnDone, userMessage } from "./runtime.ts";
import {
	finishPart,
	scriptedModel,
	textParts,
	toolCallPart,
	type StreamAttempt,
} from "./testkit/fake-model.ts";
import { pauseFakeModelAtDelta, RecordingSink, tmpDb, waitUntil } from "./testkit.ts";
import { openTurnJournal, RESOLVED_RETRY_NOTE, type TurnJournal } from "./turn-journal.ts";
import { makeResumeOps, makeResumeSinks } from "./turn-resume.ts";

setLogFile(null);

function setup(opts: {
	attempts?: StreamAttempt[];
	model?: LanguageModel;
	// The surface check reads these names against the recorded surface.
	tools?: Record<string, ReturnType<typeof tool>>;
	// Fault-injection tests break writes on the runtime's own db, not a
	// side store.
	wrapJournal?: (journal: TurnJournal) => TurnJournal;
	makeTools?: RuntimeDeps["makeTools"];
	sinkFactory?: () => RecordingSink;
	// Overflow-recovery tests wire a small window and a fold stub.
	contextWindow?: number;
	compaction?: RuntimeDeps["compaction"];
	sinkFor?: () => RecordingSink | null;
}) {
	const store = openStore(tmpDb("goblin-tr-"));
	const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
	const real = openTurnJournal(store.db);
	const journal = opts.wrapJournal?.(real) ?? real;
	const executed: { name: string; args: unknown }[] = [];
	const makeTools =
		opts.makeTools ??
		(() => ({
			probe: tool({
				inputSchema: z.object({ q: z.number() }),
				execute: async (args: { q: number }) => {
					executed.push({ name: "probe", args });
					return { ok: true, q: args.q };
				},
			}),
			...(opts.tools ?? {}),
		}));
	const edge = scriptedModel(opts.attempts ?? [textParts("resumed answer")]);
	const runtime = new Runtime({
		store,
		turnJournal: journal,
		buildStep: () => ({
			model: opts.model ?? edge.model,
			system: "test",
			...(opts.contextWindow !== undefined ? { contextWindow: opts.contextWindow } : {}),
		}),
		makeTools,
		...(opts.compaction !== undefined ? { compaction: opts.compaction } : {}),
	});
	const notices: { convId: string; sourceRunId: string; done: TurnDone }[] = [];
	let sink: RecordingSink | undefined;
	const ops = makeResumeOps({
		store,
		journal,
		runtime,
		captureConversation: (c) => c,
		makeTools,
		sinkFor: () => {
			if (opts.sinkFor !== undefined) return opts.sinkFor();
			sink = opts.sinkFactory?.() ?? new RecordingSink();
			return sink;
		},
		sinkHooks: () => ({ voice: false, recording: false, file: false }),
		notifyDone: (c, sourceRunId, done) => notices.push({ convId: c.id, sourceRunId, done }),
	});
	return {
		store,
		conv,
		journal,
		runtime,
		ops,
		executed,
		notices,
		edge,
		sink: () => sink,
	};
}

// What a crash leaves behind — stamped directly so the runtime under
// test keeps its handle.
function interruptedRun(
	store: ConversationStore,
	journal: TurnJournal,
	conv: Conversation,
	runId: string,
	opts: {
		anchorSeq?: number | null;
		snapshot?: { model: string | null; thinking: string | null };
		toolNames?: string[];
		ownedInputSeqs?: number[];
	} = {},
) {
	journal.beginRun({
		runId,
		conversationId: conv.id,
		epoch: conv.epoch,
		anchorSeq: opts.anchorSeq ?? null,
		steerMark: null,
		convSnapshot: opts.snapshot ?? { model: conv.model, thinking: conv.thinking },
		toolNames: opts.toolNames ?? ["probe"],
		startedAt: "2026-10-11T00:00:00.000Z",
		...(opts.ownedInputSeqs !== undefined ? { ownedInputSeqs: opts.ownedInputSeqs } : {}),
	});
	store.db.run("UPDATE turn_runs SET status = 'interrupted' WHERE run_id = ?", [runId]);
}

// The trigger message must be durable history for the resume's label —
// its seq is the run's anchor.
function appendUser(store: ConversationStore, conv: Conversation, text: string): number {
	store.append(conv.id, [userMessage([{ type: "text", text }])]);
	const entries = store.modelEntries(conv.id);
	return entries[entries.length - 1]!.seq;
}

// Same, returning the appended message when a fixture needs its id.
function appendUserMsg(
	store: ConversationStore,
	conv: Conversation,
	text: string,
): { seq: number; message: UIMessage } {
	const message = userMessage([{ type: "text", text }]);
	store.append(conv.id, [message]);
	return { seq: store.lastUserSeq(conv.id)!, message };
}

// The successor run id minted by a resume (first match) — or by an
// overflow continuation when the test wires a second one.
function successorRunId(store: ConversationStore, sourceRunId: string): string {
	return store.db
		.query<{ run_id: string }, [string]>(
			"SELECT run_id FROM turn_runs WHERE resumed_from = ? ORDER BY rowid",
		)
		.get(sourceRunId)!.run_id;
}

// Enough completed exchanges that the overflow compaction has a span to fold.
function seedExchanges(store: ConversationStore, convId: string): void {
	const big = "x".repeat(600);
	for (let i = 0; i < 3; i++) {
		store.append(convId, [userMessage([{ type: "text", text: `${big} q${i}` }])]);
		store.append(
			convId,
			[{ id: `a${i}`, role: "assistant", parts: [{ type: "text", text: `${big} r${i}` }] }],
			{ anchorSeq: store.lastUserSeq(convId) },
		);
	}
}

function overflowError(): APICallError {
	return new APICallError({
		message:
			"This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
		url: "https://api.openai.com/v1/chat/completions",
		requestBodyValues: {},
		statusCode: 400,
	});
}

describe("turn resume", () => {
	test("interrupted() lists the run with its journaled calls", async () => {
		const { store, conv, journal, ops, runtime } = setup({});
		interruptedRun(store, journal, conv, "run-dead");
		journal.noteToolInput("run-dead", "c1", "probe", { q: 1 });
		journal.noteToolDispatch("run-dead", "c1", "probe", { q: 1 });
		journal.noteToolResult("run-dead", "c1", { out: "landed" });
		journal.noteToolInput("run-dead", "c2", "probe", { q: 2 });
		journal.noteToolDispatch("run-dead", "c2", "probe", { q: 2 });
		journal.noteToolInput("run-dead", "c3", "probe", { q: 3 });

		const views = ops.interrupted(conv.id);
		expect(views).toHaveLength(1);
		expect(views[0]!.run.runId).toBe("run-dead");
		expect(views[0]!.calls.map((c) => c.state)).toEqual(["completed", "dispatched", "planned"]);
		expect(ops.interrupted("no-such-conv")).toEqual([]);
		await runtime.shutdown();
		store.close();
	});

	test("decide resolves ambiguous calls by ordinal and by id prefix", async () => {
		const { store, conv, journal, ops, runtime } = setup({});
		interruptedRun(store, journal, conv, "run-dead");
		journal.noteToolInput("run-dead", "call-aa", "probe", { q: 1 });
		journal.noteToolDispatch("run-dead", "call-aa", "probe", { q: 1 });
		journal.noteToolInput("run-dead", "call-bb", "probe", { q: 2 });
		journal.noteToolDispatch("run-dead", "call-bb", "probe", { q: 2 });

		expect(ops.decide(conv.id, "run-dead", "9", "skip").kind).toBe("refused");
		expect(ops.decide(conv.id, "run-dead", "nope", "skip").kind).toBe("refused");
		expect(ops.decide(conv.id, "run-dead", "call", "skip").kind).toBe("refused"); // ambiguous prefix

		expect(ops.decide(conv.id, "run-dead", "1", "record-result", "landed anyway")).toEqual({
			kind: "ok",
		});
		expect(ops.decide(conv.id, "run-dead", "call-bb", "authorize-retry", "idempotent")).toEqual({
			kind: "ok",
		});
		const calls = journal.callsFor("run-dead");
		expect(calls.find((c) => c.toolCallId === "call-aa")!.state).toBe("resolved-done");
		expect(calls.find((c) => c.toolCallId === "call-bb")!.state).toBe("resolved-retry");
		expect(ops.decide(conv.id, "run-dead", "call-aa", "skip").kind).toBe("refused");
		await runtime.shutdown();
		store.close();
	});

	test("decide ordinals stay fixed as decisions land", async () => {
		const { store, conv, journal, ops, runtime } = setup({});
		interruptedRun(store, journal, conv, "run-dead");
		for (const [id, q] of [
			["c1", 1],
			["c2", 2],
			["c3", 3],
		] as const) {
			journal.noteToolInput("run-dead", id, "probe", { q });
			journal.noteToolDispatch("run-dead", id, "probe", { q });
		}

		expect(ops.decide(conv.id, "run-dead", "1", "skip").kind).toBe("ok");
		// #2 must still name c2 — an ordinal over the shrunk dispatched
		// list would hit c3 (an unapproved side effect) or refuse.
		expect(ops.decide(conv.id, "run-dead", "2", "authorize-retry").kind).toBe("ok");
		const again = ops.decide(conv.id, "run-dead", "1", "skip");
		expect(again.kind).toBe("refused");
		if (again.kind === "refused") {
			expect(again.code).toBe("conflict");
			expect(again.reason).toContain("resolved-skip");
		}
		const calls = journal.callsFor("run-dead");
		expect(calls.map((c) => c.state)).toEqual(["resolved-skip", "resolved-retry", "dispatched"]);
		await runtime.shutdown();
		store.close();
	});

	test("a digit-string tool call id decides itself, not the ordinal", async () => {
		const { store, conv, journal, ops, runtime } = setup({});
		interruptedRun(store, journal, conv, "run-dead");
		journal.noteToolInput("run-dead", "c9", "probe", { q: 1 });
		journal.noteToolDispatch("run-dead", "c9", "probe", { q: 1 });
		journal.noteToolInput("run-dead", "1", "probe", { q: 2 });
		journal.noteToolDispatch("run-dead", "1", "probe", { q: 2 });

		// "1" is the second call's id, not the first numbered row —
		// a pure-digit ref must name the call, not the ordinal.
		expect(ops.decide(conv.id, "run-dead", "1", "skip").kind).toBe("ok");
		const calls = journal.callsFor("run-dead");
		expect(calls.find((c) => c.toolCallId === "1")!.state).toBe("resolved-skip");
		expect(calls.find((c) => c.toolCallId === "c9")!.state).toBe("dispatched");
		await runtime.shutdown();
		store.close();
	});

	test("a grant on a known call mints no ordinal — ambiguous numbers never shift", async () => {
		const { store, conv, journal, ops, runtime } = setup({});
		interruptedRun(store, journal, conv, "run-dead");
		// The known execution precedes both ambiguous rows — if its grant
		// joined the numbering, "1" would retarget it.
		journal.noteToolInput("run-dead", "c-known", "probe", { q: 0 });
		journal.noteToolDispatch("run-dead", "c-known", "probe", { q: 0 });
		journal.noteToolResult("run-dead", "c-known", { out: "old" });
		journal.noteToolInput("run-dead", "c-amb1", "probe", { q: 1 });
		journal.noteToolDispatch("run-dead", "c-amb1", "probe", { q: 1 });
		journal.noteToolInput("run-dead", "c-amb2", "probe", { q: 2 });
		journal.noteToolDispatch("run-dead", "c-amb2", "probe", { q: 2 });

		expect(ops.decide(conv.id, "run-dead", "c-known", "authorize-retry").kind).toBe("ok");
		const granted = journal.callsFor("run-dead").find((c) => c.toolCallId === "c-known")!;
		expect(granted.state).toBe("resolved-retry");
		expect(granted.retryFromKnown).toBe(true);
		// "1" still names the first ambiguous row, not the granted known one.
		expect(ops.decide(conv.id, "run-dead", "1", "skip").kind).toBe("ok");
		expect(journal.callsFor("run-dead").find((c) => c.toolCallId === "c-amb1")!.state).toBe(
			"resolved-skip",
		);
		// And "2" still names the second after the first decision landed —
		// its resolved-skip keeps its own ordinal.
		expect(ops.decide(conv.id, "run-dead", "2", "record-result", "saw it").kind).toBe("ok");
		expect(journal.callsFor("run-dead").find((c) => c.toolCallId === "c-amb2")!.state).toBe(
			"resolved-done",
		);
		await runtime.shutdown();
		store.close();
	});

	test("resume refuses while ambiguous calls stay undecided", async () => {
		const { store, conv, journal, ops, runtime } = setup({});
		const anchorSeq = appendUser(store, conv, "run the tool");
		interruptedRun(store, journal, conv, "run-dead", { anchorSeq });
		journal.noteToolInput("run-dead", "c1", "probe", { q: 1 });
		journal.noteToolDispatch("run-dead", "c1", "probe", { q: 1 });

		const out = ops.resume(conv.id, "run-dead");
		expect(out.kind).toBe("needs-decisions");
		if (out.kind === "needs-decisions") {
			expect(out.runId).toBe("run-dead");
			expect(out.calls.map((c) => c.toolCallId)).toEqual(["c1"]);
			expect(out.numbered.map((c) => c.toolCallId)).toEqual(["c1"]);
		}
		expect(ops.decide(conv.id, "run-dead", "c1", "skip").kind).toBe("ok");
		const done = ops.resume(conv.id, "run-dead");
		expect(done.kind).toBe("resumed");
		await waitUntil(() => journal.get("run-dead")!.status === "resumed", "source consumed");
		await runtime.shutdown();
		store.close();
	});

	test("a resumed turn conflicts recorded results, re-executes granted retry, runs planned", async () => {
		const { store, conv, journal, ops, runtime, executed, notices, sink } = setup({
			attempts: [
				[
					toolCallPart("n1", "probe", '{"q":1}'),
					toolCallPart("n2", "probe", '{"q":2}'),
					toolCallPart("n3", "probe", '{"q":3}'),
					finishPart("tool-calls"),
				],
				textParts("continued"),
			],
		});
		const anchorSeq = appendUser(store, conv, "do the three things");
		interruptedRun(store, journal, conv, "run-src", { anchorSeq });
		// completed — recorded evidence; a re-ask conflicts, never re-executes.
		journal.noteToolInput("run-src", "c-done", "probe", { q: 1 });
		journal.noteToolDispatch("run-src", "c-done", "probe", { q: 1 });
		journal.noteToolResult("run-src", "c-done", { out: "landed" });
		// ambiguous — the operator authorizes re-running it.
		journal.noteToolInput("run-src", "c-amb", "probe", { q: 2 });
		journal.noteToolDispatch("run-src", "c-amb", "probe", { q: 2 });
		// planned — the dead model emitted it, execute never entered.
		journal.noteToolInput("run-src", "c-plan", "probe", { q: 3 });

		expect(ops.decide(conv.id, "run-src", "c-amb", "authorize-retry").kind).toBe("ok");
		const out = ops.resume(conv.id, "run-src");
		expect(out.kind).toBe("resumed");

		expect(await sink()!.done).toEqual({ kind: "completed" });
		await waitUntil(() => !runtime.busy(conv.id), "lane drains");
		await runtime.shutdown();

		expect(executed.map((e) => e.args)).toEqual([{ q: 2 }, { q: 3 }]);
		expect(journal.get("run-src")!.status).toBe("resumed");
		// Consumption lives on the successor's inherited copy — the
		// source's own row stays unconsumed but unreachable.
		const sourceCalls = journal.callsFor("run-src");
		expect(sourceCalls.find((c) => c.toolCallId === "c-amb")!.retryConsumed).toBe(false);
		const rows = store.db
			.query<{ run_id: string; resumed_from: string | null; status: string }, [string]>(
				"SELECT run_id, resumed_from, status FROM turn_runs WHERE resumed_from = ?",
			)
			.all("run-src");
		expect(rows).toHaveLength(1);
		expect(rows[0]!.status).toBe("completed");
		const newCalls = journal.callsFor(rows[0]!.run_id);
		expect(newCalls.map((c) => c.toolCallId).sort()).toEqual([
			"c-amb",
			"c-done",
			"c-plan",
			"n1",
			"n2",
			"n3",
		]);
		// 'dispatched' stays un-inherited — ambiguity remains owned by the
		// row that ran.
		expect(newCalls.find((c) => c.toolCallId === "c-done")!.state).toBe("completed");
		const granted = newCalls.find((c) => c.toolCallId === "c-amb")!;
		expect(granted.state).toBe("resolved-retry");
		expect(granted.retryConsumed).toBe(true);
		expect(newCalls.find((c) => c.toolCallId === "c-plan")!.state).toBe("planned");
		expect(
			newCalls.filter((c) => c.toolCallId.startsWith("n")).every((c) => c.state === "completed"),
		).toBe(true);
		// n1 collides with c-done's recorded execution — a labeled
		// conflict, never the old result and never a second run.
		const reasked = newCalls.find((c) => c.toolCallId === "n1")!;
		expect(reasked.replayed).toBe(true);
		expect(reasked.result).toContain("[turn-journal conflict]");
		expect(reasked.result).toContain("c-done");
		await waitUntil(() => notices.length === 1, "done notice");
		expect(notices[0]!.sourceRunId).toBe("run-src");
		expect(notices[0]!.done.kind).toBe("completed");
		store.close();
	});

	test("record-result keeps the asserted outcome as evidence — the re-ask conflicts", async () => {
		const { store, conv, journal, ops, runtime, executed, sink } = setup({
			attempts: [
				[toolCallPart("n1", "probe", '{"q":7}'), finishPart("tool-calls")],
				textParts("ok"),
			],
		});
		const anchorSeq = appendUser(store, conv, "run q7");
		interruptedRun(store, journal, conv, "run-src", { anchorSeq });
		journal.noteToolInput("run-src", "c1", "probe", { q: 7 });
		journal.noteToolDispatch("run-src", "c1", "probe", { q: 7 });
		expect(ops.decide(conv.id, "run-src", "c1", "record-result", "operator saw it land")).toEqual({
			kind: "ok",
		});
		expect(ops.resume(conv.id, "run-src").kind).toBe("resumed");
		expect(await sink()!.done).toEqual({ kind: "completed" });
		await runtime.shutdown();
		expect(executed).toEqual([]);
		const newRun = store.db
			.query<{ run_id: string }, [string]>("SELECT run_id FROM turn_runs WHERE resumed_from = ?")
			.get("run-src")!;
		const reask = journal.callsFor(newRun.run_id).find((c) => c.toolCallId === "n1")!;
		expect(reask.state).toBe("completed");
		expect(reask.replayed).toBe(true);
		expect(reask.result).toContain("[turn-journal conflict]");
		expect(reask.result).toContain("c1");
		// The recorded outcome stayed on the source row as evidence.
		expect(journal.callsFor("run-src").find((c) => c.toolCallId === "c1")!.result).toBe(
			'"operator saw it land"',
		);
		store.close();
	});

	test("a skipped call re-asked by the model gets the refusal, never the side effect", async () => {
		const { store, conv, journal, ops, runtime, executed, sink } = setup({
			attempts: [
				[toolCallPart("n1", "probe", '{"q":5}'), finishPart("tool-calls")],
				textParts("ok"),
			],
		});
		const anchorSeq = appendUser(store, conv, "run q5");
		interruptedRun(store, journal, conv, "run-src", { anchorSeq });
		journal.noteToolInput("run-src", "c1", "probe", { q: 5 });
		journal.noteToolDispatch("run-src", "c1", "probe", { q: 5 });
		expect(ops.decide(conv.id, "run-src", "c1", "skip", "do not rerun")).toEqual({ kind: "ok" });
		expect(ops.resume(conv.id, "run-src").kind).toBe("resumed");
		expect(await sink()!.done).toEqual({ kind: "completed" });
		await runtime.shutdown();
		expect(executed).toEqual([]);
		const newRun = store.db
			.query<{ run_id: string }, [string]>("SELECT run_id FROM turn_runs WHERE resumed_from = ?")
			.get("run-src")!;
		const reasked = journal.callsFor(newRun.run_id).find((c) => c.toolCallId === "n1")!;
		expect(reasked.state).toBe("completed");
		expect(reasked.result).toContain("operator skipped re-running");
		expect(reasked.result).toContain("do not rerun");
		store.close();
	});

	test("resume refuses when model or thinking drifted", async () => {
		const { store, conv, journal, ops, runtime } = setup({});
		interruptedRun(store, journal, conv, "run-src", {
			snapshot: { model: "old/provider", thinking: "low" },
		});
		const out = ops.resume(conv.id, "run-src");
		expect(out.kind).toBe("refused");
		if (out.kind === "refused") {
			expect(out.code).toBe("invalid");
			expect(out.reason).toContain("model changed old/provider");
			expect(out.reason).toContain("thinking changed low");
		}
		await runtime.shutdown();
		store.close();
	});

	test("resume refuses when the recorded tool surface shrank", async () => {
		const { store, conv, journal, ops, runtime } = setup({});
		interruptedRun(store, journal, conv, "run-src", {
			toolNames: ["probe", "retired-tool"],
		});
		const out = ops.resume(conv.id, "run-src");
		expect(out.kind).toBe("refused");
		if (out.kind === "refused") {
			expect(out.code).toBe("invalid");
			expect(out.reason).toContain("retired-tool");
		}
		await runtime.shutdown();
		store.close();
	});

	test("resume refuses while the lane is busy", async () => {
		const gated = pauseFakeModelAtDelta(["parked", "tail"], 0);
		const { store, conv, journal, ops, runtime } = setup({ model: gated.model });
		interruptedRun(store, journal, conv, "run-src");
		const blocker = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "hold the lane" }]), blocker);
		await gated.entered;
		expect(ops.resume(conv.id, "run-src")).toMatchObject({
			kind: "refused",
			code: "conflict",
		});
		gated.release();
		expect(await blocker.done).toEqual({ kind: "completed" });
		await runtime.shutdown();
		store.close();
	});

	test("a second resume while one is in flight refuses; a finished source never re-resumes", async () => {
		const gated = pauseFakeModelAtDelta(["slow", "end"], 0);
		const { store, conv, journal, ops, runtime, notices, sink } = setup({ model: gated.model });
		interruptedRun(store, journal, conv, "run-src", {
			anchorSeq: appendUser(store, conv, "go"),
		});

		expect(ops.resume(conv.id, "run-src").kind).toBe("resumed");
		// The claim set — not the row state — blocks the in-flight window:
		// the source still reads 'interrupted' until the attempt's markRun.
		expect(journal.get("run-src")!.status).toBe("interrupted");
		expect(ops.resume(conv.id, "run-src")).toMatchObject({
			kind: "refused",
			code: "conflict",
		});
		const blocked = ops.abandon(conv.id, "run-src");
		expect(blocked).toMatchObject({ kind: "refused", code: "conflict" });
		if (blocked.kind === "refused") {
			expect(blocked.reason).toContain("resume in flight");
		}
		expect(journal.get("run-src")!.status).toBe("interrupted");
		gated.release();
		expect(await sink()!.done).toEqual({ kind: "completed" });
		await waitUntil(() => !runtime.busy(conv.id), "lane drains");
		expect(journal.get("run-src")!.status).toBe("resumed");
		expect(notices).toHaveLength(1);
		expect(ops.resume(conv.id, "run-src")).toMatchObject({
			kind: "refused",
			code: "not-found",
		});
		await runtime.shutdown();
		store.close();
	});

	test("a class sink keeps its instance — deltas and the done flush land on it", async () => {
		class PublicSink extends RecordingSink {
			flushedText = "";
			override onDone(done: TurnDone) {
				this.flushedText = this.text;
				super.onDone(done);
			}
		}
		const publicSink = new PublicSink();
		const { store, conv, journal, ops, runtime, notices } = setup({
			attempts: [textParts(["first", " second"])],
			sinkFactory: () => publicSink,
		});
		interruptedRun(store, journal, conv, "run-src", {
			anchorSeq: appendUser(store, conv, "go"),
		});

		expect(ops.resume(conv.id, "run-src").kind).toBe("resumed");
		await waitUntil(() => !runtime.busy(conv.id), "lane drains");
		expect(publicSink.text).toBe("first second");
		expect(publicSink.chunkTypes).toContain("text-delta");
		expect(publicSink.flushedText).toBe("first second");
		expect(await publicSink.done).toEqual({ kind: "completed" });
		expect(notices).toHaveLength(1);
		expect(journal.get("run-src")!.status).toBe("resumed");
		await runtime.shutdown();
		store.close();
	});

	test("a class sink with private state keeps it through the resume wrapper", async () => {
		class PrivateSink extends RecordingSink {
			#text = "";
			flushedText = "";
			override onTextDelta(delta: string) {
				this.#text += delta;
				super.onTextDelta(delta);
			}
			override onDone(done: TurnDone) {
				this.flushedText = this.#text;
				super.onDone(done);
			}
		}
		const privateSink = new PrivateSink();
		const { store, conv, journal, ops, runtime, notices } = setup({
			attempts: [textParts(["first", " second"])],
			sinkFactory: () => privateSink,
		});
		interruptedRun(store, journal, conv, "run-src", {
			anchorSeq: appendUser(store, conv, "go"),
		});

		expect(ops.resume(conv.id, "run-src").kind).toBe("resumed");
		await waitUntil(() => !runtime.busy(conv.id), "lane drains");
		expect(privateSink.text).toBe("first second");
		expect(privateSink.flushedText).toBe("first second");
		expect(await privateSink.done).toEqual({ kind: "completed" });
		expect(notices).toHaveLength(1);
		expect(journal.get("run-src")!.status).toBe("resumed");
		await runtime.shutdown();
		store.close();
	});

	test("an unreadable recorded tool surface refuses resume — no model call, row stays interrupted", async () => {
		const { store, conv, journal, ops, runtime, edge } = setup({});
		interruptedRun(store, journal, conv, "run-dead", {
			anchorSeq: appendUser(store, conv, "go"),
		});
		store.db.run("UPDATE turn_runs SET tool_names = ? WHERE run_id = ?", ["{not json", "run-dead"]);
		const out = ops.resume(conv.id, "run-dead");
		expect(out).toMatchObject({ kind: "refused", code: "invalid" });
		if (out.kind === "refused") {
			expect(out.reason).toContain("tool surface is unreadable");
		}
		expect(edge.streamCalls).toHaveLength(0);
		expect(journal.get("run-dead")!.status).toBe("interrupted");
		store.db.run("UPDATE turn_runs SET tool_names = ? WHERE run_id = ?", ['{"x":1}', "run-dead"]);
		expect(ops.resume(conv.id, "run-dead")).toMatchObject({
			kind: "refused",
			code: "invalid",
		});
		await runtime.shutdown();
		store.close();
	});

	test("a corrupt settings snapshot or loop checkpoint refuses with a readable reason", async () => {
		const { store, conv, journal, ops, runtime, edge } = setup({});
		interruptedRun(store, journal, conv, "run-dead", {
			anchorSeq: appendUser(store, conv, "go"),
		});
		store.db.run("UPDATE turn_runs SET conv_snapshot = ? WHERE run_id = ?", ["!!{", "run-dead"]);
		const out = ops.resume(conv.id, "run-dead");
		expect(out).toMatchObject({ kind: "refused", code: "invalid" });
		if (out.kind === "refused") {
			expect(out.reason).toContain("settings snapshot is unreadable");
		}
		expect(edge.streamCalls).toHaveLength(0);
		expect(journal.get("run-dead")!.status).toBe("interrupted");

		store.db.run("UPDATE turn_runs SET conv_snapshot = ? WHERE run_id = ?", [
			JSON.stringify({ model: conv.model, thinking: conv.thinking }),
			"run-dead",
		]);
		store.db.run("UPDATE turn_runs SET loop_state = ? WHERE run_id = ?", ["[bad", "run-dead"]);
		const out2 = ops.resume(conv.id, "run-dead");
		expect(out2).toMatchObject({ kind: "refused", code: "invalid" });
		if (out2.kind === "refused") {
			expect(out2.reason).toContain("loop checkpoint is unreadable");
		}
		expect(journal.get("run-dead")!.status).toBe("interrupted");
		expect(edge.streamCalls).toHaveLength(0);
		await runtime.shutdown();
		store.close();
	});

	test("a resumed turn fences a huge-args re-ask by full hash; the seeded prompt stays bounded", async () => {
		const huge = { content: "x".repeat(1_000_000) };
		const { store, conv, journal, ops, runtime, executed, sink, edge } = setup({
			attempts: [
				[toolCallPart("n1", "bigwrite", JSON.stringify(huge)), finishPart("tool-calls")],
				textParts("ok"),
			],
			tools: {
				bigwrite: tool({
					inputSchema: z.object({ content: z.string() }),
					execute: async (args: { content: string }) => {
						executed.push({ name: "bigwrite", args });
						return { ok: true };
					},
				}) as unknown as ReturnType<typeof tool>,
			},
		});
		const anchorSeq = appendUser(store, conv, "write the file");
		interruptedRun(store, journal, conv, "run-src", {
			anchorSeq,
			toolNames: ["probe", "bigwrite"],
		});
		journal.noteToolInput("run-src", "c1", "bigwrite", huge);
		journal.noteToolDispatch("run-src", "c1", "bigwrite", huge);
		journal.noteToolResult("run-src", "c1", { out: "landed" });

		expect(ops.resume(conv.id, "run-src").kind).toBe("resumed");
		expect(await sink()!.done).toEqual({ kind: "completed" });
		await waitUntil(() => !runtime.busy(conv.id), "lane drains");
		await runtime.shutdown();

		expect(executed).toEqual([]);
		const promptJson = JSON.stringify(edge.streamCalls[0]!.prompt);
		expect(promptJson).toContain("[truncated]");
		expect(promptJson.length).toBeLessThan(100_000);
		const newRun = store.db
			.query<{ run_id: string }, [string]>("SELECT run_id FROM turn_runs WHERE resumed_from = ?")
			.get("run-src")!;
		const fenced = journal.callsFor(newRun.run_id).find((c) => c.toolCallId === "n1")!;
		expect(fenced.state).toBe("completed");
		expect(fenced.replayed).toBe(true);
		expect(fenced.result).toContain("[turn-journal conflict]");
		expect(fenced.result).toContain("c1");
		store.close();
	});

	test("abandon consumes the run; a later resume finds nothing", async () => {
		const { store, conv, journal, ops, runtime } = setup({});
		interruptedRun(store, journal, conv, "run-src");
		expect(ops.abandon(conv.id, "run-src")).toEqual({ kind: "ok" });
		expect(journal.get("run-src")!.status).toBe("abandoned");
		expect(ops.resume(conv.id, "run-src")).toMatchObject({
			kind: "refused",
			code: "not-found",
		});
		expect(ops.abandon(conv.id, "run-src").kind).toBe("refused");
		expect(ops.resume(conv.id, "never-existed")).toMatchObject({
			kind: "refused",
			code: "not-found",
		});
		await runtime.shutdown();
		store.close();
	});

	test("an errored resumed turn still notifies once", async () => {
		const { store, conv, journal, ops, runtime, notices, sink } = setup({
			attempts: [[{ type: "error", error: new Error("provider died") }]],
		});
		interruptedRun(store, journal, conv, "run-src", {
			anchorSeq: appendUser(store, conv, "go"),
		});
		expect(ops.resume(conv.id, "run-src").kind).toBe("resumed");
		const done = await sink()!.done;
		expect(done.kind).toBe("error");
		await waitUntil(() => notices.length === 1, "done notice");
		expect(notices[0]!.done.kind).toBe("error");
		expect(journal.get("run-src")!.status).toBe("resumed");
		await runtime.shutdown();
		store.close();
	});

	test("resume refuses when the trigger and journaled progress are both gone", async () => {
		const { store, conv, journal, ops, runtime } = setup({});
		interruptedRun(store, journal, conv, "run-src"); // anchorSeq null, no calls
		const out = ops.resume(conv.id, "run-src");
		expect(out.kind).toBe("refused");
		if (out.kind === "refused") {
			expect(out.code).toBe("invalid");
			expect(out.reason).toContain("nothing to resume");
		}
		await runtime.shutdown();
		store.close();
	});

	test("a shut-down runtime refuses the admission", async () => {
		const { store, conv, journal, ops, runtime } = setup({});
		interruptedRun(store, journal, conv, "run-src");
		await runtime.shutdown();
		expect(ops.resume(conv.id, "run-src")).toMatchObject({
			kind: "refused",
			code: "unavailable",
		});
		store.close();
	});

	test("a journal write failure is a fatal turn error — the call never repeats", async () => {
		// The result write dies after execute() already ran — an ordinary
		// tool error would invite the model to re-issue the side effect.
		const { store, conv, runtime, executed, edge } = setup({
			wrapJournal: (real) => ({
				...real,
				noteToolResult() {
					throw new Error("journal write exploded");
				},
			}),
			attempts: [[toolCallPart("n1", "probe", '{"q":1}'), finishPart("tool-calls")]],
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "go" }]), sink);
		const done = await sink.done;
		expect(done.kind).toBe("error");
		expect(executed).toEqual([{ name: "probe", args: { q: 1 } }]);
		expect(edge.streamCalls).toHaveLength(1);
		// A completed run with dispatched calls is the lie the status
		// guard removes — the row must read error.
		const row = store.db.query<{ status: string }, []>("SELECT status FROM turn_runs").get();
		expect(row?.status).toBe("error");
		await runtime.shutdown();
		store.close();
	});

	test("a resume dying before its successor keeps the source resumable", async () => {
		// makeTools fires once in resume's surface check and once in the
		// admitted attempt — the second call throwing is the
		// /stop-then-crash shape: admission accepted, successor never begun.
		let calls = 0;
		const { store, conv, journal, ops, runtime, sink } = setup({
			makeTools: () => {
				calls++;
				if (calls === 2) throw new Error("tool factory exploded");
				return {
					probe: tool({
						inputSchema: z.object({ q: z.number() }),
						execute: async (args: { q: number }) => ({ ok: true, q: args.q }),
					}),
				};
			},
		});
		interruptedRun(store, journal, conv, "run-src", {
			anchorSeq: appendUser(store, conv, "go"),
		});
		expect(ops.resume(conv.id, "run-src").kind).toBe("resumed");
		const done = await sink()!.done;
		expect(done.kind).toBe("error");
		expect(journal.get("run-src")!.status).toBe("interrupted");
		// The claim releases on terminal delivery — otherwise every later
		// resume hits 'already in flight'.
		await waitUntil(() => !runtime.busy(conv.id), "dead attempt's lane drains");
		expect(ops.resume(conv.id, "run-src").kind).toBe("resumed");
		expect(await sink()!.done).toEqual({ kind: "completed" });
		expect(journal.get("run-src")!.status).toBe("resumed");
		await runtime.shutdown();
		store.close();
	});

	test("resume refuses when durable user input arrived after the anchor — unanswered or answered", async () => {
		const { store, conv, journal, ops, runtime, edge } = setup({});
		const anchorSeq = appendUser(store, conv, "original ask");
		interruptedRun(store, journal, conv, "run-dead", { anchorSeq });
		const before = store.history(conv.id).length;
		// Unanswered: the message is a bare later user event.
		appendUser(store, conv, "unrelated follow-up");
		const out = ops.resume(conv.id, "run-dead");
		expect(out).toMatchObject({ kind: "refused", code: "conflict" });
		expect(edge.streamCalls).toHaveLength(0);
		expect(journal.get("run-dead")!.status).toBe("interrupted");
		// No resume event, no successor — the refusal spent nothing.
		expect(store.history(conv.id).length).toBe(before + 1);
		expect(
			store.db
				.query<{ n: number }, [string]>(
					"SELECT COUNT(*) AS n FROM turn_runs WHERE resumed_from = ?",
				)
				.get("run-dead")!.n,
		).toBe(0);

		// Answered: a completed later exchange is just as foreign.
		const conv2 = store.resolve({ kind: "dm", chatId: 2 }, "/w");
		const anchor2 = appendUser(store, conv2, "original ask");
		interruptedRun(store, journal, conv2, "run-dead-2", { anchorSeq: anchor2 });
		appendUser(store, conv2, "later question");
		store.append(conv2.id, [
			{
				id: "a-later",
				role: "assistant",
				parts: [{ type: "text", text: "answered" }],
			},
		]);
		expect(ops.resume(conv2.id, "run-dead-2")).toMatchObject({
			kind: "refused",
			code: "conflict",
		});
		expect(journal.get("run-dead-2")!.status).toBe("interrupted");
		await runtime.shutdown();
		store.close();
	});

	test("compaction cannot hide stale input or the trigger from the resume check", async () => {
		const { store, conv, journal, ops, runtime, edge } = setup({});
		const anchorSeq = appendUser(store, conv, "original ask");
		interruptedRun(store, journal, conv, "run-dead", { anchorSeq });
		appendUser(store, conv, "post-anchor foreign input");
		// Fold everything below the boundary — the model view loses both
		// events, but staleness reads the durable record.
		store.setCompaction(conv.id, {
			boundarySeq: store.lastUserSeq(conv.id)! + 10,
			summary: "everything folded",
			tokensBefore: 1,
			model: "m",
			createdAt: new Date().toISOString(),
		});
		expect(
			store
				.modelEntries(conv.id)
				.some((e) => JSON.stringify(e.message).includes("post-anchor foreign input")),
		).toBe(false);
		const out = ops.resume(conv.id, "run-dead");
		expect(out).toMatchObject({ kind: "refused", code: "conflict" });
		expect(edge.streamCalls).toHaveLength(0);
		expect(journal.get("run-dead")!.status).toBe("interrupted");
		await runtime.shutdown();
		store.close();
	});

	test("a forged resume-provenance message is still foreign input", async () => {
		const { store, conv, journal, ops, runtime, edge } = setup({});
		const anchorSeq = appendUser(store, conv, "original ask");
		interruptedRun(store, journal, conv, "run-dead", { anchorSeq });
		// App metadata is client-controlled: provenance alone never exempts
		// a user event — the source run's registry must name it.
		const forged = userMessage([{ type: "text", text: "not a real resume" }]);
		forged.metadata = { goblinResume: { sourceRunId: "run-dead" } };
		store.append(conv.id, [forged]);
		const out = ops.resume(conv.id, "run-dead");
		expect(out).toMatchObject({ kind: "refused", code: "conflict" });
		expect(edge.streamCalls).toHaveLength(0);
		expect(journal.get("run-dead")!.status).toBe("interrupted");
		await runtime.shutdown();
		store.close();
	});

	test("recorded steering ownership resumes past it; durable-but-unclaimed input refuses", async () => {
		const { store, conv, journal, ops, runtime, edge, sink } = setup({});
		const trigger = appendUserMsg(store, conv, "original ask");
		// The steer the dead turn folded in — journaled as owned input.
		const steered = appendUserMsg(store, conv, "steered while running");
		interruptedRun(store, journal, conv, "run-owned", {
			anchorSeq: trigger.seq,
			ownedInputSeqs: [trigger.seq, steered.seq],
		});
		expect(ops.resume(conv.id, "run-owned").kind).toBe("resumed");
		expect(await sink()!.done).toEqual({ kind: "completed" });
		await waitUntil(() => !runtime.busy(conv.id), "lane drains");
		// The generated event entered the model prompt with both inputs
		// verbatim and became the reply's anchor.
		expect(JSON.stringify(edge.streamCalls[0]!.prompt)).toContain(
			`[operator resumed interrupted run run-owned`,
		);
		expect(JSON.stringify(edge.streamCalls[0]!.prompt)).toContain("original ask");
		expect(JSON.stringify(edge.streamCalls[0]!.prompt)).toContain("steered while running");
		const detail = store.historyDetail(conv.id);
		const resumeEvent = detail.find(
			(e) =>
				e.message.role === "user" &&
				e.message.id !== trigger.message.id &&
				e.message.id !== steered.message.id,
		)!;
		expect(resumeEvent).toBeDefined();
		expect(resumeEvent.message.metadata).toEqual({
			goblinResume: { sourceRunId: "run-owned" },
		});
		const reply = detail.at(-1)!;
		expect(reply.message.role).toBe("assistant");
		expect(reply.anchorSeq).toBe(resumeEvent.seq);
		expect(store.modelEntries(conv.id).some((e) => e.message.id === resumeEvent.message.id)).toBe(
			true,
		);
		// The registry recorded the event id — a failed next resume would
		// still recognize it as this source's own request.
		expect(journal.get("run-owned")!.resumeRequestSeqs).toEqual([resumeEvent.seq]);

		// Unclaimed: durable but never owned by the run — refuses.
		const conv2 = store.resolve({ kind: "dm", chatId: 2 }, "/w");
		const trigger2 = appendUserMsg(store, conv2, "original ask");
		interruptedRun(store, journal, conv2, "run-unclaimed", {
			anchorSeq: trigger2.seq,
			ownedInputSeqs: [trigger2.seq],
		});
		appendUserMsg(store, conv2, "arrived but never folded in");
		expect(ops.resume(conv2.id, "run-unclaimed")).toMatchObject({
			kind: "refused",
			code: "conflict",
		});
		expect(journal.get("run-unclaimed")!.status).toBe("interrupted");
		await runtime.shutdown();
		store.close();
	});

	test("a compacted trigger is recovered verbatim into the source-linked resume event", async () => {
		const { store, conv, journal, ops, runtime, edge, sink } = setup({});
		const original = userMessage([
			{ type: "text", text: "original ask" },
			{
				type: "data-attachment",
				data: { path: "/tmp/pic.png", mediaType: "image/png", filename: "pic.png", size: 9 },
			},
		]);
		store.append(conv.id, [original]);
		const anchorSeq = store.lastUserSeq(conv.id)!;
		interruptedRun(store, journal, conv, "run-dead", {
			anchorSeq,
			ownedInputSeqs: [anchorSeq],
		});
		// The trigger folds below the boundary — the model view loses it,
		// but resume restores it into the new event.
		store.setCompaction(conv.id, {
			boundarySeq: anchorSeq,
			summary: "folded past",
			tokensBefore: 1,
			model: "m",
			createdAt: new Date().toISOString(),
		});
		expect(store.modelEntries(conv.id).some((e) => e.message.id === original.id)).toBe(false);
		expect(ops.resume(conv.id, "run-dead").kind).toBe("resumed");
		expect(await sink()!.done).toEqual({ kind: "completed" });
		const detail = store.historyDetail(conv.id);
		const resumeEvent = detail.find(
			(e) => e.message.role === "user" && e.message.id !== original.id,
		)!;
		// Parts ride verbatim — the attachment stays a part, not a string.
		expect(JSON.stringify(resumeEvent.message.parts)).toContain("original ask");
		expect(
			resumeEvent.message.parts.some((p) => (p as { type: string }).type === "data-attachment"),
		).toBe(true);
		expect(JSON.stringify(resumeEvent.message.parts)).toContain("pic.png");
		expect(JSON.stringify(edge.streamCalls[0]!.prompt)).toContain("original ask");
		const reply = detail.at(-1)!;
		expect(reply.anchorSeq).toBe(resumeEvent.seq);
		expect(store.modelEntries(conv.id).some((e) => e.message.id === resumeEvent.message.id)).toBe(
			true,
		);
		await runtime.shutdown();
		store.close();
	});

	test("malformed recorded ownership refuses readable; legacy rows fail closed to the anchor", async () => {
		const { store, conv, journal, ops, runtime, edge } = setup({});
		const a1 = appendUser(store, conv, "original ask");
		interruptedRun(store, journal, conv, "run-bad", { anchorSeq: a1 });
		store.db.run("UPDATE turn_runs SET owned_input_seqs = ? WHERE run_id = ?", [
			"{not json",
			"run-bad",
		]);
		const out = ops.resume(conv.id, "run-bad");
		expect(out).toMatchObject({ kind: "refused", code: "invalid" });
		if (out.kind === "refused") {
			expect(out.reason).toContain("input ownership is unreadable");
		}
		expect(edge.streamCalls).toHaveLength(0);
		expect(journal.get("run-bad")!.status).toBe("interrupted");
		// A pre-tracking row (NULL ownership) refuses any newer durable user.
		const conv2 = store.resolve({ kind: "dm", chatId: 2 }, "/w");
		const a2 = appendUser(store, conv2, "original ask");
		interruptedRun(store, journal, conv2, "run-legacy", { anchorSeq: a2 });
		appendUser(store, conv2, "newer durable input");
		expect(ops.resume(conv2.id, "run-legacy")).toMatchObject({
			kind: "refused",
			code: "conflict",
		});
		await runtime.shutdown();
		store.close();
	});

	test("an anchorless legacy run with journaled progress and no user history still resumes", async () => {
		const { store, conv, journal, ops, runtime, sink } = setup({});
		interruptedRun(store, journal, conv, "run-src");
		journal.noteToolInput("run-src", "c1", "probe", { q: 1 });
		journal.noteToolDispatch("run-src", "c1", "probe", { q: 1 });
		journal.noteToolResult("run-src", "c1", { out: "landed" });
		expect(ops.resume(conv.id, "run-src").kind).toBe("resumed");
		expect(await sink()!.done).toEqual({ kind: "completed" });
		expect(journal.get("run-src")!.status).toBe("resumed");
		await runtime.shutdown();
		store.close();
	});

	test("steer ownership and mark persist through journal reopen; a failed conversion is not owned", async () => {
		// Step 1's tool execute parks so both steers queue before step 2's
		// prepareStep claim — the real runtime, real journal path.
		const toolGate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const { store, conv, journal, runtime } = setup({
			attempts: [
				[toolCallPart("n1", "probe", '{"q":1}'), finishPart("tool-calls")],
				textParts("answer"),
			],
			makeTools: () => ({
				probe: tool({
					inputSchema: z.object({ q: z.number() }),
					execute: async (args: { q: number }) => {
						entered.resolve();
						await toolGate.promise;
						return { ok: true, q: args.q };
					},
				}),
			}),
		});
		const head = userMessage([{ type: "text", text: "go" }]);
		const headSink = new RecordingSink();
		runtime.submit(conv, head, headSink);
		await entered.promise;
		const steerGood = userMessage([{ type: "text", text: "steered mid-turn" }]);
		const steerPoison = {
			id: "poison-steer",
			role: "user",
			parts: [
				{ type: "text", text: "read this" },
				{ type: "file", mediaType: "image/png", filename: "x.png", url: "not a url" },
			],
		} as UIMessage;
		const steerSink = new RecordingSink();
		const poisonSink = new RecordingSink();
		runtime.submit(conv, steerGood, steerSink);
		runtime.submit(conv, steerPoison, poisonSink);
		toolGate.resolve();
		expect(await headSink.done).toEqual({ kind: "completed" });
		expect((await poisonSink.done).kind).toBe("error");
		await runtime.shutdown();
		const runId = store.db
			.query<{ run_id: string }, []>("SELECT run_id FROM turn_runs")
			.get()!.run_id;
		const reopen = openTurnJournal(store.db);
		const row = reopen.get(runId)!;
		// Ownership rides durable seqs — the unclaimed steer's seq is
		// durable but never joined the owned set, so the mark stops at the
		// folded steer.
		const seqOf = (id: string) =>
			store.historyDetail(conv.id).find((e) => e.message.id === id)!.seq;
		expect(row.ownedInputSeqs).toEqual(
			expect.arrayContaining([seqOf(head.id), seqOf(steerGood.id)]),
		);
		expect(row.ownedInputSeqs).not.toContain(seqOf(steerPoison.id));
		expect(row.steerMark).toBe(seqOf(steerGood.id));
		store.close();
	});

	test("a later event reusing an owned or registered message id stays foreign — seqs are the identity", async () => {
		const { store, conv, journal, ops, runtime, edge, sink } = setup({
			makeTools: (() => {
				let calls = 0;
				return () => {
					calls++;
					// run-a's staleness refusal consumes the first surface
					// check; the third call is run-b's admitted attempt —
					// admission accepted, successor never begun.
					if (calls === 3) throw new Error("tool factory exploded");
					return {
						probe: tool({
							inputSchema: z.object({ q: z.number() }),
							execute: async (args: { q: number }) => ({ ok: true, q: args.q }),
						}),
					};
				};
			})(),
		});
		// (a) A later user event carrying the anchor's message id is not
		// the anchor — durable seqs say so.
		const trigger = appendUserMsg(store, conv, "original ask");
		interruptedRun(store, journal, conv, "run-a", {
			anchorSeq: trigger.seq,
			ownedInputSeqs: [trigger.seq],
		});
		const doppel = userMessage([{ type: "text", text: "same id, different event" }]);
		doppel.id = trigger.message.id;
		store.append(conv.id, [doppel]);
		expect(ops.resume(conv.id, "run-a")).toMatchObject({
			kind: "refused",
			code: "conflict",
		});
		expect(journal.get("run-a")!.status).toBe("interrupted");
		expect(edge.streamCalls).toHaveLength(0);

		// (b) A later event carrying a GENERATED resume request's id and
		// matching metadata is still not that request — its seq isn't
		// registered.
		const conv2 = store.resolve({ kind: "dm", chatId: 2 }, "/w");
		const trigger2 = appendUserMsg(store, conv2, "original ask");
		interruptedRun(store, journal, conv2, "run-b", {
			anchorSeq: trigger2.seq,
			ownedInputSeqs: [trigger2.seq],
		});
		expect(ops.resume(conv2.id, "run-b").kind).toBe("resumed");
		expect((await sink()!.done).kind).toBe("error"); // factory exploded
		await waitUntil(() => !runtime.busy(conv2.id), "dead attempt's lane drains");
		const generated = store
			.historyDetail(conv2.id)
			.find((e) => e.message.role === "user" && e.message.id !== trigger2.message.id)!;
		expect(journal.get("run-b")!.resumeRequestSeqs).toEqual([generated.seq]);
		const fake = userMessage([{ type: "text", text: "borrowed request id" }]);
		fake.id = generated.message.id;
		fake.metadata = { goblinResume: { sourceRunId: "run-b" } };
		store.append(conv2.id, [fake]);
		expect(ops.resume(conv2.id, "run-b")).toMatchObject({
			kind: "refused",
			code: "conflict",
		});
		expect(journal.get("run-b")!.status).toBe("interrupted");
		await runtime.shutdown();
		store.close();
	});

	test("a recorded ownership that omits the run's own anchor refuses invalid", async () => {
		const { store, conv, journal, ops, runtime, edge } = setup({});
		const trigger = appendUserMsg(store, conv, "original ask");
		interruptedRun(store, journal, conv, "run-inconsistent", {
			anchorSeq: trigger.seq,
			ownedInputSeqs: [trigger.seq + 50],
		});
		const out = ops.resume(conv.id, "run-inconsistent");
		expect(out).toMatchObject({ kind: "refused", code: "invalid" });
		if (out.kind === "refused") {
			expect(out.reason).toContain("does not name the run's own anchor");
		}
		expect(edge.streamCalls).toHaveLength(0);
		expect(journal.get("run-inconsistent")!.status).toBe("interrupted");
		await runtime.shutdown();
		store.close();
	});

	test("a failed register+append rolls back together; the source stays resumable", async () => {
		const { store, conv, journal, ops, runtime, edge, sink } = setup({});
		const trigger = appendUserMsg(store, conv, "original ask");
		interruptedRun(store, journal, conv, "run-src", {
			anchorSeq: trigger.seq,
			ownedInputSeqs: [trigger.seq],
		});
		const eventsBefore = store.history(conv.id).length;
		// A trigger fault at the registry write — inside the same
		// transaction as the event append, so neither may land.
		store.db.exec(
			"CREATE TRIGGER fail_resume_req BEFORE UPDATE OF resume_request_seqs ON turn_runs " +
				"BEGIN SELECT RAISE(FAIL, 'fixture registry fault'); END",
		);
		const out = ops.resume(conv.id, "run-src");
		expect(out).toMatchObject({ kind: "refused", code: "unavailable" });
		expect(journal.get("run-src")!.status).toBe("interrupted");
		expect(journal.get("run-src")!.resumeRequestSeqs).toBeNull();
		expect(store.history(conv.id).length).toBe(eventsBefore); // no orphan event
		expect(edge.streamCalls).toHaveLength(0);
		// Fault dropped at the fixture level — the retry records and runs.
		store.db.exec("DROP TRIGGER fail_resume_req");
		expect(ops.resume(conv.id, "run-src").kind).toBe("resumed");
		expect(await sink()!.done).toEqual({ kind: "completed" });
		expect(journal.get("run-src")!.status).toBe("resumed");
		await runtime.shutdown();
		store.close();
	});

	test("a matching historical read does not answer a new call — it executes afresh", async () => {
		// The interrupted run read the file at "A"; between runs the file
		// became "B". A resumed turn re-asking read_file(path) must see B —
		// a recorded result is evidence, never a cached answer.
		const file = join(mkdtempSync(join(tmpdir(), "goblin-sr-")), "doc.txt");
		writeFileSync(file, "A");
		const reads: string[] = [];
		const { store, conv, journal, ops, runtime, sink } = setup({
			attempts: [
				[toolCallPart("n1", "read_file", JSON.stringify({ path: file })), finishPart("tool-calls")],
				textParts("done"),
			],
			makeTools: () => ({
				read_file: tool({
					inputSchema: z.object({ path: z.string() }),
					execute: async (args: { path: string }) => {
						reads.push(args.path);
						return readFileSync(args.path, "utf8");
					},
				}),
				probe: tool({
					inputSchema: z.object({ q: z.number() }),
					execute: async () => ({ ok: true }),
				}),
			}),
		});
		const trigger = appendUserMsg(store, conv, "original ask");
		interruptedRun(store, journal, conv, "run-src", {
			anchorSeq: trigger.seq,
			ownedInputSeqs: [trigger.seq],
			toolNames: ["read_file", "probe"],
		});
		journal.noteToolInput("run-src", "c-read", "read_file", { path: file });
		journal.noteToolDispatch("run-src", "c-read", "read_file", { path: file });
		journal.noteToolResult("run-src", "c-read", "A");
		writeFileSync(file, "B");
		expect(ops.resume(conv.id, "run-src").kind).toBe("resumed");
		expect(await sink()!.done).toEqual({ kind: "completed" });
		await runtime.shutdown();
		expect(reads).toEqual([file]); // executed fresh, not replayed
		const successor = store.db
			.query<{ run_id: string }, [string]>("SELECT run_id FROM turn_runs WHERE resumed_from = ?")
			.get("run-src")!.run_id;
		const reask = journal.callsFor(successor).find((c) => c.toolCallId === "n1")!;
		expect(reask.state).toBe("completed");
		expect(reask.replayed).toBe(false);
		expect(reask.result).toBe('"B"');
		store.close();
	});

	test("identical recorded effects each label the re-ask a conflict — never a FIFO of stale outputs", async () => {
		const { store, conv, journal, ops, runtime, executed, sink } = setup({
			attempts: [
				[
					toolCallPart("n1", "probe", '{"q":1}'),
					toolCallPart("n2", "probe", '{"q":1}'),
					toolCallPart("n3", "probe", '{"q":1}'),
					finishPart("tool-calls"),
				],
				textParts("done"),
			],
		});
		const anchorSeq = appendUser(store, conv, "orig");
		interruptedRun(store, journal, conv, "run-src", { anchorSeq });
		for (const [id, out] of [
			["c-a", "first"],
			["c-b", "second"],
		] as const) {
			journal.noteToolInput("run-src", id, "probe", { q: 1 });
			journal.noteToolDispatch("run-src", id, "probe", { q: 1 });
			journal.noteToolResult("run-src", id, { out });
		}

		expect(ops.resume(conv.id, "run-src").kind).toBe("resumed");
		expect(await sink()!.done).toEqual({ kind: "completed" });
		await runtime.shutdown();
		expect(executed).toEqual([]);
		const calls = journal.callsFor(successorRunId(store, "run-src"));
		for (const id of ["n1", "n2", "n3"]) {
			const reask = calls.find((c) => c.toolCallId === id)!;
			expect(reask.replayed).toBe(true);
			// Each refusal names both recorded executions as evidence —
			// the old results are never dealt back in row order.
			expect(reask.result).toContain("[turn-journal conflict]");
			expect(reask.result).toContain("c-a");
			expect(reask.result).toContain("c-b");
			expect(reask.result).not.toContain('"first"');
			expect(reask.result).not.toContain('"second"');
		}
		store.close();
	});

	test("a grant on a known call executes exactly once — the second re-ask conflicts", async () => {
		const { store, conv, journal, ops, runtime, executed, sink } = setup({
			attempts: [
				[toolCallPart("n1", "probe", '{"q":1}'), finishPart("tool-calls")],
				[toolCallPart("n2", "probe", '{"q":1}'), finishPart("tool-calls")],
				textParts("done"),
			],
		});
		const anchorSeq = appendUser(store, conv, "orig");
		interruptedRun(store, journal, conv, "run-src", { anchorSeq });
		journal.noteToolInput("run-src", "c-done", "probe", { q: 1 });
		journal.noteToolDispatch("run-src", "c-done", "probe", { q: 1 });
		journal.noteToolResult("run-src", "c-done", { out: "landed" });
		// The operator re-runs a KNOWN call by id — the journal marks
		// the grant so it can never claim an ambiguous ordinal.
		expect(ops.decide(conv.id, "run-src", "c-done", "authorize-retry").kind).toBe("ok");

		expect(ops.resume(conv.id, "run-src").kind).toBe("resumed");
		expect(await sink()!.done).toEqual({ kind: "completed" });
		await runtime.shutdown();
		expect(executed).toEqual([{ name: "probe", args: { q: 1 } }]);
		const calls = journal.callsFor(successorRunId(store, "run-src"));
		const first = calls.find((c) => c.toolCallId === "n1")!;
		expect(first.state).toBe("completed");
		expect(first.replayed).toBe(false);
		// The grant spent durably on the successor's inherited copy.
		expect(calls.find((c) => c.toolCallId === "c-done")!.retryConsumed).toBe(true);
		const second = calls.find((c) => c.toolCallId === "n2")!;
		expect(second.replayed).toBe(true);
		expect(second.result).toContain("[turn-journal conflict]");
		expect(second.result).toContain("c-done");
		store.close();
	});

	test("two grants run two re-asks — the third meets the skipped sibling's refusal", async () => {
		const { store, conv, journal, ops, runtime, executed, sink, edge } = setup({
			attempts: [
				[toolCallPart("n1", "probe", '{"q":1}'), finishPart("tool-calls")],
				[toolCallPart("n2", "probe", '{"q":1}'), finishPart("tool-calls")],
				[toolCallPart("n3", "probe", '{"q":1}'), finishPart("tool-calls")],
				textParts("done"),
			],
		});
		const anchorSeq = appendUser(store, conv, "orig");
		interruptedRun(store, journal, conv, "run-src", { anchorSeq });
		// Same signature three times: an ambiguous call and a known
		// execution each granted, a third sibling skipped.
		journal.noteToolInput("run-src", "g-amb", "probe", { q: 1 });
		journal.noteToolDispatch("run-src", "g-amb", "probe", { q: 1 });
		journal.noteToolInput("run-src", "g-known", "probe", { q: 1 });
		journal.noteToolDispatch("run-src", "g-known", "probe", { q: 1 });
		journal.noteToolResult("run-src", "g-known", { out: "landed" });
		journal.noteToolInput("run-src", "s-skip", "probe", { q: 1 });
		journal.noteToolDispatch("run-src", "s-skip", "probe", { q: 1 });
		expect(ops.decide(conv.id, "run-src", "g-amb", "authorize-retry").kind).toBe("ok");
		expect(ops.decide(conv.id, "run-src", "g-known", "authorize-retry").kind).toBe("ok");
		expect(ops.decide(conv.id, "run-src", "s-skip", "skip", "do not repeat").kind).toBe("ok");

		expect(ops.resume(conv.id, "run-src").kind).toBe("resumed");
		expect(await sink()!.done).toEqual({ kind: "completed" });
		await runtime.shutdown();
		// Exactly two executions — one per grant, oldest first.
		expect(executed).toEqual([
			{ name: "probe", args: { q: 1 } },
			{ name: "probe", args: { q: 1 } },
		]);
		const calls = journal.callsFor(successorRunId(store, "run-src"));
		expect(calls.find((c) => c.toolCallId === "g-amb")!.retryConsumed).toBe(true);
		expect(calls.find((c) => c.toolCallId === "g-known")!.retryConsumed).toBe(true);
		const third = calls.find((c) => c.toolCallId === "n3")!;
		expect(third.replayed).toBe(true);
		expect(third.result).toContain("operator skipped re-running");
		// The seeded partial carries the evidence: the known grant's
		// recorded result and its authorization note — never a re-usable
		// answer.
		const prompt = JSON.stringify(edge.streamCalls[0]!.prompt);
		expect(prompt).toContain("landed");
		expect(prompt).toContain("authorized re-running");
		store.close();
	});

	test("a crashed retry keeps the grant spent — its own dispatch gates the next resume", async () => {
		const { store, conv, journal, ops, runtime, executed, sink, edge } = setup({
			attempts: [
				[toolCallPart("re-1", "probe", '{"q":1}'), finishPart("tool-calls")],
				textParts("done"),
			],
		});
		const anchorSeq = appendUser(store, conv, "orig");
		interruptedRun(store, journal, conv, "run-src", { anchorSeq });
		journal.noteToolInput("run-src", "c-grant", "probe", { q: 1 });
		journal.noteToolDispatch("run-src", "c-grant", "probe", { q: 1 });
		expect(ops.decide(conv.id, "run-src", "c-grant", "authorize-retry").kind).toBe("ok");

		// The first successor claimed the grant and dispatched the
		// re-execution — then died before the outcome landed. Stamped
		// the way openTurnJournal's reclassify leaves a kill.
		journal.beginRun({
			runId: "run-r1",
			conversationId: conv.id,
			epoch: conv.epoch,
			anchorSeq,
			steerMark: null,
			convSnapshot: { model: conv.model, thinking: conv.thinking },
			toolNames: ["probe"],
			startedAt: "2026-10-11T00:01:00.000Z",
			resumedFrom: "run-src",
		});
		journal.noteToolDispatch("run-r1", "n1", "probe", { q: 1 }, { retryCallId: "c-grant" });
		store.db.run("UPDATE turn_runs SET status = 'interrupted' WHERE run_id = 'run-r1'");

		// The ambiguous dispatch owns the fence — no resume until the
		// operator says what happened to it.
		expect(ops.resume(conv.id, "run-r1").kind).toBe("needs-decisions");
		expect(ops.decide(conv.id, "run-r1", "n1", "record-result", "it landed").kind).toBe("ok");

		expect(ops.resume(conv.id, "run-r1").kind).toBe("resumed");
		expect(await sink()!.done).toEqual({ kind: "completed" });
		await runtime.shutdown();
		// The grant stayed spent across the second inheritance — the
		// same-signature re-ask conflicts, nothing runs again.
		expect(executed).toEqual([]);
		const calls = journal.callsFor(successorRunId(store, "run-r1"));
		expect(calls.find((c) => c.toolCallId === "c-grant")!.retryConsumed).toBe(true);
		const reask = calls.find((c) => c.toolCallId === "re-1")!;
		expect(reask.replayed).toBe(true);
		expect(reask.result).toContain("[turn-journal conflict]");
		expect(reask.result).toContain("c-grant");
		// The seeded partial carries the spent grant as evidence — never
		// as available permission for another execution.
		const prompt = JSON.stringify(edge.streamCalls[0]!.prompt);
		expect(prompt).toContain("grant is spent");
		expect(prompt).not.toContain(RESOLVED_RETRY_NOTE);
		store.close();
	});

	test("an overflow continuation inherits the spent grant — the source's stale copy loses", async () => {
		const { store, conv, journal, ops, runtime, executed, sink } = setup({
			attempts: [
				[toolCallPart("n1", "probe", '{"q":1}'), finishPart("tool-calls")],
				overflowError(),
				[toolCallPart("re-1", "probe", '{"q":1}'), finishPart("tool-calls")],
				textParts("done"),
			],
			contextWindow: 1000,
			compaction: {
				modelRef: () => "m",
				contextWindow: () => 1000,
				summarize: async () => "folded past",
			},
		});
		seedExchanges(store, conv.id);
		const anchorSeq = appendUser(store, conv, "orig");
		interruptedRun(store, journal, conv, "run-src", { anchorSeq });
		journal.noteToolInput("run-src", "c-grant", "probe", { q: 1 });
		journal.noteToolDispatch("run-src", "c-grant", "probe", { q: 1 });
		expect(ops.decide(conv.id, "run-src", "c-grant", "authorize-retry").kind).toBe("ok");

		expect(ops.resume(conv.id, "run-src").kind).toBe("resumed");
		expect(await sink()!.done).toEqual({ kind: "completed" });
		await runtime.shutdown();
		// The granted re-ask ran once; the overflowed attempt minted a
		// continuation that re-inherits from BOTH runs.
		expect(executed).toEqual([{ name: "probe", args: { q: 1 } }]);
		const rows = store.db
			.query<{ run_id: string }, [string]>(
				"SELECT run_id FROM turn_runs WHERE resumed_from = ? ORDER BY rowid",
			)
			.all("run-src");
		expect(rows).toHaveLength(2);
		const continuation = journal.callsFor(rows[1]!.run_id);
		// The predecessor's spent copy was inherited first — INSERT OR
		// IGNORE keeps it over the source's still-open copy.
		expect(continuation.find((c) => c.toolCallId === "c-grant")!.retryConsumed).toBe(true);
		const reask = continuation.find((c) => c.toolCallId === "re-1")!;
		expect(reask.replayed).toBe(true);
		expect(reask.result).toContain("[turn-journal conflict]");
		// The source's own row still reads unconsumed — unreachable, but
		// honest evidence of what was granted.
		expect(journal.callsFor("run-src").find((c) => c.toolCallId === "c-grant")!.retryConsumed).toBe(
			false,
		);
		store.close();
	});

	test("a nested script call hits the same recovery fence — the recorded write never replays", async () => {
		// The script tool's nested calls resolve through the same
		// fenced tool objects — a recorded nested effect conflicts the
		// same as a top-level one, and the sandbox sees a refusal, not
		// the old bytes.
		const dir = mkdtempSync(join(tmpdir(), "goblin-script-fence-"));
		const target = join(dir, "out.txt");
		writeFileSync(target, "before");
		const writes: string[] = [];
		const code = [
			"try {",
			` await tools.write_file(${JSON.stringify({ path: target, content: "new" })});`,
			' return "wrote";',
			'} catch (e) { return "blocked: " + e.message; }',
		].join("\n");
		const { store, conv, journal, ops, runtime, sink } = setup({
			attempts: [
				[toolCallPart("n-script", "script", JSON.stringify({ code })), finishPart("tool-calls")],
				textParts("done"),
			],
			makeTools: (conv) =>
				withScript(
					{
						write_file: tool({
							inputSchema: z.object({ path: z.string(), content: z.string() }),
							execute: async (args: { path: string; content: string }) => {
								writes.push(args.path);
								writeFileSync(args.path, args.content);
								return { path: args.path, bytes: args.content.length };
							},
						}),
					},
					{ conversation: conv.id, maxCalls: 8 },
				),
		});
		const anchorSeq = appendUser(store, conv, "orig");
		interruptedRun(store, journal, conv, "run-src", {
			anchorSeq,
			toolNames: ["write_file", "script"],
		});
		// The interrupted run's script journaled its nested write under
		// the parent's own child id — the changed script source mints a
		// fresh signature, the nested write does not.
		journal.noteToolInput("run-src", "c-script", "script", {
			code: "return 'old version';",
		});
		journal.noteToolDispatch("run-src", "c-script", "script", {
			code: "return 'old version';",
		});
		journal.noteToolResult("run-src", "c-script", {
			text: "Script completed in 0.1s · 1 tool calls",
			calls: [],
		});
		journal.noteToolInput("run-src", "c-script/1", "write_file", { path: target, content: "new" });
		journal.noteToolDispatch("run-src", "c-script/1", "write_file", {
			path: target,
			content: "new",
		});
		journal.noteToolResult("run-src", "c-script/1", { path: target, bytes: 3 });

		expect(ops.resume(conv.id, "run-src").kind).toBe("resumed");
		expect(await sink()!.done).toEqual({ kind: "completed" });
		await runtime.shutdown();
		// The nested write never ran — the file keeps its bytes.
		expect(writes).toEqual([]);
		expect(readFileSync(target, "utf8")).toBe("before");
		const calls = journal.callsFor(successorRunId(store, "run-src"));
		// A changed code signature is a new call — the parent script ran.
		const parent = calls.find((c) => c.toolCallId === "n-script")!;
		expect(parent.state).toBe("completed");
		expect(parent.replayed).toBe(false);
		// The nested refusal journaled under the new script's own child
		// id as a synthetic replayed result carrying the conflict.
		const nested = calls.find((c) => c.toolCallId === "n-script/1")!;
		expect(nested.replayed).toBe(true);
		expect(nested.result).toContain("[turn-journal conflict]");
		expect(nested.result).toContain("c-script/1");
		// …and the script's own record carries the same refusal.
		expect(parent.result).toContain("[turn-journal conflict]");
		store.close();
	});

	test("a missing lane refuses before tools or a successor run are built", async () => {
		let toolBuilds = 0;
		const { store, conv, journal, ops, runtime, edge } = setup({
			sinkFor: () => null,
			makeTools: () => {
				toolBuilds++;
				return {};
			},
		});
		interruptedRun(store, journal, conv, "run-dead", {
			anchorSeq: appendUser(store, conv, "go"),
		});
		expect(ops.resume(conv.id, "run-dead")).toEqual({
			kind: "refused",
			code: "unavailable",
			reason: "telegram channel is disabled — the interrupted turn cannot resume",
		});
		expect(toolBuilds).toBe(0);
		expect(edge.streamCalls).toEqual([]);
		expect(journal.get("run-dead")!.status).toBe("interrupted");
		expect(
			store.db
				.query<{ run_id: string }, [string]>("SELECT run_id FROM turn_runs WHERE resumed_from = ?")
				.all("run-dead"),
		).toEqual([]);
		await runtime.shutdown();
		store.close();
	});

	test("a released claim lets abandon take a source its resume failed on", async () => {
		let calls = 0;
		const { store, conv, journal, ops, runtime, notices, sink } = setup({
			makeTools: () => {
				calls++;
				if (calls === 2) throw new Error("tool factory exploded");
				return {
					probe: tool({
						inputSchema: z.object({ q: z.number() }),
						execute: async (args: { q: number }) => ({ ok: true, q: args.q }),
					}),
				};
			},
		});
		interruptedRun(store, journal, conv, "run-src", {
			anchorSeq: appendUser(store, conv, "go"),
		});
		expect(ops.resume(conv.id, "run-src").kind).toBe("resumed");
		expect((await sink()!.done).kind).toBe("error");
		await waitUntil(() => notices.length === 1, "done notice");
		expect(journal.get("run-src")!.status).toBe("interrupted");
		expect(ops.abandon(conv.id, "run-src")).toEqual({ kind: "ok" });
		expect(journal.get("run-src")!.status).toBe("abandoned");
		await runtime.shutdown();
		store.close();
	});
});

// Per-lane routing the composition root wires: app lanes take the bell
// with no hooks and no terminal DM (the bell is already the notice);
// telegram lanes take the delivery sink, full hooks, and one DM.
describe("makeResumeSinks", () => {
	function sinks() {
		const sent: { chat: number; text: string }[] = [];
		const bellSink = new RecordingSink();
		const deliverySink = new RecordingSink();
		const deps = makeResumeSinks({
			wake: { bell: () => bellSink, delivery: () => deliverySink },
			operators: () => [7, 9],
			sendDm: async (chat, text) => {
				sent.push({ chat, text });
			},
		});
		return { sent, bellSink, deliverySink, deps };
	}

	test("a telegram lane takes the delivery sink, full hooks, and the DM", async () => {
		const store = openStore(tmpDb("goblin-rs-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const { sent, deliverySink, deps } = sinks();
		expect(deps.sinkFor(conv)).toBe(deliverySink);
		expect(deps.sinkHooks(conv)).toEqual({ voice: true, recording: true, file: true });
		deps.notifyDone?.(conv, "run-abcdef123456", { kind: "completed" });
		await waitUntil(() => sent.length === 2, "operator DMs");
		expect(sent.map((s) => s.chat)).toEqual([7, 9]);
		expect(sent[0]!.text).toContain("resumed turn run-abcd");
		expect(sent[0]!.text).toContain("completed");
		store.close();
	});

	test("an app lane takes the bell, no hooks, and no DM — the bell is the notice", async () => {
		const store = openStore(tmpDb("goblin-rs-"));
		const conv = store.resolve({ kind: "app", appId: "chat-01", chatId: 0, threadId: 0 }, "/w");
		const { sent, bellSink, deps } = sinks();
		expect(deps.sinkFor(conv)).toBe(bellSink);
		expect(deps.sinkHooks(conv)).toEqual({ voice: false, recording: false, file: false });
		deps.notifyDone?.(conv, "run-abcdef123456", { kind: "completed" });
		await Bun.sleep(20);
		expect(sent).toHaveLength(0);
		store.close();
	});

	test("a failed operator DM degrades to a warn, never a throw", async () => {
		const store = openStore(tmpDb("goblin-rs-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const deps = makeResumeSinks({
			wake: { bell: () => new RecordingSink(), delivery: () => new RecordingSink() },
			operators: () => [7],
			sendDm: () => Promise.reject(new Error("telegram down")),
		});
		// Fire-and-forget by contract — the send's rejection rides its own catch.
		deps.notifyDone?.(conv, "run-abcdef123456", { kind: "error", message: "boom" });
		await Bun.sleep(20);
		store.close();
	});

	test("a disabled telegram lane has no sink or hooks and notices skip without sending", async () => {
		const store = openStore(tmpDb("goblin-rs-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const sent: number[] = [];
		const deps = makeResumeSinks({
			wake: { bell: () => new RecordingSink() },
			operators: () => [7],
		});
		expect(deps.sinkFor(conv)).toBeNull();
		expect(deps.sinkHooks(conv)).toEqual({ voice: false, recording: false, file: false });
		deps.notifyDone?.(conv, "run-abcdef123456", { kind: "completed" });
		await Bun.sleep(20);
		expect(sent).toEqual([]);
		store.close();
	});
});

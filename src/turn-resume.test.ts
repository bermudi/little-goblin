// "Interrupted" runs are fixture-stamped the way openTurnJournal's
// reclassify leaves them; assertions ride the real fence/admission path.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APICallError } from "@ai-sdk/provider";
import type { LanguageModel, UIMessage } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { openStore, type Conversation, type ConversationStore } from "./conversation.ts";
import { appMediaSink, composeTurnSinks } from "./app-media.ts";
import { makeTools as realMakeTools } from "./agent/tools/mod.ts";
import { withScript } from "./agent/tools/script.ts";
import { setLogFile } from "./log.ts";
import { Runtime, type RuntimeDeps, type TurnDone, type TurnSink, userMessage } from "./runtime.ts";
import { SKILL_PART } from "./skill-part.ts";
import { makeDeliverySink } from "./tg/delivery.ts";
import { fakeApi } from "./testkit/fake-api.ts";
import {
	finishPart,
	scriptedModel,
	textParts,
	toolCallPart,
	type StreamAttempt,
} from "./testkit/fake-model.ts";
import {
	deferred,
	pauseFakeModelAtDelta,
	RecordingSink,
	tmpDb,
	tmpDir,
	useHome,
	waitUntil,
} from "./testkit.ts";
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
	sinkFor?: (conv: Conversation) => TurnSink | null;
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
	const sinksBuilt = { count: 0 };
	const ops = makeResumeOps({
		store,
		journal,
		runtime,
		captureConversation: (c) => c,
		makeTools,
		sinkFor: (conv) => {
			if (opts.sinkFor !== undefined) return opts.sinkFor(conv);
			sinksBuilt.count++;
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
		sinksBuilt,
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
		sourceInputSeq?: number | null;
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
		...(opts.sourceInputSeq !== undefined ? { sourceInputSeq: opts.sourceInputSeq } : {}),
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
			"n1",
			"n2",
			"n3",
			"run-src:c-amb",
			"run-src:c-done",
			"run-src:c-plan",
		]);
		// 'dispatched' stays un-inherited — ambiguity remains owned by the
		// row that ran.
		expect(newCalls.find((c) => c.toolCallId === "run-src:c-done")!.state).toBe("completed");
		const granted = newCalls.find((c) => c.toolCallId === "run-src:c-amb")!;
		expect(granted.state).toBe("resolved-retry");
		expect(granted.retryConsumed).toBe(true);
		expect(newCalls.find((c) => c.toolCallId === "run-src:c-plan")!.state).toBe("planned");
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
		const refusedOut = ops.resume(conv2.id, "run-unclaimed");
		expect(refusedOut).toMatchObject({
			kind: "refused",
			code: "conflict",
		});
		if (refusedOut.kind === "refused") {
			// The unclaimed steer arrived while the turn ran — the refusal
			// names the anchor boundary, not "after the interruption".
			expect(refusedOut.reason).toContain("after this run's anchor");
			expect(refusedOut.reason).not.toContain("after the interruption");
		}
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
		// Only the request follows; no folded steering exists to claim.
		expect(JSON.stringify(resumeEvent.message.parts)).toContain(
			"[operator resumed interrupted run run-dead; original request follows]",
		);
		expect(JSON.stringify(resumeEvent.message.parts)).not.toContain("consumed steering");
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

	test("a resume that revives the trigger and folded steering names both", async () => {
		const { store, conv, journal, ops, runtime, edge, sink } = setup({});
		const trigger = appendUserMsg(store, conv, "ORIGINAL-ASK");
		const steered = appendUserMsg(store, conv, "STEERED-INPUT");
		interruptedRun(store, journal, conv, "run-both", {
			anchorSeq: trigger.seq,
			ownedInputSeqs: [trigger.seq, steered.seq],
		});
		// Fold the trigger and its steer — neither is in the model view, so
		// the resume carries both and the prefix says exactly that.
		store.setCompaction(conv.id, {
			boundarySeq: steered.seq,
			summary: "everything folded",
			tokensBefore: 1,
			model: "m",
			createdAt: new Date().toISOString(),
		});
		expect(ops.resume(conv.id, "run-both").kind).toBe("resumed");
		expect(await sink()!.done).toEqual({ kind: "completed" });
		const detail = store.historyDetail(conv.id);
		const resumeEvent = detail.find(
			(e) =>
				e.message.role === "user" &&
				e.message.id !== trigger.message.id &&
				e.message.id !== steered.message.id,
		)!;
		const parts = JSON.stringify(resumeEvent.message.parts);
		expect(parts).toContain(
			"[operator resumed interrupted run run-both; original request and consumed steering follow]",
		);
		expect(parts).toContain("ORIGINAL-ASK");
		expect(parts).toContain("STEERED-INPUT");
		const prompt = JSON.stringify(edge.streamCalls[0]!.prompt);
		expect(prompt.split("ORIGINAL-ASK").length - 1).toBe(1);
		expect(prompt.split("STEERED-INPUT").length - 1).toBe(1);
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

	test("a malformed resume-request registry refuses readable, never as foreign input", async () => {
		const { store, conv, journal, ops, runtime } = setup({});
		const a = appendUser(store, conv, "original ask");
		interruptedRun(store, journal, conv, "run-src", {
			anchorSeq: a,
			ownedInputSeqs: [a],
		});
		// A prior resume's generated request event — the registration is
		// what corrupts below; without the unreadable flag the scan reads
		// it as foreign input and misreports a "conflict".
		store.append(conv.id, [
			{
				...userMessage([{ type: "text", text: "[operator resumed interrupted run run-src]" }]),
				metadata: { goblinResume: { sourceRunId: "run-src" } },
			},
		]);
		store.db.run("UPDATE turn_runs SET resume_request_seqs = ? WHERE run_id = ?", [
			"{not json",
			"run-src",
		]);
		const out = ops.resume(conv.id, "run-src");
		expect(out).toMatchObject({ kind: "refused", code: "invalid" });
		if (out.kind === "refused") {
			expect(out.reason).toContain("resume-request registry is unreadable");
		}
		expect(journal.get("run-src")!.status).toBe("interrupted");
		await runtime.shutdown();
		store.close();
	});

	test("an anchorless run holding foreign history refuses without blaming post-interruption input", async () => {
		const { store, conv, journal, ops, runtime } = setup({});
		appendUser(store, conv, "old ask");
		interruptedRun(store, journal, conv, "run-anchorless", { ownedInputSeqs: [] });
		const out = ops.resume(conv.id, "run-anchorless");
		expect(out).toMatchObject({ kind: "refused", code: "conflict" });
		if (out.kind === "refused") {
			expect(out.reason).toContain("recorded no anchor");
			expect(out.reason).not.toContain("after the interruption");
		}
		await runtime.shutdown();
		store.close();
	});

	test("a trigger still in the model view is not re-copied into the resume event", async () => {
		const { store, conv, journal, ops, runtime, edge, sink } = setup({});
		const trigger = appendUserMsg(store, conv, "ORIGINAL-ASK");
		interruptedRun(store, journal, conv, "run-live", {
			anchorSeq: trigger.seq,
			ownedInputSeqs: [trigger.seq],
		});
		expect(ops.resume(conv.id, "run-live").kind).toBe("resumed");
		expect(await sink()!.done).toEqual({ kind: "completed" });
		const detail = store.historyDetail(conv.id);
		const resumeEvent = detail.find(
			(e) => e.message.role === "user" && e.message.id !== trigger.message.id,
		)!;
		// The original request rides its own still-visible event — the
		// resume carries the provenance prefix only, so the model and the
		// retention document see the text once.
		expect(JSON.stringify(resumeEvent.message.parts)).not.toContain("ORIGINAL-ASK");
		expect(JSON.stringify(resumeEvent.message.parts)).toContain(
			"[operator resumed interrupted run run-live]",
		);
		expect(JSON.stringify(resumeEvent.message.parts)).not.toContain("follow");
		const prompt = JSON.stringify(edge.streamCalls[0]!.prompt);
		expect(prompt.split("ORIGINAL-ASK").length - 1).toBe(1);
		const reply = detail.at(-1)!;
		expect(reply.anchorSeq).toBe(resumeEvent.seq);
		await runtime.shutdown();
		store.close();
	});

	const useSkill = (home: string, name: string, body: string) => {
		mkdirSync(join(home, "workspace", "skills", name), { recursive: true });
		writeFileSync(join(home, "workspace", "skills", name, "SKILL.md"), body);
	};
	const DEMO_SKILL =
		"---\nname: demo\ndescription: Resume regression fixture\n---\nResume regression instruction.\n";
	const resumeEventOf = (store: ConversationStore, convId: string, runId: string) =>
		store
			.historyDetail(convId)
			.find(
				(e) =>
					(e.message.metadata as { goblinResume?: { sourceRunId?: string } } | undefined)
						?.goblinResume?.sourceRunId === runId,
			)!;
	const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

	test("a still-visible skill anchor re-attaches its ref — the resumed turn injects the body once", async () => {
		const home = useHome("goblin-trskill-");
		useSkill(home, "demo", DEMO_SKILL);
		useSkill(
			home,
			"other",
			"---\nname: other\ndescription: unrelated fixture\n---\nUNRELATED-INSTRUCTION.\n",
		);
		const { store, conv, journal, ops, runtime, edge, sink } = setup({});
		// A historical invocation of a different skill — durable, visible,
		// owned by no live run: marker only, never a body.
		store.append(conv.id, [
			userMessage([
				{ type: "text", text: "older ask" },
				{ type: SKILL_PART, data: { name: "other" } } as UIMessage["parts"][number],
			]),
		]);
		const trigger = userMessage([
			{ type: "text", text: "ORIGINAL-ASK" },
			{ type: SKILL_PART, data: { name: "demo" } } as UIMessage["parts"][number],
		]);
		store.append(conv.id, [trigger]);
		const anchorSeq = store.lastUserSeq(conv.id)!;
		interruptedRun(store, journal, conv, "run-skill", {
			anchorSeq,
			ownedInputSeqs: [anchorSeq],
		});
		expect(ops.resume(conv.id, "run-skill").kind).toBe("resumed");
		expect(await sink()!.done).toEqual({ kind: "completed" });
		const resumeEvent = resumeEventOf(store, conv.id, "run-skill");
		const parts = JSON.stringify(resumeEvent.message.parts);
		// The invocation reference re-rides the new event — the body was
		// never durable, so only the new owning turn can inject it — but
		// the still-visible request text is NOT copied, and the prefix
		// does not claim it follows.
		expect(parts).toContain('"type":"data-skill"');
		expect(parts).toContain('"name":"demo"');
		expect(parts).not.toContain("ORIGINAL-ASK");
		expect(parts).toContain("[operator resumed interrupted run run-skill]");
		expect(parts).not.toContain("original request follows");
		const prompt = JSON.stringify(edge.streamCalls[0]!.prompt);
		expect(count(prompt, "ORIGINAL-ASK")).toBe(1);
		expect(count(prompt, "Resume regression instruction.")).toBe(1);
		expect(count(prompt, "explicitly invoked skill")).toBe(1);
		// The unrelated historical invocation stays a bare marker.
		expect(count(prompt, "UNRELATED-INSTRUCTION")).toBe(0);
		expect(count(prompt, "[skill: other]")).toBe(1);
		await runtime.shutdown();
		store.close();
	});

	test("a still-visible consumed skill steer re-attaches its ref — steering text rides its own event", async () => {
		useSkill(useHome("goblin-trskill-"), "demo", DEMO_SKILL);
		const { store, conv, journal, ops, runtime, edge, sink } = setup({});
		const trigger = appendUserMsg(store, conv, "ORIGINAL-ASK");
		const steer = userMessage([
			{ type: "text", text: "STEERED-TEXT" },
			{ type: SKILL_PART, data: { name: "demo" } } as UIMessage["parts"][number],
		]);
		store.append(conv.id, [steer]);
		const steerSeq = store.lastUserSeq(conv.id)!;
		interruptedRun(store, journal, conv, "run-steer-skill", {
			anchorSeq: trigger.seq,
			ownedInputSeqs: [trigger.seq, steerSeq],
		});
		expect(ops.resume(conv.id, "run-steer-skill").kind).toBe("resumed");
		expect(await sink()!.done).toEqual({ kind: "completed" });
		const resumeEvent = resumeEventOf(store, conv.id, "run-steer-skill");
		const parts = JSON.stringify(resumeEvent.message.parts);
		expect(parts).toContain('"type":"data-skill"');
		expect(parts).not.toContain("STEERED-TEXT");
		expect(parts).not.toContain("ORIGINAL-ASK");
		expect(parts).not.toContain("original request follows");
		expect(parts).not.toContain("consumed steering follows");
		expect(parts).toContain("[operator resumed interrupted run run-steer-skill]");
		const prompt = JSON.stringify(edge.streamCalls[0]!.prompt);
		expect(count(prompt, "ORIGINAL-ASK")).toBe(1);
		expect(count(prompt, "STEERED-TEXT")).toBe(1);
		expect(count(prompt, "Resume regression instruction.")).toBe(1);
		await runtime.shutdown();
		store.close();
	});

	test("a pre-anchor coalesced owned invocation re-attaches its ref — ordinary content stays with its event", async () => {
		const home = useHome("goblin-trskill-");
		useSkill(home, "demo", DEMO_SKILL);
		useSkill(
			home,
			"other",
			"---\nname: other\ndescription: unrelated fixture\n---\nUNRELATED-INSTRUCTION.\n",
		);
		const { store, conv, journal, ops, runtime, edge, sink } = setup({});
		store.append(conv.id, [
			userMessage([
				{ type: "text", text: "older ask" },
				{ type: SKILL_PART, data: { name: "other" } } as UIMessage["parts"][number],
			]),
		]);
		const first = userMessage([
			{ type: "text", text: "FIRST-COALESCED-TEXT" },
			{ type: SKILL_PART, data: { name: "demo" } } as UIMessage["parts"][number],
		]);
		store.append(conv.id, [first]);
		const firstSeq = store.lastUserSeq(conv.id)!;
		const anchor = appendUserMsg(store, conv, "LAST-COALESCED-TEXT");
		interruptedRun(store, journal, conv, "run-coal", {
			anchorSeq: anchor.seq,
			ownedInputSeqs: [firstSeq, anchor.seq],
		});
		expect(ops.resume(conv.id, "run-coal").kind).toBe("resumed");
		expect(await sink()!.done).toEqual({ kind: "completed" });
		const resumeEvent = resumeEventOf(store, conv.id, "run-coal");
		const parts = JSON.stringify(resumeEvent.message.parts);
		expect(parts).toContain('"type":"data-skill"');
		expect(parts).toContain('"name":"demo"');
		expect(parts).not.toContain("FIRST-COALESCED-TEXT");
		expect(parts).not.toContain("LAST-COALESCED-TEXT");
		expect(parts).toContain("[operator resumed interrupted run run-coal]");
		expect(parts).not.toContain("follows");
		const prompt = JSON.stringify(edge.streamCalls[0]!.prompt);
		expect(count(prompt, "FIRST-COALESCED-TEXT")).toBe(1);
		expect(count(prompt, "LAST-COALESCED-TEXT")).toBe(1);
		expect(count(prompt, "Resume regression instruction.")).toBe(1);
		expect(count(prompt, "UNRELATED-INSTRUCTION")).toBe(0);
		expect(count(prompt, "[skill: other]")).toBe(1);
		await runtime.shutdown();
		store.close();
	});

	test("a compacted skill invocation revives verbatim — ref and request together", async () => {
		useSkill(useHome("goblin-trskill-"), "demo", DEMO_SKILL);
		const { store, conv, journal, ops, runtime, edge, sink } = setup({});
		const trigger = userMessage([
			{ type: "text", text: "ORIGINAL-ASK" },
			{ type: SKILL_PART, data: { name: "demo" } } as UIMessage["parts"][number],
		]);
		store.append(conv.id, [trigger]);
		const anchorSeq = store.lastUserSeq(conv.id)!;
		interruptedRun(store, journal, conv, "run-folded-skill", {
			anchorSeq,
			ownedInputSeqs: [anchorSeq],
		});
		store.setCompaction(conv.id, {
			boundarySeq: anchorSeq,
			summary: "folded past",
			tokensBefore: 1,
			model: "m",
			createdAt: new Date().toISOString(),
		});
		expect(ops.resume(conv.id, "run-folded-skill").kind).toBe("resumed");
		expect(await sink()!.done).toEqual({ kind: "completed" });
		const resumeEvent = resumeEventOf(store, conv.id, "run-folded-skill");
		const parts = JSON.stringify(resumeEvent.message.parts);
		// Folded out of the view entirely — every part revives, invocation
		// ref included, and the prefix names the request.
		expect(parts).toContain("ORIGINAL-ASK");
		expect(parts).toContain('"type":"data-skill"');
		expect(parts).toContain("original request follows");
		const prompt = JSON.stringify(edge.streamCalls[0]!.prompt);
		expect(count(prompt, "ORIGINAL-ASK")).toBe(1);
		expect(count(prompt, "Resume regression instruction.")).toBe(1);
		await runtime.shutdown();
		store.close();
	});

	test("resume refuses while a compaction is in flight — the view it measured can still move", async () => {
		const started = deferred();
		const gate = deferred<string>();
		const { store, conv, journal, ops, runtime, edge, sink } = setup({
			compaction: {
				modelRef: () => "m",
				contextWindow: () => 1000,
				summarize: () => {
					started.resolve();
					return gate.promise;
				},
			},
		});
		seedExchanges(store, conv.id);
		const trigger = appendUserMsg(store, conv, "original ask");
		const steered = appendUserMsg(store, conv, "steered while running");
		interruptedRun(store, journal, conv, "run-dead", {
			anchorSeq: trigger.seq,
			ownedInputSeqs: [trigger.seq, steered.seq],
		});
		// Tail-sized assistant events after the owned input push the anchor
		// and the steer below the coming boundary once the summary lands.
		for (const id of ["f1", "f2"]) {
			store.append(conv.id, [
				{ id, role: "assistant", parts: [{ type: "text", text: "y".repeat(600) }] },
			]);
		}
		const compacted = runtime.compact(conv);
		await started.promise; // the summarizer holds the lane mid-flight
		const inFlight = ops.resume(conv.id, "run-dead");
		// Admitted now, the queued resume would run after the commit — its
		// still-visible anchor would never reach the model at all.
		expect(inFlight).toMatchObject({ kind: "refused", code: "conflict" });
		expect(edge.streamCalls).toHaveLength(0);
		expect(journal.get("run-dead")!.status).toBe("interrupted");

		gate.resolve("the folded era");
		expect((await compacted).kind).toBe("compacted");
		await waitUntil(() => !runtime.busy(conv.id), "lane drains");
		// After the commit the same resume measures the moved view — both
		// folded inputs revive into the generated event instead of being
		// silently dropped.
		expect(store.modelEntries(conv.id).some((e) => e.message.id === trigger.message.id)).toBe(
			false,
		);
		expect(store.modelEntries(conv.id).some((e) => e.message.id === steered.message.id)).toBe(
			false,
		);
		expect(ops.resume(conv.id, "run-dead").kind).toBe("resumed");
		expect(await sink()!.done).toEqual({ kind: "completed" });
		const detail = store.historyDetail(conv.id);
		// The seeded exchanges are user events too — the generated event is
		// the one registered provenance names.
		const resumeEvent = detail.find(
			(e) =>
				e.message.role === "user" &&
				(e.message.metadata as { goblinResume?: { sourceRunId?: string } } | undefined)
					?.goblinResume?.sourceRunId === "run-dead",
		)!;
		const parts = JSON.stringify(resumeEvent.message.parts);
		expect(parts).toContain(
			"[operator resumed interrupted run run-dead; original request and consumed steering follow]",
		);
		expect(parts).toContain("original ask");
		expect(parts).toContain("steered while running");
		const prompt = JSON.stringify(edge.streamCalls[0]!.prompt);
		expect(prompt.split("original ask").length - 1).toBe(1);
		expect(prompt.split("steered while running").length - 1).toBe(1);
		await runtime.shutdown();
		store.close();
	});

	test("the resumed turn's watchdog judges the run's original request, not the marker", async () => {
		const { store, conv, journal, ops, runtime, sink } = setup({
			attempts: [
				[toolCallPart("n1", "probe", '{"q":1}'), finishPart("tool-calls")],
				textParts("done"),
			],
		});
		const seen: string[] = [];
		runtime.setLoopWatchdog({
			every: 1,
			decide: async (state) => {
				seen.push((state as { operatorRequest: string }).operatorRequest);
				return { answers: { stuck: 0 }, inputTokens: 0, cost: 0 };
			},
		});
		const anchorSeq = appendUser(store, conv, "Find the cause of the billing discrepancy");
		interruptedRun(store, journal, conv, "run-src", {
			anchorSeq,
			ownedInputSeqs: [anchorSeq],
		});
		// The anchor stays visible, so the generated head is the marker
		// alone — the watchdog's task text must still be the real request.
		expect(ops.resume(conv.id, "run-src").kind).toBe("resumed");
		expect(await sink()!.done).toEqual({ kind: "completed" });
		await waitUntil(() => seen.length > 0, "watchdog check fired");
		expect(seen[0]).toBe("Find the cause of the billing discrepancy");
		await runtime.shutdown();
		store.close();
	});

	test("a registry write that lands zero rows rolls the event append back", async () => {
		const { store, conv, journal, ops, runtime } = setup({});
		const a = appendUser(store, conv, "original ask");
		interruptedRun(store, journal, conv, "run-silent", {
			anchorSeq: a,
			ownedInputSeqs: [a],
		});
		// The guarded UPDATE silently skips — changes === 0 — the way a
		// status flip between the check and the write would surface.
		store.db.run(
			"CREATE TRIGGER skip_resume_req BEFORE UPDATE OF resume_request_seqs ON turn_runs " +
				"BEGIN SELECT RAISE(IGNORE); END",
		);
		const before = store.historyDetail(conv.id).length;
		const out = ops.resume(conv.id, "run-silent");
		expect(out).toMatchObject({ kind: "refused", code: "unavailable" });
		// The append rode the same transaction — nothing half-landed.
		expect(store.historyDetail(conv.id).length).toBe(before);
		expect(journal.get("run-silent")!.resumeRequestSeqs).toBeNull();
		expect(journal.get("run-silent")!.status).toBe("interrupted");
		await runtime.shutdown();
		store.close();
	});

	test("noteResumeRequest refuses a seq that is not a durable event seq", async () => {
		const { store, conv, journal, runtime } = setup({});
		const a = appendUser(store, conv, "ask");
		interruptedRun(store, journal, conv, "run-seq", { anchorSeq: a });
		expect(() => journal.noteResumeRequest("run-seq", 0)).toThrow("not a durable event seq");
		expect(journal.get("run-seq")!.resumeRequestSeqs).toBeNull();
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
		expect(calls.find((c) => c.toolCallId === "run-src:c-done")!.retryConsumed).toBe(true);
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
		expect(calls.find((c) => c.toolCallId === "run-src:g-amb")!.retryConsumed).toBe(true);
		expect(calls.find((c) => c.toolCallId === "run-src:g-known")!.retryConsumed).toBe(true);
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
		journal.noteToolDispatch("run-r1", "n1", "probe", { q: 1 }, { retryCallId: "run-src:c-grant" });
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
		expect(calls.find((c) => c.toolCallId === "run-src:c-grant")!.retryConsumed).toBe(true);
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
		expect(continuation.find((c) => c.toolCallId === "run-src:c-grant")!.retryConsumed).toBe(
			true,
		);
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

	test("a missing lane still builds no successor and executes nothing", async () => {
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
			// An empty recorded surface passes the check — the lane probe is
			// the refusal under test, not a missing tool.
			toolNames: [],
		});
		expect(ops.resume(conv.id, "run-dead")).toEqual({
			kind: "refused",
			code: "unavailable",
			reason: "telegram channel is unavailable — the interrupted turn cannot resume",
		});
		// The surface check runs before the lane probe — one validation
		// build, never an execution, submission, or successor run.
		expect(toolBuilds).toBe(1);
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

	// Every pre-admission refusal must leave sinkFor uncalled — a real
	// delivery sink starts its typing interval at construction, so
	// building one on a refusal path leaks live Telegram API traffic.
	for (const c of [
		{
			name: "undecided calls return needs-decisions",
			run: (h: ReturnType<typeof setup>) => {
				interruptedRun(h.store, h.journal, h.conv, "run-dead");
				h.journal.noteToolInput("run-dead", "c1", "probe", { q: 1 });
				h.journal.noteToolDispatch("run-dead", "c1", "probe", { q: 1 });
				return h.ops.resume(h.conv.id, "run-dead");
			},
		},
		{
			name: "settings drift refuses",
			run: (h: ReturnType<typeof setup>) => {
				interruptedRun(h.store, h.journal, h.conv, "run-dead", {
					anchorSeq: appendUser(h.store, h.conv, "go"),
					snapshot: { model: "old/provider", thinking: "low" },
				});
				return h.ops.resume(h.conv.id, "run-dead");
			},
		},
		{
			name: "a shrunk tool surface refuses",
			run: (h: ReturnType<typeof setup>) => {
				interruptedRun(h.store, h.journal, h.conv, "run-dead", {
					anchorSeq: appendUser(h.store, h.conv, "go"),
					toolNames: ["probe", "retired-tool"],
				});
				return h.ops.resume(h.conv.id, "run-dead");
			},
		},
		{
			name: "an unreadable tool surface refuses",
			run: (h: ReturnType<typeof setup>) => {
				interruptedRun(h.store, h.journal, h.conv, "run-dead", {
					anchorSeq: appendUser(h.store, h.conv, "go"),
				});
				h.store.db.run("UPDATE turn_runs SET tool_names = ? WHERE run_id = ?", [
					"{not json",
					"run-dead",
				]);
				return h.ops.resume(h.conv.id, "run-dead");
			},
		},
		{
			name: "an unreadable loop checkpoint refuses",
			run: (h: ReturnType<typeof setup>) => {
				interruptedRun(h.store, h.journal, h.conv, "run-dead", {
					anchorSeq: appendUser(h.store, h.conv, "go"),
				});
				h.store.db.run("UPDATE turn_runs SET loop_state = ? WHERE run_id = ?", [
					"[bad",
					"run-dead",
				]);
				return h.ops.resume(h.conv.id, "run-dead");
			},
		},
		{
			name: "foreign post-anchor input refuses",
			run: (h: ReturnType<typeof setup>) => {
				const anchorSeq = appendUser(h.store, h.conv, "original ask");
				interruptedRun(h.store, h.journal, h.conv, "run-dead", { anchorSeq });
				appendUser(h.store, h.conv, "unrelated follow-up");
				return h.ops.resume(h.conv.id, "run-dead");
			},
		},
		{
			name: "nothing to resume refuses",
			run: (h: ReturnType<typeof setup>) => {
				interruptedRun(h.store, h.journal, h.conv, "run-dead");
				return h.ops.resume(h.conv.id, "run-dead");
			},
		},
	]) {
		test(`refused resume builds no delivery sink — ${c.name}`, async () => {
			const h = setup({});
			const out = await c.run(h);
			expect(out.kind).not.toBe("resumed");
			expect(h.sinksBuilt.count).toBe(0);
			expect(h.edge.streamCalls).toEqual([]);
			expect(h.journal.get("run-dead")!.status).toBe("interrupted");
			await h.runtime.shutdown();
			h.store.close();
		});
	}

	test("a busy lane's refusal also builds no delivery sink", async () => {
		const gated = pauseFakeModelAtDelta(["parked", "tail"], 0);
		const h = setup({ model: gated.model });
		interruptedRun(h.store, h.journal, h.conv, "run-dead", {
			anchorSeq: appendUser(h.store, h.conv, "go"),
		});
		const blocker = new RecordingSink();
		h.runtime.submit(h.conv, userMessage([{ type: "text", text: "hold the lane" }]), blocker);
		await gated.entered;
		expect(h.ops.resume(h.conv.id, "run-dead")).toMatchObject({
			kind: "refused",
			code: "conflict",
		});
		expect(h.sinksBuilt.count).toBe(0);
		gated.release();
		expect(await blocker.done).toEqual({ kind: "completed" });
		await h.runtime.shutdown();
		h.store.close();
	});

	test("repeated refused resumes never tick a real delivery sink", async () => {
		const { api, calls } = fakeApi();
		const h = setup({
			sinkFor: (conv) => makeDeliverySink(api, conv, { typingIntervalMs: 5 }),
		});
		// needs-decisions twice — the early return never reaches sinkFor.
		interruptedRun(h.store, h.journal, h.conv, "run-dead");
		h.journal.noteToolInput("run-dead", "c1", "probe", { q: 1 });
		h.journal.noteToolDispatch("run-dead", "c1", "probe", { q: 1 });
		expect(h.ops.resume(h.conv.id, "run-dead").kind).toBe("needs-decisions");
		expect(h.ops.resume(h.conv.id, "run-dead").kind).toBe("needs-decisions");
		// …nor does a later-settings refusal.
		interruptedRun(h.store, h.journal, h.conv, "run-drift", {
			anchorSeq: appendUser(h.store, h.conv, "go"),
			snapshot: { model: "other/m", thinking: "low" },
		});
		expect(h.ops.resume(h.conv.id, "run-drift").kind).toBe("refused");
		await Bun.sleep(30);
		expect(calls.filter((c) => c.method === "sendChatAction")).toEqual([]);
		await h.runtime.shutdown();
		h.store.close();
	});

	test("a resume dying at admission fences the just-built sink and stays resumable", async () => {
		const { api, calls } = fakeApi();
		let explode = true;
		const h = setup({
			attempts: [textParts("resumed answer")],
			sinkFor: (conv) => makeDeliverySink(api, conv, { typingIntervalMs: 5 }),
			wrapJournal: (real) => ({
				...real,
				noteResumeRequest(runId, eventSeq) {
					if (explode) throw new Error("journal append exploded");
					return real.noteResumeRequest(runId, eventSeq);
				},
			}),
		});
		interruptedRun(h.store, h.journal, h.conv, "run-dead", {
			anchorSeq: appendUser(h.store, h.conv, "go"),
		});
		const out = h.ops.resume(h.conv.id, "run-dead");
		expect(out).toMatchObject({ kind: "refused", code: "unavailable" });
		if (out.kind === "refused") {
			expect(out.reason).toContain("journal append exploded");
		}
		// The orphaned sink was fenced at the throw — typing stops and
		// stays stopped; the source row was never consumed.
		const ticks = calls.filter((c) => c.method === "sendChatAction").length;
		await Bun.sleep(30);
		expect(calls.filter((c) => c.method === "sendChatAction")).toHaveLength(ticks);
		expect(h.journal.get("run-dead")!.status).toBe("interrupted");
		// The claim released with the refusal — a repaired journal resumes.
		explode = false;
		expect(h.ops.resume(h.conv.id, "run-dead").kind).toBe("resumed");
		await waitUntil(() => h.journal.get("run-dead")!.status === "resumed", "source consumed");
		await h.runtime.shutdown();
		h.store.close();
	});

	test("an app-lane resume assembles the real media surface — send_file and speak land durably", async () => {
		const home = useHome("goblin-appresume-");
		const cwd = tmpDir("goblin-appresume-cwd-");
		writeFileSync(join(cwd, "note.txt"), "attachment body\n");
		const store = openStore(tmpDb("goblin-rs-app-"));
		const conv = store.resolve({ kind: "app", appId: "chat-01", chatId: 0, threadId: 0 }, "/w");
		const journal = openTurnJournal(store.db);
		const edge = scriptedModel([
			[
				toolCallPart("n1", "send_file", JSON.stringify({ path: "note.txt", caption: "the note" })),
				toolCallPart("n2", "speak", JSON.stringify({ text: "voice hello" })),
				finishPart("tool-calls"),
			],
			textParts("both sent"),
		]);
		// The real tool factory, keyed on the same hook arguments the
		// resume path and the admitted attempt hand it — the fourth
		// (deliverFile) argument is what mounts send_file.
		const synthesized: string[] = [];
		const tools: RuntimeDeps["makeTools"] = (_conv, voice, recording, file) =>
			realMakeTools({
				cwd,
				...(voice !== undefined
					? {
							voice: {
								synthesize: async (text: string) => {
									synthesized.push(text);
									return [new Uint8Array([1, 2, 3])];
								},
								deliver: voice,
								...(recording !== undefined ? { recording } : {}),
							},
						}
					: {}),
				...(file !== undefined ? { file: { deliver: file } } : {}),
			});
		const runtime = new Runtime({
			store,
			turnJournal: journal,
			buildStep: () => ({ model: edge.model, system: "test" }),
			makeTools: tools,
		});
		const sinks = makeResumeSinks({
			wake: {
				bell: (c) =>
					composeTurnSinks(appMediaSink(c.id, { append: (msgs) => store.append(c.id, msgs, {}) })),
			},
			operators: () => [],
		});
		const ops = makeResumeOps({
			store,
			journal,
			runtime,
			captureConversation: (c) => c,
			makeTools: tools,
			sinkFor: sinks.sinkFor,
			sinkHooks: sinks.sinkHooks,
			...(sinks.notifyDone !== undefined ? { notifyDone: sinks.notifyDone } : {}),
		});
		const anchorSeq = appendUser(store, conv, "send me the note and say hi");
		interruptedRun(store, journal, conv, "run-dead", {
			anchorSeq,
			// The recorded surface is what the mounted lane actually offers.
			toolNames: Object.keys(
				tools(
					conv,
					async () => {},
					undefined,
					async () => {},
				),
			),
		});
		expect(
			Object.keys(
				tools(
					conv,
					async () => {},
					undefined,
					async () => {},
				),
			),
		).toContain("send_file");
		expect(ops.resume(conv.id, "run-dead").kind).toBe("resumed");
		await waitUntil(() => !runtime.busy(conv.id), "resumed turn drains");
		await runtime.shutdown();

		// Both deliveries are durable: an assistant attachment message per
		// file, and persisted bytes under the home's attachment store.
		const attachments = store
			.historyDetail(conv.id)
			.flatMap((e) => e.message.parts)
			.filter((p) => p.type === "data-attachment")
			.map((p) => (p as { data: { path: string; filename: string } }).data);
		expect(attachments.map((a) => a.filename)).toContain("note.txt");
		expect(attachments.map((a) => a.filename)).toContain("voice-note.ogg");
		for (const a of attachments) {
			expect(a.path.startsWith(join(home, "workspace", "attachments"))).toBe(true);
			expect(existsSync(a.path)).toBe(true);
		}
		// The bytes themselves: the copied file is the source verbatim,
		// the voice note is exactly the synthesized audio.
		const note = attachments.find((a) => a.filename === "note.txt")!;
		expect(readFileSync(note.path, "utf8")).toBe("attachment body\n");
		const voice = attachments.find((a) => a.filename === "voice-note.ogg")!;
		expect(new Uint8Array(readFileSync(voice.path))).toEqual(new Uint8Array([1, 2, 3]));
		expect(synthesized).toEqual(["voice hello"]);
		expect(journal.get("run-dead")!.status).toBe("resumed");
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

describe("resume durable source identity", () => {
	test("a resume keeps the source run's identity across generated markers, twice", async () => {
		const { store, conv, journal, ops, runtime } = setup({});
		const anchorSeq = appendUser(store, conv, "run the tool");
		interruptedRun(store, journal, conv, "run-dead", {
			anchorSeq,
			sourceInputSeq: anchorSeq,
		});
		expect(ops.resume(conv.id, "run-dead").kind).toBe("resumed");
		await waitUntil(() => journal.get("run-dead")!.status === "resumed", "source consumed");
		const second = successorRunId(store, "run-dead");
		expect(journal.get(second)!.sourceInputSeq).toBe(anchorSeq);

		await waitUntil(() => !runtime.busy(conv.id), "lane drains");
		store.db.run("UPDATE turn_runs SET status = 'interrupted' WHERE run_id = ?", [second]);
		expect(ops.resume(conv.id, second).kind).toBe("resumed");
		await waitUntil(() => journal.get(second)!.status === "resumed", "second consumed");
		const third = successorRunId(store, second);
		expect(journal.get(third)!.sourceInputSeq).toBe(anchorSeq);
		await runtime.shutdown();
		store.close();
	});

	test("a steer folded mid-resume moves the source to its own durable seq", async () => {
		const entered = deferred<void>();
		const release = deferred<void>();
		const gate = tool({
			inputSchema: z.object({ q: z.number() }),
			execute: async () => {
				entered.resolve();
				await release.promise;
				return "done";
			},
		}) as unknown as ReturnType<typeof tool>;
		const { store, conv, journal, ops, runtime } = setup({
			attempts: [
				[toolCallPart("g1", "gate", '{"q":1}'), finishPart("tool-calls")],
				textParts("resumed answer"),
			],
			tools: { gate },
		});
		const anchorSeq = appendUser(store, conv, "run it");
		interruptedRun(store, journal, conv, "run-dead", {
			anchorSeq,
			sourceInputSeq: anchorSeq,
		});
		expect(ops.resume(conv.id, "run-dead").kind).toBe("resumed");
		await entered.promise;
		runtime.submit(
			conv,
			userMessage([{ type: "text", text: "new direction" }]),
			new RecordingSink(),
		);
		const steerSeq = store.lastUserSeq(conv.id)!;
		release.resolve();
		await waitUntil(() => !runtime.busy(conv.id), "lane drains");
		expect(steerSeq).not.toBe(anchorSeq);
		expect(journal.get(successorRunId(store, "run-dead"))!.sourceInputSeq).toBe(steerSeq);
		await runtime.shutdown();
		store.close();
	});

	test("a legacy never-resumed run derives its source from the validated anchor", async () => {
		const { store, conv, journal, ops, runtime } = setup({});
		const anchorSeq = appendUser(store, conv, "run it");
		interruptedRun(store, journal, conv, "run-dead", {
			anchorSeq,
			ownedInputSeqs: [anchorSeq],
		});
		expect(ops.resume(conv.id, "run-dead").kind).toBe("resumed");
		await waitUntil(() => journal.get("run-dead")!.status === "resumed", "source consumed");
		expect(journal.get(successorRunId(store, "run-dead"))!.sourceInputSeq).toBe(anchorSeq);
		await runtime.shutdown();
		store.close();
	});

	test("a legacy already-resumed row keeps a null identity rather than inventing one", async () => {
		const { store, conv, journal, ops, runtime } = setup({});
		const anchorSeq = appendUser(store, conv, "original ask");
		interruptedRun(store, journal, conv, "run-src", {
			anchorSeq,
			sourceInputSeq: anchorSeq,
		});
		journal.beginRun({
			runId: "run-legacy",
			conversationId: conv.id,
			epoch: conv.epoch,
			anchorSeq: null,
			steerMark: null,
			convSnapshot: { model: conv.model, thinking: conv.thinking },
			toolNames: ["probe"],
			startedAt: "2026-10-11T00:00:00.000Z",
			resumedFrom: "run-src",
			ownedInputSeqs: [anchorSeq],
		});
		journal.noteToolInput("run-legacy", "c1", "probe", { q: 1 });
		journal.noteToolDispatch("run-legacy", "c1", "probe", { q: 1 });
		journal.noteToolResult("run-legacy", "c1", { out: "landed" });
		store.db.run("UPDATE turn_runs SET status = 'interrupted' WHERE run_id = 'run-legacy'");
		expect(ops.resume(conv.id, "run-legacy").kind).toBe("resumed");
		await waitUntil(() => journal.get("run-legacy")!.status === "resumed", "consumed");
		expect(journal.get(successorRunId(store, "run-legacy"))!.sourceInputSeq).toBeNull();
		await runtime.shutdown();
		store.close();
	});
});

// Per-lane routing the composition root wires: app lanes take the bell
// — appMediaSink carries file and voice-note delivery, so its hooks are
// media-true — and no terminal DM (the bell is already the notice);
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

	test("an app lane takes the bell, the media hooks, and no DM — the bell is the notice", async () => {
		const store = openStore(tmpDb("goblin-rs-"));
		const conv = store.resolve({ kind: "app", appId: "chat-01", chatId: 0, threadId: 0 }, "/w");
		const { sent, bellSink, deps } = sinks();
		expect(deps.sinkFor(conv)).toBe(bellSink);
		// The real app bell composes appMediaSink: file and voice-note are
		// mountable, the recording indicator is telegram-only.
		expect(deps.sinkHooks(conv)).toEqual({ voice: true, recording: false, file: true });
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

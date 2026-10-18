// Turn resume boundary tests (design/runtime-turn.md → Resuming an
// interrupted turn) — the operator surface over a real Runtime +
// journal + scripted model edge. An "interrupted" run is fixture-stamped
// into the journal the way a crash leaves it; every assertion rides the
// same fence/admission path production resumes take.

import { describe, expect, test } from "bun:test";
import type { LanguageModel } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { openStore, type Conversation, type ConversationStore } from "./conversation.ts";
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
import { openTurnJournal, type TurnJournal } from "./turn-journal.ts";
import { makeResumeOps, makeResumeSinks } from "./turn-resume.ts";

setLogFile(null);

function setup(opts: {
	// The resumed attempt's script — the model is faked at the edge.
	attempts?: StreamAttempt[];
	// A model override for the non-resume turn (the busy-lane test).
	model?: LanguageModel;
	// What makeTools registers beyond `probe` — the surface check reads
	// these names against the recorded tool surface.
	tools?: Record<string, ReturnType<typeof tool>>;
	// Journal wrapper — the fault-injection tests break writes on the
	// runtime's own db, not a side store.
	wrapJournal?: (journal: TurnJournal) => TurnJournal;
	// Tool-factory override — the early-failure test throws inside it.
	makeTools?: RuntimeDeps["makeTools"];
	sinkFactory?: () => RecordingSink;
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
		buildStep: () => ({ model: opts.model ?? edge.model, system: "test" }),
		makeTools,
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

// What a crash leaves behind: the run row begun under the dead process,
// its calls journaled to whatever point they reached, status flipped to
// 'interrupted' the way openTurnJournal's reclassify does on a real
// boot — stamped directly so the runtime under test keeps its handle.
function interruptedRun(
	store: ConversationStore,
	journal: TurnJournal,
	conv: Conversation,
	runId: string,
	opts: {
		anchorSeq?: number | null;
		snapshot?: { model: string | null; thinking: string | null };
		toolNames?: string[];
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
	});
	store.db.run("UPDATE turn_runs SET status = 'interrupted' WHERE run_id = ?", [runId]);
}

// The original user message must be durable history for the resume's
// trigger label — append it, then hand the run its seq as the anchor.
function appendUser(store: ConversationStore, conv: Conversation, text: string): number {
	store.append(conv.id, [userMessage([{ type: "text", text }])]);
	const entries = store.modelEntries(conv.id);
	return entries[entries.length - 1]!.seq;
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
		// A decided call takes no second decision.
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
		// A decided ordinal refuses like the id path does.
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

	test("a resumed turn replays recorded results, re-executes retry, runs planned", async () => {
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
		// completed — recorded, replays without executing.
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

		// q:1 replayed — execute never ran it. q:2 retried, q:3 planned.
		expect(executed.map((e) => e.args)).toEqual([{ q: 2 }, { q: 3 }]);
		// The source is consumed; the fresh run row links back to it.
		expect(journal.get("run-src")!.status).toBe("resumed");
		const rows = store.db
			.query<{ run_id: string; resumed_from: string | null; status: string }, [string]>(
				"SELECT run_id, resumed_from, status FROM turn_runs WHERE resumed_from = ?",
			)
			.all("run-src");
		expect(rows).toHaveLength(1);
		expect(rows[0]!.status).toBe("completed");
		// The replayed dispatch+result journaled under the new run row —
		// alongside the source's settled history it inherited.
		const newCalls = journal.callsFor(rows[0]!.run_id);
		expect(newCalls.map((c) => c.toolCallId).sort()).toEqual([
			"c-amb",
			"c-done",
			"c-plan",
			"n1",
			"n2",
			"n3",
		]);
		// The inherited rows carry the source's states verbatim: 'dispatched'
		// stays un-inherited — ambiguity remains owned by the row that ran.
		expect(newCalls.find((c) => c.toolCallId === "c-done")!.state).toBe("completed");
		expect(newCalls.find((c) => c.toolCallId === "c-amb")!.state).toBe("resolved-retry");
		expect(newCalls.find((c) => c.toolCallId === "c-plan")!.state).toBe("planned");
		expect(
			newCalls.filter((c) => c.toolCallId.startsWith("n")).every((c) => c.state === "completed"),
		).toBe(true);
		expect(newCalls.find((c) => c.toolCallId === "n1")!.result).toBe('{"out":"landed"}');
		// Headless notice fired exactly once with the terminal outcome.
		await waitUntil(() => notices.length === 1, "done notice");
		expect(notices[0]!.sourceRunId).toBe("run-src");
		expect(notices[0]!.done.kind).toBe("completed");
		store.close();
	});

	test("record-result replays the operator's asserted outcome verbatim", async () => {
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
		const replayed = journal.callsFor(newRun.run_id).find((c) => c.toolCallId === "n1")!;
		expect(replayed.state).toBe("completed");
		expect(replayed.result).toBe('"operator saw it land"');
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
		// The model re-emitted the declined call; execute never ran.
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
		// Occupy the lane with a parked ordinary turn.
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
		// Consumed for good: the source is 'resumed', no longer interrupted.
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

	test("a resumed turn replays a huge-args call by full hash; the seeded prompt stays bounded", async () => {
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
		const replayed = journal.callsFor(newRun.run_id).find((c) => c.toolCallId === "n1")!;
		expect(replayed.state).toBe("completed");
		expect(replayed.replayed).toBe(true);
		expect(replayed.result).toBe('{"out":"landed"}');
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
		// Exactly one dispatch ran, and the model never saw a retryable
		// tool error — the stream died with the journal.
		expect(executed).toEqual([{ name: "probe", args: { q: 1 } }]);
		expect(edge.streamCalls).toHaveLength(1);
		// The run row reads error, not completed — a completed run with
		// dispatched calls is the lie this fix removes.
		const row = store.db.query<{ status: string }, []>("SELECT status FROM turn_runs").get();
		expect(row?.status).toBe("error");
		await runtime.shutdown();
		store.close();
	});

	test("a resume dying before its successor keeps the source resumable", async () => {
		// makeTools is called once by ops.resume's surface check and once
		// inside the admitted attempt — the second call throwing is the
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
		// The successor never began — the source row stays interrupted.
		expect(journal.get("run-src")!.status).toBe("interrupted");
		// The claim released on terminal delivery — once the dead attempt's
		// lane drains, the operator can take the same run again instead of
		// hitting 'already in flight'.
		await waitUntil(() => !runtime.busy(conv.id), "dead attempt's lane drains");
		expect(ops.resume(conv.id, "run-src").kind).toBe("resumed");
		expect(await sink()!.done).toEqual({ kind: "completed" });
		expect(journal.get("run-src")!.status).toBe("resumed");
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

// makeResumeSinks — the per-lane routing the composition root wires:
// app lanes take the bell with no delivery hooks and no terminal DM
// (the bell is already the notice); telegram lanes take the delivery
// sink, full hooks, and one operator DM per resumed turn.
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
});

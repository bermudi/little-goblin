// The TurnEngine contract (turn/engine.ts), pinned once per engine
// through the real Runtime: one scenario table, every registered
// engine. Each scenario scripts its model calls once, engine-neutral
// (testkit/turn-script.ts); the adapter renders them for its engine —
// the AI SDK fake model, or the claude engine's query seam with the
// real bridge. Scenarios assert only observable results — sink done
// values, stored history, journal rows.

import { describe, expect, test } from "bun:test";
import { defineTool, type Tools } from "../tool.ts";
import type { Message } from "../message.ts";
import { z } from "zod";
import { isClaudeStep, type ClaudeStep } from "../agent/claude-code/mod.ts";
import { type ConversationStore, openStore } from "../conversation.ts";
import { Runtime, userMessage } from "../runtime.ts";
import { claudeScript } from "../testkit/turn-script-claude.ts";
import { sdkScript } from "../testkit/turn-script-sdk.ts";
import type { ScriptCall, ScriptedModel } from "../testkit/turn-script.ts";
import { deferred, RecordingSink, tmpDb, useHome, waitUntil } from "../testkit.ts";
import { openTurnJournal, type TurnJournal } from "../turn-journal.ts";
import { appendInterruptedProgress } from "./unlanded-progress.ts";
import { aiSdkEngine } from "./ai-sdk-engine.ts";
import { pickEngine, type TurnEngine } from "./engine.ts";

type Conv = ReturnType<ConversationStore["resolve"]>;

interface EngineRig {
	name: string;
	model: ScriptedModel;
	/** The hold the `wait` tool blocks on while it executes. */
	toolHold: { current: Held | null };
	runtime: Runtime;
	store: ConversationStore;
	conv: Conv;
	journal: TurnJournal;
}

interface Held {
	/** The hold call to script; it blocks mid-step until released. */
	call(parts: Extract<ScriptCall, { kind: "hold" }>["parts"]): ScriptCall;
	/** Fires once the turn is inside the held section. */
	entered: Promise<void>;
	enter(): void;
	gate: Promise<void>;
	release(): void;
}

function held(): Held {
	const entered = deferred<void>();
	const gate = deferred<void>();
	return {
		call: (parts) => ({ kind: "hold", parts, gate: gate.promise, entered: () => entered.resolve() }),
		entered: entered.promise,
		enter: () => entered.resolve(),
		gate: gate.promise,
		release: () => gate.resolve(),
	};
}

const rigTools = (toolHold: EngineRig["toolHold"]): Tools => ({
	echo: defineTool({
		description: "echo the message",
		input: z.object({ message: z.string() }),
		execute: async ({ message }) => `echo:${message}`,
	}),
	wait: defineTool({
		description: "wait until released",
		input: z.object({}),
		execute: async () => {
			const hold = toolHold.current!;
			hold.enter();
			await hold.gate;
			return "waited";
		},
	}),
});

const text = (t: string): ScriptCall => ({ kind: "reply", parts: [{ type: "text", text: t }] });
const echoCall = (message: string, toolCallId: string): ScriptCall => ({
	kind: "reply",
	parts: [{ type: "tool-call", toolName: "echo", input: { message }, toolCallId }],
});

/** Step 1 completes — assistant text + an echo call that settles — then
 *  step 2 holds before any content: a checkpointed step sits behind it. */
const progressThenHold = (hold: Held): ScriptCall[] => [
	{
		kind: "reply",
		parts: [
			{ type: "text", text: "FENCED-STEP1-TEXT" },
			{ type: "tool-call", toolName: "echo", input: { message: "first" }, toolCallId: "conf-fence-1" },
		],
	},
	hold.call([]),
];

function submit(rig: EngineRig, text: string): RecordingSink {
	const sink = new RecordingSink();
	rig.runtime.submit(rig.conv, userMessage([{ type: "text", text }]), sink);
	return sink;
}

const drain = (rig: EngineRig) => waitUntil(() => !rig.runtime.busy(rig.conv.id), "lane drains");

// `entered` means the provider produced the held part; the engine's
// chunk loop may still be a tick behind. The fence must land only
// after content reached the wire — the state the record pins.
const waitForWireContent = (sink: RecordingSink) =>
	waitUntil(
		() => sink.chunks.some((c) => c.type === "text-delta" || c.type === "tool-input-available"),
		"wire carries streamed content",
	);

const roles = (rig: EngineRig): string[] => rig.store.history(rig.conv.id).map((m) => m.role);

const textOf = (message: Message): string => {
	const out: string[] = [];
	for (const part of message.parts) {
		if (part.type === "text") out.push(part.text);
	}
	return out.join("");
};

function engineRig(model: ScriptedModel): EngineRig {
	useHome(`goblin-engconf-${model.engineId}-`);
	const store = openStore(tmpDb(`goblin-engconf-${model.engineId}-`));
	const journal = openTurnJournal(store.db);
	const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
	const runtime = new Runtime({
		engines: model.engines,
		store,
		buildStep: () => model.step(),
		turnJournal: journal,
	});
	const toolHold: EngineRig["toolHold"] = { current: null };
	runtime.mount({ makeTools: () => rigTools(toolHold) });
	return { name: model.engineId, model, toolHold, runtime, store, conv, journal };
}

const scenarios: Array<{ name: string; run(rig: EngineRig): Promise<void> }> = [
	{
		name: "plain text reply completes and stores [user, assistant]",
		async run(rig) {
			rig.model.script(text("CONF-REPLY"));
			const sink = submit(rig, "just talk");
			expect(await sink.done).toEqual({ kind: "completed" });
			await drain(rig);
			const history = rig.store.history(rig.conv.id);
			expect(history.map((m) => m.role)).toEqual(["user", "assistant"]);
			expect(textOf(history[1]!)).toContain("CONF-REPLY");
		},
	},
	{
		name: "one tool call then text journals dispatch+result and stores both parts",
		async run(rig) {
			rig.model.script(echoCall("hi", "conf-call-1"), text("CONF-AFTER-TOOL"));
			const sink = submit(rig, "use the tool");
			expect(await sink.done).toEqual({ kind: "completed" });
			await drain(rig);
			const history = rig.store.history(rig.conv.id);
			expect(history.map((m) => m.role)).toEqual(["user", "assistant"]);
			const reply = history[1]!;
			expect(reply.parts.some((p) => p.type === "tool-echo")).toBe(true);
			expect(textOf(reply)).toContain("CONF-AFTER-TOOL");
			const rows = rig.store.db.query<{ run_id: string }, []>("SELECT run_id FROM turn_runs").all();
			expect(rows).toHaveLength(1);
			const echo = rig.journal.callsFor(rows[0]!.run_id).find((c) => c.name === "echo");
			expect(echo?.state).toBe("completed");
			expect(echo?.beganMs).not.toBeNull();
			expect(echo?.settledMs).not.toBeNull();
			expect(echo?.result).toContain("echo:hi");
		},
	},
	{
		name: "/stop mid-run fences and records without storing an assistant message",
		async run(rig) {
			// The hold is a tool mid-execution; "/stop mid-stream" below
			// holds inside the provider stream instead.
			const hold = held();
			rig.toolHold.current = hold;
			rig.model.script({ kind: "reply", parts: [{ type: "tool-call", toolName: "wait", input: {} }] });
			const sink = submit(rig, "hold still");
			await hold.entered;
			await waitForWireContent(sink);
			rig.runtime.stop(rig.conv.id);
			hold.release();
			expect(await sink.done).toEqual({ kind: "fenced" });
			await drain(rig);
			// No assistant reply lands — the one record is a system event
			// carrying whatever the wire had streamed so far (the wait
			// tool's input).
			const history = rig.store.history(rig.conv.id);
			expect(history.map((m) => m.role)).toEqual(["user", "system"]);
			const meta = history[1]!.metadata as { unlanded?: { kind?: string } };
			expect(meta.unlanded?.kind).toBe("aborted");
		},
	},
	{
		name: "/stop after completed steps leaves them in history as ended-aborted (#195)",
		async run(rig) {
			const hold = held();
			rig.model.script(...progressThenHold(hold));
			const sink = submit(rig, "work then hold");
			await hold.entered;
			rig.runtime.stop(rig.conv.id);
			hold.release();
			expect(await sink.done).toEqual({ kind: "fenced" });
			await drain(rig);
			// No assistant reply landed — the record is one system event
			// carrying the completed call and the streamed text.
			const history = rig.store.history(rig.conv.id);
			expect(history.map((m) => m.role)).toEqual(["user", "system"]);
			const event = textOf(history[1]!);
			expect(event).toContain("was stopped");
			expect(event).toContain("echo");
			expect(event).toContain('completed: "echo:first"');
			expect(event).toContain("FENCED-STEP1-TEXT");
			const rows = rig.store.db
				.query<{ run_id: string; status: string }, []>("SELECT run_id, status FROM turn_runs")
				.all();
			expect(rows).toHaveLength(1);
			expect(rows[0]!.status).toBe("fenced");
			// The completed steps ran once; the hold's call never executed.
			const calls = rig.journal.callsFor(rows[0]!.run_id);
			expect(calls.filter((c) => c.name === "echo" && c.state === "completed")).toHaveLength(1);
		},
	},
	{
		name: "shutdown mid-run leaves the row 'running' — the next open interrupts it (#471)",
		async run(rig) {
			const hold = held();
			rig.model.script(...progressThenHold(hold));
			const sink = submit(rig, "work then hold");
			await hold.entered;
			// Not awaited yet — the turn must be released first.
			const shutdown = rig.runtime.shutdown();
			hold.release();
			expect(await sink.done).toEqual({ kind: "fenced", shutdown: true });
			await shutdown;
			// For the journal a graceful shutdown IS a crash: the fence
			// stamps nothing and records nothing — the row stays 'running'.
			expect(roles(rig)).toEqual(["user"]);
			const rows = rig.store.db
				.query<{ run_id: string; status: string }, []>(
					"SELECT run_id, status FROM turn_runs",
				)
				.all();
			expect(rows).toHaveLength(1);
			expect(rows[0]!.status).toBe("running");
			// The next open's reclassify owns both the 'interrupted' stamp
			// and the progress record — one system event, exactly once.
			const reopened = openTurnJournal(rig.store.db, {
				onInterrupted: (run, calls) => appendInterruptedProgress(rig.store, run, calls),
			});
			expect(reopened.pendingBootNotices().interrupted.map((n) => n.run.runId)).toEqual([
				rows[0]!.run_id,
			]);
			const history = rig.store.history(rig.conv.id);
			expect(history.map((m) => m.role)).toEqual(["user", "system"]);
			const event = textOf(history[1]!);
			expect(event).toContain("was interrupted");
			expect(event).toContain("echo");
			expect(event).toContain('completed: "echo:first"');
			expect(event).toContain("FENCED-STEP1-TEXT");
			const again = openTurnJournal(rig.store.db, {
				onInterrupted: (run, calls) => appendInterruptedProgress(rig.store, run, calls),
			});
			expect(
				again.pendingBootNotices().interrupted.map((n) => n.run.runId),
			).toEqual([rows[0]!.run_id]);
			expect(rig.store.history(rig.conv.id)).toHaveLength(2);
		},
	},
	{
		name: "/stop mid-stream stores one system record with the wire's id and reply",
		async run(rig) {
			// The words stream whole, then the step stalls open — the stop
			// lands before the step ends.
			const hold = held();
			rig.model.script(hold.call([{ type: "text", text: "partial words" }]));
			const sink = submit(rig, "talk then stop");
			await hold.entered;
			await waitForWireContent(sink);
			const wireStart = sink.chunks.find((c) => c.type === "start");
			expect(wireStart).toBeDefined();
			const wireId = (wireStart as { messageId: string }).messageId;
			rig.runtime.stop(rig.conv.id);
			hold.release();
			expect(await sink.done).toEqual({ kind: "fenced" });
			await drain(rig);
			// Exactly one event, role system, id from the wire's start chunk,
			// carrying the streamed words — never an assistant-role event.
			const history = rig.store.history(rig.conv.id);
			expect(history.map((m) => m.role)).toEqual(["user", "system"]);
			const record = history[1]!;
			expect(record.id).toBe(wireId);
			const meta = record.metadata as {
				unlanded?: { kind?: string; reply?: { type: string; text?: string }[] };
			};
			expect(meta.unlanded?.kind).toBe("aborted");
			expect(
				meta.unlanded?.reply?.some((p) => p.type === "text" && p.text === "partial words"),
			).toBe(true);
			// The next turn's model view: the record rides as one system-event
			// block — the text appears exactly once.
			rig.model.script(text("moving on"));
			const next = submit(rig, "next turn");
			expect(await next.done).toEqual({ kind: "completed" });
			await drain(rig);
			const prompt = rig.model.requests().at(-1)!;
			expect(prompt.split("[system event: The previous turn was stopped").length - 1).toBe(1);
		},
	},
	{
		name: "a failed stream stores the same record with kind failed",
		async run(rig) {
			// Text out, then a non-transient provider failure — the turn
			// fails with the words already on the wire.
			rig.model.script({
				kind: "fail",
				parts: [{ type: "text", text: "half" }],
				error: { message: "invalid_request_error: the model was retired" },
			});
			const sink = submit(rig, "talk then fail");
			expect((await sink.done).kind).toBe("error");
			await drain(rig);
			const history = rig.store.history(rig.conv.id);
			expect(history.map((m) => m.role)).toEqual(["user", "system"]);
			const record = history[1]!;
			const wireStart = sink.chunks.find((c) => c.type === "start");
			expect(wireStart).toBeDefined();
			expect(record.id).toBe((wireStart as { messageId: string }).messageId);
			const meta = record.metadata as {
				unlanded?: { kind?: string; reply?: { type: string; text?: string }[] };
			};
			expect(meta.unlanded?.kind).toBe("failed");
			expect(meta.unlanded?.reply?.some((p) => p.type === "text" && p.text === "half")).toBe(true);
		},
	},
	{
		name: "/stop before the first content records one stopped event with the wire's id (#408 F1)",
		async run(rig) {
			// The provider accepts the request then says nothing — the
			// wire carries only the message start when the fence lands.
			const hold = held();
			rig.model.script(hold.call([]));
			const sink = submit(rig, "hold before content");
			await hold.entered;
			// The wire opened the assistant message; no content part ever
			// arrived — the exact state that used to leave no record.
			await waitUntil(() => sink.chunks.some((c) => c.type === "start"), "wire start");
			const wireStart = sink.chunks.find((c) => c.type === "start");
			const wireId = (wireStart as { messageId: string }).messageId;
			rig.runtime.stop(rig.conv.id);
			hold.release();
			expect(await sink.done).toEqual({ kind: "fenced" });
			await drain(rig);
			// Exactly one record, role system, id from the wire's start
			// chunk — it replaces the empty optimistic assistant the
			// client showed; its reply carries no content parts.
			const history = rig.store.history(rig.conv.id);
			expect(history.map((m) => m.role)).toEqual(["user", "system"]);
			const record = history[1]!;
			expect(record.id).toBe(wireId);
			const meta = record.metadata as {
				unlanded?: { kind?: string; reply?: { type: string }[] };
			};
			expect(meta.unlanded?.kind).toBe("aborted");
			expect(Array.isArray(meta.unlanded?.reply)).toBe(true);
			expect(meta.unlanded!.reply!.every((p) => p.type === "step-start")).toBe(true);
			// The next turn's model view carries the record once.
			rig.model.script(text("moving on"));
			const next = submit(rig, "next turn");
			expect(await next.done).toEqual({ kind: "completed" });
			await drain(rig);
			const prompt = rig.model.requests().at(-1)!;
			expect(prompt.split("[system event: The previous turn was stopped").length - 1).toBe(1);
		},
	},
	{
		name: "a failure before the first content records one failed event (#408 F1)",
		async run(rig) {
			rig.model.script({
				kind: "fail",
				parts: [],
				error: { message: "invalid_request_error: provider exploded before streaming" },
			});
			const sink = submit(rig, "fail before content");
			// The wire still opened the assistant message before the
			// provider's error arrived.
			await waitUntil(() => sink.chunks.some((c) => c.type === "start"), "wire start");
			const wireStart = sink.chunks.find((c) => c.type === "start");
			const wireId = (wireStart as { messageId: string }).messageId;
			expect((await sink.done).kind).toBe("error");
			await drain(rig);
			const history = rig.store.history(rig.conv.id);
			expect(history.map((m) => m.role)).toEqual(["user", "system"]);
			const record = history[1]!;
			expect(record.id).toBe(wireId);
			const meta = record.metadata as {
				unlanded?: { kind?: string; reply?: { type: string }[] };
			};
			expect(meta.unlanded?.kind).toBe("failed");
			expect(Array.isArray(meta.unlanded?.reply)).toBe(true);
			expect(meta.unlanded!.reply!.every((p) => p.type === "step-start")).toBe(true);
			// The next turn's model view carries the record once.
			rig.model.script(text("moving on"));
			const next = submit(rig, "next turn");
			expect(await next.done).toEqual({ kind: "completed" });
			await drain(rig);
			const prompt = rig.model.requests().at(-1)!;
			expect(prompt.split("[system event: The previous turn did not finish").length - 1).toBe(1);
		},
	},
];

describe("turn engine conformance", () => {
	const engines: Array<{ name: string; make(): EngineRig }> = [
		{ name: "ai-sdk", make: () => engineRig(sdkScript()) },
		{ name: "claude-code", make: () => engineRig(claudeScript()) },
	];

	for (const engine of engines) {
		describe(`the ${engine.name} engine`, () => {
			for (const scenario of scenarios) {
				test(scenario.name, async () => {
					const rig = engine.make();
					try {
						await scenario.run(rig);
					} finally {
						await rig.runtime.shutdown();
						rig.store.close();
					}
				});
			}

			test("a mid-step text stream checkpoints its tail", async () => {
				const rig = engine.make();
				const hold = held();
				rig.model.script(hold.call([{ type: "text", text: "CHECKPOINT-TAIL" }]));
				try {
					submit(rig, "checkpoint streamed text");
					await hold.entered;
					await waitUntil(
						() => {
							const rows = rig.store.db
								.query<{ partial: string | null }, []>(
									"SELECT partial FROM turn_runs WHERE partial IS NOT NULL",
								)
								.all();
							const partial = rows.at(-1)?.partial;
							if (partial?.includes("CHECKPOINT-TAIL") !== true) return false;
							expect(partial).toContain("CHECKPOINT-TAIL");
							return true;
						},
						"mid-step partial checkpoint",
					);
				} finally {
					rig.runtime.stop(rig.conv.id);
					hold.release();
					await drain(rig);
					await rig.runtime.shutdown();
					rig.store.close();
				}
			});
		});
	}

	test("pickEngine returns the first accepting engine", () => {
		const step = sdkScript().step();
		expect(pickEngine([aiSdkEngine], step, "conv-x")).toBe(aiSdkEngine);
	});

	test("pickEngine with no matching engine fails loud", () => {
		const claudeEngine: TurnEngine<ClaudeStep> = {
			id: "claude-code",
			rules: {
				toolLaunchGate: false,
				preemptFold: false,
				contentFilterReask: false,
				transientRetry: false,
				contextFill: false,
			},
			accepts: isClaudeStep,
			run: async () => {
				throw new Error("not exercised");
			},
		};
		const step = { engine: "deepagents" };
		expect(() => pickEngine([aiSdkEngine, claudeEngine], step, "conv-x")).toThrow(
			'conversation conv-x has no engine for step engine "deepagents" (engines: ai-sdk, claude-code)',
		);
	});

	test("each engine accepts only its own tag", () => {
		const claudeEngine: TurnEngine<ClaudeStep> = {
			id: "claude-code",
			rules: {
				toolLaunchGate: false,
				preemptFold: false,
				contentFilterReask: false,
				transientRetry: false,
				contextFill: false,
			},
			accepts: isClaudeStep,
			run: async () => {
				throw new Error("not exercised");
			},
		};
		const aiStep = sdkScript().step();
		const step: ClaudeStep = {
			engine: "claude-code",
			label: "claude/claude-sonnet-4-5",
			modelId: "claude-sonnet-4-5",
			auth: "claude-code",
			system: "test",
			thinking: {},
		};
		expect(aiSdkEngine.accepts(step)).toBe(false);
		expect(claudeEngine.accepts(aiStep)).toBe(false);
	});
});

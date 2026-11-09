// The TurnEngine contract (turn/engine.ts), pinned once per engine
// through the real Runtime: one scenario table, every registered
// engine. The AI SDK side rides the testkit fake model
// (testkit/fake-model.ts); the claude side rides the engine's injected
// query seam (testkit/fake-claude.ts + the real bridge) exactly as
// runtime-engine-switch.test.ts drives it. Scenarios assert only
// observable results — sink done values, stored history, journal rows.

import { describe, expect, test } from "bun:test";
import { type ToolSet, tool, type UIMessage } from "ai";
import { z } from "zod";
import { type ClaudeEngineConfig, driveClaude } from "../agent/claude-code/engine.ts";
import type { ClaudeEngine, ClaudeStep } from "../agent/claude-code/mod.ts";
import { createToolBridge, type ToolBridge } from "../agent/claude-code/tools.ts";
import type { AuthStore } from "../auth.ts";
import type { Config, ConfigRef } from "../config.ts";
import { type ConversationStore, openStore } from "../conversation.ts";
import { Runtime, userMessage } from "../runtime.ts";
import { fakeClaude } from "../testkit/fake-claude.ts";
import { finishPart, scriptedModel, textParts, toolCallPart } from "../testkit/fake-model.ts";
import {
	deferred,
	pauseFakeModelAtDelta,
	RecordingSink,
	tmpDb,
	tmpDir,
	useHome,
	waitUntil,
} from "../testkit.ts";
import type { ModelStep } from "../turn/engine.ts";
import { openTurnJournal, type TurnJournal } from "../turn-journal.ts";
import { aiSdkEngine } from "./ai-sdk-engine.ts";
import { isClaudeStep, pickEngine } from "./engine.ts";

type Conv = ReturnType<ConversationStore["resolve"]>;

interface HeldRun {
	/** Fires once the turn is inside the held section. */
	entered: Promise<void>;
	release(): void;
}

interface EngineRig {
	name: string;
	runtime: Runtime;
	store: ConversationStore;
	conv: Conv;
	journal: TurnJournal;
	/** Script the next turn as one plain text reply. */
	scriptReply(text: string): void;
	/** Script the next turn as one echo tool call followed by a text reply. */
	scriptToolThenReply(message: string, text: string): void;
	/** Script the next turn to block mid-run; `entered` fires once it has. */
	scriptHeldRun(): HeldRun;
	/** Script one COMPLETED step (assistant text + echo tool call), then
	 *  hold mid-run — the fence lands with real progress to record. */
	scriptProgressThenHold(): HeldRun;
}

const echoTools = (): ToolSet => ({
	echo: tool({
		description: "echo the message",
		inputSchema: z.object({ message: z.string() }),
		execute: async ({ message }) => `echo:${message}`,
	}),
});

function submit(rig: EngineRig, text: string): RecordingSink {
	const sink = new RecordingSink();
	rig.runtime.submit(rig.conv, userMessage([{ type: "text", text }]), sink);
	return sink;
}

const drain = (rig: EngineRig) => waitUntil(() => !rig.runtime.busy(rig.conv.id), "lane drains");

const roles = (rig: EngineRig): string[] => rig.store.history(rig.conv.id).map((m) => m.role);

const textOf = (message: UIMessage): string => {
	const out: string[] = [];
	for (const part of message.parts) {
		if (part.type === "text") out.push(part.text);
	}
	return out.join("");
};

function sdkRig(): EngineRig {
	useHome("goblin-engconf-sdk-");
	const store = openStore(tmpDb("goblin-engconf-sdk-"));
	const journal = openTurnJournal(store.db);
	const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
	let step: ModelStep = { model: scriptedModel([]).model, system: "test", label: "fake/fake-1" };
	const runtime = new Runtime({
		engines: [aiSdkEngine],
		store,
		buildStep: () => step,
		makeTools: () => echoTools(),
		turnJournal: journal,
	});
	return {
		name: "ai-sdk",
		runtime,
		store,
		conv,
		journal,
		scriptReply: (text) => {
			step = { model: scriptedModel([textParts(text)]).model, system: "test" };
		},
		scriptToolThenReply: (message, text) => {
			step = {
				model: scriptedModel([
					[
						toolCallPart("conf-call-1", "echo", JSON.stringify({ message })),
						finishPart("tool-calls"),
					],
					textParts(text),
				]).model,
				system: "test",
			};
		},
		scriptHeldRun: () => {
			// Delta 0 streams out, delta 1 is held inside the provider
			// stream — the turn is mid-stream at `entered`.
			const gated = pauseFakeModelAtDelta(["a", "b"], 1);
			step = { model: gated.model, system: "test" };
			return { entered: gated.entered, release: () => gated.release() };
		},
		scriptProgressThenHold: () => {
			// Step 1 completes: assistant text + an echo call that settles.
			// Step 2's call never answers — the turn holds mid-run with a
			// checkpointed step behind it (the #195 fence fixture).
			const entered = deferred<void>();
			const gate = deferred<void>();
			const model = scriptedModel([
				[
					{ type: "stream-start", warnings: [] },
					{ type: "text-start", id: "t1" },
					{ type: "text-delta", id: "t1", delta: "FENCED-STEP1-TEXT" },
					{ type: "text-end", id: "t1" },
					toolCallPart("conf-fence-1", "echo", JSON.stringify({ message: "first" })),
					finishPart("tool-calls"),
				],
				{
					drive: async ({ enqueue, close }) => {
						enqueue({ type: "stream-start", warnings: [] });
						entered.resolve();
						await gate.promise;
						close();
					},
				},
			]);
			step = { model: model.model, system: "test" };
			return { entered: entered.promise, release: () => gate.resolve() };
		},
	};
}

const fakeAuth: AuthStore = {
	resolve: async (name) => `token-for-${name}`,
	has: () => true,
	names: () => ["claude-code"],
};

function claudeRig(): EngineRig {
	useHome("goblin-engconf-cc-");
	const store = openStore(tmpDb("goblin-engconf-cc-"));
	const journal = openTurnJournal(store.db);
	const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
	const fake = fakeClaude();
	const bridgeRef: { current: ToolBridge | null } = { current: null };
	const engineConfig: ClaudeEngineConfig = {
		query: fake.query,
		auth: fakeAuth,
		configRef: {
			current: {
				providers: { claude: { kind: "claude-code", auth: "claude-code" } },
			} as unknown as Config,
			ttsDown: false,
		} satisfies ConfigRef,
		configDir: tmpDir("goblin-engconf-cc-"),
		bridgeFactory: (d) => {
			const real = createToolBridge(d);
			bridgeRef.current = real;
			return real;
		},
	};
	const claudeEngine: ClaudeEngine = {
		id: "claude-code",
		accepts: isClaudeStep,
		run: (deps) => driveClaude(engineConfig, deps),
		compact: async () => {
			throw new Error("compaction not exercised here");
		},
	};
	const step: ClaudeStep = {
		engine: "claude-code",
		label: "claude/claude-sonnet-4-5",
		modelId: "claude-sonnet-4-5",
		auth: "claude-code",
		system: "test",
		thinking: {},
	};
	const runtime = new Runtime({
		engines: [claudeEngine, aiSdkEngine],
		store,
		buildStep: () => step,
		makeTools: () => echoTools(),
		turnJournal: journal,
	});
	return {
		name: "claude-code",
		runtime,
		store,
		conv,
		journal,
		scriptReply: (text) => fake.script([{ kind: "stream-text", text }]),
		scriptToolThenReply: (message, text) =>
			fake.script([
				{
					kind: "tool",
					name: "echo",
					input: { message },
					run: () => bridgeRef.current!.invoke("echo", { message }),
				},
				{ kind: "stream-text", text },
			]),
		scriptHeldRun: () => {
			// The tool execution is the hold: `run` gates before invoking
			// the bridge, so the turn sits mid-run at `entered`.
			const entered = deferred<void>();
			const gate = deferred<void>();
			fake.script([
				{
					kind: "tool",
					name: "echo",
					input: { message: "hold" },
					run: async () => {
						entered.resolve();
						await gate.promise;
						return bridgeRef.current!.invoke("echo", { message: "hold" });
					},
				},
			]);
			return { entered: entered.promise, release: () => gate.resolve() };
		},
		scriptProgressThenHold: () => {
			// Step 1 completes: streamed assistant text + an echo call that
			// settles and journals. Step 2's tool gates before the bridge —
			// the turn holds mid-run with a checkpointed step behind it.
			const entered = deferred<void>();
			const gate = deferred<void>();
			fake.script([
				{ kind: "stream-text", text: "FENCED-STEP1-TEXT" },
				{
					kind: "tool",
					name: "echo",
					input: { message: "first" },
					run: () => bridgeRef.current!.invoke("echo", { message: "first" }),
				},
				{
					kind: "tool",
					name: "echo",
					input: { message: "hold" },
					run: async () => {
						entered.resolve();
						await gate.promise;
						return bridgeRef.current!.invoke("echo", { message: "hold" });
					},
				},
			]);
			return { entered: entered.promise, release: () => gate.resolve() };
		},
	};
}

const scenarios: Array<{ name: string; run(rig: EngineRig): Promise<void> }> = [
	{
		name: "plain text reply completes and stores [user, assistant]",
		async run(rig) {
			rig.scriptReply("CONF-REPLY");
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
			rig.scriptToolThenReply("hi", "CONF-AFTER-TOOL");
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
		name: "/stop mid-run fences without storing an assistant message",
		async run(rig) {
			const held = rig.scriptHeldRun();
			const sink = submit(rig, "hold still");
			await held.entered;
			rig.runtime.stop(rig.conv.id);
			held.release();
			expect(await sink.done).toEqual({ kind: "fenced" });
			await drain(rig);
			expect(roles(rig)).toEqual(["user"]);
		},
	},
	{
		name: "/stop after completed steps leaves them in history as ended-aborted (#195)",
		async run(rig) {
			const held = rig.scriptProgressThenHold();
			const sink = submit(rig, "work then hold");
			await held.entered;
			rig.runtime.stop(rig.conv.id);
			held.release();
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
		name: "shutdown mid-run fences with the shutdown stamp",
		async run(rig) {
			const held = rig.scriptHeldRun();
			const sink = submit(rig, "hold still");
			await held.entered;
			// Not awaited yet — the turn must be released first.
			const shutdown = rig.runtime.shutdown();
			held.release();
			expect(await sink.done).toEqual({ kind: "fenced", shutdown: true });
			await shutdown;
			expect(roles(rig)).toEqual(["user"]);
		},
	},
];

describe("turn engine conformance", () => {
	const engines: Array<{ name: string; make(): EngineRig }> = [
		{ name: "ai-sdk", make: sdkRig },
		{ name: "claude-code", make: claudeRig },
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
		});
	}

	test("pickEngine returns the first accepting engine", () => {
		const step: ModelStep = { model: scriptedModel([]).model, system: "test" };
		expect(pickEngine([aiSdkEngine], step, "conv-x")).toBe(aiSdkEngine);
	});

	test("pickEngine with no matching engine fails loud", () => {
		const step: ClaudeStep = {
			engine: "claude-code",
			label: "claude/claude-sonnet-4-5",
			modelId: "claude-sonnet-4-5",
			auth: "claude-code",
			system: "test",
			thinking: {},
		};
		expect(() => pickEngine([aiSdkEngine], step, "conv-x")).toThrow(
			"conversation conv-x has no engine for this step (engines: ai-sdk)",
		);
	});
});

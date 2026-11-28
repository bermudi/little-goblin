
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { type ConversationStore, openStore } from "../conversation.ts";
import { Runtime, type TurnStep, userMessage } from "../runtime.ts";
import type { Message } from "../message.ts";
import { defineTool, type Tools } from "../tool.ts";
import { deferred, RecordingSink, tmpDb, useHome, waitUntil } from "../testkit.ts";
import { finishPart, scriptedModel, textParts, toolCallPart } from "../testkit/fake-model.ts";
import { foldSummary } from "../testkit/fake-summary.ts";
import { sdkScript } from "../testkit/turn-script-sdk.ts";
import { claudeScript } from "../testkit/turn-script-claude.ts";
import type { ScriptCall } from "../testkit/turn-script.ts";
import { aiSdkEngine } from "./ai-sdk-engine.ts";
import type { ModelStep } from "./ai-sdk-step.ts";
import type { EngineRules, TurnEngine } from "./engine.ts";

type ProbedRule = Exclude<keyof EngineRules, "toolLaunchGate" | "contextFill">;
const probedRules: readonly ProbedRule[] = [
	"transientRetry",
	"contentFilterReask",
	"preemptFold",
];

const FINAL = "FINAL-REPLY-9c1e";
const filterWarning =
	"[System detected potentially unsafe or sensitive content in input or generation. Please avoid using prompts that may generate sensitive content.]";

interface RunResult {
	done: unknown;
	reply: string;
	foldedMidTurn: boolean;
}

const textOf = (message: Message): string =>
	message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");

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

async function runTurn(
	engine: TurnEngine,
	step: TurnStep,
	opts: { foldable?: boolean } = {},
): Promise<RunResult> {
	const store = openStore(tmpDb("goblin-engine-rules-"));
	const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
	let foldedMidTurn = false;
	const replyLanded = (): boolean =>
		store.history(conv.id).some((m) => m.role === "assistant" && textOf(m).includes(FINAL));
	const runtime = new Runtime({
		engines: [engine],
		store,
		buildStep: () => step,
		...(opts.foldable === true
			? {
					compaction: {
						modelRef: () => "m",
						contextWindow: () => 1000,
						summarize: async (_c, _s, prompt) => {
							if (!replyLanded()) foldedMidTurn = true;
							return foldSummary("folded past", prompt);
						},
					},
				}
			: {}),
	});
	runtime.mount({
		makeTools: (_conv, _voice, _recording, _file): Tools => ({
			probe: defineTool({
				description: "test tool",
				input: z.object({}),
				execute: () => "probe-ok",
			}),
		}),
	});
	try {
		if (opts.foldable === true) seedExchanges(store, conv.id);
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "run the probe" }]), sink);
		const done = await sink.done;
		await waitUntil(() => !runtime.busy(conv.id), "engine-rules runtime drains");
		const last = store.history(conv.id).at(-1);
		return {
			done,
			reply: last?.role === "assistant" ? textOf(last) : "",
			foldedMidTurn,
		};
	} finally {
		await runtime.shutdown();
		store.close();
	}
}

const recovered = (r: RunResult): boolean =>
	(r.done as { kind: string }).kind === "completed" && r.reply.includes(FINAL);

function sdkStep(calls: ScriptCall[], contextWindow: number): ModelStep {
	const model = sdkScript();
	model.script(...calls);
	const step = model.step();
	if (step.engine !== "ai-sdk") throw new Error("expected an AI SDK script step");
	return { ...step, contextWindow };
}

interface EngineProbe {
	name: string;
	engine(): TurnEngine;
	probe: Record<ProbedRule, () => Promise<boolean>>;
}

function aiSdkProbe(): EngineProbe {
	return {
		name: "ai-sdk",
		engine: () => aiSdkEngine,
		probe: {
			transientRetry: async () =>
				recovered(
					await runTurn(
						aiSdkEngine,
						{
							engine: "ai-sdk",
							model: scriptedModel(
							[
								[
									{ type: "stream-start", warnings: [] },
									{ type: "error", error: new Error("socket hang up") },
								],
								textParts(FINAL),
							],
							).model,
							system: "test",
							contextWindow: 10_000,
							transientRetryDelayMs: 0,
						},
					),
				),
			contentFilterReask: async () =>
				recovered(
					await runTurn(
						aiSdkEngine,
						{
							engine: "ai-sdk",
							model: scriptedModel(
								[[{ type: "error", error: new Error(filterWarning) }], textParts(FINAL)],
							).model,
							system: "test",
							contextWindow: 10_000,
							transientRetryDelayMs: 0,
						},
					),
				),
			preemptFold: async () => {
				const r = await runTurn(
					aiSdkEngine,
					sdkStep([
						{
							kind: "reply",
							parts: [{ type: "tool-call", toolName: "probe", input: {} }],
							usage: { input: 900, output: 1 },
						},
						{ kind: "reply", parts: [{ type: "text", text: FINAL }] },
					], 1000),
					{ foldable: true },
				);
				return recovered(r) && r.foldedMidTurn;
			},
		},
	};
}

function claudeProbe(): EngineProbe {
	const fresh = () => claudeScript();
	const withWindow = (model: ReturnType<typeof claudeScript>, contextWindow: number): TurnStep => ({
		...model.step(),
		contextWindow,
	});
	return {
		name: "claude-code",
		engine: () => fresh().engines[0]!,
		probe: {
			transientRetry: async () => {
				const model = fresh();
				model.script(
					{ kind: "fail", parts: [], error: { message: "API Error: socket hang up" } },
					{ kind: "reply", parts: [{ type: "text", text: FINAL }] },
				);
				return recovered(await runTurn(model.engines[0]!, withWindow(model, 10_000)));
			},
			contentFilterReask: async () => {
				const model = fresh();
				model.script(
					{ kind: "fail", parts: [], error: { message: filterWarning } },
					{ kind: "reply", parts: [{ type: "text", text: FINAL }] },
				);
				return recovered(await runTurn(model.engines[0]!, withWindow(model, 10_000)));
			},
			preemptFold: async () => {
				const model = fresh();
				model.script(
					{
						kind: "reply",
						parts: [{ type: "tool-call", toolName: "probe", input: {} }],
						usage: { input: 900, output: 1 },
					},
					{ kind: "reply", parts: [{ type: "text", text: FINAL }] },
					{ kind: "reply", parts: [{ type: "text", text: FINAL }] },
				);
				const r = await runTurn(model.engines[0]!, withWindow(model, 1000), { foldable: true });
				return recovered(r) && r.foldedMidTurn;
			},
		},
	};
}

describe("engine rules", () => {
	for (const probe of [aiSdkProbe(), claudeProbe()]) {
		for (const rule of probedRules) {
			test(`${probe.name} follows ${rule} exactly when it declares it`, async () => {
				useHome("goblin-engine-rules-");
				const declared = probe.engine().rules[rule];
				expect({ rule, followed: await probe.probe[rule]() }).toEqual({ rule, followed: declared });
			});
		}
	}

	test("the Runtime tool-launch gate follows the selected engine's declaration", async () => {
		const results = await Promise.all([runGate(true), runGate(false)]);
		expect(results.map((result) => result.ran)).toEqual([false, true]);
		expect(results[0]!.nextPrompt).toContain("skipped: the user sent new input; re-issue if still needed");
		expect(results[0]!.nextPrompt).toContain("actually pivot");
		expect(results[1]!.nextPrompt).toContain("actually pivot");
	});
});

async function runGate(toolLaunchGate: boolean): Promise<{ ran: boolean; nextPrompt: string }> {
	const streamReady = deferred<void>();
	const releaseToolCall = deferred<void>();
	let ran = false;
	const scripted = scriptedModel([
		{
			drive: async (ctx) => {
				ctx.enqueue({ type: "stream-start", warnings: [] });
				streamReady.resolve();
				await releaseToolCall.promise;
				ctx.enqueue(toolCallPart("unstarted", "probe"));
				ctx.enqueue(finishPart("tool-calls"));
				ctx.close();
			},
		},
		textParts("done"),
	]);
	const store = openStore(tmpDb("goblin-engine-rules-"));
	const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
	const engine =
		toolLaunchGate === true
			? aiSdkEngine
			: { ...aiSdkEngine, rules: { ...aiSdkEngine.rules, toolLaunchGate: false } };
	const runtime = new Runtime({
		engines: [engine],
		store,
		buildStep: () => ({ engine: "ai-sdk", model: scripted.model, system: "test" }),
	});
	runtime.mount({ makeTools: () => ({
			probe: defineTool({
				description: "test tool",
				input: z.object({}),
				execute: () => {
					ran = true;
					return { ok: true };
				},
			}),
		}) });
	try {
		const first = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "start this" }]), first);
		await streamReady.promise;
		const steered = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "actually pivot" }]), steered);
		releaseToolCall.resolve();
		expect(await first.done).toEqual({ kind: "completed" });
		expect(await steered.done).toEqual({ kind: "completed" });
		await waitUntil(() => !runtime.busy(conv.id), "engine-rules runtime drains");
		return {
			ran,
			nextPrompt: JSON.stringify(scripted.streamCalls[1]?.prompt ?? null),
		};
	} finally {
		store.close();
	}
}

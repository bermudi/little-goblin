import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { openStore } from "../conversation.ts";
import { parseConfig } from "../config.ts";
import { Runtime, userMessage } from "../runtime.ts";
import type { AuthStore } from "../auth.ts";
import { defineTool } from "../tool.ts";
import { deferred, RecordingSink, tmpDb, waitUntil } from "../testkit.ts";
import { finishPart, scriptedModel, textParts, toolCallPart } from "../testkit/fake-model.ts";
import { fakeClaude } from "../testkit/fake-claude.ts";
import { aiSdkEngine } from "./ai-sdk-engine.ts";
import type { EngineRules } from "./engine.ts";
import { createClaudeEngine } from "../agent/claude-code/mod.ts";
import type { ConfigRef } from "../config.ts";

const aiSdkRules: EngineRules = {
	toolLaunchGate: true,
	preemptFold: true,
	contentFilterReask: true,
	transientRetry: true,
	contextFill: true,
};

const claudeRules: EngineRules = {
	toolLaunchGate: false,
	preemptFold: false,
	contentFilterReask: false,
	transientRetry: false,
	contextFill: false,
};

describe("engine rules", () => {
	test("each production engine declares its optional rules", () => {
		expect(aiSdkEngine.rules).toEqual(aiSdkRules);
		const auth: AuthStore = {
			resolve: async (name) => `token-for-${name}`,
			has: () => true,
			names: () => ["claude-code"],
		};
		const configRef: ConfigRef = {
			current: parseConfig({
				providers: { claude: { kind: "claude-code", auth: "claude-code" } },
				model: "claude/claude-sonnet-4-5",
				operators: [7],
				allowedUsers: [7],
			}),
			ttsDown: false,
		};
		const claudeEngine = createClaudeEngine({
			auth,
			configRef,
			query: fakeClaude().query,
		});
		expect(claudeEngine.rules).toEqual(claudeRules);
	});

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
		makeTools: () => ({
			probe: defineTool({
				description: "test tool",
				input: z.object({}),
				execute: () => {
					ran = true;
					return { ok: true };
				},
			}),
		}),
	});
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

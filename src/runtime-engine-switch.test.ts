// One conversation crossing turn engines mid-history: an AI-SDK turn
// with a tool call, then a claude-code turn with a tool call, then an
// AI-SDK turn again. Guards design/model.md → Model fallback list
// ("Crossing engines is allowed" gate): each engine must read the
// other's transcript — tool calls paired with their results by id on
// the AI-SDK side, rendered as text on the claude side — and the turn
// after a switch must complete.

import { describe, expect, test } from "bun:test";
import { type LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { defineTool, type Tools } from "./tool.ts";
import { z } from "zod";
import { openStore } from "./conversation.ts";
import { Runtime, userMessage } from "./runtime.ts";
import type { ModelStep } from "./turn/ai-sdk-step.ts";
import { aiSdkEngine } from "./turn/ai-sdk-engine.ts";
import { claudeScript } from "./testkit/turn-script-claude.ts";
import { finishPart, scriptedModel, textParts, toolCallPart } from "./testkit/fake-model.ts";
import { RecordingSink, tmpDb, useHome, waitUntil } from "./testkit.ts";
import { openTurnJournal } from "./turn-journal.ts";

interface PromptPart {
	type: string;
	text?: string;
	toolCallId?: string;
	toolName?: string;
}

function parts(call: LanguageModelV4CallOptions): PromptPart[] {
	const out: PromptPart[] = [];
	for (const msg of call.prompt) {
		if (typeof msg.content === "string") continue;
		for (const p of msg.content) out.push(p as PromptPart);
	}
	return out;
}

describe("one conversation across turn engines", () => {
	test("AI-SDK → claude-code → AI-SDK: each engine reads the other's turns and completes", async () => {
		useHome("goblin-engine-switch-");
		const store = openStore(tmpDb("goblin-engine-switch-"));
		const journal = openTurnJournal(store.db);
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");

		const echoed: string[] = [];
		const tools: Tools = {
			echo: defineTool({
				description: "echo the message",
				input: z.object({ message: z.string() }),
				execute: async ({ message }) => {
					echoed.push(message);
					return `echo:${message}`;
				},
			}),
		};

		// This inspection asserts AI SDK v4 prompt-part framing and tool-result IDs.
		const sdk = scriptedModel([
			// Turn 1: a tool loop, then prose.
			[
				toolCallPart("sdk-call-1", "echo", JSON.stringify({ message: "from-sdk" })),
				finishPart("tool-calls"),
			],
			textParts("SDK-TURN-ONE"),
			// Turn 3: prose after reading the claude turn.
			textParts("SDK-TURN-THREE"),
		]);

		const claude = claudeScript();

		let lane: "sdk" | "claude" = "sdk";
		const sdkStep = (): ModelStep => ({ engine: "ai-sdk", model: sdk.model, system: "test", label: "fake/fake-1" });

		const runtime = new Runtime({
			store,
			engines: [...claude.engines, aiSdkEngine],
			buildStep: () => (lane === "sdk" ? sdkStep() : claude.step()),
			turnJournal: journal,
		});
		runtime.mount({ makeTools: () => tools });
		const turn = async (text: string) => {
			const sink = new RecordingSink();
			runtime.submit(conv, userMessage([{ type: "text", text }]), sink);
			const done = await sink.done;
			await waitUntil(() => !runtime.busy(conv.id), "lane drains");
			return { sink, done };
		};

		try {
			const one = await turn("first ask");
			expect(one.done).toEqual({ kind: "completed" });

			lane = "claude";
			claude.script({
				kind: "reply",
				parts: [
					{ type: "tool-call", toolName: "echo", input: { message: "from-claude" } },
					{ type: "text", text: "CLAUDE-TURN-TWO" },
				],
			});
			const two = await turn("second ask");
			expect(two.done).toEqual({ kind: "completed" });
			expect(two.sink.text).toContain("CLAUDE-TURN-TWO");

			// The claude turn saw turn 1 in full: the ask, the tool call,
			// its goblin output, and the reply.
			expect(claude.calls()).toBe(1);
			const claudeSaw = claude.requests()[0]!;
			for (const needle of [
				"first ask",
				"[tool call: echo]",
				"from-sdk",
				"echo:from-sdk",
				"SDK-TURN-ONE",
				"second ask",
			]) {
				expect(claudeSaw).toContain(needle);
			}

			lane = "sdk";
			const three = await turn("third ask");
			expect(three.done).toEqual({ kind: "completed" });
			expect(three.sink.text).toContain("SDK-TURN-THREE");

			// The AI-SDK turn after the switch replays the claude turn as
			// structured parts: each tool call paired with a result of the
			// same id (an unpaired id is a provider 400), and the prose.
			const third = sdk.streamCalls[sdk.streamCalls.length - 1]!;
			const seen = parts(third);
			const calls = seen.filter((p) => p.type === "tool-call");
			const results = seen.filter((p) => p.type === "tool-result");
			expect(calls.map((c) => c.toolName)).toEqual(["echo", "echo"]);
			expect(new Set(results.map((r) => r.toolCallId))).toEqual(
				new Set(calls.map((c) => c.toolCallId)),
			);
			const prose = JSON.stringify(third.prompt);
			expect(prose).toContain("CLAUDE-TURN-TWO");
			expect(prose).toContain("echo:from-claude");
			expect(prose).toContain("SDK-TURN-ONE");

			expect(echoed).toEqual(["from-sdk", "from-claude"]);
		} finally {
			await runtime.shutdown();
			store.close();
		}
	});
});

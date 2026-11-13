// One conversation crossing turn engines mid-history: an AI-SDK turn
// with a tool call, then a claude-code turn with a tool call, then an
// AI-SDK turn again. Guards design/model.md → Model fallback list
// ("Crossing engines is allowed" gate): each engine must read the
// other's transcript — tool calls paired with their results by id on
// the AI-SDK side, rendered as text on the claude side — and the turn
// after a switch must complete.

import { describe, expect, test } from "bun:test";
import { type LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { type ClaudeEngineConfig, driveClaude } from "./agent/claude-code/engine.ts";
import type { ClaudeEngine, ClaudeStep } from "./agent/claude-code/mod.ts";
import { createToolBridge, type ToolBridge } from "./agent/claude-code/tools.ts";
import type { AuthStore } from "./auth.ts";
import type { ConfigRef } from "./config.ts";
import type { Config } from "./config-schema.ts";
import { openStore } from "./conversation.ts";
import { Runtime, userMessage } from "./runtime.ts";
import type { ModelStep } from "./turn/engine.ts";
import { aiSdkEngine } from "./turn/ai-sdk-engine.ts";
import { isClaudeStep } from "./turn/engine.ts";
import { fakeClaude } from "./testkit/fake-claude.ts";
import { finishPart, scriptedModel, textParts, toolCallPart } from "./testkit/fake-model.ts";
import { RecordingSink, tmpDb, tmpDir, useHome, waitUntil } from "./testkit.ts";
import { openTurnJournal } from "./turn-journal.ts";

const fakeAuth: AuthStore = {
	resolve: async (name) => `token-for-${name}`,
	has: () => true,
	names: () => ["claude-code"],
};

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
		const tools: ToolSet = {
			echo: tool({
				description: "echo the message",
				inputSchema: z.object({ message: z.string() }),
				execute: async ({ message }) => {
					echoed.push(message);
					return `echo:${message}`;
				},
			}),
		};

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

		const bridgeRef: { current: ToolBridge | null } = { current: null };
		const fake = fakeClaude();
		const engineConfig: ClaudeEngineConfig = {
			query: fake.query,
			auth: fakeAuth,
			configRef: {
				current: {
					providers: { claude: { kind: "claude-code", auth: "claude-code" } },
				} as unknown as Config,
				ttsDown: false,
			} satisfies ConfigRef,
			configDir: tmpDir("goblin-engine-switch-cc-"),
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
			nativeCompact: async () => null,
		};

		let lane: "sdk" | "claude" = "sdk";
		const claudeStep: ClaudeStep = {
			engine: "claude-code",
			label: "claude/claude-sonnet-4-5",
			modelId: "claude-sonnet-4-5",
			auth: "claude-code",
			system: "test",
			thinking: {},
		};
		const sdkStep = (): ModelStep => ({ model: sdk.model, system: "test", label: "fake/fake-1" });

		const runtime = new Runtime({
			store,
			engines: [claudeEngine, aiSdkEngine],
			buildStep: () => (lane === "sdk" ? sdkStep() : claudeStep),
			makeTools: () => tools,
			turnJournal: journal,
		});
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
			fake.script([
				{
					kind: "tool",
					name: "echo",
					input: { message: "from-claude" },
					run: () => bridgeRef.current!.invoke("echo", { message: "from-claude" }),
				},
				{ kind: "stream-text", text: "CLAUDE-TURN-TWO" },
			]);
			const two = await turn("second ask");
			expect(two.done).toEqual({ kind: "completed" });
			expect(two.sink.text).toContain("CLAUDE-TURN-TWO");

			// The claude turn saw turn 1 in full: the ask, the tool call,
			// its goblin output, and the reply.
			expect(fake.calls).toHaveLength(1);
			const claudeSaw = fake.calls[0]!.prompt.blocks.map((b) =>
				b.kind === "text" ? b.text : "",
			).join("\n");
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

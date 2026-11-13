// The claude engine's integration suite: driveClaude over the fake
// query (testkit/fake-claude.ts) with the real bridge and a scripted
// ToolSet, asserting the wire, journal, and outcome contracts it shares
// with driveStream — plus the engine-specific rulings (steer deferral,
// no forced cuts, loud rate-limit/auth text, overflow recovery hold).

import { describe, expect, test } from "bun:test";
import { type ModelMessage, type ToolSet, tool, type UIMessageChunk } from "ai";
import { z } from "zod";
import type { AuthStore } from "../../auth.ts";
import type { ConfigRef } from "../../config.ts";
import type { Config } from "../../config-schema.ts";
import { type FakeStep, fakeClaude } from "../../testkit/fake-claude.ts";
import { TurnState } from "../../turn/state.ts";
import {
	type MemberSettlement,
	openLive,
	type StreamDeps,
	type WireMember,
} from "../../turn/stream.ts";
import type { TurnJournal } from "../../turn-journal.ts";
import { type ClaudeEngineConfig, driveClaude } from "./engine.ts";
import type { ClaudeStep } from "./mod.ts";
import { createToolBridge, type ToolBridge } from "./tools.ts";

// A recorder for the journal calls the engine makes — the sqlite
// journal's own semantics are covered by turn-journal tests; here we
// pin that the engine makes the calls a resume would replay.
function recordingJournal() {
	const inputs: Array<{ callId: string; name: string; args: unknown }> = [];
	const checkpoints: unknown[] = [];
	const journal = {
		noteToolInput: (_runId: string, callId: string, name: string, args: unknown) => {
			inputs.push({ callId, name, args });
		},
	} as unknown as TurnJournal;
	// The engines checkpoint through the saveStep seam (#195), never the
	// journal directly — the recorder mirrors the seam, not the vendor.
	const saveStep = (patch: unknown): void => {
		checkpoints.push(patch);
	};
	return { journal, inputs, checkpoints, saveStep };
}

const fakeAuth: AuthStore = {
	resolve: async (name) => `token-for-${name}`,
	has: () => true,
	names: () => ["claude-code"],
};

const fakeConfigRef = (providers: Config["providers"] = {}): ConfigRef => ({
	current: { providers } as Config,
	ttsDown: false,
});

interface RecMember extends WireMember {
	chunks: UIMessageChunk[];
}

function member(): RecMember {
	const chunks: UIMessageChunk[] = [];
	return {
		seq: 1,
		message: { id: "u-1", role: "user", parts: [{ type: "text", text: "do the thing" }] },
		sink: { onStreamChunk: (c) => chunks.push(c) },
		chunks,
	};
}

function headSink() {
	return {
		text: "",
		reasoning: "",
		calls: [] as Array<{ tool: string; input: unknown }>,
		onTextDelta(d: string) {
			this.text += d;
		},
		onReasoningDelta(d: string) {
			this.reasoning += d;
		},
		onToolCall(toolName: string, input: unknown) {
			this.calls.push({ tool: toolName, input });
		},
	};
}

function echoTools(): ToolSet {
	return {
		echo: tool({
			description: "echo the message",
			inputSchema: z.object({ message: z.string() }),
			execute: async ({ message }) => `echo:${message}`,
		}),
		failing: tool({
			description: "always fails",
			inputSchema: z.object({}),
			execute: async (): Promise<string> => {
				throw new Error("boom-from-tool");
			},
		}),
	};
}

const BASE_STEP: ClaudeStep = {
	engine: "claude-code",
	label: "claude/claude-sonnet-4-5",
	modelId: "claude-sonnet-4-5",
	auth: "claude-code",
	system: "test system",
	thinking: { effort: "medium" },
	contextWindow: 200_000,
	maxTurns: 50,
};

type RigOver = Partial<Omit<StreamDeps<RecMember>, "step">> & { step?: ClaudeStep };

function rig(over: RigOver = {}) {
	const head = headSink();
	const members = [member()];
	const live = openLive();
	const settlements: Array<{ m: RecMember; done: MemberSettlement }> = [];
	const claimed: number[][] = [];
	const deps: Omit<StreamDeps<RecMember>, "step"> & { step: ClaudeStep } = {
		convId: "c-claude",
		epoch: 1,
		head,
		members,
		live,
		state: new TurnState({ convId: "c-claude", watchdog: null, request: "do the thing" }),
		assertAuthority: () => {},
		holdsAuthority: () => true,
		step: BASE_STEP,
		messages: [{ role: "user", content: "do the thing" }],
		tools: {},
		view: {
			convId: "c-claude",
			modelRef: "claude/claude-sonnet-4-5",
			tools: {},
			modalities: new Set(["text"]),
			carries: () => true,
			skillRef: () => {
				throw new Error("no skill parts expected in this fixture");
			},
		},
		claimSteers: () => {
			claimed.push([1]);
			return [];
		},
		unrequeueSteers: () => {},
		settle: (m, done) => settlements.push({ m, done }),
		steerMarkSeed: 0,
		ownedInputSeqs: [],
		sourceInputSeq: () => null,
		partial: null,
		seenText: false,
		toolCalls: [],
		digest: [],
		filterRetryUsed: false,
		overflowRecoverable: false,
		evidence: undefined,
		runId: "run-claude-1",
		saveStep: () => {},
		turnStartMs: Date.now(),
		signal: new AbortController().signal,
		...over,
	};
	return {
		deps,
		head,
		members,
		live,
		settlements,
		claimed,
	};
}

async function run(
	steps: FakeStep[] | ((getBridge: () => ToolBridge | null) => FakeStep[]),
	over: RigOver = {},
	engine: Partial<ClaudeEngineConfig> = {},
) {
	const bridgeRef: { current: ToolBridge | null } = { current: null };
	const getBridge = (): ToolBridge | null => bridgeRef.current;
	const scripted = typeof steps === "function" ? steps(getBridge) : steps;
	const fake = fakeClaude(scripted);
	const r = rig(over);
	const rec = recordingJournal();
	const journal = rec.journal;
	const outcome = await driveClaude(
		{
			query: fake.query,
			auth: fakeAuth,
			configRef: fakeConfigRef({ claude: { kind: "claude-code", auth: "claude-code" } }),
			configDir: "/tmp",
			...engine,
			bridgeFactory: (d: { convId: string; tools: ToolSet }) => {
				const real = createToolBridge(d);
				bridgeRef.current = real;
				return real;
			},
		} as unknown as ClaudeEngineConfig,
		{ ...r.deps, journal, saveStep: rec.saveStep },
	);
	return { outcome, fake, bridge: bridgeRef.current, ...r, journal, rec };
}

const types = (chunks: UIMessageChunk[]): string[] => chunks.map((c) => c.type);

describe("driveClaude — wire and outcome parity", () => {
	test("streamed text lands in both sinks with the canonical part lifecycle", async () => {
		const { outcome, members, live } = await run([
			{ kind: "stream-text", text: "hello world", usage: { inputTokens: 10, outputTokens: 5 } },
		]);
		expect(outcome.kind).toBe("ok");
		const seq = types(members[0]!.chunks);
		expect(seq).toEqual([
			"start",
			"start-step",
			"text-start",
			"text-delta",
			"text-delta",
			"text-end",
			"finish-step",
			"data-context",
			"finish",
		]);
		// The live buffer mirrors the member sink chunk-for-chunk.
		expect(types(live.chunks)).toEqual(seq);
		const finish = members[0]!.chunks.at(-1);
		expect(finish?.type).toBe("finish");
		if (finish?.type === "finish") {
			expect(finish.messageMetadata).toMatchObject({
				model: "claude/claude-sonnet-4-5",
				finishReason: "stop",
				usage: { input: 10, output: 5, lastInput: 10 },
			});
			// The streamed delta noted the first token; the stamp rides the
			// finish metadata in the same shape the API lane writes.
			const md = finish.messageMetadata as { ttftMs?: unknown };
			expect(typeof md.ttftMs).toBe("number");
			expect(md.ttftMs as number).toBeGreaterThanOrEqual(0);
		}
	});

	test("a complete assistant message without stream frames still opens its call", async () => {
		const { outcome, members } = await run([
			{ kind: "text", text: "plain answer", usage: { inputTokens: 7 } },
		]);
		expect(outcome.kind).toBe("ok");
		expect(types(members[0]!.chunks)).toContain("start-step");
		expect(types(members[0]!.chunks)).toContain("finish");
		if (outcome.kind === "ok") {
			expect(outcome.responseMessage?.parts).toEqual([{ type: "text", text: "plain answer" }]);
			expect(outcome.finishReason).toBe("stop");
			expect(outcome.lastStepInputTokens).toBe(7);
		}
	});

	test("reasoning rides the wire and the reply message", async () => {
		const { outcome, head } = await run([
			{ kind: "reasoning", text: "thinking hard" },
			{ kind: "text", text: "answer" },
		]);
		expect(head.reasoning).toBe("thinking hard");
		if (outcome.kind === "ok") {
			expect(outcome.responseMessage?.parts).toEqual([
				{ type: "reasoning", text: "thinking hard" },
				{ type: "text", text: "answer" },
			]);
		}
	});

	test("two text steps join with the display-sink paragraph break", async () => {
		const { head } = await run([
			{ kind: "stream-text", text: "part one" },
			{ kind: "stream-text", text: "part two" },
		]);
		expect(head.text).toBe("part onepart two".replace("part two", "\n\npart two"));
	});

	test("usage accumulates across steps; lastInput is the final step's", async () => {
		const { outcome, members } = await run([
			{ kind: "text", text: "one", usage: { inputTokens: 10, outputTokens: 4 } },
			{ kind: "text", text: "two", usage: { inputTokens: 20, outputTokens: 6 } },
		]);
		if (outcome.kind !== "ok") throw new Error("expected ok");
		expect(outcome.usage).toMatchObject({ inputTokens: 30, outputTokens: 10 });
		expect(outcome.lastStepInputTokens).toBe(20);
		const ctx = members[0]!.chunks.find((c) => c.type === "data-context");
		expect(ctx).toBeDefined();
	});

	test("steered messages are never claimed — they defer to the next turn", async () => {
		const { outcome, claimed } = await run([{ kind: "text", text: "ok" }]);
		expect(claimed).toEqual([]);
		if (outcome.kind !== "ok") throw new Error("expected ok");
		expect(outcome.steerMark).toBe(0);
	});
});

describe("driveClaude — tool round-trip through the real bridge", () => {
	test("adoption emits the exact goblin output on the wire", async () => {
		const { outcome, members, head } = await run(
			(getBridge) => [
				{
					kind: "tool",
					name: "echo",
					input: { message: "hi" },
					run: () => getBridge()!.invoke("echo", { message: "hi" }),
					usage: { inputTokens: 500, outputTokens: 50 },
				},
				{ kind: "text", text: "did the echo", usage: { inputTokens: 700 } },
			],
			{ tools: echoTools() },
		);
		if (outcome.kind !== "ok") throw new Error("expected ok");
		const input = members[0]!.chunks.find((c) => c.type === "tool-input-available");
		expect(input).toMatchObject({
			toolCallId: expect.any(String),
			toolName: "echo",
			input: { message: "hi" },
		});
		const output = members[0]!.chunks.find((c) => c.type === "tool-output-available");
		expect(output).toMatchObject({ output: "echo:hi" });
		expect(outcome.toolCalls).toEqual(["echo"]);
		expect(head.calls).toEqual([{ tool: "echo", input: { message: "hi" } }]);
		const toolPart = outcome.responseMessage?.parts.find((p) => p.type === "tool-echo");
		expect(toolPart).toMatchObject({ state: "output-available", output: "echo:hi" });
		expect(outcome.finishReason).toBe("stop");
	});

	test("a failing tool lands as tool-output-error with the bridge's error text", async () => {
		const { outcome, members } = await run(
			(getBridge) => [
				{
					kind: "tool",
					name: "failing",
					input: {},
					run: () => getBridge()!.invoke("failing", {}),
				},
				{ kind: "text", text: "recovered" },
			],
			{ tools: echoTools() },
		);
		if (outcome.kind !== "ok") throw new Error("expected ok");
		const errChunk = members[0]!.chunks.find((c) => c.type === "tool-output-error");
		// The adopted bridge error, not the CLI-rendered echo content.
		expect(errChunk).toMatchObject({ errorText: "boom-from-tool" });
		const toolPart = outcome.responseMessage?.parts.find((p) => p.type === "tool-failing");
		expect(toolPart).toMatchObject({ state: "output-error" });
	});

	test("the journal writes no stale planned rows and records checkpoint partials", async () => {
		const { outcome, rec } = await run(
			(getBridge) => [
				{
					kind: "tool",
					name: "echo",
					input: { message: "journaled" },
					run: () => getBridge()!.invoke("echo", { message: "journaled" }),
				},
				{ kind: "text", text: "done" },
			],
			{ tools: echoTools() },
		);
		expect(outcome.kind).toBe("ok");
		// No planned rows: the CLI's ids never match fenceTools' journal ids.
		expect(rec.inputs).toEqual([]);
		expect(rec.checkpoints.length).toBeGreaterThanOrEqual(2);
		const last = rec.checkpoints.at(-1) as { partial?: ModelMessage[] };
		const partial = last.partial ?? [];
		// assistant(tool-call) → tool(result) → assistant(text), in order.
		expect(partial.map((m) => m.role)).toEqual(["assistant", "tool", "assistant"]);
	});
});

describe("driveClaude — failures and recovery", () => {
	test("a rate-limit result fails loud with distinct text and no retry", async () => {
		const { outcome, members } = await run([
			{
				kind: "error",
				resultText:
					"You've hit the Claude Code usage limit. Try again after 3:00pm (5-hour window).",
			},
		]);
		if (outcome.kind !== "failed") throw new Error("expected failed");
		expect(outcome.errorText).toContain("Claude Code subscription limit hit");
		// Failed turns surface an error chunk on the wire.
		expect(types(members[0]!.chunks)).toContain("error");
	});

	test("an auth-flavored result names the record to rotate", async () => {
		const { outcome } = await run([
			{
				kind: "error",
				resultText: "Claude Code returned an error result: Not logged in · Please run /login",
			},
		]);
		if (outcome.kind !== "failed") throw new Error("expected failed");
		expect(outcome.errorText).toContain("Claude Code auth failed");
	});

	test("overflow with recovery enabled holds for recovery and withholds the error chunk", async () => {
		const { outcome, members } = await run(
			[
				{ kind: "text", text: "partial work", usage: { inputTokens: 300 } },
				{
					kind: "error",
					resultText:
						"Prompt is too long: 190234 tokens > 200000 maximum. Compact the conversation.",
				},
			],
			{ overflowRecoverable: true },
		);
		if (outcome.kind !== "failed") throw new Error("expected failed");
		expect(outcome.holdForRecovery).toBe(true);
		expect(types(members[0]!.chunks)).not.toContain("error");
		// The window of the completed step rides the failed rail.
		expect(outcome.window).not.toBeNull();
		expect(outcome.steps).toBe(1);
	});

	test("a thrown query error fails the turn with the message", async () => {
		const { outcome } = await run([{ kind: "error", throw: new Error("child crashed hard") }]);
		if (outcome.kind !== "failed") throw new Error("expected failed");
		expect(outcome.errorText).toBe("child crashed hard");
		expect(outcome.holdForRecovery).toBe(false);
	});

	test("a fenced turn surfaces the authority error, not a provider failure", async () => {
		const controller = new AbortController();
		let fences = 0;
		const r = rig({
			assertAuthority: () => {
				fences += 1;
				if (fences > 1) throw new Error("fenced: epoch advanced");
			},
			signal: controller.signal,
		});
		const fake = fakeClaude([
			{ kind: "text", text: "never lands" },
			{ kind: "text", text: "also never" },
		]);
		await expect(
			driveClaude(
				{
					query: fake.query,
					auth: fakeAuth,
					configRef: fakeConfigRef(),
					configDir: "/tmp",
				},
				{ ...r.deps },
			),
		).rejects.toThrow("fenced: epoch advanced");
	});
});

describe("driveClaude — the prompt and request identity", () => {
	test("one query call carries the serialized view and isolated child env", async () => {
		const { fake } = await run([{ kind: "text", text: "ok" }]);
		expect(fake.calls.length).toBe(1);
		const call = fake.calls[0]!;
		const texts = call.prompt.blocks
			.filter((b) => b.kind === "text")
			.map((b) => (b.kind === "text" ? b.text : ""));
		expect(texts[0]).toContain("[operator]");
		expect(texts.at(-1)).toContain("You are goblin");
		expect(call.options.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("token-for-claude-code");
		expect(call.options.env.CLAUDE_CONFIG_DIR).toBe("/tmp");
		expect(call.options.systemPrompt).toBe("test system");
		expect(call.options.model).toBe("claude-sonnet-4-5");
		expect(call.options.mcpServers).toHaveProperty("goblin");
		expect(call.options.allowedTools).toEqual(["mcp__goblin"]);
	});

	test("media blocks ride the prompt at their transcript position", async () => {
		const messages: ModelMessage[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "look at this" },
					{
						type: "file",
						mediaType: "image/png",
						data: "aGVsbG8=",
						filename: "shot.png",
					},
				],
			},
		];
		const { fake } = await run([{ kind: "text", text: "ok" }], { messages });
		const blocks = fake.calls[0]!.prompt.blocks;
		// Media precedes its message's text (deterministic position).
		expect(blocks[0]).toEqual({
			kind: "image",
			mediaType: "image/png",
			data: "aGVsbG8=",
		});
		expect(blocks[1]).toEqual({ kind: "text", text: "[operator]\nlook at this" });
	});
});

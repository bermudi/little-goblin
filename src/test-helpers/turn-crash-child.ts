// Env: DB_PATH, MARKER_PATH, MODE — where MODE holds the stall point:
//   plan-only:         a call to a tool with no execute — journaled at
//                      the chunk seam, never dispatched, so the row
//                      sits 'planned'. (Provider-executed calls are no
//                      longer journaled at all.)
//                      (The SDK buffers tool parts until model-call-end
//                      for retries, so a normal call has no
//                      planned-before-dispatch window to hold open.)
//   hang-in-tool:      execute marks the host then never returns —
//                      'dispatched' mid-side-effect.
//   complete-then-stall: second model call never answers — 'completed'
//                      mid-turn.
//   overflow-stall:    second call overflows the context (compaction
//                      wired, exchanges pre-seeded) and the resumed
//                      attempt's first call never answers — the kill
//                      lands on the continuation, not the overflowed one.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { APICallError, type LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { tool, type LanguageModel, type ToolSet } from "ai";
import { z } from "zod";
import { openStore } from "../conversation.ts";
import { setLogFile } from "../log.ts";
import { Runtime, userMessage } from "../runtime.ts";
import type { TurnDone, TurnSink } from "../turn/sink.ts";
import { aiSdkEngine } from "../turn/ai-sdk-engine.ts";
import { openTurnJournal } from "../turn-journal.ts";

const DB_PATH = process.env.DB_PATH ?? "";
const MARKER_PATH = process.env.MARKER_PATH ?? "";
const MODE = process.env.MODE ?? "";
if (DB_PATH === "" || MARKER_PATH === "" || MODE === "") {
	throw new Error("DB_PATH/MARKER_PATH/MODE are required");
}
setLogFile(null);

const idle = () => new Promise<never>(() => {});

const streamStart: LanguageModelV4StreamPart = { type: "stream-start", warnings: [] };
const callPart: LanguageModelV4StreamPart = {
	type: "tool-call",
	toolCallId: "call-1",
	toolName: "probe",
	input: "{}",
};
const plannedCallPart: LanguageModelV4StreamPart = {
	type: "tool-call",
	toolCallId: "call-1",
	toolName: "declared",
	input: "{}",
};
const finishPart: LanguageModelV4StreamPart = {
	type: "finish",
	finishReason: { unified: "tool-calls", raw: undefined },
	usage: {
		inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
		outputTokens: { total: 1, text: undefined, reasoning: undefined },
	},
};

const parts = (list: LanguageModelV4StreamPart[]) =>
	new ReadableStream<LanguageModelV4StreamPart>({
		start(controller) {
			for (const p of list) controller.enqueue(p);
			// Left open — the mode decides what the parent kills.
		},
	});

// The step ends — the overflow mode's leg has to complete so the next
// model call (the overflow) happens.
const closedParts = (list: LanguageModelV4StreamPart[]) =>
	new ReadableStream<LanguageModelV4StreamPart>({
		start(controller) {
			for (const p of list) controller.enqueue(p);
			controller.close();
		},
	});

let streamCalls = 0;
const model = {
	specificationVersion: "v4",
	provider: "fake",
	modelId: "fake-1",
	supportedUrls: {},
	doGenerate() {
		throw new Error("unimplemented");
	},
	doStream() {
		streamCalls += 1;
		if (MODE === "overflow-stall") {
			// 1: probe runs (marker + journaled result); 2: the provider
			// rejects for context size (compaction + resume); 3: the
			// continuation's first call never answers — the kill point.
			if (streamCalls === 1) return { stream: closedParts([streamStart, callPart, finishPart]) };
			if (streamCalls === 2) {
				throw new APICallError({
					message:
						"This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
					url: "https://api.openai.com/v1/chat/completions",
					requestBodyValues: {},
					statusCode: 400,
				});
			}
			return { stream: parts([]) };
		}
		if (streamCalls > 1) return { stream: parts([]) }; // second step never answers
		if (MODE === "plan-only") {
			return { stream: parts([streamStart, plannedCallPart, finishPart]) };
		}
		return { stream: parts([streamStart, callPart, finishPart]) };
	},
} as unknown as LanguageModel;

const probeTools = {
	probe: tool({
		inputSchema: z.object({}),
		execute: async () => {
			appendFileSync(MARKER_PATH, "dispatched\n");
			if (MODE === "hang-in-tool") await idle();
			return { ok: true };
		},
	}),
};
// No execute: the call is declared to the journal but nothing can ever
// enter it — plan-only's never-dispatched row. Plan-only only: the
// overflow mode's resume compares the tool surface.
const tools: ToolSet =
	MODE === "plan-only"
		? { ...probeTools, declared: tool({ inputSchema: z.object({}) }) }
		: probeTools;

// Below DB_PATH's dir — a SIGKILLed child leaks nothing the parent
// won't remove.
const workspace = join(dirname(DB_PATH), "ws");
mkdirSync(workspace, { recursive: true });
const store = openStore(DB_PATH);
const turnJournal = openTurnJournal(store.db);
const conv = store.resolve({ kind: "dm", chatId: 1 }, workspace);
if (MODE === "overflow-stall") {
	// Completed exchanges for the overflow compaction to fold.
	const big = "x".repeat(600);
	for (let i = 0; i < 3; i++) {
		store.append(conv.id, [userMessage([{ type: "text", text: `${big} q${i}` }])]);
		store.append(
			conv.id,
			[{ id: `a${i}`, role: "assistant", parts: [{ type: "text", text: `${big} r${i}` }] }],
			{ anchorSeq: store.lastUserSeq(conv.id) },
		);
	}
}
const runtime = new Runtime({
	engines: [aiSdkEngine],
	store,
	turnJournal,
	buildStep: () => ({
		model,
		system: "crash test",
		// A small window makes the pre-seeded exchanges compactable —
		// the overflow recovery needs a span to fold.
		...(MODE === "overflow-stall" ? { contextWindow: 1000 } : {}),
	}),
	makeTools: () => tools,
	...(MODE === "overflow-stall"
		? {
				compaction: {
					modelRef: () => "m",
					contextWindow: () => 1000,
					summarize: async () => "the folded era",
				},
			}
		: {}),
});
const sink: TurnSink = {
	onTextDelta() {},
	onReasoningDelta() {},
	onToolCall() {},
	onDone(_done: TurnDone) {},
};
runtime.submit(conv, userMessage([{ type: "text", text: "run probe" }]), sink);
// The parent watches the marker or the journal; this process never
// exits on its own.
await idle();

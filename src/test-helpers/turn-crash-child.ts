// Child process for the turn-journal crash test: a real Runtime over a
// real goblin.sqlite whose "probe" tool and scripted model stop at a
// MODE-selected point; the parent SIGKILLs there and reopens the store.
// Env (no secrets): DB_PATH, MARKER_PATH, MODE —
//   plan-only:         the model emits a provider-executed call — the
//                      fence never dispatches those, so the row sits
//                      'planned' while the next step never answers.
//                      (The SDK buffers tool parts until model-call-end
//                      for the retry machinery, so a normal call has no
//                      planned-before-dispatch window to hold open.)
//   hang-in-tool:      probe's execute marks the host then never returns —
//                      the call sits 'dispatched' mid-side-effect.
//   complete-then-stall: probe returns, the second model call never
//                      answers — the call sits 'completed' mid-turn.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { tool, type LanguageModel } from "ai";
import { z } from "zod";
import { openStore } from "../conversation.ts";
import { setLogFile } from "../log.ts";
import { Runtime, userMessage, type TurnDone, type TurnSink } from "../runtime.ts";
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
const providerCallPart: LanguageModelV4StreamPart = {
	type: "tool-call",
	toolCallId: "call-1",
	toolName: "probe",
	input: "{}",
	providerExecuted: true,
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
		if (streamCalls > 1) return { stream: parts([]) }; // second step never answers
		if (MODE === "plan-only") {
			return { stream: parts([streamStart, providerCallPart, finishPart]) };
		}
		return { stream: parts([streamStart, callPart, finishPart]) };
	},
} as unknown as LanguageModel;

const tools = {
	probe: tool({
		inputSchema: z.object({}),
		execute: async () => {
			appendFileSync(MARKER_PATH, "dispatched\n");
			if (MODE === "hang-in-tool") await idle();
			return { ok: true };
		},
	}),
};

// The workspace sits below the parent's own temp dir (DB_PATH's dir)
// so a SIGKILLed child leaks nothing the parent won't remove.
const workspace = join(dirname(DB_PATH), "ws");
mkdirSync(workspace, { recursive: true });
const store = openStore(DB_PATH);
const turnJournal = openTurnJournal(store.db);
const conv = store.resolve({ kind: "dm", chatId: 1 }, workspace);
const runtime = new Runtime({
	store,
	turnJournal,
	buildStep: () => ({ model, system: "crash test" }),
	makeTools: () => tools,
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

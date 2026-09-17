import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel, UIMessage } from "ai";
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";
import { openStore, type ConversationStore } from "./conversation.ts";
import { Runtime, userMessage, type TurnDone, type TurnSink } from "./runtime.ts";

let dirs: string[] = [];
function tmpdb(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-rt-"));
	dirs.push(dir);
	return join(dir, "goblin.sqlite");
}
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fake the model provider at the edge: a LanguageModelV2 that streams the
// given deltas with a delay between each.
function fakeModel(deltas: string[], delayMs = 15): LanguageModel {
	return {
		specificationVersion: "v2",
		provider: "fake",
		modelId: "fake-1",
		supportedUrls: {},
		doGenerate() {
			throw new Error("unimplemented");
		},
		doStream(options: { abortSignal?: AbortSignal }) {
			const signal = options.abortSignal;
			const stream = new ReadableStream<LanguageModelV2StreamPart>({
				async start(controller) {
					const push = (p: LanguageModelV2StreamPart) => {
						try {
							controller.enqueue(p);
						} catch {
							/* closed by abort */
						}
					};
					push({ type: "stream-start", warnings: [] });
					push({ type: "text-start", id: "t1" });
					for (const d of deltas) {
						if (signal?.aborted) break;
						await sleep(delayMs);
						push({ type: "text-delta", id: "t1", delta: d });
					}
					push({ type: "text-end", id: "t1" });
					push({
						type: "finish",
						finishReason: "stop",
						usage: { inputTokens: 1, outputTokens: deltas.length, totalTokens: 2 },
					});
					try {
						controller.close();
					} catch {
						/* already closed */
					}
				},
			});
			return { stream };
		},
	} as unknown as LanguageModel;
}

class RecordingSink implements TurnSink {
	text = "";
	done: Promise<TurnDone>;
	private resolveDone: (d: TurnDone) => void;
	constructor() {
		let r: (d: TurnDone) => void = () => {};
		this.done = new Promise<TurnDone>((res) => {
			r = res;
		});
		this.resolveDone = r;
	}
	onTextDelta(d: string) {
		this.text += d;
	}
	onReasoningDelta() {}
	onToolCall() {}
	onDone(d: TurnDone) {
		this.resolveDone(d);
	}
}

function setup(deltas: string[], delayMs = 15) {
	const store = openStore(tmpdb());
	const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
	const runtime = new Runtime({
		store,
		buildStep: () => ({ model: fakeModel(deltas, delayMs), system: "test" }),
		makeTools: () => ({}),
	});
	return { store, conv, runtime };
}

describe("turn authority", () => {
	test("clean turn completes and persists the assistant message", async () => {
		const { store, conv, runtime } = setup(["hello", " world"], 5);
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "hi" }]), sink);
		expect(await sink.done).toEqual({ kind: "completed" });
		expect(sink.text).toBe("hello world");
		const roles = store.history(conv.id).map((m) => m.role);
		expect(roles).toEqual(["user", "assistant"]);
		store.close();
	});

	test("epoch advance mid-turn fences it — quietly, no assistant append", async () => {
		const { store, conv, runtime } = setup(["a", "b", "c", "d", "e"], 20);
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "hi" }]), sink);
		await sleep(50); // a couple of deltas in
		store.bumpEpoch(conv.id); // settings change, e.g. /think
		expect(await sink.done).toEqual({ kind: "fenced" });
		expect(sink.text.length).toBeGreaterThan(0);
		expect(sink.text.length).toBeLessThan(5);
		// the fenced turn must not write assistant output into history
		expect(store.history(conv.id).map((m) => m.role)).toEqual(["user"]);
		store.close();
	});

	test("/stop aborts and drains the queue", async () => {
		const { store, conv, runtime } = setup(["x", "y", "z", "w"], 30);
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "hi" }]), sink);
		await sleep(40);
		runtime.stop(conv.id);
		const d = await sink.done;
		expect(d.kind === "fenced" || d.kind === "aborted").toBe(true);
		store.close();
	});

	test("queued turns run serially", async () => {
		const { store, conv, runtime } = setup(["r"], 10);
		const s1 = new RecordingSink();
		const s2 = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "one" }]), s1);
		runtime.submit(conv, userMessage([{ type: "text", text: "two" }]), s2);
		await Promise.all([s1.done, s2.done]);
		const users = store.history(conv.id).filter((m) => m.role === "user");
		expect(users).toHaveLength(2);
		store.close();
	});
});

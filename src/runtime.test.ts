import { afterEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool, type LanguageModel, type UIMessage, type UIMessageChunk } from "ai";
import { z } from "zod";
import {
	APICallError,
	type LanguageModelV4,
	type LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { appAddress, captureConversationSettings, openStore } from "./conversation.ts";
import { parseConfig } from "./config.ts";
import type { JevClient } from "./jev.ts";
import { ATTACHMENT_PART } from "./agent/attachments.ts";
import { setLogFile } from "./log.ts";
import { Runtime, userMessage, type TurnDone, type TurnSink } from "./runtime.ts";
import { readFileTool } from "./agent/tools/read.ts";

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
		specificationVersion: "v4",
		provider: "fake",
		modelId: "fake-1",
		supportedUrls: {},
		doGenerate() {
			throw new Error("unimplemented");
		},
		doStream(options: { abortSignal?: AbortSignal }) {
			const signal = options.abortSignal;
			const stream = new ReadableStream<LanguageModelV4StreamPart>({
				async start(controller) {
					const push = (p: LanguageModelV4StreamPart) => {
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
						finishReason: { unified: "stop", raw: undefined },
						usage: {
							inputTokens: {
								total: 1,
								noCache: undefined,
								cacheRead: undefined,
								cacheWrite: undefined,
							},
							outputTokens: { total: deltas.length, text: undefined, reasoning: undefined },
						},
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
	// The raw pass-through hook, recorded verbatim — the app channel's
	// SSE surface is built on this stream.
	chunkTypes: string[] = [];
	chunks: UIMessageChunk[] = [];
	done: Promise<TurnDone>;
	// Resolves when the runtime admits the turn — setAuthorityCheck
	// fires before any model work, the deterministic moment for tests
	// that bump the epoch against a live turn.
	admitted: Promise<void>;
	// Resolves on the first observed text delta — the turn is admitted
	// and mid-stream.
	firstDelta: Promise<void>;
	private resolveDone: (d: TurnDone) => void;
	private markAdmitted: () => void = () => {};
	private markFirstDelta: () => void = () => {};
	constructor() {
		let r: (d: TurnDone) => void = () => {};
		this.done = new Promise<TurnDone>((res) => {
			r = res;
		});
		this.resolveDone = r;
		this.admitted = new Promise<void>((res) => {
			this.markAdmitted = res;
		});
		this.firstDelta = new Promise<void>((res) => {
			this.markFirstDelta = res;
		});
	}
	setAuthorityCheck() {
		this.markAdmitted();
	}
	onTextDelta(d: string) {
		this.text += d;
		this.markFirstDelta();
	}
	onReasoningDelta() {}
	onToolCall() {}
	onStreamChunk(chunk: UIMessageChunk) {
		this.chunkTypes.push(chunk.type);
		this.chunks.push(chunk);
	}
	onDone(d: TurnDone) {
		this.resolveDone(d);
	}
}

// The bell's shape (design/app.md → Spin-off): delivery hooks only —
// no onStreamChunk, so the streaming-lane boundary treats it as
// headless. It only ever sees the turn's terminal outcome.
class HeadlessSink implements TurnSink {
	done: Promise<TurnDone>;
	private resolveDone: (d: TurnDone) => void;
	constructor() {
		let r: (d: TurnDone) => void = () => {};
		this.done = new Promise<TurnDone>((res) => {
			r = res;
		});
		this.resolveDone = r;
	}
	onTextDelta() {}
	onReasoningDelta() {}
	onToolCall() {}
	onDone(d: TurnDone) {
		this.resolveDone(d);
	}
}

// The delivery-completion park: the turn finished and its onDone
// is held on a gate, so the drain loop is still "running" while new
// submits only queue (#82's repro shape — a slow Telegram send or
// bell delivery holding the lane open).
class ParkedDoneSink implements TurnSink {
	done: Promise<TurnDone>;
	private resolveDone: (d: TurnDone) => void = () => {};
	constructor(private gate: Promise<void>) {
		this.done = new Promise<TurnDone>((res) => {
			this.resolveDone = res;
		});
	}
	onTextDelta() {}
	onReasoningDelta() {}
	onToolCall() {}
	async onDone(d: TurnDone) {
		this.resolveDone(d);
		await this.gate;
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

describe("provider-filter retry", () => {
	// Verbatim Telegram warning supplied by the operator. These scripted
	// model-edge failures exercise SDK recovery, not an assumed z.ai envelope.
	const warning =
		"[System detected potentially unsafe or sensitive content in input or generation. Please avoid using prompts that may generate sensitive content. Thank you for your cooperation.][20261005061517b57fc824";
	const finish = (reason: "stop" | "tool-calls" | "content-filter"): LanguageModelV4StreamPart => ({
		type: "finish",
		finishReason: { unified: reason, raw: undefined },
		usage: {
			inputTokens: { total: 10, noCache: 2, cacheRead: 8, cacheWrite: undefined },
			outputTokens: { total: 1, text: 1, reasoning: undefined },
		},
	});
	const answer = (text = "Recovered answer"): LanguageModelV4StreamPart[] => [
		{ type: "text-start", id: "text" },
		{ type: "text-delta", id: "text", delta: text },
		{ type: "text-end", id: "text" },
		finish("stop"),
	];
	const call: LanguageModelV4StreamPart = {
		type: "tool-call",
		toolCallId: "call",
		toolName: "probe",
		input: "{}",
	};
	const blocked: LanguageModelV4StreamPart = { type: "error", error: new Error(warning) };

	function scripted(
		attempts: (
			| LanguageModelV4StreamPart[]
			| Error
			| { readError: Error }
			| { cancelError: Error }
		)[],
	) {
		const requests: string[] = [];
		const model: LanguageModelV4 = {
			specificationVersion: "v4",
			provider: "fake",
			modelId: "filter-test",
			supportedUrls: {},
			doGenerate() {
				throw new Error("unused");
			},
			async doStream(options) {
				const attempt = attempts[requests.length];
				requests.push(JSON.stringify(options));
				if (attempt === undefined) throw new Error("unexpected extra model request");
				if (attempt instanceof Error) throw attempt;
				return {
					stream: new ReadableStream<LanguageModelV4StreamPart>({
						start(controller) {
							if ("readError" in attempt) {
								controller.error(attempt.readError);
								return;
							}
							if ("cancelError" in attempt) {
								controller.enqueue(blocked);
								return; // Leave open so reader.cancel exercises cleanup.
							}
							controller.enqueue({ type: "stream-start", warnings: [] });
							for (const part of attempt) controller.enqueue(part);
							controller.close();
						},
						cancel() {
							if ("cancelError" in attempt) throw attempt.cancelError;
						},
					}),
				};
			},
		};
		return { model, requests };
	}

	for (const [name, failure] of [
		["SSE error chunk", [blocked]],
		["HTTP rejection", new Error(warning)],
		["stream read rejection", { readError: new Error(warning) }],
		["content-filter finish reason", [finish("content-filter")]],
	] satisfies [string, LanguageModelV4StreamPart[] | Error | { readError: Error }][]) {
		test(`${name}: retries identical request, hides first error from both delivery hooks and history`, async () => {
			const { model, requests } = scripted([failure, answer()]);
			const store = openStore(tmpdb());
			const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
			const runtime = new Runtime({
				store,
				buildStep: () => ({ model, system: "unchanged system" }),
				makeTools: () => ({}),
			});
			const sink = new RecordingSink();
			runtime.submit(conv, userMessage([{ type: "text", text: "Discuss German politics" }]), sink);
			expect(await sink.done).toEqual({ kind: "completed" });
			while (runtime.busy(conv.id)) await sleep(1);
			await runtime.shutdown();
			expect(requests).toHaveLength(2);
			expect(requests[0]).toBe(requests[1]);
			expect(sink.text).toBe("Recovered answer");
			expect(sink.chunkTypes).not.toContain("error");
			expect(JSON.stringify(store.history(conv.id))).not.toContain(warning);
			expect(store.history(conv.id)).toHaveLength(2);
			store.close();
		});
	}

	test("preserves earlier tool results and never executes tools from the blocked attempt", async () => {
		const { model, requests } = scripted([
			[call, finish("tool-calls")],
			[{ ...call, toolCallId: "blocked-call" }, blocked],
			answer(),
		]);
		const store = openStore(tmpdb());
		const conv = store.resolve(appAddress("filter-retry"), "/w");
		let executions = 0;
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model, system: "test" }),
			makeTools: () => ({
				probe: tool({
					inputSchema: z.object({}),
					execute: () => {
						executions++;
						return { result: "already completed" };
					},
				}),
			}),
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "Do the action then answer" }]), sink);
		expect(await sink.done).toEqual({ kind: "completed" });
		while (runtime.busy(conv.id)) await sleep(1);
		await runtime.shutdown();
		expect(executions).toBe(1);
		expect(requests).toHaveLength(3);
		expect(requests[1]).toBe(requests[2]);
		expect(requests[2]).toContain("already completed");
		expect(sink.chunkTypes).not.toContain("error");
		expect(JSON.stringify(store.history(conv.id))).not.toContain("blocked-call");
		store.close();
	});

	test("chunked tool input completes the turn instead of leaving the sink running forever", async () => {
		const { model, requests } = scripted([
			[
				{ type: "tool-input-start", id: "call", toolName: "probe" },
				{ type: "tool-input-delta", id: "call", delta: "{" },
				{ type: "tool-input-delta", id: "call", delta: "}" },
				{ type: "tool-input-end", id: "call" },
				call,
				finish("tool-calls"),
			],
			answer(),
		]);
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		let executions = 0;
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model, system: "test" }),
			makeTools: () => ({
				probe: tool({
					inputSchema: z.object({}),
					execute: () => {
						executions++;
						return { ok: true };
					},
				}),
			}),
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "Use the tool then answer" }]), sink);
		expect(await sink.done).toEqual({ kind: "completed" });
		while (runtime.busy(conv.id)) await sleep(1);
		await runtime.shutdown();
		expect(executions).toBe(1);
		expect(requests).toHaveLength(2);
		expect(sink.text).toBe("Recovered answer");
		expect(store.history(conv.id)).toHaveLength(2);
		store.close();
	}, 3_000);

	test("a second filter later in the turn exhausts the retry budget and saves no failed reply", async () => {
		const { model, requests } = scripted([
			[blocked],
			[call, finish("tool-calls")],
			[finish("content-filter")],
		]);
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model, system: "test" }),
			makeTools: () => ({ probe: tool({ inputSchema: z.object({}), execute: () => "done" }) }),
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "test" }]), sink);
		expect(await sink.done).toEqual({
			kind: "error",
			message: "Provider blocked this request again after one retry.",
		});
		while (runtime.busy(conv.id)) await sleep(1);
		await runtime.shutdown();
		expect(requests).toHaveLength(3);
		expect(sink.chunkTypes.filter((type) => type === "error")).toHaveLength(1);
		expect(store.history(conv.id)).toHaveLength(1);
		store.close();
	});

	test("ordinary assistant refusal text is an answer, not a retry signal", async () => {
		const { model, requests } = scripted([answer(warning)]);
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model, system: "test" }),
			makeTools: () => ({}),
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "test" }]), sink);
		expect(await sink.done).toEqual({ kind: "completed" });
		while (runtime.busy(conv.id)) await sleep(1);
		await runtime.shutdown();
		expect(requests).toHaveLength(1);
		expect(sink.text).toBe(warning);
		store.close();
	});

	for (const [name, error] of [
		["plain error", blocked.error],
		["nested error", { error: { message: warning } }],
		["nested response error", { response: { error: { message: warning } } }],
	] satisfies [string, unknown][])
		test(`two blocked attempts (${name}) cannot expose their tool calls`, async () => {
			const failure: LanguageModelV4StreamPart = { type: "error", error };
			const { model, requests } = scripted([
				[call, failure],
				[call, failure],
			]);
			const store = openStore(tmpdb());
			const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
			let executions = 0;
			const runtime = new Runtime({
				store,
				buildStep: () => ({ model, system: "test" }),
				makeTools: () => ({
					probe: tool({
						inputSchema: z.object({}),
						execute: () => {
							executions++;
							return "done";
						},
					}),
				}),
			});
			const sink = new RecordingSink();
			runtime.submit(conv, userMessage([{ type: "text", text: "test" }]), sink);
			expect((await sink.done).kind).toBe("error");
			while (runtime.busy(conv.id)) await sleep(1);
			await runtime.shutdown();
			expect(requests).toHaveLength(2);
			expect(executions).toBe(0);
			expect(sink.chunkTypes).not.toContain("tool-input-available");
			store.close();
		});

	test("cancellation cleanup failure is logged without replacing the filter retry", async () => {
		const { model, requests } = scripted([{ cancelError: new Error("cancel failed") }, answer()]);
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model, system: "test" }),
			makeTools: () => ({}),
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "test" }]), sink);
		expect(await sink.done).toEqual({ kind: "completed" });
		while (runtime.busy(conv.id)) await sleep(1);
		await runtime.shutdown();
		expect(requests).toHaveLength(2);
		expect(sink.text).toBe("Recovered answer");
		expect(sink.chunkTypes).not.toContain("error");
		store.close();
	});

	test("ordinary retryable HTTP failures retain the existing SDK retry policy", async () => {
		const { model, requests } = scripted([
			new APICallError({
				message: "Service unavailable",
				url: "https://provider.invalid/responses",
				requestBodyValues: {},
				statusCode: 503,
				isRetryable: true,
			}),
			answer(),
		]);
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model, system: "test" }),
			makeTools: () => ({}),
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "test" }]), sink);
		expect(await sink.done).toEqual({ kind: "completed" });
		while (runtime.busy(conv.id)) await sleep(1);
		await runtime.shutdown();
		expect(requests).toHaveLength(2);
		expect(sink.chunkTypes).not.toContain("error");
		store.close();
	});

	test("stop during filter cleanup prevents a second model request", async () => {
		let entered: () => void = () => {};
		let release: () => void = () => {};
		const cleaning = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let requests = 0;
		const model: LanguageModelV4 = {
			specificationVersion: "v4",
			provider: "fake",
			modelId: "filter-test",
			supportedUrls: {},
			doGenerate() {
				throw new Error("unused");
			},
			async doStream() {
				requests++;
				return {
					stream: new ReadableStream<LanguageModelV4StreamPart>({
						start(controller) {
							controller.enqueue(blocked);
						},
						async cancel() {
							entered();
							await gate;
						},
					}),
				};
			},
		};
		const store = openStore(tmpdb());
		const conv = store.resolve(appAddress("filter-cleanup"), "/w");
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model, system: "test" }),
			makeTools: () => ({}),
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "test" }]), sink);
		await cleaning;
		runtime.stop(conv.id);
		release();
		expect(await sink.done).toEqual({ kind: "fenced" });
		while (runtime.busy(conv.id)) await sleep(1);
		await runtime.shutdown();
		expect(requests).toBe(1);
		expect(sink.chunkTypes).not.toContain("error");
		expect(store.history(conv.id)).toHaveLength(1);
		store.close();
	});

	test("a late filter preserves already-streamed text, without exposing the filter error", async () => {
		const { model, requests } = scripted([
			[
				{ type: "text-start", id: "partial" },
				{ type: "text-delta", id: "partial", delta: "Partial answer. " },
				finish("content-filter"),
			],
			answer(),
		]);
		const store = openStore(tmpdb());
		const conv = store.resolve(appAddress("late-filter"), "/w");
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model, system: "test" }),
			makeTools: () => ({}),
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "test" }]), sink);
		expect(await sink.done).toEqual({ kind: "completed" });
		while (runtime.busy(conv.id)) await sleep(1);
		await runtime.shutdown();
		expect(requests).toHaveLength(2);
		expect(requests[0]).toBe(requests[1]);
		expect(sink.text.replace(/\s+/g, " ").trim()).toBe("Partial answer. Recovered answer");
		expect(sink.chunkTypes).not.toContain("error");
		// UI history is what the operator actually saw, including the partial.
		expect(JSON.stringify(store.history(conv.id))).toContain("Partial answer.");
		expect(JSON.stringify(store.history(conv.id))).not.toContain("Provider content filter");
		store.close();
	});

	test("stop while a rejected call is pending prevents its retry", async () => {
		const { model, requests } = scripted([new Error(warning)]);
		let entered: () => void = () => {};
		let release: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const slowModel: LanguageModelV4 = {
			...model,
			async doStream(options) {
				entered();
				await gate;
				return model.doStream(options);
			},
		};
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model: slowModel, system: "test" }),
			makeTools: () => ({}),
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "test" }]), sink);
		await started;
		runtime.stop(conv.id);
		release();
		expect(await sink.done).toEqual({ kind: "fenced" });
		while (runtime.busy(conv.id)) await sleep(1);
		await runtime.shutdown();
		expect(requests).toHaveLength(1);
		expect(sink.text).toBe("");
		expect(store.history(conv.id)).toHaveLength(1);
		store.close();
	});
});

// Records the prompt each doStream call receives — JSON-stringified so
// requests compare bytewise across turns (cache-stability tests).
function recordingModel(deltas: string[], delayMs = 15) {
	const prompts: string[] = [];
	const base = fakeModel(deltas, delayMs) as unknown as {
		doStream(o: { prompt: unknown }): { stream: ReadableStream<LanguageModelV4StreamPart> };
	};
	const model = {
		...base,
		doStream(o: { prompt: unknown }) {
			prompts.push(JSON.stringify(o.prompt));
			return base.doStream(o);
		},
	} as unknown as LanguageModel;
	return { model, prompts };
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
		await sink.firstDelta; // first delta observed — turn is mid-stream
		store.bumpEpoch(conv.id); // settings change, e.g. /think
		expect(await sink.done).toEqual({ kind: "fenced" });
		expect(sink.text.length).toBeGreaterThan(0);
		expect(sink.text.length).toBeLessThan(5);
		// the fenced turn must not write assistant output into history
		expect(store.history(conv.id).map((m) => m.role)).toEqual(["user"]);
		store.close();
	});

	test("a settings fence aborts the provider stream, not just the turn loop", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		let seen: AbortSignal | undefined;
		const base = fakeModel(["a", "b", "c", "d", "e"], 20) as unknown as {
			doStream(o: { prompt: unknown; abortSignal?: AbortSignal }): {
				stream: ReadableStream<LanguageModelV4StreamPart>;
			};
		};
		const model = {
			...base,
			doStream(o: { prompt: unknown; abortSignal?: AbortSignal }) {
				seen = o.abortSignal;
				return base.doStream(o);
			},
		} as unknown as LanguageModel;
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model, system: "test" }),
			makeTools: () => ({}),
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "hi" }]), sink);
		await sink.firstDelta; // mid-stream
		store.bumpEpoch(conv.id); // /voice or /memory toggle — no /stop, no abort
		expect(await sink.done).toEqual({ kind: "fenced" });
		// the fence must kill the model call itself: the provider stream
		// cannot keep generating into a stream nobody reads
		expect(seen?.aborted).toBe(true);
		store.close();
	});

	test("/stop aborts and drains the queue", async () => {
		const { store, conv, runtime } = setup(["x", "y", "z", "w"], 30);
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "hi" }]), sink);
		await sleep(40);
		runtime.stop(conv.id);
		const d = await sink.done;
		expect(d.kind).toBe("fenced");
		store.close();
	});

	test("post-commit cancellation requires the committed fence and does not advance it again", async () => {
		const { store, conv, runtime } = setup(["a", "b", "c", "d"], 20);
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "hi" }]), sink);
		await sink.firstDelta;
		expect(() => runtime.cancelFenced(conv.id, 0)).toThrow("committed epoch");
		expect(() => runtime.cancelFenced(conv.id, 1)).toThrow("committed epoch");
		const epoch = store.bumpEpoch(conv.id);
		expect(runtime.cancelFenced(conv.id, epoch).stopped).toBe(true);
		expect(store.get(conv.id)?.epoch).toBe(epoch);
		expect(await sink.done).toEqual({ kind: "fenced" });
		await runtime.shutdown();
		expect(store.history(conv.id).map((message) => message.role)).toEqual(["user"]);
		store.close();
	});

	test("/stop notifies queued turns — every sink gets exactly one onDone", async () => {
		const { store, conv, runtime } = setup(["a", "b", "c", "d"], 30);
		const s1 = new RecordingSink();
		const s2 = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "one" }]), s1);
		await sleep(10); // first turn is running
		runtime.submit(conv, userMessage([{ type: "text", text: "two" }]), s2); // queued
		const { stopped, settled } = runtime.stop(conv.id);
		expect(stopped).toBe(true);
		// the dropped turn's sink is still told, so it can release resources
		expect(await s2.done).toEqual({ kind: "fenced" });
		expect((await s1.done).kind).toBe("fenced");
		await settled;
		store.close();
	});

	test("/stop reports nothing-running on an idle lane — epoch still bumps", async () => {
		const { store, conv, runtime } = setup(["a"], 30);
		const idle = runtime.stop(conv.id);
		expect(idle.stopped).toBe(false);
		// The bump is harmless — and any turn admitted next captures it.
		expect(store.get(conv.id)!.epoch).toBe(1);
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "hi" }]), sink);
		await sleep(5); // admitted and running
		const live = runtime.stop(conv.id);
		expect(live.stopped).toBe(true);
		store.close();
	});

	test("stop().settled resolves only after the dropped sinks' onDone settles", async () => {
		const { store, conv, runtime } = setup(["a", "b", "c", "d"], 30);
		const running = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "one" }]), running);
		await sleep(10); // first turn is running
		// A queued sink whose onDone does a slow final flush.
		let flushed = false;
		const flush = new Promise<void>((r) =>
			setTimeout(() => {
				flushed = true;
				r();
			}, 40),
		);
		const queued: TurnSink = {
			onTextDelta() {},
			onReasoningDelta() {},
			onToolCall() {},
			onDone: async () => {
				await flush;
			},
		};
		runtime.submit(conv, userMessage([{ type: "text", text: "two" }]), queued);
		const { settled } = runtime.stop(conv.id);
		let settledDone = false;
		void settled.then(() => {
			settledDone = true;
		});
		await sleep(15); // stop has run; the flush has not finished
		expect(flushed).toBe(false);
		expect(settledDone).toBe(false);
		await flush;
		await sleep(15);
		expect(settledDone).toBe(true);
		store.close();
	});

	test("a finished lane does not report stoppable turns", async () => {
		const { store, conv, runtime } = setup(["a"], 5);
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "hi" }]), sink);
		await sink.done;
		await sleep(10); // lane fully drained
		expect(runtime.stop(conv.id).stopped).toBe(false);
		store.close();
	});

	test("shutdown fences every lane and resolves after the sinks' onDone", async () => {
		const { store, conv, runtime } = setup(["a", "b", "c", "d", "e"], 20);
		const conv2 = store.resolve({ kind: "dm", chatId: 2 }, "/w");
		const s1 = new RecordingSink();
		const s2 = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "one" }]), s1);
		runtime.submit(conv2, userMessage([{ type: "text", text: "two" }]), s2);
		await sleep(30); // both turns mid-stream
		await runtime.shutdown();
		expect(await s1.done).toEqual({ kind: "fenced" });
		expect(await s2.done).toEqual({ kind: "fenced" });
		// fenced turns commit no assistant output
		expect(store.history(conv.id).map((m) => m.role)).toEqual(["user"]);
		expect(store.history(conv2.id).map((m) => m.role)).toEqual(["user"]);
		store.close();
	});

	test("a submit after shutdown lands in history but never runs", async () => {
		const { store, conv, runtime } = setup(["a"], 5);
		await runtime.shutdown();
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "hi" }]), sink);
		expect(await sink.done).toEqual({ kind: "fenced" });
		await sleep(50); // prove no turn ever starts
		expect(sink.text).toBe("");
		expect(store.history(conv.id).map((m) => m.role)).toEqual(["user"]);
		store.close();
	});

	test("a tool call under stale authority never executes", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		let executed = false;
		const runtime = new Runtime({
			store,
			buildStep: () => ({
				model: {
					specificationVersion: "v4",
					provider: "fake",
					modelId: "fake-1",
					supportedUrls: {},
					doGenerate() {
						throw new Error("unimplemented");
					},
					doStream() {
						const stream = new ReadableStream<LanguageModelV4StreamPart>({
							async start(controller) {
								const push = (p: LanguageModelV4StreamPart) => {
									try {
										controller.enqueue(p);
									} catch {
										/* closed */
									}
								};
								push({ type: "stream-start", warnings: [] });
								await sleep(30); // epoch bump lands before the tool call
								push({
									type: "tool-call",
									toolCallId: "c1",
									toolName: "probe",
									input: "{}",
								});
								push({
									type: "finish",
									finishReason: { unified: "tool-calls", raw: undefined },
									usage: {
										inputTokens: {
											total: 1,
											noCache: undefined,
											cacheRead: undefined,
											cacheWrite: undefined,
										},
										outputTokens: { total: 1, text: undefined, reasoning: undefined },
									},
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
				} as unknown as LanguageModel,
				system: "test",
			}),
			makeTools: () => ({
				probe: tool({
					inputSchema: z.object({}),
					execute: async () => {
						executed = true;
						return { ok: true };
					},
				}),
			}),
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "hi" }]), sink);
		await sink.admitted; // turn holds its epoch — bump cannot race admission
		store.bumpEpoch(conv.id); // settings change mid-turn
		expect(await sink.done).toEqual({ kind: "fenced" });
		expect(executed).toBe(false); // the fenced tool's side effect never ran
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

	test("submits queued behind a running turn coalesce into ONE successor turn", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const { model, prompts } = recordingModel(["answer"], 30);
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model, system: "test" }),
			makeTools: () => ({}),
		});
		const s1 = new RecordingSink();
		const s2 = new RecordingSink();
		const s3 = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "2+2?" }]), s1);
		await sleep(15); // turn 1 is mid-stream
		runtime.submit(conv, userMessage([{ type: "text", text: "2+5?" }]), s2);
		runtime.submit(conv, userMessage([{ type: "text", text: "2+8?" }]), s3);
		// Two queued submits, one successor turn — every sink still gets
		// exactly one onDone.
		expect(await s1.done).toEqual({ kind: "completed" });
		expect(await s2.done).toEqual({ kind: "completed" });
		expect(await s3.done).toEqual({ kind: "completed" });
		expect(prompts).toHaveLength(2); // two model calls for three submits
		// The streaming sink is the first queued one; the rest get the
		// outcome and nothing else.
		expect(s2.text).toBe("answer");
		expect(s3.text).toBe("");
		// The second call's context tells the true story: the first
		// answer sits right after its question, and the queued burst
		// reads as ONE user message, not turns the reply already saw.
		const wire = JSON.parse(prompts[1]!) as {
			role: string;
			content: { type: string; text?: string }[];
		}[];
		const msgs = wire.filter((m) => m.role !== "system");
		expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		expect(msgs[0]!.content.map((c) => c.text)).toEqual(["2+2?"]);
		expect(msgs[1]!.content.map((c) => c.text)).toEqual(["answer"]);
		expect(msgs[2]!.content.map((c) => c.text)).toEqual(["2+5?", "2+8?"]);
		store.close();
	});

	test("a history system event reaches the model as a bracketed user-role note", async () => {
		// The reviewer lands its save note in history as role "system"
		// (design/skills.md — "lands in history as a system event"). The
		// SDK's streamText rejects system messages in `messages`, so the
		// runtime renders the event as a user-role note in position —
		// the stored role is untouched.
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const event =
			"saved skill: talk-first — announced in this topic with an undo invite; " +
			"an undo request means deleting skills/talk-first/";
		store.append(conv.id, [
			{ id: "u1", role: "user", parts: [{ type: "text", text: "earlier question" }] },
			{ id: "a1", role: "assistant", parts: [{ type: "text", text: "earlier answer" }] },
			{ id: "sys1", role: "system", parts: [{ type: "text", text: event }] },
		]);
		const { model, prompts } = recordingModel(["answer"], 5);
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model, system: "test instructions" }),
			makeTools: () => ({}),
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "what did you save?" }]), sink);
		expect(await sink.done).toEqual({ kind: "completed" });
		expect(prompts).toHaveLength(1);
		const wire = JSON.parse(prompts[0]!) as {
			role: string;
			content: { type: string; text?: string }[];
		}[];
		// The only system-role entry on the wire is `instructions` — the
		// frozen per-conversation prefix the fake provider sees as one
		// system prompt item.
		expect(wire.filter((m) => m.role === "system")).toHaveLength(1);
		const msgs = wire.filter((m) => m.role !== "system");
		expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		// The event merges with the trailing user submit: the bracketed
		// note leads the merged message's content, the submit follows.
		expect(msgs[2]!.content.map((c) => c.text)).toEqual([
			`[system event: ${event}]`,
			"what did you save?",
		]);
		// History on disk keeps the system role — the mapping is
		// render-only, at the conversion boundary.
		expect(store.history(conv.id).map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"system",
			"user",
			"assistant",
		]);
		store.close();
	});

	test("distinct text parts stream with a seam — blocks must not fuse in the bubble", async () => {
		// A multi-step turn (text, tool call, more text) emits several text
		// parts. The chat bubble must show them as blocks, not one run-on —
		// "yo 👋 what's up" + "Workspace…" streamed as "upWorkspace" once.
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const runtime = new Runtime({
			store,
			buildStep: () => ({
				model: {
					specificationVersion: "v4",
					provider: "fake",
					modelId: "two-part-1",
					supportedUrls: {},
					doGenerate() {
						throw new Error("unimplemented");
					},
					doStream() {
						const stream = new ReadableStream<LanguageModelV4StreamPart>({
							start(controller) {
								controller.enqueue({ type: "stream-start", warnings: [] });
								controller.enqueue({ type: "text-start", id: "t1" });
								controller.enqueue({
									type: "text-delta",
									id: "t1",
									delta: "yo 👋 what's up",
								});
								controller.enqueue({ type: "text-end", id: "t1" });
								controller.enqueue({ type: "text-start", id: "t2" });
								controller.enqueue({
									type: "text-delta",
									id: "t2",
									delta: "Workspace is basically fresh",
								});
								controller.enqueue({ type: "text-end", id: "t2" });
								controller.enqueue({
									type: "finish",
									finishReason: { unified: "stop", raw: undefined },
									usage: {
										inputTokens: {
											total: 1,
											noCache: undefined,
											cacheRead: undefined,
											cacheWrite: undefined,
										},
										outputTokens: { total: 2, text: undefined, reasoning: undefined },
									},
								});
								controller.close();
							},
						});
						return { stream };
					},
				} as unknown as LanguageModel,
				system: "test",
			}),
			makeTools: () => ({}),
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "hi" }]), sink);
		expect(await sink.done).toEqual({ kind: "completed" });
		expect(sink.text).toBe("yo 👋 what's up\n\nWorkspace is basically fresh");
		store.close();
	});

	test("a two-step turn streams its blocks with seams — even when step 2 reuses step 1's part id", async () => {
		// The real shape: text + tool call in step 1, tool executes, text
		// continues in step 2. Providers synthesizing part ids per request
		// can hand step 2 the SAME id ("t1") — the seam must survive that,
		// so the step boundary itself has to reset the tracker.
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		let executed = false;
		let call = 0;
		const runtime = new Runtime({
			store,
			buildStep: () => ({
				model: {
					specificationVersion: "v4",
					provider: "fake",
					modelId: "two-step-1",
					supportedUrls: {},
					doGenerate() {
						throw new Error("unimplemented");
					},
					doStream() {
						call++;
						const stream = new ReadableStream<LanguageModelV4StreamPart>({
							start(controller) {
								const push = (p: LanguageModelV4StreamPart) => controller.enqueue(p);
								push({ type: "stream-start", warnings: [] });
								if (call === 1) {
									push({ type: "text-start", id: "t1" });
									push({ type: "text-delta", id: "t1", delta: "yo 👋 what's up" });
									push({ type: "text-end", id: "t1" });
									push({ type: "tool-call", toolCallId: "c1", toolName: "probe", input: "{}" });
									push({
										type: "finish",
										finishReason: { unified: "tool-calls", raw: undefined },
										usage: {
											inputTokens: {
												total: 1,
												noCache: undefined,
												cacheRead: undefined,
												cacheWrite: undefined,
											},
											outputTokens: { total: 1, text: undefined, reasoning: undefined },
										},
									});
								} else {
									// Same id as step 1 — deliberate.
									push({ type: "text-start", id: "t1" });
									push({ type: "text-delta", id: "t1", delta: "Workspace is basically fresh" });
									push({ type: "text-end", id: "t1" });
									push({
										type: "finish",
										finishReason: { unified: "stop", raw: undefined },
										usage: {
											inputTokens: {
												total: 1,
												noCache: undefined,
												cacheRead: undefined,
												cacheWrite: undefined,
											},
											outputTokens: { total: 1, text: undefined, reasoning: undefined },
										},
									});
								}
								controller.close();
							},
						});
						return { stream };
					},
				} as unknown as LanguageModel,
				system: "test",
			}),
			makeTools: () => ({
				probe: tool({
					inputSchema: z.object({}),
					execute: async () => {
						executed = true;
						return { ok: true };
					},
				}),
			}),
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "hi" }]), sink);
		expect(await sink.done).toEqual({ kind: "completed" });
		expect(executed).toBe(true); // step 2 really ran — this is the real shape
		expect(sink.text).toBe("yo 👋 what's up\n\nWorkspace is basically fresh");
		store.close();
	});

	test("a failed model stream reports error — no silent completion, no partial append", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const runtime = new Runtime({
			store,
			buildStep: () => ({
				model: {
					specificationVersion: "v4",
					provider: "fake",
					modelId: "err-1",
					supportedUrls: {},
					doGenerate() {
						throw new Error("unimplemented");
					},
					doStream() {
						const stream = new ReadableStream<LanguageModelV4StreamPart>({
							start(controller) {
								controller.enqueue({ type: "stream-start", warnings: [] });
								controller.enqueue({ type: "text-start", id: "t1" });
								controller.enqueue({ type: "text-delta", id: "t1", delta: "partial" });
								controller.enqueue({ type: "error", error: new Error("provider blew up") });
								controller.close();
							},
						});
						return { stream };
					},
				} as unknown as LanguageModel,
				system: "test",
			}),
			makeTools: () => ({}),
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "hi" }]), sink);
		const d = await sink.done;
		expect(d.kind).toBe("error");
		expect((d as { message: string }).message).toContain("provider blew up");
		// the failed turn must not commit its partial assistant output
		expect(store.history(conv.id).map((m) => m.role)).toEqual(["user"]);
		store.close();
	});

	test("an attachment part the model can't consume degrades to its path reference", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		// Stored intake record: path + metadata, no payload.
		store.append(conv.id, [
			{
				id: "u1",
				role: "user",
				parts: [
					{
						type: "data-attachment",
						data: {
							path: "/gone/x.png",
							mediaType: "image/png",
							filename: "x.png",
							size: 10,
						},
					},
				],
			},
		]);
		const { model, prompts } = recordingModel(["ok"], 5);
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model, system: "test" }), // no inputModalities → text-only
			makeTools: () => ({}),
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "hi" }]), sink);
		expect(await sink.done).toEqual({ kind: "completed" });
		expect(prompts[0]).toContain("[attachment: /gone/x.png");
		expect(prompts[0]).not.toContain("data:image/png");
		store.close();
	});

	test("an attachment part materializes inline for a capable model", async () => {
		const dir = mkdtempSync(join(tmpdir(), "goblin-rt-att-"));
		dirs.push(dir);
		const f = join(dir, "x.png");
		writeFileSync(f, "pngdata");
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		store.append(conv.id, [
			{
				id: "u1",
				role: "user",
				parts: [
					{
						type: "data-attachment",
						data: { path: f, mediaType: "image/png", filename: "x.png", size: 7 },
					},
				],
			},
		]);
		const { model, prompts } = recordingModel(["ok"], 5);
		const runtime = new Runtime({
			store,
			buildStep: () => ({
				model,
				system: "test",
				inputModalities: new Set(["text", "image"]),
			}),
			makeTools: () => ({}),
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "hi" }]), sink);
		expect(await sink.done).toEqual({ kind: "completed" });
		expect(prompts[0]).toContain("image/png");
		expect(prompts[0]).not.toContain("[attachment:");
		store.close();
	});

	test("a throwing sink still gets exactly one onDone", async () => {
		const { store, conv, runtime } = setup(["a"], 5);
		let calls = 0;
		runtime.submit(conv, userMessage([{ type: "text", text: "hi" }]), {
			onTextDelta() {},
			onReasoningDelta() {},
			onToolCall() {},
			onDone() {
				calls++;
				throw new Error("sink blew up");
			},
		});
		await sleep(100);
		expect(calls).toBe(1);
		store.close();
	});
});

// ---------- context overflow recovery ----------

// A provider-side context overflow: the OpenAI wording over a 400
// APICallError — the shape a provider actually throws out of doStream.
function overflowError(): APICallError {
	return new APICallError({
		message:
			"This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
		url: "https://api.openai.com/v1/chat/completions",
		requestBodyValues: {},
		statusCode: 400,
	});
}

function textReply(text: string): LanguageModelV4StreamPart[] {
	return [
		{ type: "stream-start", warnings: [] },
		{ type: "text-start", id: "t1" },
		{ type: "text-delta", id: "t1", delta: text },
		{ type: "text-end", id: "t1" },
		{
			type: "finish",
			finishReason: { unified: "stop", raw: undefined },
			usage: {
				inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
				outputTokens: { total: 1, text: undefined, reasoning: undefined },
			},
		},
	];
}

// A model scripted per doStream call: a part list streams verbatim, an
// Error throws out of doStream (a provider rejection — the SDK surfaces
// it as an `error` chunk). Every wire prompt is captured.
function scriptedModel(scripts: Array<LanguageModelV4StreamPart[] | Error>) {
	const prompts: string[] = [];
	let calls = 0;
	const model = {
		specificationVersion: "v4",
		provider: "fake",
		modelId: "fake-1",
		supportedUrls: {},
		doGenerate() {
			throw new Error("unimplemented");
		},
		doStream(o: { prompt: unknown }) {
			prompts.push(JSON.stringify(o.prompt));
			const script = scripts[calls++] ?? textReply("ok");
			if (script instanceof Error) throw script;
			return {
				stream: new ReadableStream<LanguageModelV4StreamPart>({
					start(controller) {
						for (const p of script) controller.enqueue(p);
						controller.close();
					},
				}),
			};
		},
	} as unknown as LanguageModel;
	return { model, prompts };
}

// Enough completed exchanges that chooseBoundary has a span to fold.
function seedExchanges(store: ReturnType<typeof openStore>, convId: string): void {
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

describe("context overflow recovery", () => {
	test("an overflow on the first call compacts and resumes — one stored reply", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		seedExchanges(store, conv.id);
		const { model, prompts } = scriptedModel([overflowError(), textReply("the answer")]);
		const summaries: string[] = [];
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model, system: "test", contextWindow: 1000 }),
			makeTools: () => ({}),
			compaction: {
				modelRef: () => "m",
				summarize: async (_conv, _system, prompt) => {
					summaries.push(prompt);
					return "the folded era";
				},
			},
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "live question" }]), sink);
		expect(await sink.done).toEqual({ kind: "completed" });
		expect(sink.text).toBe("the answer");
		// Exactly one compaction ran; the resumed call read the compacted
		// view — summary carried first, the live question kept in the tail.
		expect(summaries).toHaveLength(1);
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toContain("the folded era");
		expect(prompts[1]).toContain("live question");
		// The held error never reached the client stream.
		expect(sink.chunkTypes).not.toContain("error");
		// One stored assistant reply — the failed attempt left nothing.
		const history = store.history(conv.id);
		expect(history.filter((m) => m.role === "assistant")).toHaveLength(4); // 3 seeded + this turn's
		const last = history.at(-1)!;
		expect(last.role).toBe("assistant");
		const lastText = last.parts.find((p) => p.type === "text") as { text: string } | undefined;
		expect(lastText?.text).toBe("the answer");
		store.close();
	});

	test("a mid-turn overflow resumes without re-running tools — one merged reply", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		seedExchanges(store, conv.id);
		const toolCallScript: LanguageModelV4StreamPart[] = [
			{ type: "stream-start", warnings: [] },
			{ type: "tool-call", toolCallId: "c1", toolName: "probe", input: "{}" },
			{
				type: "finish",
				finishReason: { unified: "tool-calls", raw: undefined },
				usage: {
					inputTokens: {
						total: 1,
						noCache: undefined,
						cacheRead: undefined,
						cacheWrite: undefined,
					},
					outputTokens: { total: 1, text: undefined, reasoning: undefined },
				},
			},
		];
		const { model, prompts } = scriptedModel([
			toolCallScript,
			overflowError(),
			textReply("the final answer"),
		]);
		let executions = 0;
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model, system: "test", contextWindow: 1000 }),
			makeTools: () => ({
				probe: tool({
					inputSchema: z.object({}),
					execute: async () => {
						executions++;
						return "probe-result-7f3a";
					},
				}),
			}),
			compaction: { modelRef: () => "m", summarize: async () => "folded past" },
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "run the probe" }]), sink);
		expect(await sink.done).toEqual({ kind: "completed" });
		// The whole point of the continuation: the failed attempt's tool
		// work is never re-run.
		expect(executions).toBe(1);
		expect(prompts).toHaveLength(3);
		// The resumed prompt carries the failed attempt's tool result —
		// the model continues from where it died, not from scratch.
		expect(prompts[2]).toContain("probe-result-7f3a");
		// The held error never reached the wire, and every `start` chunk —
		// the failed attempt's and the resume's — names the ONE stored
		// message id: the resume continues the partial, it doesn't start
		// a sibling.
		expect(sink.chunkTypes).not.toContain("error");
		const stored = store.history(conv.id).at(-1)!;
		expect(stored.role).toBe("assistant");
		const starts = sink.chunks.filter((c) => c.type === "start");
		expect(starts.length).toBeGreaterThanOrEqual(2);
		for (const c of starts) {
			expect((c as { messageId?: string }).messageId).toBe(stored.id);
		}
		// ONE stored reply holds the completed tool part AND the answer.
		const types = stored.parts.map((p) => p.type);
		expect(types).toContain("tool-probe");
		expect(types).toContain("text");
		const text = stored.parts.find((p) => p.type === "text") as { text: string } | undefined;
		expect(text?.text).toBe("the final answer");
		expect(store.history(conv.id).filter((m) => m.role === "assistant")).toHaveLength(4);
		store.close();
	});

	test("an overflow with nothing left to compact ends with a plain message", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const { model, prompts } = scriptedModel([overflowError(), textReply("unreached")]);
		let summarizeCalls = 0;
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model, system: "test", contextWindow: 1000 }),
			makeTools: () => ({}),
			compaction: {
				modelRef: () => "m",
				summarize: async () => {
					summarizeCalls++;
					return "folded";
				},
			},
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "hi" }]), sink);
		const done = await sink.done;
		expect(done.kind).toBe("error");
		if (done.kind !== "error") return;
		expect(done.message).toContain("nothing left to compact");
		expect(done.message.length).toBeLessThan(200);
		// No boundary was written, and the turn never re-asked the model.
		expect(summarizeCalls).toBe(0);
		expect(prompts).toHaveLength(1);
		store.close();
	});

	test("a second overflow on the resumed attempt ends the turn", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		seedExchanges(store, conv.id);
		const { model, prompts } = scriptedModel([
			overflowError(),
			overflowError(),
			textReply("unreached"),
		]);
		let summarizeCalls = 0;
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model, system: "test", contextWindow: 1000 }),
			makeTools: () => ({}),
			compaction: {
				modelRef: () => "m",
				summarize: async () => {
					summarizeCalls++;
					return "folded past";
				},
			},
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "live question" }]), sink);
		const done = await sink.done;
		expect(done.kind).toBe("error");
		if (done.kind !== "error") return;
		expect(done.message).toContain("still full after compacting");
		expect(done.message.length).toBeLessThan(200);
		// One recovery per turn: one compaction, one resume call, no loop.
		expect(summarizeCalls).toBe(1);
		expect(prompts).toHaveLength(2);
		store.close();
	});

	test("a non-overflow provider error does not compact or resume", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		seedExchanges(store, conv.id);
		const auth = new APICallError({
			message: "Authentication Failed",
			url: "https://api.openai.com/v1/chat/completions",
			requestBodyValues: {},
			statusCode: 401,
		});
		const { model, prompts } = scriptedModel([auth, textReply("unreached")]);
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model, system: "test", contextWindow: 1000 }),
			makeTools: () => ({}),
			compaction: { modelRef: () => "m", summarize: async () => "folded" },
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "hi" }]), sink);
		expect(await sink.done).toEqual({ kind: "error", message: "Authentication Failed" });
		expect(prompts).toHaveLength(1);
		expect(store.getCompaction(conv.id)).toBeNull();
		store.close();
	});

	test("/stop during the overflow compaction fences the turn — no resume", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		seedExchanges(store, conv.id);
		const { model, prompts } = scriptedModel([overflowError(), textReply("unreached")]);
		// Gate the summary call so the stop lands mid-compaction: the
		// compact abort controller must end the attempt, never resume.
		let summarizeStarted!: () => void;
		const started = new Promise<void>((r) => {
			summarizeStarted = r;
		});
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model, system: "test", contextWindow: 1000 }),
			makeTools: () => ({}),
			compaction: {
				modelRef: () => "m",
				summarize: (_conv, _system, _prompt, signal) => {
					summarizeStarted();
					return signal.aborted
						? Promise.reject(new Error("summarize aborted"))
						: new Promise<string>(() => {});
				},
			},
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "live question" }]), sink);
		await started;
		runtime.stop(conv.id);
		expect(await sink.done).toEqual({ kind: "fenced" });
		// The compaction died with the stop; no resume call ever ran.
		await sleep(30);
		expect(prompts).toHaveLength(1);
		expect(store.getCompaction(conv.id)).toBeNull();
		store.close();
	});
});

describe("cache stability", () => {
	// DESIGN.md, Cache stability: the request for turn N+1 is the request
	// for turn N with new content appended — bytes already sent are never
	// rewritten. This is the end-to-end guard: history out of SQLite,
	// through materialization and conversion, onto the wire.
	function prefixOf(request: string, count: number): string {
		const msgs = JSON.parse(request) as unknown[];
		return JSON.stringify(msgs.slice(0, count));
	}
	function messageCount(request: string): number {
		return (JSON.parse(request) as unknown[]).length;
	}

	test("turn N+1's request is turn N's request with content appended", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const { model, prompts } = recordingModel(["hello world"], 5);
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model, system: "test" }),
			makeTools: () => ({}),
		});
		const s1 = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "hi" }]), s1);
		expect(await s1.done).toEqual({ kind: "completed" });
		const s2 = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "again" }]), s2);
		expect(await s2.done).toEqual({ kind: "completed" });
		expect(prompts.length).toBe(2);
		// The whole first request survives verbatim as the head of the
		// second — provider prefix caches stay valid across turns.
		expect(prefixOf(prompts[1]!, messageCount(prompts[0]!))).toBe(prompts[0]!);
		store.close();
	});

	test("inlined image bytes don't move when new media arrives later", async () => {
		const dir = mkdtempSync(join(tmpdir(), "goblin-rt-cache-"));
		dirs.push(dir);
		const a = join(dir, "a.png");
		const b = join(dir, "b.png");
		writeFileSync(a, "pngdata-a");
		writeFileSync(b, "pngdata-b");
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const { model, prompts } = recordingModel(["ok"], 5);
		const runtime = new Runtime({
			store,
			buildStep: () => ({
				model,
				system: "test",
				inputModalities: new Set(["text", "image"]),
			}),
			makeTools: () => ({}),
		});
		const att = (f: string, name: string, size: number): UIMessage["parts"][number] => ({
			type: "data-attachment" as const,
			data: { path: f, mediaType: "image/png", filename: name, size },
		});
		const s1 = new RecordingSink();
		runtime.submit(
			conv,
			userMessage([att(a, "a.png", 9), { type: "text", text: "what is this" }]),
			s1,
		);
		expect(await s1.done).toEqual({ kind: "completed" });
		const s2 = new RecordingSink();
		runtime.submit(conv, userMessage([att(b, "b.png", 9), { type: "text", text: "and this" }]), s2);
		expect(await s2.done).toEqual({ kind: "completed" });
		expect(prompts.length).toBe(2);
		// The first photo's inlined bytes ride the head of the second
		// request unchanged — a new photo never re-decides an old one.
		expect(prefixOf(prompts[1]!, messageCount(prompts[0]!))).toBe(prompts[0]!);
		expect(prompts[0]!).toContain("image/png");
		expect(prompts[1]!).toContain("image/png");
		store.close();
	});

	test("window gauge and cached split land in the log", async () => {
		const dir = mkdtempSync(join(tmpdir(), "goblin-rt-log-"));
		dirs.push(dir);
		const logFile = join(dir, "goblin.log");
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		// One step, reporting a warm cache (700 of 900 input tokens cached)
		// against a 1000-token window — 90% utilization must warn.
		const model = {
			specificationVersion: "v4",
			provider: "fake",
			modelId: "fake-1",
			supportedUrls: {},
			doGenerate() {
				throw new Error("unimplemented");
			},
			doStream() {
				const stream = new ReadableStream<LanguageModelV4StreamPart>({
					start(controller) {
						controller.enqueue({ type: "stream-start", warnings: [] });
						controller.enqueue({ type: "text-start", id: "t1" });
						controller.enqueue({ type: "text-delta", id: "t1", delta: "ok" });
						controller.enqueue({ type: "text-end", id: "t1" });
						controller.enqueue({
							type: "finish",
							finishReason: { unified: "stop", raw: undefined },
							usage: {
								inputTokens: {
									total: 900,
									noCache: undefined,
									cacheRead: 700,
									cacheWrite: undefined,
								},
								outputTokens: {
									total: 1,
									text: undefined,
									reasoning: undefined,
								},
							},
						});
						controller.close();
					},
				});
				return { stream };
			},
		} as unknown as LanguageModel;
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model, system: "test", contextWindow: 1000 }),
			makeTools: () => ({}),
		});
		setLogFile(logFile);
		try {
			const sink = new RecordingSink();
			runtime.submit(conv, userMessage([{ type: "text", text: "hi" }]), sink);
			expect(await sink.done).toEqual({ kind: "completed" });
			const lines = readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l) as Record<string, unknown>);
			const warn = lines.find(
				(l) => l.msg === "context window ≥80% — history is approaching the limit",
			);
			expect(warn).toMatchObject({ input: 900, limit: 1000, pct: 90 });
			const stepUsage = lines.find((l) => l.msg === "model step usage");
			expect(stepUsage).toMatchObject({
				inputTokens: 900,
				cacheReadTokens: 700,
				cacheWriteTokens: null,
				outputTokens: 1,
			});
			const completed = lines.find((l) => l.msg === "turn completed");
			expect(completed?.window).toEqual({ input: 900, limit: 1000, pct: 90 });
			expect(completed?.usage).toEqual({ input: 900, cacheRead: 700, cacheWrite: null, output: 1 });
		} finally {
			setLogFile(null);
			store.close();
		}
	});

	test("a schema-rejected tool call leaves a trace in the log", async () => {
		// The Sep 28 outage class: a provider that cannot fill a tool
		// schema emits {} and the call dies in validation — before the
		// fix, nothing was logged and the only witness was the model.
		const dir = mkdtempSync(join(tmpdir(), "goblin-rt-log-"));
		dirs.push(dir);
		const logFile = join(dir, "goblin.log");
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		let call = 0;
		const model = {
			specificationVersion: "v4",
			provider: "fake",
			modelId: "fake-1",
			supportedUrls: {},
			doGenerate() {
				throw new Error("unimplemented");
			},
			doStream() {
				call++;
				const stream = new ReadableStream<LanguageModelV4StreamPart>({
					start(controller) {
						controller.enqueue({ type: "stream-start", warnings: [] });
						if (call === 1) {
							// read_file requires `path`; the model sent {}.
							controller.enqueue({
								type: "tool-call",
								toolCallId: "c1",
								toolName: "read_file",
								input: "{}",
							});
						} else {
							controller.enqueue({ type: "text-start", id: "t1" });
							controller.enqueue({ type: "text-delta", id: "t1", delta: "sorry" });
							controller.enqueue({ type: "text-end", id: "t1" });
						}
						controller.enqueue({
							type: "finish",
							finishReason: { unified: call === 1 ? "tool-calls" : "stop", raw: undefined },
							usage: {
								inputTokens: {
									total: 1,
									noCache: undefined,
									cacheRead: undefined,
									cacheWrite: undefined,
								},
								outputTokens: { total: 1, text: undefined, reasoning: undefined },
							},
						});
						controller.close();
					},
				});
				return { stream };
			},
		} as unknown as LanguageModel;
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model, system: "test", contextWindow: 1000 }),
			// The real read_file tool: its schema rejects {} at validation.
			makeTools: () => ({ read_file: readFileTool("/tmp") }),
		});
		setLogFile(logFile);
		try {
			const sink = new RecordingSink();
			runtime.submit(conv, userMessage([{ type: "text", text: "read a file" }]), sink);
			expect(await sink.done).toEqual({ kind: "completed" });
			const lines = readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l) as Record<string, unknown>);
			const rejected = lines.find((l) => l.msg === "tool call rejected");
			expect(rejected).toMatchObject({ tool: "read_file", arg: "{}" });
			// The validation error names the missing field — the whole
			// diagnosis in one line.
			expect(String(rejected?.error)).toContain("path");
			// And the stop reason rides the completion line.
			expect(lines.find((l) => l.msg === "turn completed")?.finish).toBe("stop");
		} finally {
			setLogFile(null);
			store.close();
		}
	});

	test("a throwing tool execute leaves a trace in the log", async () => {
		const dir = mkdtempSync(join(tmpdir(), "goblin-rt-log-"));
		dirs.push(dir);
		const logFile = join(dir, "goblin.log");
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		let call = 0;
		const model = {
			specificationVersion: "v4",
			provider: "fake",
			modelId: "fake-1",
			supportedUrls: {},
			doGenerate() {
				throw new Error("unimplemented");
			},
			doStream() {
				call++;
				const stream = new ReadableStream<LanguageModelV4StreamPart>({
					start(controller) {
						controller.enqueue({ type: "stream-start", warnings: [] });
						if (call === 1) {
							controller.enqueue({
								type: "tool-call",
								toolCallId: "c1",
								toolName: "boom",
								input: "{}",
							});
						} else {
							controller.enqueue({ type: "text-start", id: "t1" });
							controller.enqueue({ type: "text-delta", id: "t1", delta: "ok" });
							controller.enqueue({ type: "text-end", id: "t1" });
						}
						controller.enqueue({
							type: "finish",
							finishReason: { unified: call === 1 ? "tool-calls" : "stop", raw: undefined },
							usage: {
								inputTokens: {
									total: 1,
									noCache: undefined,
									cacheRead: undefined,
									cacheWrite: undefined,
								},
								outputTokens: { total: 1, text: undefined, reasoning: undefined },
							},
						});
						controller.close();
					},
				});
				return { stream };
			},
		} as unknown as LanguageModel;
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model, system: "test", contextWindow: 1000 }),
			makeTools: () => ({
				boom: tool({
					description: "always throws",
					inputSchema: z.object({}),
					execute: async (): Promise<string> => {
						throw new Error("kapow");
					},
				}),
			}),
		});
		setLogFile(logFile);
		try {
			const sink = new RecordingSink();
			runtime.submit(conv, userMessage([{ type: "text", text: "boom" }]), sink);
			expect(await sink.done).toEqual({ kind: "completed" });
			const lines = readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l) as Record<string, unknown>);
			const failed = lines.find((l) => l.msg === "tool execute failed");
			expect(failed).toMatchObject({ tool: "boom" });
			expect(String(failed?.error)).toContain("kapow");
		} finally {
			setLogFile(null);
			store.close();
		}
	});

	test("a completed turn at ≥75% of the window compacts; below it does not", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		// Seed three big exchanges + the turn's own: the compactor must fold
		// the first three into a summary and keep the live one whole.
		const big = "x".repeat(600);
		for (let i = 0; i < 3; i++) {
			store.append(conv.id, [userMessage([{ type: "text", text: `${big} q${i}` }])]);
			store.append(
				conv.id,
				[{ id: `a${i}`, role: "assistant", parts: [{ type: "text", text: `${big} r${i}` }] }],
				{ anchorSeq: store.lastUserSeq(conv.id) },
			);
		}
		const model = (inputTokens: number) =>
			({
				specificationVersion: "v4",
				provider: "fake",
				modelId: "fake-1",
				supportedUrls: {},
				doGenerate() {
					throw new Error("unimplemented");
				},
				doStream() {
					const stream = new ReadableStream<LanguageModelV4StreamPart>({
						start(controller) {
							controller.enqueue({ type: "stream-start", warnings: [] });
							controller.enqueue({ type: "text-start", id: "t1" });
							controller.enqueue({ type: "text-delta", id: "t1", delta: "ok" });
							controller.enqueue({ type: "text-end", id: "t1" });
							controller.enqueue({
								type: "finish",
								finishReason: { unified: "stop", raw: undefined },
								usage: {
									inputTokens: {
										total: inputTokens,
										noCache: undefined,
										cacheRead: undefined,
										cacheWrite: undefined,
									},
									outputTokens: {
										total: 1,
										text: undefined,
										reasoning: undefined,
									},
								},
							});
							controller.close();
						},
					});
					return { stream };
				},
			}) as unknown as LanguageModel;
		const summaries: string[] = [];
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model: model(750), system: "test", contextWindow: 1000 }),
			makeTools: () => ({}),
			compaction: {
				modelRef: () => "zai/glm-5.3",
				summarize: async (_conv, _system, prompt, _signal) => {
					summaries.push(prompt);
					return "the folded era";
				},
			},
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "live question" }]), sink);
		expect(await sink.done).toEqual({ kind: "completed" });
		// The compaction runs in-lane AFTER the sinks are notified — done
		// resolving only means the reply landed. Poll for the pointer,
		// bounded, instead of a fixed sleep.
		for (let i = 0; i < 100 && store.getCompaction(conv.id) === null; i++) {
			await sleep(10);
		}
		// Exactly 75% is inclusive — the trigger fired.
		// 80% ≥ 75%: the compactor ran in-lane before onDone settled the
		// next queued turn's snapshot — here, before done resolves.
		expect(summaries).toHaveLength(1);
		expect(summaries[0]).toContain("q0");
		const pointer = store.getCompaction(conv.id);
		// The budget keeps a chunky recent tail (whole exchanges only), so
		// the cut lands at the end of the second exchange — seq 4 — with the
		// live exchange (u7/a7) whole in the tail.
		expect(pointer).toMatchObject({
			boundarySeq: 4,
			summary: "the folded era",
			model: "zai/glm-5.3",
		});
		// The record stays whole; the model view is summary + kept tail.
		expect(store.history(conv.id)).toHaveLength(8);
		const view = store.modelEntries(conv.id);
		expect(view).toHaveLength(5);
		expect((view[0]!.message.parts[0] as { text: string }).text).toContain("the folded era");
		const lastText = view
			.at(-1)!
			.message.parts.find((p) => (p as { type: string }).type === "text") as
			| { text: string }
			| undefined;
		expect(lastText?.text).toBe("ok");
		store.close();

		// Just below the threshold (74%): no compaction, no pointer.
		const store2 = openStore(tmpdb());
		const conv2 = store2.resolve({ kind: "dm", chatId: 1 }, "/w");
		const runtime2 = new Runtime({
			store: store2,
			buildStep: () => ({ model: model(740), system: "test", contextWindow: 1000 }),
			makeTools: () => ({}),
			compaction: {
				modelRef: () => "m",
				summarize: async () => {
					throw new Error("must not compact");
				},
			},
		});
		const sink2 = new RecordingSink();
		runtime2.submit(conv2, userMessage([{ type: "text", text: "hi" }]), sink2);
		expect(await sink2.done).toEqual({ kind: "completed" });
		expect(store2.getCompaction(conv2.id)).toBeNull();
		store2.close();
	});

	test("/compact serializes behind a running turn — no orphaned exchange", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const big = "x".repeat(600);
		for (let i = 0; i < 3; i++) {
			store.append(conv.id, [userMessage([{ type: "text", text: `${big} q${i}` }])]);
			store.append(
				conv.id,
				[{ id: `a${i}`, role: "assistant", parts: [{ type: "text", text: `${big} r${i}` }] }],
				{ anchorSeq: store.lastUserSeq(conv.id) },
			);
		}
		const runtime = new Runtime({
			store,
			buildStep: () => ({
				model: fakeModel(["slow ", "reply"], 40),
				system: "test",
				contextWindow: 1000,
			}),
			makeTools: () => ({}),
			compaction: {
				modelRef: () => "m",
				summarize: async () => "folded",
			},
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "live question" }]), sink);
		// The manual compact queues while the turn still runs — it must not
		// choose a cut until the turn's response is appended to history.
		const compacted = runtime.compact(conv);
		await sink.done;
		const outcome = await compacted;
		expect(outcome.kind).toBe("compacted");
		const boundary = store.getCompaction(conv.id)!.boundarySeq;
		// THE invariant (DESIGN.md, Compaction): the model view's tail is
		// exactly the events whose causal position follows the boundary —
		// nothing orphaned (an anchored reply without its question), and
		// nothing silently swallowed (an event neither summarized nor shown).
		const tail = store
			.modelEntries(conv.id)
			.slice(1)
			.map((e) => e.seq);
		const expected = store
			.historyDetail(conv.id)
			.filter((e) => (e.anchorSeq ?? e.seq) > boundary)
			.map((e) => e.seq);
		expect(tail).toEqual(expected);
		store.close();
	});

	test("/stop drops a queued /compact — it resolves as a noop", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const runtime = new Runtime({
			store,
			buildStep: () => ({
				model: fakeModel(["slow ", "reply"], 40),
				system: "test",
				contextWindow: 1000,
			}),
			makeTools: () => ({}),
			compaction: { modelRef: () => "m", summarize: async () => "folded" },
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "hi" }]), sink);
		await sink.firstDelta; // mid-stream: the compact queues behind the turn
		const compacted = runtime.compact(conv);
		const { stopped } = runtime.stop(conv.id);
		expect(stopped).toBe(true);
		// stop means stop — the queued job drops like a queued turn, but
		// its promise still settles so the /compact reply fires.
		expect(await compacted).toEqual({ kind: "noop", reason: "stopped" });
		expect(await sink.done).toEqual({ kind: "fenced" });
		expect(store.getCompaction(conv.id)).toBeNull();
		store.close();
	});

	test("/stop during a pending buildStep aborts the compaction — no pointer written", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const big = "x".repeat(600);
		for (let i = 0; i < 3; i++) {
			store.append(conv.id, [userMessage([{ type: "text", text: `${big} q${i}` }])]);
			store.append(
				conv.id,
				[{ id: `a${i}`, role: "assistant", parts: [{ type: "text", text: `${big} r${i}` }] }],
				{ anchorSeq: store.lastUserSeq(conv.id) },
			);
		}
		// buildStep hangs until the stop has landed: the abort controller
		// must be registered BEFORE this await, or the stop aborts a null
		// controller and the compaction runs on despite it.
		let releaseBuild!: () => void;
		const buildGate = new Promise<void>((r) => {
			releaseBuild = r;
		});
		const runtime = new Runtime({
			store,
			buildStep: () =>
				buildGate.then(() => ({
					model: fakeModel(["reply"], 5),
					system: "test",
					contextWindow: 1000,
				})),
			makeTools: () => ({}),
			compaction: {
				modelRef: () => "m",
				// Fails fast on an already-aborted signal, as a real model call
				// does — the summary must never run past a stop.
				summarize: (_conv, _system, _prompt, signal) =>
					signal.aborted
						? Promise.reject(new Error("summarize aborted"))
						: Promise.resolve("must not summarize"),
			},
		});
		const compacted = runtime.compact(conv);
		// The compaction is now suspended inside buildStep with its
		// controller registered — stop must see (and abort) it.
		const { stopped } = runtime.stop(conv.id);
		expect(stopped).toBe(true);
		releaseBuild();
		// /stop carries two fences — the epoch bump and the abort — and the
		// authority check lands first now: the compaction rejects as fenced
		// before the (pre-aborted) summary call could even start.
		await expect(compacted).rejects.toThrow("turn fenced");
		// No history pointer was written despite the summary path being
		// reachable — the crossing retries on the next threshold.
		expect(store.getCompaction(conv.id)).toBeNull();
		store.close();
	});

	test("a settings epoch change fences an in-flight compaction — no pointer, snapshot kept", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const big = "x".repeat(600);
		for (let i = 0; i < 3; i++) {
			store.append(conv.id, [userMessage([{ type: "text", text: `${big} q${i}` }])]);
			store.append(
				conv.id,
				[{ id: `a${i}`, role: "assistant", parts: [{ type: "text", text: `${big} r${i}` }] }],
				{ anchorSeq: store.lastUserSeq(conv.id) },
			);
		}
		// The frozen prompt snapshot the completed turn holds — the fenced
		// compaction must not clear it: that refresh belongs to the
		// compaction that actually lands.
		store.savePromptSnapshot(conv.id, "frozen system prompt", ["seed"]);
		// Gate the summary call so the settings change lands mid-compaction.
		// /memory bumps the epoch without touching the abort signal — unlike
		// /stop there is no abort to carry the fence, only the commit check.
		let summarizeStarted!: () => void;
		const started = new Promise<void>((r) => {
			summarizeStarted = r;
		});
		let releaseSummary!: (summary: string) => void;
		const gate = new Promise<string>((r) => {
			releaseSummary = r;
		});
		let summarizeCalls = 0;
		const model = (inputTokens: number) =>
			({
				specificationVersion: "v4",
				provider: "fake",
				modelId: "fake-1",
				supportedUrls: {},
				doGenerate() {
					throw new Error("unimplemented");
				},
				doStream() {
					const stream = new ReadableStream<LanguageModelV4StreamPart>({
						start(controller) {
							controller.enqueue({ type: "stream-start", warnings: [] });
							controller.enqueue({ type: "text-start", id: "t1" });
							controller.enqueue({ type: "text-delta", id: "t1", delta: "ok" });
							controller.enqueue({ type: "text-end", id: "t1" });
							controller.enqueue({
								type: "finish",
								finishReason: { unified: "stop", raw: undefined },
								usage: {
									inputTokens: {
										total: inputTokens,
										noCache: undefined,
										cacheRead: undefined,
										cacheWrite: undefined,
									},
									outputTokens: {
										total: 1,
										text: undefined,
										reasoning: undefined,
									},
								},
							});
							controller.close();
						},
					});
					return { stream };
				},
			}) as unknown as LanguageModel;
		// Turn one crosses the threshold (75%); the barrier turn below stays
		// far under it so it triggers no second compaction.
		let builds = 0;
		const runtime = new Runtime({
			store,
			buildStep: () => ({
				model: model(builds++ === 0 ? 750 : 50),
				system: "test",
				contextWindow: 1000,
			}),
			makeTools: () => ({}),
			compaction: {
				modelRef: () => "m",
				summarize: (_conv, _system, _prompt, signal) => {
					if (signal.aborted) return Promise.reject(new Error("summarize aborted"));
					summarizeCalls++;
					summarizeStarted();
					return gate;
				},
			},
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "live question" }]), sink);
		expect(await sink.done).toEqual({ kind: "completed" });
		await started; // the threshold compaction's summary is now in flight
		// A queued successor settles only after the in-lane compaction —
		// its done is the barrier proving the fenced commit attempt ran.
		const barrier = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "follow-up" }]), barrier);
		// The epoch-changing mutation /memory uses — no /stop, no abort.
		store.applySettings(conv.id, { memoryExcluded: true });
		expect(store.get(conv.id)?.epoch).toBe(1);
		releaseSummary("the folded era");
		expect(await barrier.done).toEqual({ kind: "completed" });
		// Settle the lane before closing the store — the barrier turn's
		// post-done work must finish first.
		await runtime.shutdown();
		// The summary resolved, but the pointer never landed and the frozen
		// snapshot survived — the next threshold crossing retries under the
		// new settings.
		expect(summarizeCalls).toBe(1);
		expect(store.getCompaction(conv.id)).toBeNull();
		expect(store.promptSnapshot(conv.id)).toEqual({
			text: "frozen system prompt",
			sources: ["seed"],
		});
		store.close();
	});

	test("a settings epoch change fences a manual /compact mid-summary — it rejects, no pointer", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const big = "x".repeat(600);
		for (let i = 0; i < 3; i++) {
			store.append(conv.id, [userMessage([{ type: "text", text: `${big} q${i}` }])]);
			store.append(
				conv.id,
				[{ id: `a${i}`, role: "assistant", parts: [{ type: "text", text: `${big} r${i}` }] }],
				{ anchorSeq: store.lastUserSeq(conv.id) },
			);
		}
		let summarizeStarted!: () => void;
		const started = new Promise<void>((r) => {
			summarizeStarted = r;
		});
		let releaseSummary!: (summary: string) => void;
		const gate = new Promise<string>((r) => {
			releaseSummary = r;
		});
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model: fakeModel(["reply"], 1), system: "test", contextWindow: 1000 }),
			makeTools: () => ({}),
			compaction: {
				modelRef: () => "m",
				summarize: (_conv, _system, _prompt, signal) => {
					if (signal.aborted) return Promise.reject(new Error("summarize aborted"));
					summarizeStarted();
					return gate;
				},
			},
		});
		const compacted = runtime.compact(conv);
		await started; // the manual job's summary is now in flight
		store.applySettings(conv.id, { memoryExcluded: true }); // epoch bump, no abort
		releaseSummary("the folded era");
		// The job rejects with the fence — the /compact reply reports it and
		// nothing was written.
		await expect(compacted).rejects.toThrow("turn fenced");
		await runtime.shutdown();
		expect(store.getCompaction(conv.id)).toBeNull();
		store.close();
	});

	test("/stop while completion delivery is pending prevents a new auto-compaction", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		let builds = 0;
		let release!: () => void;
		const pendingDelivery = new Promise<void>((resolve) => {
			release = resolve;
		});
		const runtime = new Runtime({
			store,
			buildStep: () => {
				builds++;
				return { model: fakeModel(["ok"], 1), system: "test", contextWindow: 1 };
			},
			makeTools: () => ({}),
			compaction: { modelRef: () => "m", summarize: async () => "should not run" },
		});
		const sink = new RecordingSink();
		const delivered = sink.onDone.bind(sink);
		sink.onDone = async (done) => {
			await pendingDelivery;
			delivered(done);
		};
		runtime.submit(conv, userMessage([{ type: "text", text: "hi" }]), sink);
		await sink.firstDelta;
		// Let the turn reach onDone, then revoke its authority while the
		// delivery remains parked.
		for (let i = 0; i < 100 && store.history(conv.id).length < 2; i++) await sleep(1);
		expect(store.history(conv.id)).toHaveLength(2);
		runtime.stop(conv.id);
		release();
		await sink.done;
		await sleep(20);
		expect(builds).toBe(1);
		expect(store.getCompaction(conv.id)).toBeNull();
		store.close();
	});

	test("provider warnings are logged, not dropped", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const dir = mkdtempSync(join(tmpdir(), "goblin-rt-log-"));
		dirs.push(dir);
		const logFile = join(dir, "goblin.log");
		const model = {
			specificationVersion: "v4",
			provider: "fake",
			modelId: "fake-1",
			supportedUrls: {},
			doGenerate() {
				throw new Error("unimplemented");
			},
			doStream() {
				const stream = new ReadableStream<LanguageModelV4StreamPart>({
					start(controller) {
						controller.enqueue({
							type: "stream-start",
							warnings: [{ type: "unsupported", feature: "temperature" }],
						});
						controller.enqueue({ type: "text-start", id: "t1" });
						controller.enqueue({ type: "text-delta", id: "t1", delta: "ok" });
						controller.enqueue({ type: "text-end", id: "t1" });
						controller.enqueue({
							type: "finish",
							finishReason: { unified: "stop", raw: undefined },
							usage: {
								inputTokens: {
									total: 1,
									noCache: undefined,
									cacheRead: undefined,
									cacheWrite: undefined,
								},
								outputTokens: { total: 1, text: undefined, reasoning: undefined },
							},
						});
						controller.close();
					},
				});
				return { stream };
			},
		} as unknown as LanguageModel;
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model, system: "test" }),
			makeTools: () => ({}),
		});
		setLogFile(logFile);
		try {
			const sink = new RecordingSink();
			runtime.submit(conv, userMessage([{ type: "text", text: "hi" }]), sink);
			expect(await sink.done).toEqual({ kind: "completed" });
			// The warn rides the same turn's log trail — a warning that never
			// lands was the fail-quiet seam this guards against.
			await Bun.sleep(20);
			const lines = readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l) as Record<string, unknown>);
			const warn = lines.find((l) => l.msg === "model warnings");
			expect(warn?.warnings).toEqual(["unsupported:temperature"]);
		} finally {
			setLogFile(null);
			store.close();
		}
	});
});

describe("skill reviewer hook", () => {
	test("shutdown fences a held gate after its conversation lane has drained", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model: fakeModel(["answer"], 1), system: "test" }),
			makeTools: () => ({}),
		});
		let release!: () => void;
		let entered!: () => void;
		const held = new Promise<void>((r) => {
			release = r;
		});
		const atGate = new Promise<void>((r) => {
			entered = r;
		});
		runtime.setReviewer({
			gate: {
				decide: async () => {
					entered();
					await held;
					return { answers: { correction: 1 }, inputTokens: 1, cost: 0 };
				},
			},
			thresholds: { correction: 0.8, procedure: 0.8 },
			queueCap: 3,
			evidence: { calls: 8, argChars: 300, outChars: 300 },
			reviewModel: async () => {
				throw new Error("shutdown let a review start");
			},
			store,
			skillsDir: "/none",
			workspaceDir: "/none",
			notify: async () => {},
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "save this" }]), sink);
		expect(await sink.done).toEqual({ kind: "completed" });
		await atGate;
		// A settled drain removes the lane; shutdown must still find the gate.
		await sleep(20);
		await runtime.shutdown();
		store.close();
		release();
		await sleep(20);
	});
	// A model that calls a tool, then answers — scripted streams per step.
	function toolThenText(toolName: string, deltas: string[]): LanguageModel {
		let step = 0;
		return {
			specificationVersion: "v4",
			provider: "fake",
			modelId: "fake-tool",
			supportedUrls: {},
			doGenerate() {
				throw new Error("unimplemented");
			},
			doStream() {
				const n = step++;
				const stream = new ReadableStream<LanguageModelV4StreamPart>({
					start(controller) {
						controller.enqueue({ type: "stream-start", warnings: [] });
						if (n === 0) {
							controller.enqueue({ type: "tool-call", toolCallId: "c1", toolName, input: "{}" });
							controller.enqueue({
								type: "finish",
								finishReason: { unified: "tool-calls", raw: undefined },
								usage: {
									inputTokens: {
										total: 1,
										noCache: undefined,
										cacheRead: undefined,
										cacheWrite: undefined,
									},
									outputTokens: { total: 1, text: undefined, reasoning: undefined },
								},
							});
						} else {
							controller.enqueue({ type: "text-start", id: "t1" });
							for (const d of deltas)
								controller.enqueue({ type: "text-delta", id: "t1", delta: d });
							controller.enqueue({ type: "text-end", id: "t1" });
							controller.enqueue({
								type: "finish",
								finishReason: { unified: "stop", raw: undefined },
								usage: {
									inputTokens: {
										total: 1,
										noCache: undefined,
										cacheRead: undefined,
										cacheWrite: undefined,
									},
									outputTokens: { total: 1, text: undefined, reasoning: undefined },
								},
							});
						}
						controller.close();
					},
				});
				return { stream };
			},
		} as unknown as LanguageModel;
	}

	test("a completed turn gates its snapshot — operator burst, reply, tool names", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model: toolThenText("bash", ["do", "ne"]), system: "test" }),
			makeTools: () => ({
				bash: tool({ inputSchema: z.object({}), execute: async () => "ok" }),
			}),
		});
		let gated: unknown = null;
		let markGated: () => void = () => {};
		const gatedIt = new Promise<void>((res) => {
			markGated = res;
		});
		runtime.setReviewer({
			// The gate stub records the state considerTurn built — the
			// hook's snapshot, observed through the real call path.
			gate: {
				decide: async (state) => {
					gated = state;
					markGated();
					return { answers: {}, inputTokens: null, cost: null };
				},
			},
			thresholds: { correction: 0.8, procedure: 0.8 },
			queueCap: 3,
			evidence: { calls: 8, argChars: 300, outChars: 300 },
			reviewModel: async () => {
				throw new Error("empty answers never review — must not resolve");
			},
			store,
			skillsDir: "/none",
			workspaceDir: "/none",
			notify: async () => {},
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "run it" }]), sink);
		expect(await sink.done).toEqual({ kind: "completed" });
		// Off-lane: completion never waits for the gate.
		await gatedIt;
		expect(gated as string).toContain("run it");
		expect(gated as string).toContain("done");
		expect(gated as string).toContain("tools: bash (1 total)");
		store.close();
	});

	test("a fenced turn never gates", async () => {
		const { store, conv, runtime } = setup(["a", "b", "c", "d", "e"], 20);
		let gated = false;
		runtime.setReviewer({
			gate: {
				decide: async () => {
					gated = true;
					return { answers: {}, inputTokens: null, cost: null };
				},
			},
			thresholds: { correction: 0.8, procedure: 0.8 },
			queueCap: 3,
			evidence: { calls: 8, argChars: 300, outChars: 300 },
			reviewModel: async () => {
				throw new Error("must not resolve");
			},
			store,
			skillsDir: "/none",
			workspaceDir: "/none",
			notify: async () => {},
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "hi" }]), sink);
		await sink.firstDelta;
		store.bumpEpoch(conv.id);
		expect(await sink.done).toEqual({ kind: "fenced" });
		await sleep(50); // the fire-and-forget gate would have fired by now
		expect(gated).toBe(false);
		store.close();
	});

	test("a memory-excluded turn never gates — the reviewer skips it and logs why", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const root = mkdtempSync(join(tmpdir(), "goblin-rt-"));
		dirs.push(root);
		const logFile = join(root, "goblin.log");
		setLogFile(logFile);
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model: fakeModel(["answer"], 5), system: "test" }),
			makeTools: () => ({}),
		});
		runtime.setReviewer({
			gate: {
				decide: async () => {
					throw new Error("memory-excluded turns must never gate");
				},
			},
			thresholds: { correction: 0.8, procedure: 0.8 },
			queueCap: 3,
			evidence: { calls: 8, argChars: 300, outChars: 300 },
			reviewModel: async () => {
				throw new Error("must not resolve");
			},
			store,
			skillsDir: "/none",
			workspaceDir: "/none",
			notify: async () => {},
		});
		store.applySettings(conv.id, { memoryExcluded: true });
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "off the record" }]), sink);
		expect(await sink.done).toEqual({ kind: "completed" });
		await sleep(50);
		const skipped = readFileSync(logFile, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as Record<string, unknown>)
			.find((e) => e.msg === "reviewer skipped — memory excluded");
		expect(skipped).toMatchObject({ conversation: conv.id });
		store.close();
	});

	test("memory switched off mid-turn prevents review at completion", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model: fakeModel(["first", "last"], 30), system: "test" }),
			makeTools: () => ({}),
		});
		let gated = false;
		runtime.setReviewer({
			gate: {
				decide: async () => {
					gated = true;
					return { answers: {}, inputTokens: null, cost: null };
				},
			},
			thresholds: { correction: 0.8, procedure: 0.8 },
			queueCap: 3,
			evidence: { calls: 8, argChars: 300, outChars: 300 },
			reviewModel: async () => {
				throw new Error("must not review");
			},
			store,
			skillsDir: "/none",
			workspaceDir: "/none",
			notify: async () => {},
		});
		const sink = new RecordingSink();
		const onDone = sink.onDone.bind(sink);
		sink.onDone = (done) => {
			if (done.kind === "completed") store.applySettings(conv.id, { memoryExcluded: true });
			onDone(done);
		};
		runtime.submit(conv, userMessage([{ type: "text", text: "private now" }]), sink);
		expect(await sink.done).toEqual({ kind: "completed" });
		await sleep(20);
		expect(gated).toBe(false);
		store.close();
	});

	test("the turn's tool digest reaches the review payload through the real stream path", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const root = mkdtempSync(join(tmpdir(), "goblin-rt-"));
		dirs.push(root);
		const workspace = join(root, "ws");
		const skills = join(workspace, "skills");
		mkdirSync(skills, { recursive: true });
		const logFile = join(root, "goblin.log");
		setLogFile(logFile);
		const prompts: string[] = [];
		const reviewModel = {
			specificationVersion: "v4",
			provider: "fake",
			modelId: "fake-review",
			supportedUrls: {},
			doGenerate: async (options: unknown) => {
				prompts.push(JSON.stringify((options as { prompt?: unknown }).prompt ?? null));
				return {
					content: [{ type: "text", text: "nothing worth saving" }],
					finishReason: { unified: "stop", raw: undefined },
					usage: {
						inputTokens: {
							total: 1,
							noCache: undefined,
							cacheRead: undefined,
							cacheWrite: undefined,
						},
						outputTokens: { total: 1, text: undefined, reasoning: undefined },
					},
					warnings: [],
				};
			},
			doStream: () => {
				throw new Error("unimplemented");
			},
		} as unknown as LanguageModel;
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model: toolThenText("bash", ["done"]), system: "test" }),
			makeTools: () => ({
				bash: tool({
					inputSchema: z.object({}),
					execute: async () => ({ exit_code: 0, stdout: "listed" }),
				}),
			}),
		});
		runtime.setReviewer({
			gate: {
				decide: async () => ({
					answers: { correction: 0, procedure: 0.99 },
					inputTokens: 1,
					cost: 0,
				}),
			},
			thresholds: { correction: 0.8, procedure: 0.8 },
			queueCap: 3,
			evidence: { calls: 8, argChars: 300, outChars: 300 },
			reviewModel: async () => ({ ref: "fake/review", model: reviewModel }),
			store,
			skillsDir: skills,
			workspaceDir: workspace,
			notify: async () => {},
			skillsRefBin: join(root, "nonexistent-skills-ref"),
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "list the files" }]), sink);
		expect(await sink.done).toEqual({ kind: "completed" });
		for (let i = 0; i < 500 && prompts.length === 0; i++) await sleep(2);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("- bash — ok");
		expect(prompts[0]).toContain("listed");
		expect(prompts[0]).toContain("list the files");
		store.close();
	});
});

// ---------- steering ----------

// Two-step model: call #1 finishes with a tool call, call #2 streams
// `secondText`. The test's gate promise blocks the tool's execute, so
// the step boundary (prepareStep before call #2) opens exactly when the
// test decides. Every wire prompt is captured JSON-stringified.
function gatedToolModel(secondText: string) {
	const prompts: string[] = [];
	let calls = 0;
	const finish = (reason: "tool-calls" | "stop"): LanguageModelV4StreamPart => ({
		type: "finish",
		finishReason: { unified: reason, raw: undefined },
		usage: {
			inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
			outputTokens: { total: 1, text: undefined, reasoning: undefined },
		},
	});
	const base = {
		specificationVersion: "v4",
		provider: "fake",
		modelId: "fake-1",
		supportedUrls: {},
		doGenerate() {
			throw new Error("unimplemented");
		},
		doStream() {
			const n = ++calls;
			const parts: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
			if (n === 1) {
				parts.push(
					{ type: "tool-call", toolCallId: "c1", toolName: "probe", input: "{}" },
					finish("tool-calls"),
				);
			} else {
				parts.push(
					{ type: "text-start", id: "t2" },
					{ type: "text-delta", id: "t2", delta: secondText },
					{ type: "text-end", id: "t2" },
					finish("stop"),
				);
			}
			return {
				stream: new ReadableStream<LanguageModelV4StreamPart>({
					start(controller) {
						for (const p of parts) controller.enqueue(p);
						controller.close();
					},
				}),
			};
		},
	};
	const model = {
		...base,
		doStream(o: { prompt: unknown }) {
			prompts.push(JSON.stringify(o.prompt));
			return (
				base as unknown as {
					doStream(o: unknown): { stream: ReadableStream<LanguageModelV4StreamPart> };
				}
			).doStream(o);
		},
	} as unknown as LanguageModel;
	return { model, prompts };
}

function steeringSetup(model: LanguageModel, gate?: Promise<void>, modalities?: Set<string>) {
	const store = openStore(tmpdb());
	const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
	const runtime = new Runtime({
		store,
		buildStep: () => ({
			model,
			system: "test",
			...(modalities ? { inputModalities: modalities } : {}),
		}),
		makeTools: () => ({
			probe: tool({
				inputSchema: z.object({}),
				execute: async () => {
					if (gate) await gate;
					return { ok: true };
				},
			}),
		}),
	});
	return { store, conv, runtime };
}

describe("steering", () => {
	test("a submit during a live turn joins the next model call", async () => {
		let releaseTool: () => void = () => {};
		const gate = new Promise<void>((r) => {
			releaseTool = r;
		});
		const { model, prompts } = gatedToolModel("adjusted");
		const { store, conv, runtime } = steeringSetup(model, gate);
		const s1 = new RecordingSink();
		const s2 = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "start this" }]), s1);
		// Turn 1 is mid-tool-call (step 1 done, tool gated). Submit —
		// this is the steer.
		await sleep(20);
		runtime.submit(conv, userMessage([{ type: "text", text: "actually pivot" }]), s2);
		releaseTool();
		expect(await s1.done).toEqual({ kind: "completed" });
		expect(await s2.done).toEqual({ kind: "completed" });
		expect(s1.text).toBe("adjusted"); // call #1 streams no text — only the tool call
		expect(s2.text).toBe(""); // delta-style text is the head's delivery seam
		// The steered member's chunk stream did NOT run dry (audit #4):
		// it saw the same wire as the head — replay of what preceded the
		// join, live tail after. One turn, one reply, every screen sees it.
		expect(s2.chunks).toEqual(s1.chunks);
		expect(s2.chunks.some((c) => c.type === "start")).toBe(true);
		// One turn, two model calls; the second call's wire prompt
		// carries the steered message as an appended user message.
		expect(prompts).toHaveLength(2);
		const wire = JSON.parse(prompts[1]!) as {
			role: string;
			content: { type: string; text?: string }[];
		}[];
		const texts = wire
			.filter((m) => m.role === "user")
			.flatMap((m) => m.content.filter((c) => c.type === "text").map((c) => c.text!));
		expect(texts).toEqual(["start this", "actually pivot"]);
		// History: both user messages, then one assistant exchange. The
		// reply anchors after the steered message — the burst it
		// actually answered.
		const detail = store.historyDetail(conv.id);
		expect(detail.map((d) => d.message.role)).toEqual(["user", "user", "assistant"]);
		const steeredSeq = detail[1]!.seq;
		expect(detail[2]!.anchorSeq).toBe(steeredSeq);
		store.close();
	});

	describe("live chunk subscription (resumable streams)", () => {
		test("a mid-turn subscriber gets replay + live tail + one end; idle lanes are null", async () => {
			let releaseTool: () => void = () => {};
			const gate = new Promise<void>((r) => {
				releaseTool = r;
			});
			const { model } = gatedToolModel("tail text");
			const { store, conv, runtime } = steeringSetup(model, gate);
			const s1 = new RecordingSink();
			// No submit yet — no lane, nothing to attach to.
			expect(
				runtime.subscribeLiveChunks(
					conv.id,
					() => {},
					() => {},
				),
			).toBeNull();
			runtime.submit(conv, userMessage([{ type: "text", text: "go" }]), s1);
			await sleep(20); // step 1 (the tool call) is on the wire, tool gated
			const seen: UIMessageChunk[] = [];
			const endedRef: { done: TurnDone | null } = { done: null };
			const replay = runtime.subscribeLiveChunks(
				conv.id,
				(c) => seen.push(c),
				(d) => {
					endedRef.done = d;
				},
			);
			expect(replay).not.toBeNull();
			// Replay begins at the wire's first chunk — the tool call the
			// late joiner missed is included, not resumed mid-sentence.
			expect(replay!.some((c) => c.type === "start")).toBe(true);
			expect(replay!.some((c) => c.type === "tool-input-available")).toBe(true);
			releaseTool();
			expect(await s1.done).toEqual({ kind: "completed" });
			expect(endedRef.done?.kind).toBe("completed");
			// The subscriber saw the same wire as the head, gapless.
			expect(seen).toEqual(s1.chunks.slice(replay!.length));
			// After the turn settles, there is nothing left to attach to.
			expect(
				runtime.subscribeLiveChunks(
					conv.id,
					() => {},
					() => {},
				),
			).toBeNull();
			store.close();
		});
	});

	test("a submit during the turn's startup steers into the first call", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const { model, prompts } = recordingModel(["done"], 5);
		let releaseStep: () => void = () => {};
		const stepGate = new Promise<void>((r) => {
			releaseStep = r;
		});
		const runtime = new Runtime({
			store,
			// buildStep still pending when the second submit lands.
			buildStep: async () => {
				await stepGate;
				return { model, system: "test" };
			},
			makeTools: () => ({}),
		});
		const s1 = new RecordingSink();
		const s2 = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "one" }]), s1);
		await sleep(10);
		runtime.submit(conv, userMessage([{ type: "text", text: "two" }]), s2);
		releaseStep();
		expect(await s1.done).toEqual({ kind: "completed" });
		expect(await s2.done).toEqual({ kind: "completed" });
		expect(s2.text).toBe(""); // delta-style text stays the head's seam
		expect(s2.chunks).toEqual(s1.chunks); // the chunk stream fans out to every member
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("one");
		expect(prompts[0]).toContain("two");
		store.close();
	});

	test("input after the final model call queues into a successor turn", async () => {
		const { model, prompts } = gatedToolModel("second");
		const { store, conv, runtime } = steeringSetup(model);
		const s1 = new RecordingSink();
		const s2 = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "one" }]), s1);
		await s1.done; // turn fully over — no boundary left
		runtime.submit(conv, userMessage([{ type: "text", text: "two" }]), s2);
		expect(await s2.done).toEqual({ kind: "completed" });
		expect(prompts).toHaveLength(3); // turn 1's tool loop = 2 calls + successor
		const roles = store.history(conv.id).map((m) => m.role);
		expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
		store.close();
	});

	test("a fenced turn requeues the steer instead of consuming it", async () => {
		let releaseTool: () => void = () => {};
		const gate = new Promise<void>((r) => {
			releaseTool = r;
		});
		const { model, prompts } = gatedToolModel("never seen");
		const { store, conv, runtime } = steeringSetup(model, gate);
		const s1 = new RecordingSink();
		const s2 = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "one" }]), s1);
		await sleep(20); // mid-tool-call
		store.bumpEpoch(conv.id); // fence, without stop()'s queue drop
		runtime.submit(conv, userMessage([{ type: "text", text: "two" }]), s2);
		releaseTool();
		expect(await s1.done).toEqual({ kind: "fenced" });
		// The steered submit was requeued at the fence, not consumed —
		// the successor turn answers it.
		expect(await s2.done).toEqual({ kind: "completed" });
		expect(prompts).toHaveLength(3);
		expect(prompts[2]).toContain("two");
		await sleep(20); // let the successor's post-completion authority check land before close
		store.close();
	});

	test("a submit landing mid-conversion stays above the ownership mark", async () => {
		// The steer is a photo whose readFile parks on a FIFO — a
		// deterministic window to land a follow-up while the boundary is
		// mid-conversion. The mark must claim the photo (injected) and
		// never the follow-up (still pending, never read).
		const dir = mkdtempSync(join(tmpdir(), "goblin-rt-fifo-"));
		dirs.push(dir);
		const fifo = join(dir, "photo.png");
		execSync(`mkfifo '${fifo}'`);
		let releaseTool: () => void = () => {};
		const gate = new Promise<void>((r) => {
			releaseTool = r;
		});
		const { model, prompts } = gatedToolModel("adjusted");
		const { store, conv, runtime } = steeringSetup(model, gate, new Set(["text", "image"]));
		const s1 = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "start this" }]), s1);
		await sleep(20); // parked mid-tool-call
		const s2 = new RecordingSink();
		runtime.submit(
			conv,
			{
				id: "steer-photo",
				role: "user",
				parts: [
					{
						type: ATTACHMENT_PART,
						data: { path: fifo, mediaType: "image/png", filename: "photo.png", size: 7 },
					},
				],
			} as UIMessage,
			s2,
		);
		releaseTool(); // tool resolves → prepareStep splices the photo → readFile parks on the FIFO
		await sleep(30);
		const s3 = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "follow-up" }]), s3);
		// Unpark the photo and let the turn finish.
		await writeFile(fifo, "pngdata");
		expect(await s1.done).toEqual({ kind: "completed" });
		expect(await s2.done).toEqual({ kind: "completed" });
		// Swap the FIFO for a regular file: the successor's admission would
		// otherwise re-read the FIFO with no writer left and park forever.
		unlinkSync(fifo);
		writeFileSync(fifo, "pngdata");
		// The follow-up was never injected — a successor turn answers it.
		expect(await s3.done).toEqual({ kind: "completed" });
		expect(prompts).toHaveLength(3);
		// Call #2 carried the photo, not the follow-up.
		expect(prompts[1]).toContain("photo.png");
		expect(prompts[1]).not.toContain("follow-up");
		// Turn 1's reply anchors after the photo — never after input it
		// didn't read. The successor's reply anchors after the follow-up.
		const detail = store.historyDetail(conv.id);
		const seqOf = (id: string) => detail.find((d) => d.message.id === id)!.seq;
		const assistants = detail.filter((d) => d.message.role === "assistant");
		expect(assistants).toHaveLength(2);
		expect(assistants[0]!.anchorSeq).toBe(seqOf("steer-photo"));
		// The follow-up is the newest user message; the successor's reply
		// anchors there.
		const followUpSeq = Math.max(
			...detail.filter((d) => d.message.role === "user").map((d) => d.seq),
		);
		expect(assistants[1]!.anchorSeq).toBe(followUpSeq);
		store.close();
	});

	test("a steered message that cannot convert errors its own delivery, not the conversation", async () => {
		let releaseTool: () => void = () => {};
		const gate = new Promise<void>((r) => {
			releaseTool = r;
		});
		const { model, prompts } = gatedToolModel("adjusted");
		const { store, conv, runtime } = steeringSetup(model, gate);
		const s1 = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "start this" }]), s1);
		await sleep(20); // parked mid-tool-call
		// Poison: a file part with an invalid URL — materializeAttachments
		// passes it through untouched, convertToModelMessages throws.
		const s2 = new RecordingSink();
		runtime.submit(
			conv,
			{
				id: "poison",
				role: "user",
				parts: [
					{ type: "text", text: "read this" },
					{ type: "file", mediaType: "image/png", filename: "x.png", url: "not a url" },
				],
			} as UIMessage,
			s2,
		);
		releaseTool();
		// The poison's own delivery errors; turn 1 completes over the rest.
		expect(await s1.done).toEqual({ kind: "completed" });
		const poisoned = await s2.done;
		expect(poisoned.kind).toBe("error");
		// Call #2 never saw the poison; the reply anchors at the trigger,
		// not at the message it couldn't carry.
		expect(prompts[1]).not.toContain("read this");
		const first = store.historyDetail(conv.id);
		const firstReply = first.filter((d) => d.message.role === "assistant")[0]!;
		expect(firstReply.anchorSeq).toBe(first.find((d) => d.message.id === "poison")!.seq - 1);
		// A successor turn must survive the poison sitting in history:
		// admission degrades it to a placeholder and the turn completes.
		const s3 = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "still there?" }]), s3);
		expect(await s3.done).toEqual({ kind: "completed" });
		expect(prompts).toHaveLength(3);
		expect(prompts[2]).toContain("could not be prepared for the model");
		expect(prompts[2]).toContain("still there?");
		store.close();
	});
});

describe("app channel", () => {
	// The turn loop is shared machinery: an app conversation submits,
	// steers, fences and persists exactly like a telegram one — the only
	// difference is the sink it streams into (DESIGN.md, App channel).
	test("an app conversation runs a turn and streams raw chunks to its sink", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve(appAddress("chat-01"), "/w");
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model: fakeModel(["hello", " app"], 0), system: "test" }),
			makeTools: () => ({}),
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "hi" }]), sink);
		expect(await sink.done).toEqual({ kind: "completed" });
		expect(sink.text).toBe("hello app");
		// The raw pass-through saw the same stream the delta methods
		// consumed — the app client's SSE surface rides verbatim.
		expect(sink.chunkTypes).toContain("text-delta");
		expect(sink.chunkTypes[0]).toBe("start");
		expect(sink.chunkTypes[sink.chunkTypes.length - 1]).toBe("finish");
		expect(store.history(conv.id).map((m) => m.role)).toEqual(["user", "assistant"]);
		await runtime.shutdown();
		store.close();
	});

	test("steering into a running app turn works through the same queue", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve(appAddress("chat-01"), "/w");
		const { model, prompts } = recordingModel(["done"], 0);
		let releaseStep: () => void = () => {};
		const stepGate = new Promise<void>((r) => {
			releaseStep = r;
		});
		const runtime = new Runtime({
			store,
			// buildStep still pending when the second submit lands — the
			// steer folds it into the first model call.
			buildStep: async () => {
				await stepGate;
				return { model, system: "test" };
			},
			makeTools: () => ({}),
		});
		const s1 = new RecordingSink();
		const s2 = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "one" }]), s1);
		await sleep(10);
		runtime.submit(conv, userMessage([{ type: "text", text: "two" }]), s2);
		releaseStep();
		expect(await s1.done).toEqual({ kind: "completed" });
		expect(await s2.done).toEqual({ kind: "completed" });
		expect(s2.text).toBe(""); // delta-style text stays the head's seam
		expect(s2.chunks).toEqual(s1.chunks); // the chunk stream fans out to every member
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("one");
		expect(prompts[0]).toContain("two");
		expect(store.history(conv.id).map((m) => m.role)).toEqual(["user", "user", "assistant"]);
		await runtime.shutdown();
		store.close();
	});
});

// A submit "streams" iff its sink defines onStreamChunk. A turn headed
// by a headless sink — the spin-off's bell — must never absorb a
// streaming submit: the merged sink would see only onDone and the
// client watching the stream would wait forever (design/app.md →
// Spin-off).
describe("streaming lane boundary", () => {
	test("a headless turn never absorbs a streaming submit — it heads the next turn", async () => {
		let releaseTool: () => void = () => {};
		const gate = new Promise<void>((r) => {
			releaseTool = r;
		});
		const { model, prompts } = gatedToolModel("adjusted");
		const { store, conv, runtime } = steeringSetup(model, gate);
		const headless = new HeadlessSink();
		const streaming = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "start this" }]), headless);
		await sleep(20); // parked mid-tool-call
		runtime.submit(conv, userMessage([{ type: "text", text: "watch me" }]), streaming);
		releaseTool();
		expect(await headless.done).toEqual({ kind: "completed" });
		// Not folded into the headless turn — a successor turn ran and
		// the streaming sink got the raw chunks as its head.
		expect(await streaming.done).toEqual({ kind: "completed" });
		expect(streaming.chunkTypes).toContain("text-delta");
		expect(streaming.text).toBe("adjusted");
		expect(prompts[1]).not.toContain("watch me");
		expect(prompts[2]).toContain("watch me");
		store.close();
	});

	test("a streaming head absorbs both sink kinds, as before", async () => {
		let releaseTool: () => void = () => {};
		const gate = new Promise<void>((r) => {
			releaseTool = r;
		});
		const { model, prompts } = gatedToolModel("adjusted");
		const { store, conv, runtime } = steeringSetup(model, gate);
		const streaming = new RecordingSink();
		const headless = new HeadlessSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "one" }]), streaming);
		await sleep(20); // parked mid-tool-call
		runtime.submit(conv, userMessage([{ type: "text", text: "two" }]), headless);
		releaseTool();
		expect(await streaming.done).toEqual({ kind: "completed" });
		expect(await headless.done).toEqual({ kind: "completed" });
		// One turn — the steered message rode call #2's prompt.
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toContain("two");
		store.close();
	});

	test("a headless turn still steers headless followers into the live call", async () => {
		let releaseTool: () => void = () => {};
		const gate = new Promise<void>((r) => {
			releaseTool = r;
		});
		const { model, prompts } = gatedToolModel("adjusted");
		const { store, conv, runtime } = steeringSetup(model, gate);
		const first = new HeadlessSink();
		const second = new HeadlessSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "one" }]), first);
		await sleep(20); // parked mid-tool-call
		runtime.submit(conv, userMessage([{ type: "text", text: "two" }]), second);
		releaseTool();
		expect(await first.done).toEqual({ kind: "completed" });
		expect(await second.done).toEqual({ kind: "completed" });
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toContain("two");
		store.close();
	});

	// #82: the lane boundary must hold at ADMISSION too. Drain's splice
	// leaves a streaming submit queued behind a headless head; its
	// message is durable history (every submit appends before admission),
	// so the headless turn's admission snapshot would otherwise read it,
	// anchor its reply to it — and the client's own successor turn would
	// answer the same message a second time. Multiple pending submits at
	// admission, not arrivals during the model loop.
	test("admission never reads a queued streaming submit — the client keeps its own turn", async () => {
		const { model, prompts } = recordingModel(["answer"], 5);
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model, system: "test" }),
			makeTools: () => ({}),
		});
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const parked = new ParkedDoneSink(gate);
		const background = new HeadlessSink();
		const client = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "first turn" }]), parked);
		// The drain loop is parked in the first turn's delivery completion —
		// the two submits below only queue (lane still running).
		await parked.done;
		runtime.submit(conv, userMessage([{ type: "text", text: "background beat" }]), background);
		runtime.submit(conv, userMessage([{ type: "text", text: "client owns me" }]), client);
		release();
		expect(await background.done).toEqual({ kind: "completed" });
		expect(await client.done).toEqual({ kind: "completed" });
		// Three turns ran: parked, background, the client's own. The
		// background turn's model request never contained the client's
		// message — ownership, not durability, bounds the view.
		expect(prompts).toHaveLength(3);
		expect(prompts[1]).not.toContain("client owns me");
		expect(prompts[2]).toContain("background beat");
		expect(prompts[2]).toContain("client owns me");
		expect(client.text).toBe("answer");
		// Causal view: the background reply sorts after its own burst and
		// BEFORE the client's input — it never anchors to a message this
		// turn didn't read. The client's reply anchors to the client's
		// message it actually answered.
		const detail = store.historyDetail(conv.id);
		expect(detail.map((d) => d.message.role)).toEqual([
			"user",
			"assistant", // first turn
			"user",
			"assistant", // background beat answered before the client's input
			"user",
			"assistant", // the client's own turn
		]);
		expect(detail[3]!.anchorSeq).toBe(detail[2]!.seq);
		expect(detail[5]!.anchorSeq).toBe(detail[4]!.seq);
		store.close();
	});
});

describe("loop landings", () => {
	// Design/model.md → "No step budget — loops are caught, not capped":
	// a turn has no step count. What bounds it is the repeat detector
	// (10 identical call+result pairs warn, 20 cut), the system1 loop
	// watchdog (two consecutive stuck verdicts cut), and the context
	// landing (a step at ≥85% of the catalog window lands tools-off).
	const finish = (reason: "stop" | "tool-calls", inputTokens = 10): LanguageModelV4StreamPart => ({
		type: "finish",
		finishReason: { unified: reason, raw: undefined },
		usage: {
			inputTokens: { total: inputTokens, noCache: 2, cacheRead: 8, cacheWrite: undefined },
			outputTokens: { total: 1, text: 1, reasoning: undefined },
		},
	});
	// Tool-greedy while tools exist (and under the call cap, if any),
	// answering the moment toolChoice goes none — the compliant model
	// every forced step relies on.
	function loopModel(
		opts: { calls?: number; input?: (n: number) => unknown; inputTokens?: number } = {},
	): {
		model: LanguageModel;
		requests: { toolChoice: unknown; prompt: string }[];
	} {
		const requests: { toolChoice: unknown; prompt: string }[] = [];
		const model: LanguageModel = {
			specificationVersion: "v4",
			provider: "fake",
			modelId: "loop-test",
			supportedUrls: {},
			doGenerate() {
				throw new Error("unused");
			},
			async doStream(options) {
				const n = requests.length + 1;
				requests.push({
					toolChoice: options.toolChoice?.type ?? null,
					prompt: JSON.stringify(options.prompt ?? []),
				});
				const noTools = options.toolChoice?.type === "none";
				const callTool = !noTools && (opts.calls === undefined || n <= opts.calls);
				const parts: LanguageModelV4StreamPart[] = callTool
					? [
							{
								type: "tool-call",
								toolCallId: `c${n}`,
								toolName: "probe",
								input: JSON.stringify(opts.input?.(n) ?? {}),
							},
							finish("tool-calls", opts.inputTokens ?? 10),
						]
					: [
							{ type: "text-start", id: "t" },
							{ type: "text-delta", id: "t", delta: "the wrapped answer" },
							{ type: "text-end", id: "t" },
							finish("stop", opts.inputTokens ?? 10),
						];
				return {
					stream: new ReadableStream<LanguageModelV4StreamPart>({
						start(controller) {
							controller.enqueue({ type: "stream-start", warnings: [] });
							for (const p of parts) controller.enqueue(p);
							controller.close();
						},
					}),
				};
			},
		};
		return { model, requests };
	}
	function loopSetup(
		model: LanguageModel,
		opts: {
			execute?: () => unknown;
			executeAsync?: () => Promise<unknown>;
			contextWindow?: number;
		} = {},
	) {
		const store = openStore(tmpdb());
		const conv = store.resolve(appAddress("loop"), "/w");
		let executions = 0;
		const runtime = new Runtime({
			store,
			buildStep: () => ({
				model,
				system: "test",
				...(opts.contextWindow !== undefined ? { contextWindow: opts.contextWindow } : {}),
			}),
			makeTools: () => ({
				probe: tool({
					inputSchema: z.looseObject({}),
					execute: opts.executeAsync
						? async () => {
								executions++;
								return opts.executeAsync!();
							}
						: () => {
								executions++;
								return opts.execute ? opts.execute() : "ok";
							},
				}),
			}),
		});
		return { store, conv, runtime, executions: () => executions };
	}
	const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;
	const WARN_BIT = "same tool call and gotten the same result 10 times";
	const CUT_BIT = "kept returning the same result";

	test("no cap: 80 distinct tool calls complete normally, unforced", async () => {
		const { model, requests } = loopModel({ calls: 80, input: (n) => ({ n }) });
		const { store, conv, runtime, executions } = loopSetup(model);
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "dig everywhere" }]), sink);
		expect(await sink.done).toEqual({ kind: "completed" });
		while (runtime.busy(conv.id)) await sleep(1);
		await runtime.shutdown();
		// 80 tool steps then the answer step — no forced landing.
		expect(requests).toHaveLength(81);
		expect(requests.every((r) => r.toolChoice !== "none")).toBe(true);
		expect(executions()).toBe(80);
		expect(sink.text).toBe("the wrapped answer");
		const md = (store.history(conv.id)[1] as { metadata?: unknown }).metadata as
			| { forcedCompletion?: unknown }
			| undefined;
		expect(md?.forcedCompletion).toBeUndefined();
		store.close();
	});

	test("repeat detector: identical call+result warns once at 10, cuts at 20", async () => {
		// Every step re-issues the same call; the tool returns the same
		// result — the definition of no progress.
		const { model, requests } = loopModel();
		const { store, conv, runtime } = loopSetup(model, { execute: () => "same result" });
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "spin" }]), sink);
		expect(await sink.done).toEqual({ kind: "completed", forced: "repeat" });
		while (runtime.busy(conv.id)) await sleep(1);
		await runtime.shutdown();
		// 20 tool steps: warn appended at the request after the 10th
		// result, cut lands tools-off on the request after the 20th.
		expect(requests).toHaveLength(21);
		// The warning lands exactly once per request — appended once at a
		// boundary and carried forward by the SDK, never re-appended.
		expect(requests.slice(0, 10).every((r) => !r.prompt.includes(WARN_BIT))).toBe(true);
		for (const r of requests.slice(10)) {
			expect(occurrences(r.prompt, WARN_BIT)).toBe(1);
		}
		expect(requests[20]!.toolChoice).toBe("none");
		expect(occurrences(requests[20]!.prompt, CUT_BIT)).toBe(1);
		expect(requests.slice(0, 20).every((r) => !r.prompt.includes(CUT_BIT))).toBe(true);
		expect(sink.text).toBe("the wrapped answer");
		// The landing stamps itself in the stored metadata.
		const md = (store.history(conv.id)[1] as { metadata?: unknown }).metadata as
			| { forcedCompletion?: unknown }
			| undefined;
		expect(md?.forcedCompletion).toBe("repeat");
		store.close();
	});

	test("same call with changing results never trips the detector", async () => {
		const { model, requests } = loopModel({ calls: 25, input: () => ({ poll: true }) });
		const { store, conv, runtime } = loopSetup(model, { execute: () => `fresh ${Math.random()}` });
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "poll" }]), sink);
		expect(await sink.done).toEqual({ kind: "completed" });
		expect(requests.every((r) => r.toolChoice !== "none")).toBe(true);
		expect(requests.every((r) => !r.prompt.includes(WARN_BIT))).toBe(true);
		store.close();
	});

	describe("loop watchdog", () => {
		// The system1 progress check (design/model.md): every N completed
		// calls the turn's own digest ring is scored "stuck". ≥0.7 warns;
		// a second consecutive ≥0.7 cuts; a pass resets. Fail-open.
		function decideScript(scores: (number | Error)[]): {
			decide: JevClient["decide"];
			states: { totalToolCalls: number; recentCalls: { result: string }[] }[];
			// A check in flight survives onDone (the verdict lands after the
			// turn's last request) — tests that assert on calls must await it.
			settled(): Promise<void>;
		} {
			const states: { totalToolCalls: number; recentCalls: { result: string }[] }[] = [];
			let i = 0;
			let pending = 0;
			const decide: JevClient["decide"] = async (state, questions) => {
				pending++;
				try {
					// Settle inside the next tool's execution so the verdict is
					// deterministic in time (probe's 20ms execution pads it).
					await sleep(5);
					expect(questions["stuck"]).toBeDefined();
					const s = state as {
						totalToolCalls: number;
						recentCalls: { result: string; tool: string }[];
					};
					expect(s.totalToolCalls).toBeGreaterThan(0);
					// The watchdog's own ring carries real results — never the
					// "(no result)" placeholder an evidence ring would show.
					expect(s.recentCalls.length).toBeGreaterThan(0);
					for (const c of s.recentCalls) {
						expect(c.result).not.toBe("(no result)");
						expect(c.result.length).toBeGreaterThan(0);
					}
					states.push({ totalToolCalls: s.totalToolCalls, recentCalls: s.recentCalls });
					const score = scores[i++];
					if (score instanceof Error) throw score;
					return { answers: { stuck: score ?? 0 }, inputTokens: 5, cost: 0 };
				} finally {
					pending--;
				}
			};
			return {
				decide,
				states,
				settled: async () => {
					while (pending > 0) await sleep(1);
				},
			};
		}

		test("two consecutive stuck verdicts cut — the first warns", async () => {
			const { model, requests } = loopModel();
			const { decide, states } = decideScript([0.9, 0.9]);
			const { store, conv, runtime } = loopSetup(model, {
				executeAsync: async () => {
					await sleep(20);
					return "ok";
				},
			});
			runtime.setLoopWatchdog({ decide, every: 2 });
			const sink = new RecordingSink();
			runtime.submit(conv, userMessage([{ type: "text", text: "spin" }]), sink);
			expect(await sink.done).toEqual({ kind: "completed", forced: "watchdog" });
			while (runtime.busy(conv.id)) await sleep(1);
			await runtime.shutdown();
			// Checks at calls 2 and 4: the first warns (lands in the next
			// boundary's request, tools still on), the second cuts — the
			// last request is the tools-off landing with the cut nudge.
			expect(states).toHaveLength(2);
			const cut = requests.length - 1;
			expect(requests[cut]!.toolChoice).toBe("none");
			expect(occurrences(requests[cut]!.prompt, "judged stuck twice in a row")).toBe(1);
			// The warning was appended once and carried forward — once in
			// the cut request too, never duplicated.
			expect(occurrences(requests[cut]!.prompt, "look stuck")).toBe(1);
			expect(requests.slice(0, cut).every((r) => r.toolChoice !== "none")).toBe(true);
			expect(sink.text).toBe("the wrapped answer");
			const md = (store.history(conv.id)[1] as { metadata?: unknown }).metadata as
				| { forcedCompletion?: unknown }
				| undefined;
			expect(md?.forcedCompletion).toBe("watchdog");
			store.close();
		});

		test("a sub-threshold check resets the escalation — no cut", async () => {
			const { model, requests } = loopModel({ calls: 6 });
			const { decide, states, settled } = decideScript([0.9, 0.1, 0.9]);
			const { store, conv, runtime } = loopSetup(model, {
				executeAsync: async () => {
					await sleep(20);
					return "ok";
				},
			});
			runtime.setLoopWatchdog({ decide, every: 2 });
			const sink = new RecordingSink();
			runtime.submit(conv, userMessage([{ type: "text", text: "grind" }]), sink);
			expect(await sink.done).toEqual({ kind: "completed" });
			while (runtime.busy(conv.id)) await sleep(1);
			await runtime.shutdown();
			await settled(); // the last check can outlive the answer step
			// warn, reset, warn — never two consecutive stuck verdicts.
			expect(states).toHaveLength(3);
			expect(requests.every((r) => r.toolChoice !== "none")).toBe(true);
			store.close();
		});

		test("an unavailable system1 fails open — the turn completes", async () => {
			const { model, requests } = loopModel({ calls: 4 });
			const { decide, settled } = decideScript([
				new Error("system1 down"),
				new Error("system1 down"),
			]);
			const { store, conv, runtime } = loopSetup(model, {
				executeAsync: async () => {
					await sleep(20);
					return "ok";
				},
			});
			runtime.setLoopWatchdog({ decide, every: 2 });
			const sink = new RecordingSink();
			runtime.submit(conv, userMessage([{ type: "text", text: "grind" }]), sink);
			expect(await sink.done).toEqual({ kind: "completed" });
			while (runtime.busy(conv.id)) await sleep(1);
			await runtime.shutdown();
			await settled();
			expect(requests.every((r) => r.toolChoice !== "none")).toBe(true);
			store.close();
		});
	});

	test("context landing: a step at ≥85% of the window forces tools-off", async () => {
		const { model, requests } = loopModel({ calls: 5, inputTokens: 900 });
		const { store, conv, runtime } = loopSetup(model, { contextWindow: 1000 });
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "fill me" }]), sink);
		expect(await sink.done).toEqual({ kind: "completed", forced: "context" });
		while (runtime.busy(conv.id)) await sleep(1);
		await runtime.shutdown();
		// Step 1's 900/1000 input crossed the line — request 2 is the
		// tools-off landing with the context nudge, not call 5.
		expect(requests).toHaveLength(2);
		expect(requests[1]!.toolChoice).toBe("none");
		expect(occurrences(requests[1]!.prompt, "context window is nearly full")).toBe(1);
		expect(sink.text).toBe("the wrapped answer");
		const md = (store.history(conv.id)[1] as { metadata?: unknown }).metadata as
			| { forcedCompletion?: unknown }
			| undefined;
		expect(md?.forcedCompletion).toBe("context");
		store.close();
	});

	test("a poisoned steer at the landing step does not eat the cut", async () => {
		// The steer claims the pending queue but its conversion fails —
		// the landing must still land tools-off (review m1).
		let releaseTool: () => void = () => {};
		const gate = new Promise<void>((r) => {
			releaseTool = r;
		});
		const { model, requests } = loopModel({ inputTokens: 900 });
		const { store, conv, runtime } = loopSetup(model, {
			contextWindow: 1000,
			executeAsync: async () => {
				await gate;
				return "ok";
			},
		});
		const s1 = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "start" }]), s1);
		await sleep(20); // parked mid-tool-call
		const s2 = new RecordingSink();
		runtime.submit(
			conv,
			{
				id: "poison",
				role: "user",
				parts: [
					{ type: "text", text: "read this" },
					{ type: "file", mediaType: "image/png", filename: "x.png", url: "not a url" },
				],
			} as UIMessage,
			s2,
		);
		releaseTool();
		// The context cut (900/1000 on step 1) still lands: the steer
		// errored its own delivery and the forced step went tools-off.
		expect(await s1.done).toEqual({ kind: "completed", forced: "context" });
		expect((await s2.done).kind).toBe("error");
		while (runtime.busy(conv.id)) await sleep(1);
		await runtime.shutdown();
		expect(requests.at(-1)!.toolChoice).toBe("none");
		expect(requests.at(-1)!.prompt).toContain("context window is nearly full");
		expect(s1.text).toBe("the wrapped answer");
		store.close();
	});
});

describe("forced-landing defiance guard", () => {
	// Review 2026-10-07, m3: the "turn always ends in an answer" invariant
	// rested on provider compliance with toolChoice:none. This model
	// ignores it — every step, forced or not, emits a tool call and
	// finish=tool-calls. The guard must close the turn with synthetic
	// prose anyway: stored, and live on the delta path (telegram's wire).
	test("defiant model still gets an answer — synthetic prose, stamped", async () => {
		const requests: { toolChoice: unknown }[] = [];
		const model: LanguageModel = {
			specificationVersion: "v4",
			provider: "fake",
			modelId: "defiant",
			supportedUrls: {},
			doGenerate() {
				throw new Error("unused");
			},
			async doStream(options) {
				requests.push({ toolChoice: options.toolChoice?.type ?? null });
				return {
					stream: new ReadableStream({
						start(controller) {
							controller.enqueue({ type: "stream-start", warnings: [] });
							controller.enqueue({
								type: "tool-call",
								toolCallId: `c${requests.length}`,
								toolName: "probe",
								input: "{}",
							} satisfies LanguageModelV4StreamPart);
							controller.enqueue({
								type: "finish",
								finishReason: { unified: "tool-calls", raw: undefined },
								usage: {
									inputTokens: {
										total: 900,
										noCache: undefined,
										cacheRead: undefined,
										cacheWrite: undefined,
									},
									outputTokens: { total: 1, text: undefined, reasoning: undefined },
								},
							} satisfies LanguageModelV4StreamPart);
							controller.close();
						},
					}),
				};
			},
		};
		const store = openStore(tmpdb());
		const conv = store.resolve(appAddress("defiant"), "/w");
		let executions = 0;
		const runtime = new Runtime({
			store,
			// 900/1000 on every step — the context landing drives the cut.
			buildStep: () => ({ model, system: "test", contextWindow: 1000 }),
			makeTools: () => ({
				probe: tool({
					inputSchema: z.object({}),
					execute: () => {
						executions++;
						return "ok";
					},
				}),
			}),
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "never answer" }]), sink);
		expect(await sink.done).toEqual({ kind: "completed", forced: "context" });
		while (runtime.busy(conv.id)) await sleep(1);
		await runtime.shutdown();
		// The forced step was sent with toolChoice none — and defied.
		expect(requests.at(-1)!.toolChoice).toBe("none");
		expect(executions).toBeGreaterThanOrEqual(1);
		// The invariant's last word: prose in history AND on the delta
		// wire, worded for the landing that fired.
		const reply = store.history(conv.id)[1] as UIMessage;
		const text = reply.parts
			.filter((p) => p.type === "text")
			.map((p) => p.text)
			.join("");
		expect(text).toContain("My context window filled up before I wrote my answer");
		expect(sink.text).toContain("My context window filled up before I wrote my answer");
		store.close();
	});
});

test("model/thinking changes do not interrupt admitted turns; next turn and manual compaction resolve latest channel settings", async () => {
	const store = openStore(tmpdb());
	let cfg = parseConfig({
		providers: { test: { kind: "codex" } },
		model: "test/app",
		thinking: "high",
		allowedUsers: [7],
		telegram: { model: "test/telegram", thinking: "low" },
	});
	const app = store.resolve(appAddress("channel-settings"), "/work");
	const dm = store.resolve({ kind: "dm", chatId: 7 }, "/work");
	store.setMeta(dm.id, { model: "test/retired", thinking: "max" });
	let release: () => void = () => {};
	const held = new Promise<void>((r) => {
		release = r;
	});
	let calls = 0;
	const summaries: string[] = [];
	const runtime = new Runtime({
		store,
		captureConversation: (conv) => captureConversationSettings(store, conv, cfg),
		async buildStep(conv) {
			if (++calls === 1) await held;
			return {
				model: fakeModel([`${conv.model}:${conv.thinking}`], 1),
				system: "test",
				label: conv.model!,
			};
		},
		makeTools: () => ({}),
		compaction: {
			modelRef: (conv) => conv.model!,
			summarize: async (conv) => {
				summaries.push(`${conv.model}:${conv.thinking}`);
				return "summary";
			},
		},
	});
	try {
		const first = new RecordingSink();
		runtime.submit(app, userMessage([{ type: "text", text: "first" }]), first);
		await first.admitted;
		store.setMeta(app.id, { model: "test/personal", thinking: "max" });
		cfg = parseConfig({
			...cfg,
			model: "test/future",
			thinking: "off",
			telegram: { ...cfg.telegram, model: "test/telegram-new", thinking: "medium" },
		});
		release();
		expect((await first.done).kind).toBe("completed");
		expect(first.text).toBe("test/app:high");
		const second = new RecordingSink();
		runtime.submit(app, userMessage([{ type: "text", text: "second" }]), second);
		expect((await second.done).kind).toBe("completed");
		expect(second.text).toBe("test/personal:max");
		const telegram = new RecordingSink();
		runtime.submit(dm, userMessage([{ type: "text", text: "telegram" }]), telegram);
		expect((await telegram.done).kind).toBe("completed");
		expect(telegram.text).toBe("test/telegram-new:medium");
		// Force enough history to compact, then use an intentionally stale
		// Conversation object: /compact resolves at execution, not enqueue.
		for (let i = 0; i < 4; i++)
			store.append(app.id, [
				userMessage([{ type: "text", text: "past ".repeat(25000) }]),
				{ id: `past-${i}`, role: "assistant", parts: [{ type: "text", text: "done" }] },
			]);
		store.setMeta(app.id, { model: "test/compact", thinking: "low" });
		expect((await runtime.compact(app)).kind).toBe("compacted");
		expect(summaries.every((s) => s === "test/compact:low")).toBe(true);
		expect(summaries.length).toBeGreaterThan(0);
		expect(store.getCompaction(app.id)!.model).toBe("test/compact");
	} finally {
		await runtime.shutdown();
		store.close();
	}
});

test("overflow compaction and resumed model call keep the admitted selection across settings edits", async () => {
	const store = openStore(tmpdb());
	const conv = store.resolve(appAddress("overflow-settings"), "/work");
	seedExchanges(store, conv.id);
	const cfg = parseConfig({
		providers: { test: { kind: "codex" } },
		model: "test/original",
		thinking: "high",
		allowedUsers: [7],
	});
	const { model } = scriptedModel([overflowError(), textReply("recovered"), textReply("next")]);
	const selections: string[] = [];
	const summarySelections: string[] = [];
	const runtime = new Runtime({
		store,
		captureConversation: (row) => captureConversationSettings(store, row, cfg),
		buildStep: (row) => {
			selections.push(`${row.model}:${row.thinking}`);
			return { model, system: "test", contextWindow: 1000 };
		},
		makeTools: () => ({}),
		compaction: {
			modelRef: (row) => row.model!,
			summarize: async (row) => {
				store.setMeta(row.id, { model: "test/changed", thinking: "low" });
				summarySelections.push(`${row.model}:${row.thinking}`);
				return "summary";
			},
		},
	});
	try {
		const first = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "recover" }]), first);
		expect((await first.done).kind).toBe("completed");
		expect(first.text).toBe("recovered");
		expect(selections).toEqual(["test/original:high", "test/original:high", "test/original:high"]);
		expect(summarySelections).toEqual(["test/original:high"]);
		expect(store.getCompaction(conv.id)!.model).toBe("test/original");
		const next = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "continue" }]), next);
		expect((await next.done).kind).toBe("completed");
		expect(selections.at(-1)).toBe("test/changed:low");
	} finally {
		await runtime.shutdown();
		store.close();
	}
});

test("invalid durable app settings report admission error exactly once without starting a model call", async () => {
	const store = openStore(tmpdb());
	const conv = store.resolve(appAddress("bad-settings"), "/work");
	store.setMeta(conv.id, { thinking: "corrupt-disk-value" });
	const cfg = parseConfig({
		providers: { test: { kind: "codex" } },
		model: "test/chat",
		allowedUsers: [7],
	});
	let modelCalls = 0;
	let completions = 0;
	const sink = new RecordingSink();
	const runtime = new Runtime({
		store,
		captureConversation: (row) => captureConversationSettings(store, row, cfg),
		buildStep: () => {
			modelCalls++;
			return { model: fakeModel(["unused"]), system: "test" };
		},
		makeTools: () => ({}),
	});
	try {
		runtime.submit(conv, userMessage([{ type: "text", text: "test" }]), {
			onTextDelta() {},
			onReasoningDelta() {},
			onToolCall() {},
			onDone(done) {
				completions++;
				sink.onDone(done);
			},
		});
		expect((await sink.done).kind).toBe("error");
		await runtime.shutdown();
		expect(modelCalls).toBe(0);
		expect(completions).toBe(1);
	} finally {
		store.close();
	}
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool, type LanguageModel, type UIMessage } from "ai";
import { z } from "zod";
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";
import { openStore } from "./conversation.ts";
import { setLogFile } from "./log.ts";
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

// Records the prompt each doStream call receives — JSON-stringified so
// requests compare bytewise across turns (cache-stability tests).
function recordingModel(deltas: string[], delayMs = 15) {
	const prompts: string[] = [];
	const base = fakeModel(deltas, delayMs) as unknown as {
		doStream(o: { prompt: unknown }): { stream: ReadableStream<LanguageModelV2StreamPart> };
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
					specificationVersion: "v2",
					provider: "fake",
					modelId: "fake-1",
					supportedUrls: {},
					doGenerate() {
						throw new Error("unimplemented");
					},
					doStream() {
						const stream = new ReadableStream<LanguageModelV2StreamPart>({
							async start(controller) {
								const push = (p: LanguageModelV2StreamPart) => {
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
									finishReason: "tool-calls",
									usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
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
					specificationVersion: "v2",
					provider: "fake",
					modelId: "two-part-1",
					supportedUrls: {},
					doGenerate() {
						throw new Error("unimplemented");
					},
					doStream() {
						const stream = new ReadableStream<LanguageModelV2StreamPart>({
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
									finishReason: "stop",
									usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
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
					specificationVersion: "v2",
					provider: "fake",
					modelId: "two-step-1",
					supportedUrls: {},
					doGenerate() {
						throw new Error("unimplemented");
					},
					doStream() {
						call++;
						const stream = new ReadableStream<LanguageModelV2StreamPart>({
							start(controller) {
								const push = (p: LanguageModelV2StreamPart) => controller.enqueue(p);
								push({ type: "stream-start", warnings: [] });
								if (call === 1) {
									push({ type: "text-start", id: "t1" });
									push({ type: "text-delta", id: "t1", delta: "yo 👋 what's up" });
									push({ type: "text-end", id: "t1" });
									push({ type: "tool-call", toolCallId: "c1", toolName: "probe", input: "{}" });
									push({
										type: "finish",
										finishReason: "tool-calls",
										usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
									});
								} else {
									// Same id as step 1 — deliberate.
									push({ type: "text-start", id: "t1" });
									push({ type: "text-delta", id: "t1", delta: "Workspace is basically fresh" });
									push({ type: "text-end", id: "t1" });
									push({
										type: "finish",
										finishReason: "stop",
										usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
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
					specificationVersion: "v2",
					provider: "fake",
					modelId: "err-1",
					supportedUrls: {},
					doGenerate() {
						throw new Error("unimplemented");
					},
					doStream() {
						const stream = new ReadableStream<LanguageModelV2StreamPart>({
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

	test("a message landing while the model step resolves stays out of the running turn", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const prompts: string[] = [];
		let resolveStep!: (step: { model: LanguageModel; system: string }) => void;
		const stepReady = new Promise<{ model: LanguageModel; system: string }>((r) => {
			resolveStep = r;
		});
		const base = fakeModel(["ok"], 5) as unknown as {
			doStream(o: { prompt: unknown }): { stream: ReadableStream<LanguageModelV2StreamPart> };
		};
		const recording = {
			...base,
			doStream(o: { prompt: unknown }) {
				prompts.push(JSON.stringify(o.prompt));
				return base.doStream(o);
			},
		} as unknown as LanguageModel;
		const runtime = new Runtime({
			store,
			buildStep: () => stepReady,
			makeTools: () => ({}),
		});
		const s1 = new RecordingSink();
		const s2 = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "first" }]), s1);
		await sleep(0); // turn 1 is now parked inside buildStep
		runtime.submit(conv, userMessage([{ type: "text", text: "second" }]), s2);
		resolveStep({ model: recording, system: "test" });
		await Promise.all([s1.done, s2.done]);
		// turn 1 admitted before "second" landed — it must not answer it;
		// turn 2 owns it.
		expect(prompts[0]).toContain("first");
		expect(prompts[0]).not.toContain("second");
		expect(prompts[1]).toContain("second");
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
			userMessage([
				att(a, "a.png", 9),
				{ type: "text", text: "what is this" },
			]),
			s1,
		);
		expect(await s1.done).toEqual({ kind: "completed" });
		const s2 = new RecordingSink();
		runtime.submit(
			conv,
			userMessage([
				att(b, "b.png", 9),
				{ type: "text", text: "and this" },
			]),
			s2,
		);
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
			specificationVersion: "v2",
			provider: "fake",
			modelId: "fake-1",
			supportedUrls: {},
			doGenerate() {
				throw new Error("unimplemented");
			},
			doStream() {
				const stream = new ReadableStream<LanguageModelV2StreamPart>({
					start(controller) {
						controller.enqueue({ type: "stream-start", warnings: [] });
						controller.enqueue({ type: "text-start", id: "t1" });
						controller.enqueue({ type: "text-delta", id: "t1", delta: "ok" });
						controller.enqueue({ type: "text-end", id: "t1" });
						controller.enqueue({
							type: "finish",
							finishReason: "stop",
							usage: {
								inputTokens: 900,
								outputTokens: 1,
								totalTokens: 901,
								cachedInputTokens: 700,
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
				cachedInputTokens: 700,
				outputTokens: 1,
			});
			const completed = lines.find((l) => l.msg === "turn completed");
			expect(completed?.window).toEqual({ input: 900, limit: 1000, pct: 90 });
			expect(completed?.usage).toEqual({ input: 900, cached: 700, output: 1 });
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
				specificationVersion: "v2",
				provider: "fake",
				modelId: "fake-1",
				supportedUrls: {},
				doGenerate() {
					throw new Error("unimplemented");
			},
				doStream() {
					const stream = new ReadableStream<LanguageModelV2StreamPart>({
						start(controller) {
							controller.enqueue({ type: "stream-start", warnings: [] });
							controller.enqueue({ type: "text-start", id: "t1" });
							controller.enqueue({ type: "text-delta", id: "t1", delta: "ok" });
							controller.enqueue({ type: "text-end", id: "t1" });
							controller.enqueue({
								type: "finish",
								finishReason: "stop",
								usage: { inputTokens, outputTokens: 1, totalTokens: inputTokens + 1 },
							});
							controller.close();
						},
					});
					return { stream };
				},
			} as unknown as LanguageModel);
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
		expect(pointer).toMatchObject({ boundarySeq: 4, summary: "the folded era", model: "zai/glm-5.3" });
		// The record stays whole; the model view is summary + kept tail.
		expect(store.history(conv.id)).toHaveLength(8);
		const view = store.modelEntries(conv.id);
		expect(view).toHaveLength(5);
		expect((view[0]!.message.parts[0] as { text: string }).text).toContain("the folded era");
		const lastText = view
			.at(-1)!
			.message.parts.find((p) => (p as { type: string }).type === "text") as { text: string } | undefined;
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
			buildStep: () => ({ model: fakeModel(["slow ", "reply"], 40), system: "test", contextWindow: 1000 }),
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
		const tail = store.modelEntries(conv.id).slice(1).map((e) => e.seq);
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
			buildStep: () => ({ model: fakeModel(["slow ", "reply"], 40), system: "test", contextWindow: 1000 }),
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

	test("provider warnings are logged, not dropped", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const dir = mkdtempSync(join(tmpdir(), "goblin-rt-log-"));
		dirs.push(dir);
		const logFile = join(dir, "goblin.log");
		const model = {
			specificationVersion: "v2",
			provider: "fake",
			modelId: "fake-1",
			supportedUrls: {},
			doGenerate() {
				throw new Error("unimplemented");
			},
			doStream() {
				const stream = new ReadableStream<LanguageModelV2StreamPart>({
					start(controller) {
						controller.enqueue({
							type: "stream-start",
							warnings: [
								{ type: "unsupported-setting", setting: "temperature" },
							],
						});
						controller.enqueue({ type: "text-start", id: "t1" });
						controller.enqueue({ type: "text-delta", id: "t1", delta: "ok" });
						controller.enqueue({ type: "text-end", id: "t1" });
						controller.enqueue({
								type: "finish",
								finishReason: "stop",
								usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
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
			expect(warn?.warnings).toEqual(["unsupported-setting:temperature"]);
		} finally {
			setLogFile(null);
			store.close();
		}
	});
});

describe("skill reviewer hook", () => {
	// A model that calls a tool, then answers — scripted streams per step.
	function toolThenText(toolName: string, deltas: string[]): LanguageModel {
		let step = 0;
		return {
			specificationVersion: "v2",
			provider: "fake",
			modelId: "fake-tool",
			supportedUrls: {},
			doGenerate() {
				throw new Error("unimplemented");
			},
			doStream() {
				const n = step++;
				const stream = new ReadableStream<LanguageModelV2StreamPart>({
					start(controller) {
						controller.enqueue({ type: "stream-start", warnings: [] });
						if (n === 0) {
							controller.enqueue({ type: "tool-call", toolCallId: "c1", toolName, input: "{}" });
							controller.enqueue({
								type: "finish",
								finishReason: "tool-calls",
								usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
							});
						} else {
							controller.enqueue({ type: "text-start", id: "t1" });
							for (const d of deltas) controller.enqueue({ type: "text-delta", id: "t1", delta: d });
							controller.enqueue({ type: "text-end", id: "t1" });
							controller.enqueue({
								type: "finish",
								finishReason: "stop",
								usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
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
			threshold: 0.8,
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
			threshold: 0.8,
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
});

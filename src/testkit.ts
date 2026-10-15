// Shared test harness — boundary fakes and filesystem fixtures for the
// colocated suites. House rule (AGENTS.md): fake the model provider and
// the Telegram API at the edge, never mock module internals. The fakes
// here ARE that edge, so every suite shares one copy and they drift
// together: a provider-contract change updates one fake, not four.
//
// Importing this module registers an afterEach that removes every
// tracked temp dir and restores GOBLIN_HOME — test files get cleanup
// by importing, and must not also restore GOBLIN_HOME by hand for dirs
// obtained here. Test-only: production modules never import this file.

import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	LanguageModelV4CallOptions,
	LanguageModelV4GenerateResult,
	LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import type { LanguageModel, UIMessageChunk } from "ai";
import { openStore, type ConversationStore } from "./conversation.ts";
import type { TurnDone, TurnSink } from "./runtime.ts";

// ---------- filesystem fixtures ----------

const trackedDirs: string[] = [];
let savedHome: string | undefined;
let homeSaved = false;

afterEach(() => {
	for (const d of trackedDirs.splice(0)) rmSync(d, { recursive: true, force: true });
	if (homeSaved) {
		if (savedHome === undefined) delete process.env.GOBLIN_HOME;
		else process.env.GOBLIN_HOME = savedHome;
		savedHome = undefined;
		homeSaved = false;
	}
});

/** A fresh temp dir, removed after the test. */
export function tmpDir(prefix = "goblin-test-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	trackedDirs.push(dir);
	return dir;
}

/** Point GOBLIN_HOME at a fresh temp dir (restored after the test). */
export function useHome(prefix = "goblin-home-"): string {
	if (!homeSaved) {
		savedHome = process.env.GOBLIN_HOME;
		homeSaved = true;
	}
	const dir = tmpDir(prefix);
	process.env.GOBLIN_HOME = dir;
	return dir;
}

/** Path to a not-yet-created sqlite file inside a tracked temp dir. */
export function tmpDb(prefix = "goblin-db-"): string {
	return join(tmpDir(prefix), "goblin.sqlite");
}

/** An open conversation store on a temp db. The caller closes it. */
export function openTestStore(prefix?: string): {
	store: ConversationStore;
	dbPath: string;
	dir: string;
} {
	const dbPath = tmpDb(prefix);
	return { store: openStore(dbPath), dbPath, dir: join(dbPath, "..") };
}

// ---------- timing: event awaits, not guesses ----------

export const sleep = (ms: number) =>
	new Promise<void>((r) => setTimeout(r, ms));

/**
 * Poll `cond` until it holds, failing loud after `timeoutMs`. Replaces
 * unbounded `while (…) await sleep(1)` loops (a hang becomes a named
 * failure) and fixed "should be enough" sleeps before an observable
 * state (the condition is the proof, not the elapsed time).
 */
export async function waitUntil(
	cond: () => boolean | Promise<boolean>,
	label: string,
	timeoutMs = 5_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await cond()) return;
		if (Date.now() >= deadline) throw new Error(`waitUntil timed out: ${label}`);
		await sleep(1);
	}
}

/** A promise with its resolution handed to the test — a gate, not a sleep. */
export function deferred<T = void>(): {
	promise: Promise<T>;
	resolve: (v: T | PromiseLike<T>) => void;
	reject: (e: unknown) => void;
} {
	let resolve: (v: T | PromiseLike<T>) => void = () => {};
	let reject: (e: unknown) => void = () => {};
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

// ---------- model provider fakes (the edge) ----------

/**
 * Streaming fake: emits `deltas` as one text part, one per `delayMs`,
 * then a stop finish. Respects the abort signal between deltas — a
 * fence must be able to kill the stream mid-flight.
 */
export function fakeModel(deltas: string[], delayMs = 5): LanguageModel {
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

/** fakeModel that also records each request's prompt, JSON-stringified. */
export function recordingModel(
	deltas: string[],
	delayMs = 5,
): { model: LanguageModel; prompts: string[] } {
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

/** What the generate-arm fake provider observed, per call. */
export interface GenerateCall {
	prompt: LanguageModelV4CallOptions["prompt"];
	maxOutputTokens: number | undefined;
	abortSignal: AbortSignal | undefined;
}

export type GenerateResponder = (
	opts: LanguageModelV4CallOptions,
) => LanguageModelV4GenerateResult | Promise<LanguageModelV4GenerateResult>;

/** Generate-arm fake (doGenerate): records the call, answers via `respond`. */
export function fakeGenerateModel(calls: GenerateCall[], respond: GenerateResponder): LanguageModel {
	return {
		specificationVersion: "v4",
		provider: "fake",
		modelId: "fake-1",
		supportedUrls: {},
		async doGenerate(opts: LanguageModelV4CallOptions) {
			calls.push({
				prompt: opts.prompt,
				maxOutputTokens: opts.maxOutputTokens,
				abortSignal: opts.abortSignal,
			});
			return respond(opts);
		},
	} as unknown as LanguageModel;
}

// ---------- turn sinks ----------

/**
 * The full-featured recording sink: delta text, the raw chunk stream
 * (the app channel's SSE surface rides it verbatim), tool calls, and
 * event promises tests await instead of sleeping — `admitted` (the
 * authority check is installed, before any model work), `firstDelta`
 * (mid-stream), `firstToolCall` (the model emitted a tool call).
 * Defining onStreamChunk makes submits through this sink streaming —
 * use HeadlessSink where the headless lane is the subject.
 */
export class RecordingSink implements TurnSink {
	text = "";
	chunkTypes: string[] = [];
	chunks: UIMessageChunk[] = [];
	toolCalls: string[] = [];
	done: Promise<TurnDone>;
	admitted: Promise<void>;
	firstDelta: Promise<void>;
	firstToolCall: Promise<string>;
	private resolveDone: (d: TurnDone) => void;
	private markAdmitted: () => void = () => {};
	private markFirstDelta: () => void = () => {};
	private markFirstToolCall: (name: string) => void = () => {};
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
		this.firstToolCall = new Promise<string>((res) => {
			this.markFirstToolCall = res;
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
	onToolCall(toolName: string) {
		this.toolCalls.push(toolName);
		this.markFirstToolCall(toolName);
	}
	onStreamChunk(chunk: UIMessageChunk) {
		this.chunkTypes.push(chunk.type);
		this.chunks.push(chunk);
	}
	onDone(d: TurnDone) {
		this.resolveDone(d);
	}
}

/**
 * Delivery-hooks-only sink (the spin-off bell's shape): no
 * onStreamChunk, so the streaming-lane boundary treats it as headless.
 * It only ever sees the turn's terminal outcome.
 */
export class HeadlessSink implements TurnSink {
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

/**
 * Delivery-completion park: the turn finished and its onDone is held
 * on a gate, so the drain loop is still "running" while new submits
 * only queue (a slow Telegram send or bell delivery holding the lane).
 */
export class ParkedDoneSink implements TurnSink {
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

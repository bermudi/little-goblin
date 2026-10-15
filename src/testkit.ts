import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel, UIMessageChunk } from "ai";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
export { openStore } from "./conversation.ts";
import type { TurnDone, TurnSink } from "./runtime.ts";

export interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T | PromiseLike<T>): void;
	reject(reason?: unknown): void;
}

export function deferred<T = void>(): Deferred<T> {
	let resolve!: Deferred<T>["resolve"];
	let reject!: Deferred<T>["reject"];
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

export interface FakeModelOptions {
	/** Optional pause before each emitted delta. Prefer beforeDelta for gated tests. */
	delayMs?: number;
	/** Event-controlled pause point for deterministic stream/race tests. */
	beforeDelta?: (
		delta: string,
		index: number,
		signal: AbortSignal | undefined,
	) => void | Promise<void>;
	modelId?: string;
}

/**
 * A small provider-edge stream fake shared by integration tests. Tests that
 * need an in-flight turn should gate a specific delta with beforeDelta rather
 * than depending on scheduler timing.
 */
export function fakeModel(
	deltas: string[],
	options: FakeModelOptions | number = {},
): LanguageModel {
	const opts = typeof options === "number" ? { delayMs: options } : options;
	return {
		specificationVersion: "v4",
		provider: "fake",
		modelId: opts.modelId ?? "fake-1",
		supportedUrls: {},
		doGenerate() {
			throw new Error("unimplemented");
		},
		doStream(options: { abortSignal?: AbortSignal }) {
			const { abortSignal } = options;
			const stream = new ReadableStream<LanguageModelV4StreamPart>({
				async start(controller) {
					const push = (part: LanguageModelV4StreamPart) => {
						try {
							controller.enqueue(part);
						} catch {
							// The consumer may cancel the stream during a fenced turn.
						}
					};
					push({ type: "stream-start", warnings: [] });
					push({ type: "text-start", id: "t1" });
					for (const [index, delta] of deltas.entries()) {
						if (abortSignal?.aborted) break;
						await opts.beforeDelta?.(delta, index, abortSignal);
						if (abortSignal?.aborted) break;
						if (opts.delayMs !== undefined && opts.delayMs > 0) {
							await new Promise<void>((resolve) => setTimeout(resolve, opts.delayMs));
						}
						if (abortSignal?.aborted) break;
						push({ type: "text-delta", id: "t1", delta });
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
							outputTokens: {
								total: deltas.length,
								text: undefined,
								reasoning: undefined,
							},
						},
					});
					try {
						controller.close();
					} catch {
						// The consumer may have cancelled while the stream was closing.
					}
				},
			});
			return { stream };
		},
	} as unknown as LanguageModel;
}

/** Records the runtime's delivery and streaming hooks, with event promises for race tests. */
export class RecordingSink implements TurnSink {
	text = "";
	chunkTypes: string[] = [];
	chunks: UIMessageChunk[] = [];
	readonly done: Promise<TurnDone>;
	readonly admitted: Promise<void>;
	readonly firstDelta: Promise<void>;
	private resolveDone!: (done: TurnDone) => void;
	private markAdmitted!: () => void;
	private markFirstDelta!: () => void;

	constructor() {
		this.done = new Promise<TurnDone>((resolve) => {
			this.resolveDone = resolve;
		});
		this.admitted = new Promise<void>((resolve) => {
			this.markAdmitted = resolve;
		});
		this.firstDelta = new Promise<void>((resolve) => {
			this.markFirstDelta = resolve;
		});
	}

	setAuthorityCheck() {
		this.markAdmitted();
	}

	onTextDelta(delta: string) {
		this.text += delta;
		this.markFirstDelta();
	}

	onReasoningDelta() {}
	onToolCall() {}

	onStreamChunk(chunk: UIMessageChunk) {
		this.chunkTypes.push(chunk.type);
		this.chunks.push(chunk);
	}

	onDone(done: TurnDone) {
		this.resolveDone(done);
	}
}

const tempDirs = new Set<string>();
let savedHome: string | undefined;
let homeWasCaptured = false;

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.add(dir);
	return dir;
}

/** Return a unique temporary SQLite filename; testkit removes its directory after each test. */
export function tmpdb(prefix = "goblin-test-"): string {
	return join(makeTempDir(prefix), "goblin.sqlite");
}

/** Create and select a temporary GOBLIN_HOME, restored and removed after each test. */
export function useHome(prefix = "goblin-test-"): string {
	if (!homeWasCaptured) {
		savedHome = process.env.GOBLIN_HOME;
		homeWasCaptured = true;
	}
	const home = makeTempDir(prefix);
	process.env.GOBLIN_HOME = home;
	return home;
}

afterEach(() => {
	try {
		for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	} finally {
		tempDirs.clear();
		if (homeWasCaptured) {
			if (savedHome === undefined) delete process.env.GOBLIN_HOME;
			else process.env.GOBLIN_HOME = savedHome;
			savedHome = undefined;
			homeWasCaptured = false;
		}
	}
});

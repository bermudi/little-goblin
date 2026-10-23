// Importing registers an afterEach that removes every tracked temp dir
// and restores GOBLIN_HOME — test files must not also restore it by
// hand for dirs obtained here. Test-only: production never imports this.
//
// Bun runs all test files of one invocation in a single process and
// scopes a module-level afterEach to the file whose import first ran
// this module: without bunfig.toml's [test] preload of this file,
// every later file would share trackedDirs without ever firing the
// hook (observed 2026-10-22: full-suite runs leaked ~86k mkdtemp dirs,
// ~15GB, until /tmp hit ENOSPC). The preload makes this hook global;
// the import-time sweep below heals what killed runs leave behind.

import { afterEach } from "bun:test";
import { mkdtempSync, readdirSync, rmdirSync, rmSync, statSync, type Dirent } from "node:fs";
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

let fixtureRoot: string | null = null;

function fixtureRootDir(): string {
	if (fixtureRoot === null) {
		fixtureRoot = mkdtempSync(join(tmpdir(), `goblin-test-fixtures-${process.pid}-`));
	}
	return fixtureRoot;
}

function releaseFixtureRootIfEmpty(): void {
	if (fixtureRoot === null) return;
	try {
		rmdirSync(fixtureRoot);
		fixtureRoot = null;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			fixtureRoot = null;
		} else if (code !== "ENOTEMPTY" && code !== "EEXIST") {
			console.error(`testkit fixture root release failed for ${fixtureRoot}: ${String(err)}`);
		}
	}
}

afterEach(() => {
	for (const d of trackedDirs.splice(0)) rmSync(d, { recursive: true, force: true });
	releaseFixtureRootIfEmpty();
	if (homeSaved) {
		if (savedHome === undefined) delete process.env.GOBLIN_HOME;
		else process.env.GOBLIN_HOME = savedHome;
		savedHome = undefined;
		homeSaved = false;
	}
});

/** Fixture dirs older than this are assumed abandoned and swept. */
export const STALE_MS = 60 * 60 * 1000;

const FIXTURE_ROOT_PATTERN = /^goblin-test-fixtures-([1-9]\d*)-[A-Za-z0-9]{6}$/;

function ownerDead(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ESRCH";
	}
}

/**
 * Remove stale fixture roots older than STALE_MS whose owner PID is
 * dead. Runs once per test process at import. Best effort by design:
 * entries raced away by a concurrent sweeper are fine (rmSync force
 * ignores ENOENT); only a persistent failure gets a stderr line so
 * hygiene never reddens a suite. `root` is injectable so tests can
 * sweep a private staging area rather than the shared tmpdir.
 */
export function sweepStaleFixtureDirs(root = tmpdir(), now = Date.now()): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return;
	}
	const cut = now - STALE_MS;
	for (const e of entries) {
		const match = FIXTURE_ROOT_PATTERN.exec(e.name);
		if (match === null || !e.isDirectory()) continue;
		const pid = Number.parseInt(match[1]!, 10);
		if (!Number.isSafeInteger(pid) || pid <= 0) continue;
		const dir = join(root, e.name);
		try {
			if (statSync(dir).mtimeMs >= cut) continue;
			if (!ownerDead(pid)) continue;
			rmSync(dir, { recursive: true, force: true });
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				console.error(`testkit stale sweep skipped ${dir}: ${String(err)}`);
			}
		}
	}
}

sweepStaleFixtureDirs();

/** A fresh temp dir inside this process's fixture root, removed after the test. */
export function tmpDir(prefix = "goblin-test-"): string {
	const dir = mkdtempSync(join(fixtureRootDir(), prefix));
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

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll `cond` until it holds, failing loud after `timeoutMs`. */
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

// Respects the abort signal between deltas — a fence must be able to
// kill the stream mid-flight. beforeDelta replaces the delay with an
// event-controlled pause point.

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
					for (const [index, d] of deltas.entries()) {
						if (signal?.aborted) break;
						await opts.beforeDelta?.(d, index, signal);
						if (signal?.aborted) break;
						if (opts.delayMs !== undefined && opts.delayMs > 0) await sleep(opts.delayMs);
						if (signal?.aborted) break;
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

/** Hold a provider stream at one delta until a test releases it. */
export function pauseFakeModelAtDelta(
	deltas: string[],
	index = 0,
): { model: LanguageModel; entered: Promise<void>; release(): void } {
	const entered = deferred<void>();
	const gate = deferred<void>();
	const model = fakeModel(deltas, {
		beforeDelta: async (_delta, current) => {
			if (current === index) {
				entered.resolve();
				await gate.promise;
			}
		},
	});
	return { model, entered: entered.promise, release: () => gate.resolve() };
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
export function fakeGenerateModel(
	calls: GenerateCall[],
	respond: GenerateResponder,
): LanguageModel {
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

// Defining onStreamChunk makes submits through this sink streaming —
// use HeadlessSink where the headless lane is the subject.

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

// No onStreamChunk, so the streaming-lane boundary treats it as headless
// (the spin-off bell's shape).

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

// onDone is held on a gate — the drain loop stays "running" while new
// submits only queue (a slow Telegram send or bell delivery).

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

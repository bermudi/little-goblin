import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel, UIMessage } from "ai";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { openStore } from "./conversation.ts";
import { HindsightClient } from "./hindsight.ts";
import type { MemoryConfig } from "./config.ts";
import { Runtime, userMessage, type TurnDone, type TurnSink } from "./runtime.ts";

let dirs: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
function tmpdb(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-memturn-"));
	dirs.push(dir);
	return join(dir, "goblin.sqlite");
}
afterEach(() => {
	for (const s of servers.splice(0)) s.stop(true);
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeModel(deltas: string[], delayMs = 5): LanguageModel {
	return {
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
							/* closed by abort */
						}
					};
					push({ type: "stream-start", warnings: [] });
					push({ type: "text-start", id: "t1" });
					for (const d of deltas) {
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
	} as unknown as LanguageModel;
}

class RecordingSink implements TurnSink {
	text = "";
	done: Promise<TurnDone>;
	// Resolves on the first observed text delta — proof the turn was
	// admitted (epoch captured) and is mid-stream. Fence-timing tests
	// await this instead of sleeping a guess.
	firstDelta: Promise<void>;
	private resolveDone: (d: TurnDone) => void;
	private markFirstDelta: () => void = () => {};
	constructor() {
		let r: (d: TurnDone) => void = () => {};
		this.done = new Promise<TurnDone>((res) => {
			r = res;
		});
		this.resolveDone = r;
		this.firstDelta = new Promise<void>((res) => {
			this.markFirstDelta = res;
		});
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

const memConfig: MemoryConfig = {
	baseUrl: "http://127.0.0.1:1",
	bankId: "g",
	recallTimeoutMs: 1000,
	maxTokens: 256,
	budget: "low",
};

interface Harness {
	recallCount(): number;
	// The recall query text of every /memories/recall request — the
	// exclusion boundary's regression assertions read exactly what left
	// the process (#85).
	recallQueries(): string[];
	retains: unknown[];
	conversation: string;
	runtime: Runtime;
	store: ReturnType<typeof openStore>;
	client: HindsightClient;
	recallOk: { current: boolean | null };
}

function harness(opts: { recallStatus?: number; factText?: string } = {}): Harness {
	const recalls: string[] = [];
	const retains: unknown[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (request) => {
			const url = new URL(request.url);
			if (request.method === "POST" && url.pathname.endsWith("/memories/recall")) {
				const body = (await request.json()) as { query?: unknown };
				recalls.push(typeof body.query === "string" ? body.query : "");
				if ((opts.recallStatus ?? 200) !== 200) {
					return new Response("down", { status: opts.recallStatus ?? 503 });
				}
				return Response.json({
					results:
						opts.factText === undefined
							? []
							: [
									{
										id: "fact-1",
										text: opts.factText,
										type: "world",
										document_id: "exchange/dm:1/1/a",
										occurred_start: "2026-01-01",
									},
								],
				});
			}
			if (request.method === "POST") {
				retains.push(await request.json());
				return Response.json({
					success: true,
					bank_id: "g",
					items_count: 1,
					async: true,
					operation_id: "00000000-0000-4000-8000-000000000001",
				});
			}
			return Response.json({
				operation_id: "00000000-0000-4000-8000-000000000001",
				status: "processing",
			});
		},
	});
	servers.push(server);
	const store = openStore(tmpdb());
	const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
	const client = new HindsightClient({
		baseUrl: `http://127.0.0.1:${server.port}`,
		bankId: "g",
	});
	const recallOk = { current: null as boolean | null };
	const runtime = new Runtime({
		store,
		buildStep: () => ({ model: fakeModel(["ok"]), system: "test" }),
		makeTools: () => ({}),
		memory: {
			client,
			config: { ...memConfig, baseUrl: `http://127.0.0.1:${server.port}` },
			contexts: store.memoryContexts,
			noteRecall: (ok) => {
				recallOk.current = ok;
			},
		},
	});
	return {
		recallCount: () => recalls.length,
		recallQueries: () => recalls,
		retains,
		conversation: conv.id,
		runtime,
		store,
		client,
		recallOk,
	};
}

describe("memory turn integration", () => {
	test("completed turns recall, persist the block, and queue retention", async () => {
		const h = harness({ factText: "Quiet mornings preferred." });
		const sink = new RecordingSink();
		h.runtime.submit(
			h.store.get(h.conversation)!,
			userMessage([{ type: "text", text: "i like quiet mornings" }]),
			sink,
		);
		expect(await sink.done).toEqual({ kind: "completed" });
		const blocks = h.store.memoryContexts.load(h.conversation);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.content).toContain("Quiet mornings");
		expect(blocks[0]?.content).toContain("take precedence");
		const item = h.store.memoryQueue.next(h.client.target, Date.now());
		expect(item).not.toBeNull();
		expect(item?.document.id.startsWith("exchange/dm:1/1/")).toBe(true);
		expect(h.recallCount()).toBe(1);
		h.store.close();
	});

	test("an outage degrades the turn without killing it", async () => {
		const h = harness({ recallStatus: 503 });
		const sink = new RecordingSink();
		h.runtime.submit(
			h.store.get(h.conversation)!,
			userMessage([{ type: "text", text: "hello" }]),
			sink,
		);
		expect(await sink.done).toEqual({ kind: "completed" });
		expect(h.recallOk.current).toBe(false);
		const blocks = h.store.memoryContexts.load(h.conversation);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.content).toContain("unavailable");
		expect(blocks[0]?.content).not.toContain("no relevant memories");
		// Retention still queued — the outage was on recall, not retain.
		expect(h.store.memoryQueue.next(h.client.target, Date.now())).not.toBeNull();
		h.store.close();
	});

	test("excluded topics touch no memory at all", async () => {
		const h = harness({ factText: "Quiet mornings." });
		h.store.applySettings(h.conversation, { memoryExcluded: true });
		const sink = new RecordingSink();
		h.runtime.submit(
			h.store.get(h.conversation)!,
			userMessage([{ type: "text", text: "hello" }]),
			sink,
		);
		expect(await sink.done).toEqual({ kind: "completed" });
		expect(h.store.memoryContexts.load(h.conversation)).toEqual([]);
		expect(h.recallCount()).toBe(0);
		h.store.close();
	});

	test("re-enabling memory never ships excluded-era messages (#85)", async () => {
		const h = harness({ factText: "an unrelated stored fact" });
		// The excluded era: a completed exchange carrying a private
		// canary. No memory requests may occur.
		h.store.applySettings(h.conversation, { memoryExcluded: true });
		const excluded = new RecordingSink();
		h.runtime.submit(
			h.store.get(h.conversation)!,
			userMessage([{ type: "text", text: "secret canary ALPHA" }]),
			excluded,
		);
		expect(await excluded.done).toEqual({ kind: "completed" });
		expect(h.recallCount()).toBe(0);
		// Re-enable and run an unrelated fresh turn.
		h.store.applySettings(h.conversation, { memoryExcluded: false });
		const fresh = new RecordingSink();
		h.runtime.submit(
			h.store.get(h.conversation)!,
			userMessage([{ type: "text", text: "hello again" }]),
			fresh,
		);
		expect(await fresh.done).toEqual({ kind: "completed" });
		// Eligibility is stamped at append time — the excluded era is
		// historical for memory even after re-enabling, so neither the
		// recall query nor the new retention document may carry it.
		expect(h.recallCount()).toBe(1);
		expect(h.recallQueries().join("\n")).not.toContain("secret canary ALPHA");
		const item = h.store.memoryQueue.next(h.client.target, Date.now());
		expect(item).not.toBeNull();
		expect(item?.document.content).not.toContain("secret canary ALPHA");
		// The fresh turn itself is eligible and does ship.
		expect(item?.document.content).toContain("hello again");
		h.store.close();
	});

	test("fenced turns commit no memory", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request) =>
				new URL(request.url).pathname.endsWith("/memories/recall")
					? Response.json({ results: [] })
					: Response.json({
							success: true,
							bank_id: "g",
							items_count: 1,
							async: true,
							operation_id: "00000000-0000-4000-8000-000000000002",
						}),
		});
		servers.push(server);
		const client = new HindsightClient({ baseUrl: `http://127.0.0.1:${server.port}`, bankId: "g" });
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model: fakeModel(["a", "b", "c", "d", "e"], 20), system: "test" }),
			makeTools: () => ({}),
			memory: {
				client,
				config: { ...memConfig, baseUrl: `http://127.0.0.1:${server.port}` },
				contexts: store.memoryContexts,
				noteRecall: () => {},
			},
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "hi" }]), sink);
		// The first delta proves the turn was admitted (epoch captured)
		// and is mid-stream — bumping before that can race admission and
		// let the turn adopt the new epoch instead of fencing.
		await sink.firstDelta;
		store.bumpEpoch(conv.id);
		expect(await sink.done).toEqual({ kind: "fenced" });
		expect(store.history(conv.id).map((m) => m.role)).toEqual(["user"]);
		expect(store.memoryQueue.next(client.target, Date.now())).toBeNull();
		// The recall ran before the fence, so its working-state block
		// persists — but no completed-turn memory was committed. A
		// same-anchor retry replaces the orphan under the fenced boundary.
		expect(store.memoryContexts.load(conv.id)).toHaveLength(1);
		store.close();
	});

	test("a late recall after forgetting cannot reinsert a redacted source", async () => {
		const store = openStore(tmpdb());
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		let recallStarted!: () => void;
		let release!: () => void;
		const started = new Promise<void>((resolve) => {
			recallStarted = resolve;
		});
		const parked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async () => {
				recallStarted();
				await parked;
				return Response.json({
					results: [
						{
							id: "fact-1",
							text: "forget this",
							type: "world",
							document_id: "exchange/dm:1/1/a",
						},
					],
				});
			},
		});
		servers.push(server);
		const client = new HindsightClient({ baseUrl: `http://127.0.0.1:${server.port}`, bankId: "g" });
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model: fakeModel(["ok"]), system: "test" }),
			makeTools: () => ({}),
			memory: {
				client,
				config: { ...memConfig, baseUrl: `http://127.0.0.1:${server.port}` },
				contexts: store.memoryContexts,
				noteRecall: () => {},
			},
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "hi" }]), sink);
		await started;
		runtime.stop(conv.id);
		store.memoryContexts.suppress("exchange/dm:1/1/a");
		store.memoryContexts.deleteByDocument("exchange/dm:1/1/a");
		release();
		expect(await sink.done).toEqual({ kind: "fenced" });
		expect(store.memoryContexts.load(conv.id)).toEqual([]);
		store.close();
	});

	test("program housekeeping recalls but never retains", async () => {
		const h = harness({ factText: "Quiet mornings." });
		const sink = new RecordingSink();
		h.runtime.submit(
			h.store.get(h.conversation)!,
			userMessage([{ type: "text", text: "[program: brief · trigger: schedule] send the brief" }]),
			sink,
		);
		expect(await sink.done).toEqual({ kind: "completed" });
		// Recall ran (evidence for the program)…
		expect(h.store.memoryContexts.load(h.conversation)).toHaveLength(1);
		// …but housekeeping is never retained.
		expect(h.store.memoryQueue.next(h.client.target, Date.now())).toBeNull();
		h.store.close();
	});

	test("a compaction summary is carried context, never retained as operator speech", async () => {
		const h = harness();
		// A compaction whose tail has no assistant reply yet: the synthetic
		// summary is the newest "user" text in the model view until the
		// next response lands.
		h.store.append(h.conversation, [
			userMessage([{ type: "text", text: "old stuff" }]),
			{ id: "a0", role: "assistant", parts: [{ type: "text", text: "old reply" }] },
		]);
		h.store.setCompaction(h.conversation, {
			boundarySeq: 2,
			summary: "the folded era",
			tokensBefore: 10,
			model: "m",
			createdAt: "2026-01-01T00:00:00Z",
		});
		const sink = new RecordingSink();
		h.runtime.submit(
			h.store.get(h.conversation)!,
			userMessage([{ type: "text", text: "remember the coffee detail" }]),
			sink,
		);
		expect(await sink.done).toEqual({ kind: "completed" });
		const item = h.store.memoryQueue.next(h.client.target, Date.now());
		expect(item).not.toBeNull();
		expect(item?.document.content).toContain("remember the coffee detail");
		expect(item?.document.content).not.toContain("the folded era");
		expect(item?.document.content).not.toContain("history compacted");
		h.store.close();
	});

	test("an operator message in a housekeeping burst is still retained", async () => {
		const h = harness({ factText: "Quiet mornings." });
		// The scheduler and the delegation watcher both fire while the
		// operator's message still waits for its turn — one mixed burst.
		// Housekeeping must not fence the operator's memory out of it.
		h.store.append(h.conversation, [
			userMessage([{ type: "text", text: "remember: i take my coffee black" }]),
			userMessage([{ type: "text", text: "[delegation: deploy · done] all green" }]),
		]);
		const sink = new RecordingSink();
		h.runtime.submit(
			h.store.get(h.conversation)!,
			userMessage([{ type: "text", text: "[program: brief · trigger: schedule] send the brief" }]),
			sink,
		);
		expect(await sink.done).toEqual({ kind: "completed" });
		const item = h.store.memoryQueue.next(h.client.target, Date.now());
		expect(item).not.toBeNull();
		expect(item?.document.content).toContain("i take my coffee black");
		expect(item?.document.content).not.toContain("[program:");
		expect(item?.document.content).not.toContain("[delegation:");
		h.store.close();
	});

	test("a mid-turn user message is operator speech in retention, not context", async () => {
		const h = harness();
		// Turn A in flight: the operator's follow-up arrives (seq 2)
		// before turn A's response does (seq 3, anchored to seq 1). The
		// causal view places the reply before the follow-up — classifying
		// the burst by arrival seq would demote the follow-up to context.
		h.store.append(h.conversation, [
			userMessage([{ type: "text", text: "what about the coffee order" }]),
		]);
		h.store.append(h.conversation, [
			userMessage([{ type: "text", text: "remember: i take my coffee black" }]),
		]);
		h.store.append(
			h.conversation,
			[{ id: "a1", role: "assistant", parts: [{ type: "text", text: "got it" }] }],
			{ anchorSeq: 1 },
		);
		const sink = new RecordingSink();
		h.runtime.submit(
			h.store.get(h.conversation)!,
			userMessage([{ type: "text", text: "and what else is new" }]),
			sink,
		);
		expect(await sink.done).toEqual({ kind: "completed" });
		const item = h.store.memoryQueue.next(h.client.target, Date.now());
		expect(item).not.toBeNull();
		// The mid-turn message and this turn's trigger are the burst;
		// only the pre-response exchange is prior context.
		expect(item?.document.content).toBe(
			"[Context — not fresh evidence]: what about the coffee order\n" +
				"got it\n" +
				"Operator: remember: i take my coffee black\n" +
				"and what else is new\n" +
				"Goblin: ok",
		);
		h.store.close();
	});

	test("a voice-note transcript is operator speech in recall and retention (#111)", async () => {
		const h = harness();
		const sink = new RecordingSink();
		h.runtime.submit(
			h.store.get(h.conversation)!,
			userMessage([
				{
					type: "data-attachment",
					data: {
						path: "/workspace/attachments/ogg-u1.oga",
						mediaType: "audio/ogg",
						filename: "voice.oga",
						size: 1024,
						speech: true,
						transcript: "water the fern before friday",
					},
				},
			]),
			sink,
		);
		expect(await sink.done).toEqual({ kind: "completed" });
		// The spoken words reach the retained document…
		const item = h.store.memoryQueue.next(h.client.target, Date.now());
		expect(item).not.toBeNull();
		expect(item?.document.content).toContain("water the fern before friday");
		// …and the recall query that left the process carried them too.
		expect(h.recallQueries()[0]).toContain("water the fern before friday");
		h.store.close();
	});
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel, UIMessage } from "ai";
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";
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
						finishReason: "stop",
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
	retains: unknown[];
	conversation: string;
	runtime: Runtime;
	store: ReturnType<typeof openStore>;
	client: HindsightClient;
	recallOk: { current: boolean | null };
}

function harness(opts: { recallStatus?: number; factText?: string } = {}): Harness {
	const recalls: { path: string }[] = [];
	const retains: unknown[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (request) => {
			const url = new URL(request.url);
			if (request.method === "POST" && url.pathname.endsWith("/memories/recall")) {
				recalls.push({ path: url.pathname });
				if ((opts.recallStatus ?? 200) !== 200) {
					return new Response("down", { status: opts.recallStatus ?? 503 });
				}
				return Response.json({
					results: opts.factText === undefined ? [] : [{
						id: "fact-1", text: opts.factText, type: "world",
						document_id: "exchange/dm:1/1/a", occurred_start: "2026-01-01",
					}],
				});
			}
			if (request.method === "POST") {
				retains.push(await request.json());
				return Response.json({
					success: true, bank_id: "g", items_count: 1, async: true,
					operation_id: "00000000-0000-4000-8000-000000000001",
				});
			}
			return Response.json({ operation_id: "00000000-0000-4000-8000-000000000001", status: "processing" });
		},
	});
	servers.push(server);
	const store = openStore(tmpdb());
	const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
	const client = new HindsightClient({
		baseUrl: `http://127.0.0.1:${server.port}`, bankId: "g",
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
	return { recallCount: () => recalls.length, retains, conversation: conv.id, runtime, store, client, recallOk };
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
						success: true, bank_id: "g", items_count: 1, async: true,
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

	test("scheduled housekeeping recalls but never retains", async () => {
		const h = harness({ factText: "Quiet mornings." });
		const sink = new RecordingSink();
		h.runtime.submit(
			h.store.get(h.conversation)!,
			userMessage([{ type: "text", text: "[scheduled: brief] send the brief" }]),
			sink,
		);
		expect(await sink.done).toEqual({ kind: "completed" });
		// Recall ran (evidence for the job)…
		expect(h.store.memoryContexts.load(h.conversation)).toHaveLength(1);
		// …but housekeeping is never retained.
		expect(h.store.memoryQueue.next(h.client.target, Date.now())).toBeNull();
		h.store.close();
	});
});

import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api } from "grammy";
import type { Config } from "../config.ts";
import { openStore } from "../conversation.ts";
import { HindsightClient } from "../hindsight.ts";
import { startMemoryWorker } from "../memory.ts";
import type { Runtime } from "../runtime.ts";
import { handleCommand, type CommandDeps } from "./commands.ts";
import { TelegramTimeoutError } from "./deadline.ts";
import { log } from "../log.ts";

let dirs: string[] = [];
function tmpdb(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-cmd-"));
	dirs.push(dir);
	return join(dir, "goblin.sqlite");
}
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

const config: Config = {
	providers: {
		zai: { kind: "openai-compatible", baseUrl: "https://api.z.ai/v4", auth: "zai" },
	},
	model: "zai/glm-5.3",
	tts: false,
	favorites: ["zai/glm-5.3"],
	thinking: "medium",
	allowedUsers: [1],
	telegram: { dmGapMinutes: 45 },
	http: { port: 8787 },
	logLevel: "info",
};

function setup(overrides?: { compact?: Runtime["compact"] }) {
	const store = openStore(tmpdb());
	const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
	const sent: string[] = [];
	const stopped: string[] = [];
	const deps: CommandDeps = {
		api: {
			sendMessage: async (_chat: number, text: string) => {
				sent.push(text);
				return { message_id: sent.length };
			},
		} as unknown as Api,
		configRef: { current: config, ttsDown: false },
		store,
		runtime: {
			stop: (id: string) => {
				stopped.push(id);
				return { stopped: stopped.length > 0, settled: Promise.resolve() };
			},
			...(overrides?.compact ? { compact: overrides.compact } : {}),
		} as unknown as Runtime,
		botUsername: "goblin",
	};
	return { store, conv, sent, stopped, deps };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 10));

describe("commands", () => {
	test("/compact runs the compactor and reports the numbers", async () => {
		const compactCalls: string[] = [];
		const { store, conv, sent, deps } = setup({
			compact: async (c) => {
				compactCalls.push(c.id);
				return {
					kind: "compacted",
					boundarySeq: 40,
					eventsCompacted: 42,
					tokensBefore: 21_000,
					tailEvents: 6,
					summary: "s",
				};
			},
		});
		expect(handleCommand(deps, conv, "/compact")).toBe(true);
		await tick();
		expect(compactCalls).toEqual([conv.id]);
		expect(sent[0]).toContain("compacted 42 messages");
		expect(sent[0]).toContain("kept the last 6");
		store.close();
	});

	test("/compact with nothing to do says so; a failure surfaces", async () => {
		const { store, conv, sent, deps } = setup({
			compact: async () => ({ kind: "noop", reason: "nothing worth compacting" }),
		});
		expect(handleCommand(deps, conv, "/compact")).toBe(true);
		await tick();
		expect(sent[0]).toContain("nothing to compact");
		store.close();

		const failing = setup({
			compact: async () => {
				throw new Error("summarizer exploded");
			},
		});
		expect(handleCommand(failing.deps, failing.conv, "/compact")).toBe(true);
		await tick();
		expect(failing.sent[0]).toContain("compact failed: summarizer exploded");
		failing.store.close();
	});

	test("/model and /think are retired — they are no longer commands", () => {
		const { store, conv, deps } = setup();
		// Not handled: falls through to intake as an ordinary message the
		// model answers ("use the settings app") — muscle memory degrades
		// gracefully instead of silently doing settings work.
		expect(handleCommand(deps, conv, "/model zai/glm-4.5")).toBe(false);
		expect(handleCommand(deps, conv, "/think high")).toBe(false);
		store.close();
	});

	test("/voice toggles voice replies and bumps the epoch", () => {
		const { store, conv, deps } = setup();
		deps.configRef.current = { ...config, tts: { kind: "edge", voice: "en-US-AriaNeural" } };
		expect(handleCommand(deps, conv, "/voice")).toBe(true);
		const after = store.get(conv.id)!;
		expect(after.voice).toBe(true);
		expect(after.epoch).toBe(1);
		handleCommand(deps, after, "/voice");
		expect(store.get(conv.id)!.voice).toBe(false);
		store.close();
	});

	test("/voice refuses to enable when tts is explicitly off", () => {
		const { store, conv, sent, deps } = setup();
		expect(handleCommand(deps, conv, "/voice")).toBe(true);
		expect(store.get(conv.id)!.voice).toBe(false);
		expect(sent[0]).toContain("turned off");
		store.close();
	});

	test("/voice refuses to enable while the ffmpeg gate has tts down", () => {
		const { store, conv, sent, deps } = setup();
		deps.configRef.current = { ...config, tts: { kind: "edge", voice: "en-US-AriaNeural" } };
		deps.configRef.ttsDown = true;
		expect(handleCommand(deps, conv, "/voice")).toBe(true);
		expect(store.get(conv.id)!.voice).toBe(false);
		expect(sent[0]).toContain("ffmpeg");
		store.close();
	});

	test("/stop fences the conversation", () => {
		const { store, conv, sent, stopped, deps } = setup();
		expect(handleCommand(deps, conv, "/stop")).toBe(true);
		expect(stopped).toEqual([conv.id]);
		expect(sent[0]).toBe("stopped");
		store.close();
	});

	test("/stop with nothing running says so", () => {
		const { store, conv, sent, deps } = setup();
		(deps.runtime as unknown as { stop: () => { stopped: boolean; settled: Promise<void> } }).stop =
			() => ({ stopped: false, settled: Promise.resolve() });
		expect(handleCommand(deps, conv, "/stop")).toBe(true);
		expect(sent[0]).toBe("nothing was running");
		store.close();
	});

	test("a wedged bot-api fails the command reply at the send budget, not grammy's 500s", async () => {
		const { store, conv, deps } = setup();
		// Never settles — a hung-but-alive bot-api connection. The reply is
		// fire-and-forget, so the only observable bound is the warn firing
		// at the 30s budget every sibling send uses (bug-hunt finding 16).
		deps.api.sendMessage = () => new Promise<never>(() => {});
		const warn = spyOn(log, "warn");
		jest.useFakeTimers();
		try {
			expect(handleCommand(deps, conv, "/stop")).toBe(true);
			jest.advanceTimersByTime(30_000);
			await new Promise<void>((r) => process.nextTick(r));
			const call = warn.mock.calls.find(([msg]) => msg === "command reply failed");
			expect(call).toBeDefined();
			const err = call![1];
			expect(err).toBeInstanceOf(TelegramTimeoutError);
			expect((err as TelegramTimeoutError).label).toBe("sendMessage (command reply)");
		} finally {
			jest.useRealTimers();
			warn.mockRestore();
		}
		store.close();
	});

	test("/stop@otherbot is not ours — consumed silently, no stop, no reply", () => {
		const { store, conv, sent, stopped, deps } = setup();
		expect(handleCommand(deps, conv, "/stop@otherbot")).toBe(true);
		expect(stopped).toEqual([]);
		expect(sent).toEqual([]);
		store.close();
	});

	test("/stop@goblin addressed to this bot still handles", () => {
		const { store, conv, stopped, deps } = setup();
		expect(handleCommand(deps, conv, "/stop@goblin")).toBe(true);
		expect(stopped).toEqual([conv.id]);
		store.close();
	});

	test("/start answers a canned greeting — consumed, never a model turn", () => {
		const { store, conv, sent, deps } = setup();
		expect(handleCommand(deps, conv, "/start")).toBe(true);
		expect(sent[0]).toContain("goblin online");
		// A deep-link payload rides along silently — same greeting.
		expect(handleCommand(deps, conv, "/start payload-x")).toBe(true);
		expect(sent[1]).toContain("goblin online");
		store.close();
	});
});

const memBlock = {
	baseUrl: "http://127.0.0.1:1",
	bankId: "g",
	recallTimeoutMs: 500,
	maxTokens: 256,
	budget: "low" as const,
};

function setupMemory() {
	const { store, conv, sent, stopped, deps } = setup();
	deps.configRef.current = { ...config, memory: memBlock };
	deps.memory = {
		client: new HindsightClient({ baseUrl: "http://127.0.0.1:1", bankId: "g" }),
		contexts: store.memoryContexts,
		queue: store.memoryQueue,
		// No worker runs in these fixtures — the quiesce seam passes
		// through (the race test below wires a real one).
		withWorkerPaused: <T>(fn: () => Promise<T>): Promise<T> => fn(),
		lastRecallOk: () => null,
		lastRecallAt: () => null,
	};
	return { store, conv, sent, stopped, deps };
}

// Enqueue one retention row for this conversation and mark it blocked —
// the /memory degraded fixture.
function blockOne(
	store: ReturnType<typeof setup>["store"],
	client: HindsightClient,
	documentId: string,
): string {
	const id = store.memoryQueue.enqueue(client.target, {
		id: documentId,
		content: "Operator: hi\nGoblin: hello",
		timestamp: new Date().toISOString(),
		conversationId: "dm:1",
		sourceIds: ["u1", "a7"],
	});
	const item = store.memoryQueue.get(id);
	if (!item) throw new Error("expected queued memory");
	store.memoryQueue.update(item, "blocked", 0, "Hindsight http failure (HTTP 429)");
	return id;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(sent: string[], n: number): Promise<void> {
	for (let i = 0; i < 100 && sent.length < n; i++) await sleep(10);
	expect(sent.length).toBeGreaterThanOrEqual(n);
}

// The client DELETEs `<base>/documents/<encoded-id>` (base carries the
// bank prefix) — the fake echoes the id back for z.literal validation.
function deleteIdFrom(url: string): string {
	const path = new URL(url).pathname;
	const at = path.lastIndexOf("/documents/");
	return decodeURIComponent(path.slice(at + "/documents/".length));
}

describe("memory commands", () => {
	test("/memory without the block says so", () => {
		const { store, conv, sent, deps } = setup();
		expect(handleCommand(deps, conv, "/memory")).toBe(true);
		expect(sent[0]).toContain("not configured");
		store.close();
	});

	test("/memory status reports state and topic inclusion", () => {
		const { store, conv, sent, deps } = setupMemory();
		expect(handleCommand(deps, conv, "/memory")).toBe(true);
		expect(sent[0]).toContain("healthy");
		expect(sent[0]).toContain("included");
		store.close();
	});

	test("/memory healthy rendering: queue, recall, topic — no state-word echo", () => {
		const { store, conv, sent, deps } = setupMemory();
		const client = deps.memory!.client;
		const id = store.memoryQueue.enqueue(client.target, {
			id: "exchange/dm:1/1/a",
			content: "Operator: hi\nGoblin: hello",
			timestamp: new Date().toISOString(),
			conversationId: conv.id,
			sourceIds: ["u1", "a1"],
		});
		const item = store.memoryQueue.get(id);
		if (!item) throw new Error("expected queued memory");
		store.memoryQueue.update(item, "completed", 0, null);
		expect(handleCommand(deps, conv, "/memory")).toBe(true);
		expect(sent[0]).toContain("memory: healthy\n");
		expect(sent[0]).toContain("queue: 0 queued · 1 retained");
		expect(sent[0]).toContain("last recall: never");
		expect(sent[0]).toContain("this topic: included");
		expect(sent[0]).toContain("forget with /forget <query>");
		// The killed redundancy: "memory: healthy — memory healthy".
		expect(sent[0]).not.toContain("memory healthy");
		store.close();
	});

	test("/memory shows parked forget rows and deletion-specific retry guidance", () => {
		const { store, conv, sent, deps } = setupMemory();
		blockOne(store, deps.memory!.client, "exchange/dm:1/1/a");
		store.memoryQueue.markDocumentDeleting("exchange/dm:1/1/a");
		expect(handleCommand(deps, conv, "/memory status")).toBe(true);
		expect(sent[0]).toContain("memory: degraded");
		expect(sent[0]).toContain("1 awaiting forget confirmation");
		expect(sent[0]).toContain("retry /forget delete <documentId>");
		expect(sent[0]).toContain("not /memory retry");
		expect(sent[0]).toContain("queue: 0 queued");
		store.close();
	});

	test("/memory pending rendering counts queued work; recall time and outcome", () => {
		const { store, conv, sent, deps } = setupMemory();
		const client = deps.memory!.client;
		for (const id of ["exchange/dm:1/1/a", "exchange/dm:1/2/b"]) {
			store.memoryQueue.enqueue(client.target, {
				id,
				content: "Operator: hi\nGoblin: hello",
				timestamp: new Date().toISOString(),
				conversationId: conv.id,
				sourceIds: ["u1", "a1"],
			});
		}
		deps.memory = {
			...deps.memory!,
			lastRecallOk: () => true,
			lastRecallAt: () => new Date().toISOString(),
		};
		expect(handleCommand(deps, conv, "/memory")).toBe(true);
		expect(sent[0]).toContain("memory: pending");
		expect(sent[0]).toContain("queue: 2 queued · 0 retained");
		expect(sent[0]).toMatch(/last recall: \d{2}:\d{2} \(ok\)/);
		store.close();
	});

	test("/memory degraded lists blocked retention with actions", () => {
		const { store, conv, sent, deps } = setupMemory();
		blockOne(store, deps.memory!.client, "exchange/dm:1/7/a7");
		expect(handleCommand(deps, conv, "/memory")).toBe(true);
		expect(sent[0]).toContain("memory: degraded — 1 blocked retention needs operator review");
		expect(sent[0]).toContain("  1. a7 (1 attempt): Hindsight http failure (HTTP 429)");
		expect(sent[0]).toContain("actions: /memory retry · /memory dismiss");
		expect(sent[0]).toContain("queue: 0 queued · 0 retained");
		store.close();
	});

	test("/memory shows dismissed rows as kept for audit", () => {
		const { store, conv, sent, deps } = setupMemory();
		blockOne(store, deps.memory!.client, "exchange/dm:1/7/a7");
		expect(store.memoryQueue.dismissBlocked(deps.memory!.client.target)).toBe(1);
		expect(handleCommand(deps, conv, "/memory")).toBe(true);
		expect(sent[0]).toContain("memory: healthy");
		expect(sent[0]).toContain("queue: 0 queued · 0 retained · 1 dismissed (kept for audit)");
		store.close();
	});

	test("a failed last recall degrades without inventing blocked work", () => {
		const { store, conv, sent, deps } = setupMemory();
		deps.memory = {
			...deps.memory!,
			lastRecallOk: () => false,
			lastRecallAt: () => new Date().toISOString(),
		};
		expect(handleCommand(deps, conv, "/memory")).toBe(true);
		expect(sent[0]).toContain("memory: degraded — last recall failed");
		expect(sent[0]).not.toContain("actions:");
		store.close();
	});

	test("/memory retry requeues blocked retention with fresh operation ids", () => {
		const { store, conv, sent, deps } = setupMemory();
		const client = deps.memory!.client;
		const id = blockOne(store, client, "exchange/dm:1/7/a7");
		expect(handleCommand(deps, conv, "/memory retry")).toBe(true);
		expect(sent.at(-1)).toContain("requeued 1 blocked retention with fresh operation ids");
		const requeued = store.memoryQueue.next(client.target, Date.now());
		expect(requeued?.document.id).toBe("exchange/dm:1/7/a7");
		expect(requeued?.operation_id).not.toBe(id);
		expect(requeued?.attempts).toBe(0);
		store.close();
	});

	test("/memory dismiss keeps blocked rows for audit and out of the queue", () => {
		const { store, conv, sent, deps } = setupMemory();
		const client = deps.memory!.client;
		blockOne(store, client, "exchange/dm:1/7/a7");
		expect(handleCommand(deps, conv, "/memory dismiss")).toBe(true);
		expect(sent.at(-1)).toContain("dismissed 1 blocked retention (kept for audit)");
		expect(store.memoryQueue.counts(client.target).dismissed).toBe(1);
		expect(store.memoryQueue.next(client.target, Date.now())).toBeNull();
		store.close();
	});

	test("/memory retry and dismiss without the block say so", () => {
		const { store, conv, sent, deps } = setup();
		expect(handleCommand(deps, conv, "/memory retry")).toBe(true);
		expect(handleCommand(deps, conv, "/memory dismiss")).toBe(true);
		expect(sent[0]).toContain("not configured");
		expect(sent[1]).toContain("not configured");
		store.close();
	});

	test("/memory off excludes and on re-includes, bumping the epoch", () => {
		const { store, conv, sent, deps } = setupMemory();
		expect(handleCommand(deps, conv, "/memory off")).toBe(true);
		expect(store.get(conv.id)!.memoryExcluded).toBe(true);
		expect(store.get(conv.id)!.epoch).toBe(1);
		expect(sent.at(-1)).toContain("off");
		expect(handleCommand(deps, store.get(conv.id)!, "/memory on")).toBe(true);
		expect(store.get(conv.id)!.memoryExcluded).toBe(false);
		store.close();
	});

	test("/memory off purges the topic's queued retention", () => {
		const { store, conv, sent, deps } = setupMemory();
		const client = deps.memory!.client;
		store.memoryQueue.enqueue(client.target, {
			id: "exchange/dm:1/1/a",
			content: "Operator: hi\nGoblin: hello",
			timestamp: new Date().toISOString(),
			conversationId: conv.id,
			sourceIds: ["u1", "a1"],
		});
		expect(handleCommand(deps, conv, "/memory off")).toBe(true);
		expect(sent.at(-1)).toContain("1 queued cancelled");
		expect(store.memoryQueue.next(client.target, Date.now())).toBeNull();
		store.close();
	});

	test("/memory rejects bad args", () => {
		const { store, conv, sent, deps } = setupMemory();
		expect(handleCommand(deps, conv, "/memory maybe")).toBe(true);
		expect(sent[0]).toContain("usage: /memory on|off|retry|dismiss|status");
		expect(store.get(conv.id)!.memoryExcluded).toBe(false);
		store.close();
	});

	test("/forget without args shows usage", () => {
		const { store, conv, sent, deps } = setupMemory();
		expect(handleCommand(deps, conv, "/forget")).toBe(true);
		expect(sent[0]).toContain("/forget <query>");
		store.close();
	});

	test("/forget refuses excluded topics", () => {
		const { store, conv, sent, deps } = setupMemory();
		handleCommand(deps, conv, "/memory off");
		expect(handleCommand(deps, store.get(conv.id)!, "/forget lighthouse")).toBe(true);
		expect(sent.at(-1)).toContain("excluded");
		store.close();
	});

	test("/forget <query> lists matching sources", async () => {
		const { store, conv, sent, deps } = setupMemory();
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				Response.json({
					results: [
						{
							id: "f1",
							text: "Lighthouse weekends.",
							document_id: "exchange/a",
							occurred_start: "2026-02-01",
						},
						{
							id: "f2",
							text: "Lighthouse again.",
							document_id: "exchange/a",
							occurred_start: "2026-02-02",
						},
						{
							id: "f3",
							text: "Quiet mornings.",
							document_id: "exchange/b",
							occurred_start: "2026-01-01",
						},
					],
				}),
		});
		try {
			deps.memory = {
				...deps.memory!,
				client: new HindsightClient({ baseUrl: `http://127.0.0.1:${server.port}`, bankId: "g" }),
			};
			expect(handleCommand(deps, conv, "/forget lighthouse")).toBe(true);
			await waitFor(sent, 1);
			// Numbered, preview-first — no raw document ids to type on a phone.
			expect(sent[0]).toContain("1. Lighthouse weekends. (2026-02-01)");
			expect(sent[0]).toContain("2. Quiet mornings. (2026-01-01)");
			expect(sent[0]).toContain("/forget delete <n> — or the full document id (irreversible)");
			expect(sent[0]).not.toContain("exchange/");
		} finally {
			server.stop(true);
			store.close();
		}
	});

	test("/forget delete <n> resolves the cached listing and deletes that document", async () => {
		const { store, conv, sent, deps } = setupMemory();
		const deleted: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request) => {
				if (request.method === "DELETE") {
					const id = deleteIdFrom(request.url);
					deleted.push(id);
					return Response.json({ success: true, document_id: id });
				}
				return Response.json({
					results: [
						{
							id: "f1",
							text: "Lighthouse weekends.",
							document_id: "exchange/a",
							occurred_start: "2026-02-01",
						},
						{
							id: "f2",
							text: "Quiet mornings.",
							document_id: "exchange/b",
							occurred_start: "2026-01-01",
						},
					],
				});
			},
		});
		try {
			deps.memory = {
				...deps.memory!,
				client: new HindsightClient({ baseUrl: `http://127.0.0.1:${server.port}`, bankId: "g" }),
			};
			expect(handleCommand(deps, conv, "/forget lighthouse")).toBe(true);
			await waitFor(sent, 1);
			// Pick #2 off the listing just rendered — the full id was never shown.
			expect(handleCommand(deps, conv, "/forget delete 2")).toBe(true);
			await waitFor(sent, 2);
			expect(deleted).toEqual(["exchange/b"]);
			expect(sent[1]).toContain("forgotten exchange/b");
			// The confirmation echoes the preview so the pick is auditable.
			expect(sent[1]).toContain("Quiet mornings.");
			expect(store.memoryContexts.isSuppressed("exchange/b")).toBe(true);
			expect(store.memoryContexts.isSuppressed("exchange/a")).toBe(false);
		} finally {
			server.stop(true);
			store.close();
		}
	});

	test("/forget delete <n> with an expired listing refuses and deletes nothing", async () => {
		const { store, conv, sent, deps } = setupMemory();
		const deleted: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request) => {
				if (request.method === "DELETE") {
					const id = deleteIdFrom(request.url);
					deleted.push(id);
					return Response.json({ success: true, document_id: id });
				}
				return Response.json({
					results: [
						{
							id: "f1",
							text: "Lighthouse weekends.",
							document_id: "exchange/a",
							occurred_start: "2026-02-01",
						},
					],
				});
			},
		});
		try {
			deps.memory = {
				...deps.memory!,
				client: new HindsightClient({ baseUrl: `http://127.0.0.1:${server.port}`, bankId: "g" }),
			};
			expect(handleCommand(deps, conv, "/forget lighthouse")).toBe(true);
			await waitFor(sent, 1);
			// Age the cached listing past its ttl — row surgery is the only
			// lever a test has over wall-clock.
			store.db.run("UPDATE forget_listings SET created_at = ? WHERE conversation_id = ?", [
				new Date(Date.now() - 60_000_000).toISOString(),
				conv.id,
			]);
			expect(handleCommand(deps, conv, "/forget delete 1")).toBe(true);
			await waitFor(sent, 2);
			expect(sent[1]).toBe(
				"no usable listing for that number — run /forget <query> and pick within 10 minutes",
			);
			expect(deleted).toEqual([]);
			expect(store.memoryContexts.isSuppressed("exchange/a")).toBe(false);
		} finally {
			server.stop(true);
			store.close();
		}
	});

	test("/forget delete <n> from another conversation refuses and deletes nothing", async () => {
		const { store, conv, sent, deps } = setupMemory();
		const deleted: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request) => {
				if (request.method === "DELETE") {
					const id = deleteIdFrom(request.url);
					deleted.push(id);
					return Response.json({ success: true, document_id: id });
				}
				return Response.json({
					results: [
						{
							id: "f1",
							text: "Lighthouse weekends.",
							document_id: "exchange/a",
							occurred_start: "2026-02-01",
						},
					],
				});
			},
		});
		try {
			deps.memory = {
				...deps.memory!,
				client: new HindsightClient({ baseUrl: `http://127.0.0.1:${server.port}`, bankId: "g" }),
			};
			// Listing cached under conv A's id…
			expect(handleCommand(deps, conv, "/forget lighthouse")).toBe(true);
			await waitFor(sent, 1);
			// …but picked from a different conversation: the per-conversation
			// key must refuse rather than let B spend A's number.
			const other = store.resolve({ kind: "dm", chatId: 424242 }, "/unused");
			expect(handleCommand(deps, other, "/forget delete 1")).toBe(true);
			await waitFor(sent, 2);
			expect(sent[1]).toBe(
				"no usable listing for that number — run /forget <query> and pick within 10 minutes",
			);
			expect(deleted).toEqual([]);
			expect(store.memoryContexts.isSuppressed("exchange/a")).toBe(false);
		} finally {
			server.stop(true);
			store.close();
		}
	});

	test("/forget delete suppresses, cancels, deletes, and redacts", async () => {
		const { store, conv, sent, stopped, deps } = setupMemory();
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request) => {
				const path = new URL(request.url).pathname;
				if (path.includes("/operations/")) {
					// The queued row is pending; the delete still reconciles its
					// UUID — terminal on the first poll.
					return Response.json({
						operation_id: path.split("/").pop(),
						status: "completed",
					});
				}
				if (request.method === "DELETE") {
					return Response.json({ success: true, document_id: "exchange/dm:1/1/a" });
				}
				return Response.json({ results: [] });
			},
		});
		try {
			const client = new HindsightClient({
				baseUrl: `http://127.0.0.1:${server.port}`,
				bankId: "g",
			});
			deps.memory = { ...deps.memory!, client };
			// A queued retention and a snapshot citing the document.
			store.memoryQueue.enqueue(client.target, {
				id: "exchange/dm:1/1/a",
				content: "Operator: hi\nGoblin: hello",
				timestamp: new Date().toISOString(),
				conversationId: conv.id,
				sourceIds: ["u1", "a1"],
			});
			store.memoryContexts.save(conv.id, 1, "block citing a", ["exchange/dm:1/1/a"]);
			expect(handleCommand(deps, conv, "/forget delete exchange/dm:1/1/a")).toBe(true);
			await waitFor(sent, 1);
			expect(sent[0]).toContain("forgotten exchange/dm:1/1/a");
			expect(store.memoryContexts.isSuppressed("exchange/dm:1/1/a")).toBe(true);
			expect(stopped).toContain(conv.id);
			expect(store.memoryQueue.next(client.target, Date.now())).toBeNull();
			expect(store.memoryContexts.load(conv.id)).toEqual([]);
		} finally {
			server.stop(true);
			store.close();
		}
	});
});

// Enqueue one retention row for this document and mark it submitted —
// acknowledged remotely, still processing there: the /forget delete
// settle fixture (reachable in production via /memory retry).
function submitOne(
	store: ReturnType<typeof setup>["store"],
	client: HindsightClient,
	documentId: string,
): string {
	const id = store.memoryQueue.enqueue(client.target, {
		id: documentId,
		content: "Operator: hi\nGoblin: hello",
		timestamp: new Date().toISOString(),
		conversationId: "dm:1",
		sourceIds: ["u1", "a7"],
	});
	const item = store.memoryQueue.get(id);
	if (!item) throw new Error("expected queued memory");
	store.memoryQueue.update(item, "submitted", 0, null);
	return id;
}

describe("forget delete against in-flight retention", () => {
	test("nothing in flight: delete proceeds without polling operations", async () => {
		const { store, conv, sent, deps } = setupMemory();
		const deleted: string[] = [];
		const polled: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request) => {
				const path = new URL(request.url).pathname;
				if (path.includes("/operations/")) {
					polled.push(path);
					return Response.json({ operation_id: path.split("/").pop(), status: "completed" });
				}
				if (request.method === "DELETE") {
					const id = deleteIdFrom(request.url);
					deleted.push(id);
					return Response.json({ success: true, document_id: id });
				}
				return Response.json({ results: [] });
			},
		});
		try {
			deps.memory = {
				...deps.memory!,
				client: new HindsightClient({ baseUrl: `http://127.0.0.1:${server.port}`, bankId: "g" }),
				settleTiming: { pollMs: 5, budgetMs: 2_000 },
			};
			expect(handleCommand(deps, conv, "/forget delete exchange/dm:1/1/a")).toBe(true);
			await waitFor(sent, 1);
			expect(deleted).toEqual(["exchange/dm:1/1/a"]);
			// No submitted row existed, so the settle wait never touches the wire.
			expect(polled).toEqual([]);
			expect(sent[0]).toContain("forgotten exchange/dm:1/1/a");
			expect(store.memoryContexts.isSuppressed("exchange/dm:1/1/a")).toBe(true);
		} finally {
			server.stop(true);
			store.close();
		}
	});

	// A pending row is not proof of never-sent — a lost submit
	// acknowledgement (or a crash before the submitted-state write)
	// leaves the row pending while its operation may be live remotely.
	// The delete must reconcile the UUID: one poll, absent remotely →
	// settled, then the cancel (#86).
	test("a pending row is reconciled with one poll before its cancel", async () => {
		const { store, conv, sent, deps } = setupMemory();
		const deleted: string[] = [];
		const polled: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request) => {
				const path = new URL(request.url).pathname;
				if (path.includes("/operations/")) {
					polled.push(path);
					return Response.json({ operation_id: path.split("/").pop(), status: "completed" });
				}
				if (request.method === "DELETE") {
					const id = deleteIdFrom(request.url);
					deleted.push(id);
					return Response.json({ success: true, document_id: id });
				}
				return Response.json({ results: [] });
			},
		});
		try {
			const client = new HindsightClient({
				baseUrl: `http://127.0.0.1:${server.port}`,
				bankId: "g",
			});
			deps.memory = { ...deps.memory!, client, settleTiming: { pollMs: 5, budgetMs: 2_000 } };
			const operationId = store.memoryQueue.enqueue(client.target, {
				id: "exchange/dm:1/1/a",
				content: "Operator: hi\nGoblin: hello",
				timestamp: new Date().toISOString(),
				conversationId: conv.id,
				sourceIds: ["u1", "a1"],
			});
			expect(handleCommand(deps, conv, "/forget delete exchange/dm:1/1/a")).toBe(true);
			await waitFor(sent, 1);
			// The operation is absent remotely — one poll reconciles the
			// uncertain UUID, then the row is cancelled without a wait.
			expect(polled.length).toBe(1);
			expect(deleted).toEqual(["exchange/dm:1/1/a"]);
			expect(sent[0]).toContain("1 queued cancelled");
			expect(store.memoryQueue.get(operationId)).toBeNull();
			expect(store.memoryQueue.next(client.target, Date.now())).toBeNull();
		} finally {
			server.stop(true);
			store.close();
		}
	});

	test("a submitted operation is polled to terminal (transient errors retry) before the delete", async () => {
		const { store, conv, sent, deps } = setupMemory();
		const deleted: string[] = [];
		const polls: number[] = [];
		// processing → retryable 503 → completed: the wait must outlast all three.
		const script = ["processing", "http-503", "completed"];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request) => {
				const path = new URL(request.url).pathname;
				if (path.includes("/operations/")) {
					const step = polls.push(1);
					const mode = script[Math.min(step - 1, script.length - 1)];
					if (mode === "http-503") return new Response("busy", { status: 503 });
					return Response.json({ operation_id: path.split("/").pop(), status: mode });
				}
				if (request.method === "DELETE") {
					const id = deleteIdFrom(request.url);
					deleted.push(id);
					return Response.json({ success: true, document_id: id });
				}
				return Response.json({ results: [] });
			},
		});
		try {
			const client = new HindsightClient({
				baseUrl: `http://127.0.0.1:${server.port}`,
				bankId: "g",
			});
			deps.memory = { ...deps.memory!, client, settleTiming: { pollMs: 5, budgetMs: 2_000 } };
			const operationId = submitOne(store, client, "exchange/dm:1/1/a");
			expect(handleCommand(deps, conv, "/forget delete exchange/dm:1/1/a")).toBe(true);
			await waitFor(sent, 1);
			// Polled past the 503 to completed, only then deleted.
			expect(polls.length).toBeGreaterThanOrEqual(3);
			expect(deleted).toEqual(["exchange/dm:1/1/a"]);
			expect(sent[0]).toContain("forgotten exchange/dm:1/1/a");
			expect(store.memoryContexts.isSuppressed("exchange/dm:1/1/a")).toBe(true);
			// The settled submitted row leaves with the cancel, not behind it.
			expect(store.memoryQueue.get(operationId)).toBeNull();
		} finally {
			server.stop(true);
			store.close();
		}
	});

	test("an operation that never settles makes the delete refuse and touch nothing", async () => {
		const { store, conv, sent, deps } = setupMemory();
		const deleted: string[] = [];
		const polls: number[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request) => {
				const path = new URL(request.url).pathname;
				if (path.includes("/operations/")) {
					polls.push(1);
					return Response.json({ operation_id: path.split("/").pop(), status: "processing" });
				}
				if (request.method === "DELETE") {
					const id = deleteIdFrom(request.url);
					deleted.push(id);
					return Response.json({ success: true, document_id: id });
				}
				return Response.json({ results: [] });
			},
		});
		try {
			const client = new HindsightClient({
				baseUrl: `http://127.0.0.1:${server.port}`,
				bankId: "g",
			});
			deps.memory = { ...deps.memory!, client, settleTiming: { pollMs: 5, budgetMs: 80 } };
			const operationId = submitOne(store, client, "exchange/dm:1/1/a");
			expect(handleCommand(deps, conv, "/forget delete exchange/dm:1/1/a")).toBe(true);
			await waitFor(sent, 1);
			expect(polls.length).toBeGreaterThanOrEqual(2);
			expect(deleted).toEqual([]); // nothing deleted remotely
			expect(store.memoryContexts.isSuppressed("exchange/dm:1/1/a")).toBe(false); // nothing suppressed
			// The row stays submitted — a later /forget delete can settle it.
			expect(store.memoryQueue.get(operationId)?.state).toBe("submitted");
			expect(sent[0]).toBe(
				"memory for that document is still processing remotely — try /forget delete again in a minute",
			);
		} finally {
			server.stop(true);
			store.close();
		}
	});

	// The found race: the worker flips an outbox row to submitted only
	// AFTER client.submit() returns — during the HTTP call the row still
	// reads pending, so an unpaused /forget delete treats it as never-sent,
	// cancels the local row, and the submit then lands on Hindsight: the
	// forgotten document is re-created remotely with no row left to
	// settle. The delete must quiesce the worker (withWorkerPaused).
	test("a delete racing an in-flight submit waits it out — no resurrect", async () => {
		const { store, conv, sent, deps } = setupMemory();
		const events: string[] = [];
		let releaseSubmit!: () => void;
		const submitHeld = new Promise<void>((r) => {
			releaseSubmit = r;
		});
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async (request) => {
				const path = new URL(request.url).pathname;
				if (request.method === "POST" && path.endsWith("/memories")) {
					events.push("submit");
					const body = (await request.json()) as { operation_id?: unknown };
					await submitHeld; // the submit hangs mid-HTTP
					events.push("submit-landed");
					return Response.json({
						success: true,
						bank_id: "g",
						items_count: 1,
						async: true,
						operation_id: typeof body.operation_id === "string" ? body.operation_id : "?",
					});
				}
				if (path.includes("/operations/")) {
					events.push("settle");
					return Response.json({ operation_id: path.split("/").pop(), status: "completed" });
				}
				if (request.method === "DELETE") {
					events.push("delete");
					return Response.json({ success: true, document_id: deleteIdFrom(request.url) });
				}
				return Response.json({ results: [] });
			},
		});
		const worker = startMemoryWorker(
			store.memoryQueue,
			new HindsightClient({
				baseUrl: `http://127.0.0.1:${server.port}`,
				bankId: "g",
			}),
			{ intervalMs: 5 },
		);
		try {
			const client = new HindsightClient({
				baseUrl: `http://127.0.0.1:${server.port}`,
				bankId: "g",
			});
			deps.memory = {
				...deps.memory!,
				client,
				settleTiming: { pollMs: 5, budgetMs: 2_000 },
				withWorkerPaused: (fn) => worker.withWorkerPaused(fn),
			};
			const operationId = store.memoryQueue.enqueue(client.target, {
				id: "exchange/dm:1/1/a",
				content: "Operator: hi\nGoblin: hello",
				timestamp: new Date().toISOString(),
				conversationId: conv.id,
				sourceIds: ["u1", "a1"],
			});
			// Let the worker's timer pick the row and park inside the submit.
			for (let i = 0; i < 400 && !events.includes("submit"); i++) {
				await sleep(5);
			}
			expect(events).toContain("submit");

			expect(handleCommand(deps, conv, "/forget delete exchange/dm:1/1/a")).toBe(true);
			// The delete is now queued behind the worker's in-flight drain:
			// nothing is cancelled, deleted, or replied while the submit hangs.
			await sleep(80);
			expect(events).toEqual(["submit"]); // no settle, no delete
			expect(sent).toEqual([]);
			expect(store.memoryQueue.get(operationId)?.state).toBe("pending"); // row untouched

			releaseSubmit();
			await waitFor(sent, 1);
			// The submit landed first, its row settled, only then the delete —
			// the document cannot resurrect from the in-flight retain.
			expect(events.indexOf("submit-landed")).toBeLessThan(events.indexOf("delete"));
			expect(sent[0]).toContain("forgotten exchange/dm:1/1/a");
			expect(store.memoryContexts.isSuppressed("exchange/dm:1/1/a")).toBe(true);
			// The row settles consistently: cancelled by the delete, not
			// stranded, and nothing re-queued after it.
			expect(store.memoryQueue.get(operationId)).toBeNull();
			expect(store.memoryQueue.next(client.target, Date.now())).toBeNull();
		} finally {
			await worker.stop();
			server.stop(true);
			store.close();
		}
	});
});

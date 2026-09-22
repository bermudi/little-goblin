import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api } from "grammy";
import type { Config } from "../config.ts";
import { openStore } from "../conversation.ts";
import { HindsightClient } from "../hindsight.ts";
import type { Runtime } from "../runtime.ts";
import { handleCommand, type CommandDeps } from "./commands.ts";

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
	favorites: ["zai/glm-5.3"],
	thinking: "medium",
	allowedUsers: [1],
	telegram: {},
	http: { port: 8787 },
	logLevel: "info",
};

function setup() {
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
		configRef: { current: config },
		store,
		runtime: {
			stop: (id: string) => {
				stopped.push(id);
				return { stopped: stopped.length > 0, settled: Promise.resolve() };
			},
		} as unknown as Runtime,
		botUsername: "goblin",
	};
	return { store, conv, sent, stopped, deps };
}

describe("commands", () => {
	test("/model rejects a ref without provider/model shape", () => {
		const { store, conv, sent, deps } = setup();
		expect(handleCommand(deps, conv, "/model zai")).toBe(true);
		expect(store.get(conv.id)!.model).toBeNull();
		expect(sent[0]).toContain("<provider>/<model-id>");
		store.close();
	});

	test("/model sets an override and bumps the epoch", () => {
		const { store, conv, deps } = setup();
		expect(handleCommand(deps, conv, "/model zai/glm-4.5")).toBe(true);
		const after = store.get(conv.id)!;
		expect(after.model).toBe("zai/glm-4.5");
		expect(after.epoch).toBe(1);
		store.close();
	});

	test("/model rejects an unknown provider", () => {
		const { store, conv, sent, deps } = setup();
		expect(handleCommand(deps, conv, "/model other/x")).toBe(true);
		expect(store.get(conv.id)!.model).toBeNull();
		expect(sent[0]).toContain("unknown provider");
		store.close();
	});

	test("/model reset clears the override", () => {
		const { store, conv, sent, deps } = setup();
		handleCommand(deps, conv, "/model zai/glm-4.5");
		expect(store.get(conv.id)!.model).toBe("zai/glm-4.5");
		handleCommand(deps, conv, "/model reset");
		const after = store.get(conv.id)!;
		expect(after.model).toBeNull();
		expect(sent.at(-1)).toContain("default");
		store.close();
	});

	test("/think reset clears the override", () => {
		const { store, conv, deps } = setup();
		handleCommand(deps, conv, "/think high");
		expect(store.get(conv.id)!.thinking).toBe("high");
		handleCommand(deps, conv, "/think reset");
		expect(store.get(conv.id)!.thinking).toBeNull();
		store.close();
	});

	test("/think rejects a bad level", () => {
		const { store, conv, deps } = setup();
		handleCommand(deps, conv, "/think turbo");
		expect(store.get(conv.id)!.thinking).toBeNull();
		store.close();
	});

	test("/think rejects a level the model can't express", () => {
		const { store, conv, sent, deps } = setup();
		// glm-5.3 thinking is forced — off is not on its ladder.
		handleCommand(deps, conv, "/think off");
		expect(store.get(conv.id)!.thinking).toBeNull();
		expect(sent[0]).toContain("low, high, max");
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

	test("/voice refuses to enable without tts configured", () => {
		const { store, conv, sent, deps } = setup();
		expect(handleCommand(deps, conv, "/voice")).toBe(true);
		expect(store.get(conv.id)!.voice).toBe(false);
		expect(sent[0]).toContain("not configured");
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
	const { store, conv, sent, deps } = setup();
	deps.configRef.current = { ...config, memory: memBlock };
	deps.memory = {
		client: new HindsightClient({ baseUrl: "http://127.0.0.1:1", bankId: "g" }),
		contexts: store.memoryContexts,
		queue: store.memoryQueue,
		lastRecallOk: () => null,
	};
	return { store, conv, sent, deps };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(sent: string[], n: number): Promise<void> {
	for (let i = 0; i < 100 && sent.length < n; i++) await sleep(10);
	expect(sent.length).toBeGreaterThanOrEqual(n);
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
		expect(sent[0]).toContain("on|off|status");
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
			fetch: () => Response.json({ results: [
				{ id: "f1", text: "Lighthouse weekends.", document_id: "exchange/a", occurred_start: "2026-02-01" },
				{ id: "f2", text: "Lighthouse again.", document_id: "exchange/a", occurred_start: "2026-02-02" },
				{ id: "f3", text: "Quiet mornings.", document_id: "exchange/b", occurred_start: "2026-01-01" },
			] }),
		});
		try {
			deps.memory = {
				...deps.memory!,
				client: new HindsightClient({ baseUrl: `http://127.0.0.1:${server.port}`, bankId: "g" }),
			};
			expect(handleCommand(deps, conv, "/forget lighthouse")).toBe(true);
			await waitFor(sent, 1);
			expect(sent[0]).toContain("exchange/a");
			expect(sent[0]).toContain("exchange/b");
			expect(sent[0]).toContain("/forget delete");
		} finally {
			server.stop(true);
			store.close();
		}
	});

	test("/forget delete suppresses, cancels, deletes, and redacts", async () => {
		const { store, conv, sent, deps } = setupMemory();
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request) => {
				if (request.method === "DELETE") {
					return Response.json({ success: true, document_id: "exchange/dm:1/1/a" });
				}
				return Response.json({ results: [] });
			},
		});
		try {
			const client = new HindsightClient({ baseUrl: `http://127.0.0.1:${server.port}`, bankId: "g" });
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
			expect(store.memoryQueue.next(client.target, Date.now())).toBeNull();
			expect(store.memoryContexts.load(conv.id)).toEqual([]);
		} finally {
			server.stop(true);
			store.close();
		}
	});
});


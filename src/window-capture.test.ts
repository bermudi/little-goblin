import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { listCalls, openCacheObservation, type CacheCallInput } from "./cache-observation.ts";
import { appAddress, openStore } from "./conversation.ts";
import { tmpDb } from "./testkit.ts";
import {
	invalidateWindowCaptures,
	openWindowCapture,
	serializeToolDefs,
	stubBinary,
	type WindowCapture,
} from "./window-capture.ts";

function capture(over: Partial<WindowCapture> = {}): WindowCapture {
	return {
		v: 1,
		system: "You are goblin.",
		tools: [{ name: "bash", description: "run it", parameters: { type: "object" } }],
		messages: [{ role: "user", content: "hi" }],
		segments: {
			identity: 10,
			environment: 5,
			project: 0,
			agentsMd: 0,
			userMd: 0,
			skills: 0,
			toolDefs: 7,
			history: 2,
			toolResults: 0,
		},
		...over,
	};
}

describe("window capture", () => {
	test("record then read round-trips the payload; latest wins", () => {
		const db = new Database(":memory:");
		const store = openWindowCapture(db, { now: () => 1_000 });
		store.record("app/a", { model: "z/glm", step: 1, capture: capture(), recallVersion: 0 });
		store.record("app/a", {
			model: "z/glm",
			step: 2,
			capture: capture({ system: "second window" }),
			recallVersion: 0,
		});
		store.record("app/b", { model: "o/other", step: 1, capture: capture(), recallVersion: 0 });

		const read = store.read("app/a");
		expect(read).not.toBeNull();
		expect(read!.capturedMs).toBe(1_000);
		expect(read!.model).toBe("z/glm");
		expect(read!.step).toBe(2);
		expect(read!.capture.system).toBe("second window");
		expect(read!.capture.messages).toEqual([{ role: "user", content: "hi" }]);
		// The other conversation's row is untouched.
		expect(store.read("app/b")!.step).toBe(1);
		expect(store.read("app/missing")).toBeNull();
	});

	test("media bytes are stubbed to counts, never stringified", () => {
		const db = new Database(":memory:");
		const store = openWindowCapture(db);
		const bytes = new Uint8Array([1, 2, 3, 4]);
		store.record("app/a", {
			model: "z/glm",
			step: 1,
			recallVersion: 0,
			capture: capture({
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "what is this" },
							{ type: "file", data: bytes, mediaType: "image/png" },
							{ type: "image", image: bytes },
							{ type: "file", data: new URL("https://x/y.png"), mediaType: "image/png" },
						],
					},
				],
			}),
		});
		const messages = store.read("app/a")!.capture.messages as Array<Record<string, unknown>>;
		const content = messages[0]!.content as Array<Record<string, unknown>>;
		expect(content[1]).toEqual({
			type: "file",
			data: { omitted: "bytes", count: 4 },
			mediaType: "image/png",
		});
		expect(content[2]).toEqual({ type: "image", image: { omitted: "bytes", count: 4 } });
		// A URL part keeps its address — the model saw the text, not bytes.
		expect(content[3]!.data).toBe("https://x/y.png");
		expect(JSON.stringify(messages)).not.toContain('"0":');
	});

	test("a corrupted payload fails loud with the conversation named", () => {
		const db = new Database(":memory:");
		const store = openWindowCapture(db);
		db.query(
			"INSERT INTO context_windows (conversation_id, captured_ms, model, step, payload) VALUES (?, ?, ?, ?, ?)",
		).run("app/bad", 1, "m", 1, new Uint8Array([0, 1, 2]));
		expect(() => store.read("app/bad")).toThrow(/app\/bad failed to decode/);
	});

	test("a payload of the wrong shape fails loud, never parses as empty", () => {
		const db = new Database(":memory:");
		const store = openWindowCapture(db);
		store.record("app/a", { model: "m", step: 1, capture: capture(), recallVersion: 0 });
		// Overwrite with valid gzip of a shapeless object.
		const blob = Bun.gzipSync(new TextEncoder().encode(JSON.stringify({ nope: true })));
		db.query("UPDATE context_windows SET payload = ? WHERE conversation_id = ?").run(blob, "app/a");
		expect(() => store.read("app/a")).toThrow();
	});

	test("the row rides deleteConversation — a re-minted id inherits nothing", () => {
		const store = openStore(":memory:");
		const windows = openWindowCapture(store.db);
		const conv = store.resolve(appAddress("gone"), "/w");
		windows.record(conv.id, { model: "m", step: 1, capture: capture(), recallVersion: 0 });
		expect(windows.read(conv.id)).not.toBeNull();

		store.deleteConversation(conv.id);
		expect(windows.read(conv.id)).toBeNull();

		// Operator-chosen ids re-mint freely; the new generation must not
		// serve the deleted one's capture as its own.
		const reminted = store.resolve(appAddress("gone"), "/w");
		expect(reminted.id).toBe(conv.id);
		expect(windows.read(reminted.id)).toBeNull();
		store.close();
	});
});

describe("recall-version fencing", () => {
	test("a forget clears stored windows and fences a pre-forget version", () => {
		const store = openStore(":memory:");
		const windows = openWindowCapture(store.db);
		const conv = store.resolve(appAddress("gone"), "/w");
		const other = store.resolve(appAddress("other"), "/w");
		store.memoryContexts.save(conv.id, 1, "[recall]", ["exchange/x/1/a"]);
		store.memoryContexts.save(other.id, 5, "[unrelated]", ["exchange/y/2/b"]);
		windows.record(conv.id, { model: "m", step: 1, capture: capture(), recallVersion: 0 });
		windows.record(other.id, { model: "m", step: 2, capture: capture(), recallVersion: 0 });
		expect(windows.version()).toBe(0);

		const removed = store.memoryContexts.deleteByDocument("exchange/x/1/a");
		expect(removed).toBe(1);
		expect(store.memoryContexts.load(conv.id)).toEqual([]);
		expect(store.memoryContexts.load(other.id)).toHaveLength(1);
		expect(windows.read(conv.id)).toBeNull();
		expect(windows.read(other.id)).toBeNull();
		expect(windows.version()).toBe(1);

		windows.record(conv.id, {
			model: "m",
			step: 3,
			capture: capture(),
			recallVersion: 0,
		});
		expect(windows.read(conv.id)).toBeNull();
		windows.record(conv.id, {
			model: "m",
			step: 3,
			capture: capture(),
			recallVersion: 1,
		});
		expect(windows.read(conv.id)).not.toBeNull();
		store.close();
	});

	test("the version fence holds across separate handles on one database file", () => {
		const dbPath = tmpDb("goblin-wc-");
		const dbA = new Database(dbPath);
		const dbB = new Database(dbPath);
		try {
			const a = openWindowCapture(dbA);
			const b = openWindowCapture(dbB);
			a.record("app/c", {
				model: "m",
				step: 1,
				capture: capture(),
				recallVersion: a.version(),
			});
			expect(b.read("app/c")).not.toBeNull();
			invalidateWindowCaptures(dbB);
			expect(b.version()).toBe(1);
			expect(a.version()).toBe(1);
			expect(a.read("app/c")).toBeNull();
			a.record("app/c", {
				model: "m",
				step: 1,
				capture: capture({ system: "revived" }),
				recallVersion: 0,
			});
			expect(a.read("app/c")).toBeNull();
			expect(b.read("app/c")).toBeNull();
			b.record("app/c", {
				model: "m",
				step: 1,
				capture: capture({ system: "revived" }),
				recallVersion: b.version(),
			});
			expect(b.read("app/c")).not.toBeNull();
		} finally {
			dbA.close();
			dbB.close();
		}
	});

	test("a real forget of a recall in another conversation clears stored windows", async () => {
		const store = openStore(":memory:");
		const windows = openWindowCapture(store.db);
		const conv = store.resolve(appAddress("one"), "/w");
		const other = store.resolve(appAddress("two"), "/w");
		const fact = "the operator's cat is named ORION-9z7w";
		store.memoryContexts.save(conv.id, 1, `[recall] ${fact}`, ["exchange/dm:1/1/a"]);
		store.memoryContexts.save(other.id, 9, "[other recall]", ["exchange/dm:2/3/b"]);
		windows.record(conv.id, {
			model: "m",
			step: 1,
			capture: capture({ messages: [{ role: "user", content: `turn sees ${fact}` }] }),
			recallVersion: 0,
		});
		expect(JSON.stringify(windows.read(conv.id)!.capture.messages)).toContain(fact);

		const { forgetDocument } = await import("./memory/forget.ts");
		const remote = {
			target: "a".repeat(64),
			operation: async () => null,
			deleteDocument: async () => {},
		};
		const result = await forgetDocument(
			{
				client: remote,
				contexts: store.memoryContexts,
				queue: store.memoryQueue,
				withWorkerPaused: (fn) => fn(),
			},
			"exchange/dm:1/1/a",
			{ channel: "telegram" },
		);
		expect(result.outcome).toBe("forgotten");
		expect(windows.read(conv.id)).toBeNull();
		expect(store.memoryContexts.load(conv.id)).toEqual([]);
		expect(store.memoryContexts.load(other.id)).toHaveLength(1);
		expect(windows.version()).toBe(1);
		store.close();
	});
});

describe("serializeToolDefs", () => {
	const sampleTool = tool({
		description: "Read a file",
		inputSchema: z.object({ path: z.string() }),
		execute: async () => "contents",
	});

	test("carries name, description and the JSON schema", () => {
		const tools: ToolSet = { read_file: sampleTool };
		const [def] = serializeToolDefs(tools);
		expect(def!.name).toBe("read_file");
		expect(def!.description).toBe("Read a file");
		const parameters = def!.parameters as { type: string; properties: unknown };
		expect(parameters.type).toBe("object");
		expect(parameters.properties).toHaveProperty("path");
	});

	test("a missing description reads as null", () => {
		const bare = tool({ inputSchema: z.object({}), execute: async () => "ok" });
		const tools: ToolSet = { bash: bare };
		const [def] = serializeToolDefs(tools);
		expect(def!.description).toBeNull();
	});
});

describe("listCalls", () => {
	function callInput(over: Partial<CacheCallInput> = {}): CacheCallInput {
		return {
			callId: `call-${Math.random().toString(36).slice(2)}`,
			conversationId: "app/a",
			purpose: null,
			model: "z/glm-5.3-flash",
			routeKey: "a".repeat(64),
			headHash: "h".repeat(64),
			requestHash: "r".repeat(64),
			settingsHash: "s".repeat(64),
			promptHashes: ["p1"],
			...over,
		};
	}

	test("returns the conversation's calls newest first, other conversations excluded", () => {
		const db = new Database(":memory:");
		const observation = openCacheObservation(db, { now: () => 5_000 });
		const first = observation.begin(callInput({ callId: "c1" }));
		first.finish(usageOf(100, 80, 10));
		const second = observation.begin(callInput({ callId: "c2" }));
		second.finish(usageOf(200, 150, 20));
		observation.begin(callInput({ callId: "c3", conversationId: "app/b" }));

		const rows = listCalls(db, "app/a");
		expect(rows.map((r) => r.callId)).toEqual(["c2", "c1"]);
		expect(rows[1]!.inputTokens).toBe(100);
		expect(rows[1]!.cacheRead).toBe(80);
		expect(rows[1]!.status).toBe("completed");
		expect(rows[1]!.prefixRelation).toBe("first");
		expect(rows[0]!.finishedMs).toBe(5_000);
	});

	function usageOf(input: number, cacheRead: number, output: number) {
		return {
			inputTokens: { total: input, noCache: undefined, cacheRead, cacheWrite: undefined },
			outputTokens: { total: output, text: undefined, reasoning: undefined },
		} as const;
	}
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthStore } from "../auth.ts";
import { type ConversationStore, openStore } from "../conversation.ts";
import { type ForgetSource, forgetDocument, type HindsightInstance } from "./forget.ts";
import { HindsightClient, type MemoryDocument, type MemoryOperation } from "./hindsight.ts";
import { buildDestinationClient } from "./mod.ts";
import { MemoryQueueWorker } from "./queue.ts";

const documentId = "exchange/dm:1/1/a";
const doc: MemoryDocument = {
	id: documentId,
	conversationId: "dm:1",
	sourceIds: ["u1", "a1"],
	timestamp: "2026-10-08T10:00:00Z",
	content: "Operator: hi\nGoblin: hello",
};
const target = "a".repeat(64);

const dirs: string[] = [];
const stores: ConversationStore[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
	for (const store of stores.splice(0)) store.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function storeAt(): ConversationStore {
	const dir = mkdtempSync(join(tmpdir(), "goblin-forget-test-"));
	dirs.push(dir);
	const store = openStore(join(dir, "state.sqlite"));
	stores.push(store);
	return store;
}

function fakeRemote(
	statuses: (MemoryOperation["status"] | null)[],
	of: string = target,
): {
	instance: HindsightInstance;
	polled: string[];
	deleted: string[];
} {
	const polled: string[] = [];
	const deleted: string[] = [];
	let step = 0;
	return {
		polled,
		deleted,
		instance: {
			target: of,
			async operation(operationId: string) {
				polled.push(operationId);
				const status = statuses[Math.min(step++, statuses.length - 1)] ?? null;
				return status === null ? null : { operation_id: operationId, status };
			},
			async deleteDocument(id: string) {
				deleted.push(id);
			},
		},
	};
}

function sourceOf(client: HindsightInstance, store: ConversationStore) {
	return {
		client,
		contexts: store.memoryContexts,
		queue: store.memoryQueue,
		withWorkerPaused: <T>(fn: () => Promise<T>) => fn(),
		settleTiming: { pollMs: 5, budgetMs: 2_000 },
	};
}

describe("forget reconciles uncertain pending retention", () => {
	test("a lost submit acknowledgement leaves a pending row that forget still settles", async () => {
		const store = storeAt();
		const events: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async (request) => {
				const path = new URL(request.url).pathname;
				if (request.method === "POST" && path.endsWith("/memories")) {
					events.push("accepted");
					return new Response("try later", { status: 503 });
				}
				if (path.includes("/operations/")) {
					const polls = events.filter((e) => e === "poll").length;
					events.push("poll");
					return Response.json({
						operation_id: path.split("/").pop(),
						status: polls >= 2 ? "completed" : "processing",
					});
				}
				if (request.method === "DELETE") {
					events.push("delete");
					return Response.json({ success: true, document_id: documentId });
				}
				return Response.json({ results: [] });
			},
		});
		servers.push(server);
		const client = new HindsightClient({
			baseUrl: `http://127.0.0.1:${server.port}`,
			bankId: "g",
		});
		const operationId = store.memoryQueue.enqueue(client.target, doc);
		await new MemoryQueueWorker(store.memoryQueue, client).tick();
		const row = store.memoryQueue.get(operationId);
		expect(row?.state).toBe("pending");
		expect(row?.attempts).toBe(1);

		const result = await forgetDocument(sourceOf(client, store), documentId, {
			channel: "telegram",
			conversation: "dm:1",
		});
		expect(result).toEqual({ outcome: "forgotten", cancelled: 1, redacted: 0, settledOps: 1 });
		expect(events[0]).toBe("accepted");
		expect(events.filter((e) => e === "poll").length).toBeGreaterThanOrEqual(3);
		expect(events.lastIndexOf("delete")).toBeGreaterThan(events.lastIndexOf("poll"));
		expect(store.memoryQueue.get(operationId)).toBeNull();
		expect(store.memoryContexts.isSuppressed(documentId)).toBe(true);
	});

	test("a crash between acceptance and the submitted write is reconciled too", async () => {
		const store = storeAt();
		const remote = fakeRemote(["processing", "completed"]);
		const operationId = store.memoryQueue.enqueue(target, doc);
		const result = await forgetDocument(sourceOf(remote.instance, store), documentId, {
			channel: "mini-app",
		});
		expect(result).toEqual({ outcome: "forgotten", cancelled: 1, redacted: 0, settledOps: 1 });
		expect(remote.polled).toEqual([operationId, operationId]);
		expect(remote.deleted).toEqual([documentId]);
		expect(store.memoryQueue.get(operationId)).toBeNull();
		expect(store.memoryContexts.isSuppressed(documentId)).toBe(true);
	});

	test("a pending operation that never settles refuses and keeps its tracking", async () => {
		const store = storeAt();
		const remote = fakeRemote(["processing"]);
		const operationId = store.memoryQueue.enqueue(target, doc);
		const result = await forgetDocument(
			{
				...sourceOf(remote.instance, store),
				settleTiming: { pollMs: 5, budgetMs: 60 },
			},
			documentId,
			{ channel: "mini-app" },
		);
		expect(result).toEqual({ outcome: "busy", unsettled: 1 });
		expect(remote.deleted).toEqual([]);
		expect(store.memoryContexts.isSuppressed(documentId)).toBe(false);
		expect(store.memoryQueue.get(operationId)?.state).toBe("pending");
	});

	test("a pending operation absent remotely is reconciled with one poll, then cancelled", async () => {
		const store = storeAt();
		const remote = fakeRemote([null]);
		const operationId = store.memoryQueue.enqueue(target, doc);
		const result = await forgetDocument(sourceOf(remote.instance, store), documentId, {
			channel: "mini-app",
		});
		expect(result).toEqual({ outcome: "forgotten", cancelled: 1, redacted: 0, settledOps: 1 });
		expect(remote.polled).toEqual([operationId]);
		expect(remote.deleted).toEqual([documentId]);
		expect(store.memoryQueue.get(operationId)).toBeNull();
	});
});

describe("forget after a memory destination change", () => {
	const auth: AuthStore = {
		resolve: () => Promise.reject(new Error("unexpected auth resolution")),
		has: () => false,
		names: () => [],
	};
	function twoBanks(): {
		store: ConversationStore;
		oldClient: HindsightClient;
		newClient: HindsightClient;
		oldEvents: string[];
		newEvents: string[];
	} {
		const store = storeAt();
		const oldEvents: string[] = [];
		const newEvents: string[] = [];
		const oldServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request) => {
				const path = new URL(request.url).pathname;
				if (request.method === "POST" && path.endsWith("/memories")) {
					oldEvents.push("accepted");
					return new Response("try later", { status: 503 });
				}
				if (path.includes("/operations/")) {
					const polls = oldEvents.filter((e) => e === "old-poll").length;
					oldEvents.push("old-poll");
					return new Response(
						JSON.stringify({
							operation_id: path.split("/").pop(),
							status: polls >= 1 ? "completed" : "processing",
						}),
					);
				}
				if (request.method === "DELETE") {
					oldEvents.push("old-delete");
					return Response.json({ success: true, document_id: documentId });
				}
				return Response.json({ results: [] });
			},
		});
		const newServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request) => {
				const path = new URL(request.url).pathname;
				newEvents.push(`${request.method} ${path}`);
				if (request.method === "DELETE") {
					return Response.json({ success: true, document_id: documentId });
				}
				return new Response(null, { status: 404 });
			},
		});
		servers.push(oldServer, newServer);
		const oldClient = new HindsightClient({
			baseUrl: `http://127.0.0.1:${oldServer.port}`,
			bankId: "old",
		});
		const newClient = new HindsightClient({
			baseUrl: `http://127.0.0.1:${newServer.port}`,
			bankId: "new",
		});
		store.memoryDestinations.record({
			baseUrl: `http://127.0.0.1:${oldServer.port}`,
			bankId: "old",
		});
		store.memoryDestinations.record({
			baseUrl: `http://127.0.0.1:${newServer.port}`,
			bankId: "new",
		});
		return { store, oldClient, newClient, oldEvents, newEvents };
	}

	test("settles and deletes through the owning bank, never polls the new bank for old ops", async () => {
		const { store, oldClient, newClient, oldEvents, newEvents } = twoBanks();
		const operationId = store.memoryQueue.enqueue(oldClient.target, doc);
		await new MemoryQueueWorker(store.memoryQueue, oldClient).tick();
		expect(store.memoryQueue.get(operationId)?.state).toBe("pending");

		const source: ForgetSource = {
			...sourceOf(newClient, store),
			clientForTarget: (t) => {
				const destination = store.memoryDestinations.get(t);
				return destination === null ? null : buildDestinationClient(destination, auth);
			},
		};
		const result = await forgetDocument(source, documentId, { channel: "telegram" });
		expect(result).toEqual({ outcome: "forgotten", cancelled: 1, redacted: 0, settledOps: 1 });
		expect(oldEvents[0]).toBe("accepted");
		expect(oldEvents.filter((e) => e === "old-poll").length).toBeGreaterThanOrEqual(2);
		expect(oldEvents.lastIndexOf("old-delete")).toBeGreaterThan(oldEvents.lastIndexOf("old-poll"));
		expect(newEvents).toEqual([
			`DELETE /v1/default/banks/new/documents/${encodeURIComponent(documentId)}`,
		]);
		expect(store.memoryQueue.get(operationId)).toBeNull();
		expect(store.memoryContexts.isSuppressed(documentId)).toBe(true);
	});

	test("an old bank no longer addressable refuses and preserves its tracking", async () => {
		const { store, oldClient, newClient, oldEvents, newEvents } = twoBanks();
		const operationId = store.memoryQueue.enqueue(oldClient.target, doc);
		await new MemoryQueueWorker(store.memoryQueue, oldClient).tick();

		const source: ForgetSource = {
			...sourceOf(newClient, store),
			clientForTarget: () => null,
		};
		const result = await forgetDocument(source, documentId, { channel: "mini-app" });
		expect(result).toEqual({ outcome: "foreign-bank", target: oldClient.target });
		expect(oldEvents).toEqual(["accepted"]);
		expect(newEvents).toEqual([]);
		expect(store.memoryQueue.get(operationId)?.state).toBe("pending");
		expect(store.memoryContexts.isSuppressed(documentId)).toBe(false);
	});
});

describe("forget keeps its retry map when a remote delete fails", () => {
	const newTarget = "b".repeat(64);
	function flakyOldBank(): {
		instance: HindsightInstance;
		deletes: () => number;
		stillHolds: () => boolean;
	} {
		const state = { deletes: 0, holds: true };
		const instance: HindsightInstance = {
			target,
			async operation() {
				return null;
			},
			async deleteDocument() {
				state.deletes++;
				if (state.deletes === 1) throw new Error("synthetic transient DELETE failure");
				state.holds = false;
			},
		};
		return { instance, deletes: () => state.deletes, stillHolds: () => state.holds };
	}

	test("a failed old-bank delete keeps the destination tracked; retry retries the old bank", async () => {
		const store = storeAt();
		const old = flakyOldBank();
		const operationId = store.memoryQueue.enqueue(target, doc);
		const current: HindsightInstance = {
			target: newTarget,
			async operation() {
				return null;
			},
			async deleteDocument() {},
		};
		const source: ForgetSource = {
			...sourceOf(current, store),
			clientForTarget: () => old.instance,
		};
		let firstFailed = false;
		try {
			await forgetDocument(source, documentId, { channel: "telegram", conversation: "dm:1" });
		} catch {
			firstFailed = true;
		}
		expect(firstFailed).toBe(true);
		expect(store.memoryContexts.isSuppressed(documentId)).toBe(true);
		expect(store.memoryQueue.documentDestinations(documentId)).toEqual([{ target, inflight: [] }]);
		expect(store.memoryQueue.get(operationId)?.state).toBe("deleting");
		expect(store.memoryQueue.next(target, Date.now())).toBeNull();

		const retry = await forgetDocument(source, documentId, {
			channel: "telegram",
			conversation: "dm:1",
		});
		expect(retry.outcome).toBe("forgotten");
		expect(old.deletes()).toBe(2);
		expect(old.stillHolds()).toBe(false);
		expect(store.memoryQueue.get(operationId)).toBeNull();
	});

	test("each destination's rows drop only after its own delete confirms", async () => {
		const store = storeAt();
		const secondTarget = "c".repeat(64);
		const deletedFirst: string[] = [];
		const first: HindsightInstance = {
			target,
			async operation() {
				return null;
			},
			async deleteDocument(id) {
				deletedFirst.push(id);
			},
		};
		const second: HindsightInstance = {
			target: secondTarget,
			async operation() {
				return null;
			},
			async deleteDocument() {
				throw new Error("synthetic old-bank outage");
			},
		};
		const current: HindsightInstance = {
			target: newTarget,
			async operation() {
				return null;
			},
			async deleteDocument() {},
		};
		const firstOp = store.memoryQueue.enqueue(target, doc);
		const secondOp = store.memoryQueue.enqueue(secondTarget, doc);
		let failed = false;
		try {
			await forgetDocument(
				{
					...sourceOf(current, store),
					clientForTarget: (t) => (t === target ? first : second),
				},
				documentId,
				{ channel: "mini-app" },
			);
		} catch {
			failed = true;
		}
		expect(failed).toBe(true);
		expect(deletedFirst).toEqual([documentId]);
		expect(store.memoryQueue.get(firstOp)).toBeNull();
		expect(store.memoryQueue.get(secondOp)?.state).toBe("deleting");
		expect(store.memoryQueue.documentDestinations(documentId)).toEqual([
			{ target: secondTarget, inflight: [] },
		]);
	});
});

// The forget protocol's in-flight reconciliation. A queue row reading
// `pending` is NOT proof its retention was never sent: the worker's
// submit can be accepted remotely while its acknowledgement degrades
// (a retryable timeout/5xx leaves the row pending), and a crash between
// acceptance and the submitted-state write does the same. The operation
// UUID is durable from enqueue, so forget must reconcile every in-flight
// UUID — pending rows included — before cancelling tracking or reporting
// success (#86; the same window as #99's crash-between-accept-and-write).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type ConversationStore } from "./conversation.ts";
import { HindsightClient, type MemoryDocument, type MemoryOperation } from "./hindsight.ts";
import { forgetDocument, type HindsightInstance } from "./memory-forget.ts";
import { MemoryQueueWorker } from "./memory-queue.ts";

const documentId = "exchange/dm:1/1/a";
const doc: MemoryDocument = {
	id: documentId,
	conversationId: "dm:1",
	sourceIds: ["u1", "a1"],
	timestamp: "2026-10-08T10:00:00Z",
	content: "Operator: hi\nGoblin: hello",
};
// Any well-formed target — the queue only needs the 64-hex vocabulary.
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

// A scripted remote: operation() walks the statuses in order (last one
// sticks), null models an operation absent remotely; the delete records
// itself so tests can pin request ordering.
function fakeRemote(statuses: (MemoryOperation["status"] | null)[]): {
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
	// #86's reproduction: the worker submits, Hindsight accepts the retain
	// under the persisted UUID, but the acknowledgement degrades to a
	// retryable 503 — the row stays pending while the operation is live
	// remotely. Forgetting must poll that UUID to terminal before the
	// delete, or the accepted operation re-creates the document after it.
	test("a lost submit acknowledgement leaves a pending row that forget still settles", async () => {
		const store = storeAt();
		const events: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async (request) => {
				const path = new URL(request.url).pathname;
				if (request.method === "POST" && path.endsWith("/memories")) {
					events.push("accepted"); // the retain landed; only the ack degrades
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
		// The premise: the lost acknowledgement leaves the row pending.
		const row = store.memoryQueue.get(operationId);
		expect(row?.state).toBe("pending");
		expect(row?.attempts).toBe(1);

		const result = await forgetDocument(sourceOf(client, store), documentId, {
			channel: "telegram",
			conversation: "dm:1",
		});
		expect(result).toEqual({ outcome: "forgotten", cancelled: 1, redacted: 0, settledOps: 1 });
		// The accepted operation reached terminal before the delete — no
		// resurrect window between the two.
		expect(events[0]).toBe("accepted");
		expect(events.filter((e) => e === "poll").length).toBeGreaterThanOrEqual(3);
		expect(events.lastIndexOf("delete")).toBeGreaterThan(events.lastIndexOf("poll"));
		expect(store.memoryQueue.get(operationId)).toBeNull();
		expect(store.memoryContexts.isSuppressed(documentId)).toBe(true);
	});

	// #99's crash window: a crash between Hindsight accepting a retain and
	// the local submitted-state write leaves the row pending with the
	// operation live remotely. Same reconciliation, no worker involved.
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
		// The uncertain row survives with its UUID — a later forget can
		// still reconcile it once the remote finishes.
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

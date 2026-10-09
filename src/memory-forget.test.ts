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
import type { AuthStore } from "./auth.ts";
import { openStore, type ConversationStore } from "./conversation.ts";
import { HindsightClient, type MemoryDocument, type MemoryOperation } from "./hindsight.ts";
import { buildDestinationClient } from "./memory.ts";
import { forgetDocument, type ForgetSource, type HindsightInstance } from "./memory-forget.ts";
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
// itself so tests can pin request ordering. `of` names the target the
// stub answers for (rows must be enqueued against the same one).
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

// #87: the destination-change case. Queue rows bind to the endpoint+bank
// target hash, and that hash is one-way — an operation accepted by a
// PREVIOUS bank can never be reconciled through the current client: the
// new bank's bank-scoped 404 reads as "settled", the old rows get
// cancelled, the delete lands only in the new bank, and the old bank
// keeps both the document and its live retention while forget reports
// success. Forgetting must settle each destination's in-flight
// operations and delete the document through the owning destination.
describe("forget after a memory destination change", () => {
	// No recorded destination exercises an auth path — destinations here
	// carry no key; a resolution attempt means a wiring bug.
	const auth: AuthStore = {
		resolve: () => Promise.reject(new Error("unexpected auth resolution")),
		has: () => false,
		names: () => [],
	};
	// Two loopback banks. The old bank accepts the retain under the
	// persisted UUID but its acknowledgement degrades to a 503 (the #86
	// premise), so the row reads pending while the operation runs remotely
	// against the OLD bank. Each modeled boot records its destination —
	// production sequencing (index.ts) — and the restart is modeled by
	// forgetting through a client pointed at the NEW bank whose
	// clientForTarget reconstructs the old bank from that history.
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
					oldEvents.push("accepted"); // the retain landed; only the ack degrades
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
				// Bank-scoped: the old bank's operation id is unknown here.
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
		// Boot 1 ran the old bank; boot 2 (the restart) runs the new one.
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

		// The restart: forget runs through the new bank's client and
		// reconstructs the old bank's from destination history — the
		// production clientForTarget wiring from index.ts.
		const source: ForgetSource = {
			...sourceOf(newClient, store),
			clientForTarget: (t) => {
				const destination = store.memoryDestinations.get(t);
				return destination === null ? null : buildDestinationClient(destination, auth);
			},
		};
		const result = await forgetDocument(source, documentId, { channel: "telegram" });
		expect(result).toEqual({ outcome: "forgotten", cancelled: 1, redacted: 0, settledOps: 1 });
		// The owning bank reconciled its own operation: polls, then the
		// delete after the last one — no resurrect window.
		expect(oldEvents[0]).toBe("accepted");
		expect(oldEvents.filter((e) => e === "old-poll").length).toBeGreaterThanOrEqual(2);
		expect(oldEvents.lastIndexOf("old-delete")).toBeGreaterThan(oldEvents.lastIndexOf("old-poll"));
		// The new bank saw exactly its own document delete — never an
		// operation poll for the old bank's UUID. (Ids are percent-encoded
		// in the wire path, as the client's encodeURIComponent does.)
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

		// Destination history cannot reconstruct that target — rows that
		// predate the table are exactly this case — so forget must refuse
		// rather than poll the new bank and drop the old rows on a
		// foreign delete.
		const source: ForgetSource = {
			...sourceOf(newClient, store),
			clientForTarget: () => null,
		};
		const result = await forgetDocument(source, documentId, { channel: "mini-app" });
		expect(result).toEqual({ outcome: "foreign-bank", target: oldClient.target });
		expect(oldEvents).toEqual(["accepted"]); // nothing reconciled, nothing deleted
		expect(newEvents).toEqual([]);
		expect(store.memoryQueue.get(operationId)?.state).toBe("pending");
		expect(store.memoryContexts.isSuppressed(documentId)).toBe(false);
	});
});

// #113: the outbox rows ARE the document→destination map. Cancelling
// them before the remote deletes meant a failed old-bank delete (or a
// crash in that window) left retry with no way to know the old bank
// holds the document — it deleted only from the current bank and
// reported forgotten while the old copy survived. Deletion work must
// persist per document/destination until that destination confirms;
// suppression alone stops ingestion.
describe("forget keeps its retry map when a remote delete fails", () => {
	const newTarget = "b".repeat(64);
	// A foreign bank whose first DELETE fails; the row is enqueued
	// directly (never submitted), so settle sees an absent operation
	// and passes without remote help.
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
		expect(firstFailed).toBe(true); // fail loud: the delete error escapes
		// Suppression committed on the first attempt — nothing can re-enqueue.
		expect(store.memoryContexts.isSuppressed(documentId)).toBe(true);
		// THE regression: the old bank's row survives as the retry map,
		// parked where the worker can never submit it again.
		expect(store.memoryQueue.documentDestinations(documentId)).toEqual([{ target, inflight: [] }]);
		expect(store.memoryQueue.get(operationId)?.state).toBe("deleting");
		expect(store.memoryQueue.next(target, Date.now())).toBeNull();

		const retry = await forgetDocument(source, documentId, {
			channel: "telegram",
			conversation: "dm:1",
		});
		expect(retry.outcome).toBe("forgotten");
		expect(old.deletes()).toBe(2); // the retry went back to the old bank
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
		expect(deletedFirst).toEqual([documentId]); // confirmed before the crash
		// The confirmed destination's rows are gone; the failing one's
		// stay — exactly the map a retry needs.
		expect(store.memoryQueue.get(firstOp)).toBeNull();
		expect(store.memoryQueue.get(secondOp)?.state).toBe("deleting");
		expect(store.memoryQueue.documentDestinations(documentId)).toEqual([
			{ target: secondTarget, inflight: [] },
		]);
	});
});

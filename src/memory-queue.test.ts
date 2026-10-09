import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UIMessage } from "ai";
import { openStore, type ConversationStore } from "./conversation.ts";
import { HindsightClient, type MemoryDocument } from "./hindsight.ts";
import { MemoryQueueWorker } from "./memory-queue.ts";

const dirs: string[] = [];
const stores: ConversationStore[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
	for (const store of stores.splice(0)) store.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function database(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-memory-test-"));
	dirs.push(dir);
	return join(dir, "state.sqlite");
}
function storeAt(path: string): ConversationStore {
	const store = openStore(path);
	stores.push(store);
	store.resolve({ kind: "dm", chatId: 1 }, "/unused");
	return store;
}
function service(handler: (request: Request) => Response | Promise<Response>): HindsightClient {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
	servers.push(server);
	return new HindsightClient({ baseUrl: `http://127.0.0.1:${server.port}`, bankId: "g" });
}
const doc: MemoryDocument = {
	id: "exchange-1",
	conversationId: "dm:1",
	sourceIds: ["user-1", "assistant-1"],
	timestamp: "2026-09-22T10:00:00Z",
	content: "Operator: Quiet please.\nGoblin: Understood.",
};
const reply: UIMessage = {
	id: "assistant-1",
	role: "assistant",
	parts: [{ type: "text", text: "Understood." }],
};
function enqueue(store: ConversationStore, client: HindsightClient): string {
	store.append("dm:1", [reply], { memory: { target: client.target, document: doc } });
	const item = store.memoryQueue.next(client.target, Date.now());
	if (!item) throw new Error("expected pending memory");
	return item.operation_id;
}

test("history and retention commit together; invalid memory rolls history back", () => {
	const store = storeAt(database());
	const client = new HindsightClient({ baseUrl: "http://127.0.0.1:1", bankId: "g" });
	expect(() =>
		store.append("dm:1", [reply], {
			memory: { target: client.target, document: { ...doc, timestamp: "bad" } },
		}),
	).toThrow();
	expect(store.history("dm:1")).toEqual([]);
	expect(store.memoryQueue.next(client.target, Date.now())).toBeNull();
	const id = enqueue(store, client);
	expect(store.history("dm:1")).toEqual([reply]);
	expect(store.memoryQueue.get(id)?.document).toEqual(doc);
	expect(() =>
		store.append("dm:1", [reply], {
			memory: { target: client.target, document: { ...doc, content: "changed content" } },
		}),
	).toThrow("identity reused");
	expect(store.history("dm:1")).toHaveLength(1);
});

test("restart preserves operation identity; acknowledgement alone is not completion", async () => {
	let operationId = "";
	let remoteStatus = "processing";
	const client = service(async (request) => {
		if (request.method === "POST") {
			const body: unknown = await request.json();
			expect(body).toMatchObject({ operation_id: operationId, async: true });
			return Response.json({
				success: true,
				bank_id: "g",
				items_count: 1,
				async: true,
				operation_id: operationId,
			});
		}
		return Response.json({ operation_id: operationId, status: remoteStatus });
	});
	const path = database();
	let store = storeAt(path);
	operationId = enqueue(store, client);
	store.close();
	stores.splice(stores.indexOf(store), 1);
	store = storeAt(path);
	expect(store.memoryQueue.get(operationId)?.state).toBe("pending");
	let now = Date.now();
	const worker = new MemoryQueueWorker(store.memoryQueue, client, () => now);
	await worker.tick();
	expect(store.memoryQueue.get(operationId)?.state).toBe("submitted");
	now += 5_000;
	await worker.tick();
	expect(store.memoryQueue.get(operationId)?.state).toBe("submitted");
	remoteStatus = "completed";
	now += 5_000;
	await worker.tick();
	expect(store.memoryQueue.get(operationId)?.state).toBe("completed");
	now += 10_000;
	expect(await worker.tick()).toBe(false);
});

test("lost acknowledgement retries the same operation with backoff; ticks never overlap", async () => {
	const received: unknown[] = [];
	let id = "";
	const client = service(async (request) => {
		received.push(await request.json());
		if (received.length === 1) return new Response("unavailable", { status: 503 });
		return Response.json({
			success: true,
			bank_id: "g",
			items_count: 1,
			async: true,
			operation_id: id,
		});
	});
	const store = storeAt(database());
	id = enqueue(store, client);
	let now = Date.now();
	const worker = new MemoryQueueWorker(store.memoryQueue, client, () => now);
	await Promise.all([worker.tick(), worker.tick()]);
	expect(received).toHaveLength(1);
	expect(store.memoryQueue.get(id)?.state).toBe("pending");
	expect(await worker.tick()).toBe(false);
	now += 1_000;
	await worker.tick();
	expect(received).toHaveLength(2);
	expect(received[0]).toEqual(received[1]);
	expect(store.memoryQueue.get(id)?.state).toBe("submitted");
});

test("destination changes cannot redirect queued personal content", async () => {
	let requests = 0;
	const client = service(() => {
		requests++;
		return Response.json({ results: [] });
	});
	const store = storeAt(database());
	const other = new HindsightClient({ baseUrl: "http://127.0.0.1:1", bankId: "different" });
	const id = enqueue(store, other);
	const worker = new MemoryQueueWorker(store.memoryQueue, client);
	expect(await worker.tick()).toBe(false);
	expect(requests).toBe(0);
	expect(store.memoryQueue.get(id)?.state).toBe("pending");
});

test("worker outcome classification: transport failure vs advance (feeds the outage tracker)", async () => {
	const outcomes: { ok: boolean; transport: boolean }[] = [];
	// Dead port: submit fails as a retryable transport error.
	const dead = new HindsightClient({ baseUrl: "http://127.0.0.1:1", bankId: "g" });
	const deadStore = storeAt(database());
	const deadId = enqueue(deadStore, dead);
	const deadWorker = new MemoryQueueWorker(deadStore.memoryQueue, dead, Date.now, (o) =>
		outcomes.push({ ok: o.ok, transport: "transport" in o && o.transport }),
	);
	await deadWorker.tick();
	expect(outcomes).toEqual([{ ok: false, transport: true }]);
	expect(deadStore.memoryQueue.get(deadId)?.state).toBe("pending");

	// Live service: submit acknowledged — an advance, not an outage.
	let opId = "";
	const client = service(() =>
		Response.json({
			success: true,
			bank_id: "g",
			items_count: 1,
			async: true,
			operation_id: opId,
		}),
	);
	const store = storeAt(database());
	opId = enqueue(store, client);
	const worker = new MemoryQueueWorker(store.memoryQueue, client, Date.now, (o) =>
		outcomes.push({ ok: o.ok, transport: "transport" in o && o.transport }),
	);
	await worker.tick();
	expect(outcomes).toEqual([
		{ ok: false, transport: true },
		{ ok: true, transport: false },
	]);
});

test("excluding a topic purges only its pending rows", async () => {
	const client = service(() => Response.json({ results: [] }));
	const store = storeAt(database());
	const other = { ...doc, id: "exchange-2", conversationId: "dm:2" };
	const submittedId = store.memoryQueue.enqueue(client.target, {
		...doc,
		id: "exchange-submitted",
	});
	const submitted = store.memoryQueue.get(submittedId)!;
	store.memoryQueue.update(submitted, "submitted", 0, null);
	store.memoryQueue.enqueue(client.target, doc);
	store.memoryQueue.enqueue(client.target, other);
	expect(store.memoryQueue.cancelConversation("dm:1")).toBe(1);
	expect(store.memoryQueue.get(submittedId)?.state).toBe("submitted");
	expect(store.memoryQueue.next(client.target, Date.now())?.document.id).toBe("exchange-2");
});

test("pruned operations and permanent HTTP errors remain inspectable, not blindly replayed", async () => {
	let id = "";
	let responseMode = "submit";
	const client = service(() => {
		if (responseMode === "auth") return new Response("private upstream body", { status: 401 });
		if (responseMode === "missing") return Response.json({ operation_id: id, status: "not_found" });
		return Response.json({
			success: true,
			bank_id: "g",
			items_count: 1,
			async: true,
			operation_id: id,
		});
	});
	const store = storeAt(database());
	id = enqueue(store, client);
	let now = Date.now();
	const worker = new MemoryQueueWorker(store.memoryQueue, client, () => now);
	await worker.tick();
	responseMode = "missing";
	now += 5_000;
	await worker.tick();
	expect(store.memoryQueue.get(id)?.state).toBe("blocked");
	expect(store.memoryQueue.get(id)?.error).toContain("reconciliation");
	now += 5_000;
	expect(await worker.tick()).toBe(false);
	const second = { ...doc, id: "exchange-2" };
	const secondId = store.memoryQueue.enqueue(client.target, second);
	responseMode = "auth";
	await worker.tick();
	expect(store.memoryQueue.get(secondId)?.state).toBe("blocked");
	expect(store.memoryQueue.get(secondId)?.error).not.toContain("private");
});

test("cancelled work stays queued without incrementing retry state", async () => {
	let requests = 0;
	const client = service(() => {
		requests++;
		return Response.json({ results: [] });
	});
	const store = storeAt(database());
	const id = enqueue(store, client);
	const worker = new MemoryQueueWorker(store.memoryQueue, client);
	expect(await worker.tick(AbortSignal.abort())).toBe(false);
	expect(store.memoryQueue.get(id)?.attempts).toBe(0);
	expect(requests).toBe(0);
});

test("slow HTTP failures do not consume the backoff before it begins", async () => {
	let now = Date.now();
	let calls = 0;
	const client = service(() => {
		calls++;
		now += 30_000; // Advance the test clock while the request is in flight.
		return new Response("slow outage", { status: 503 });
	});
	const store = storeAt(database());
	const id = enqueue(store, client);
	const worker = new MemoryQueueWorker(store.memoryQueue, client, () => now);
	await worker.tick();
	expect(store.memoryQueue.get(id)?.next_attempt).toBe(now + 1_000);
	expect(await worker.tick()).toBe(false);
	expect(calls).toBe(1);
	now += 1_000;
	await worker.tick();
	expect(calls).toBe(2);
});

test("due pending submissions outrank polling older submitted operations", () => {
	const client = new HindsightClient({ baseUrl: "http://127.0.0.1:1", bankId: "g" });
	const store = storeAt(database());
	const firstId = store.memoryQueue.enqueue(client.target, doc);
	const first = store.memoryQueue.get(firstId);
	if (!first) throw new Error("expected queued memory");
	// Older rowid, acknowledged, due — its next step is a status poll.
	store.memoryQueue.update(first, "submitted", 0, null);
	const secondId = store.memoryQueue.enqueue(client.target, { ...doc, id: "exchange-2" });
	expect(store.memoryQueue.next(client.target, Date.now())?.operation_id).toBe(secondId);
});

// The 2026-09-25 incident: hand-requeuing by flipping state back to
// pending could never drain — the stale operation_id is a dead remote op
// server-side, so the replay just re-read its failed status. A retry
// must reach the wire as a brand-new operation.
test("retryBlocked mints a fresh operation id and the replay completes", async () => {
	let remoteStatus = "failed";
	const client = service(async (request) => {
		if (request.method === "POST") {
			const body = (await request.json()) as { operation_id?: unknown };
			const id = typeof body.operation_id === "string" ? body.operation_id : "";
			return Response.json({
				success: true,
				bank_id: "g",
				items_count: 1,
				async: true,
				operation_id: id,
			});
		}
		const id = new URL(request.url).pathname.split("/").pop() ?? "";
		return Response.json({ operation_id: id, status: remoteStatus });
	});
	const store = storeAt(database());
	const firstId = enqueue(store, client);
	let now = Date.now();
	const worker = new MemoryQueueWorker(store.memoryQueue, client, () => now);
	await worker.tick(); // submit acknowledged
	now += 5_000;
	await worker.tick(); // poll: remote says failed → blocked
	expect(store.memoryQueue.get(firstId)?.state).toBe("blocked");
	expect(store.memoryQueue.retryBlocked(client.target)).toBe(1);
	// In-place UPDATE under a new primary key: the old operation id is gone.
	expect(store.memoryQueue.get(firstId)).toBeNull();
	const requeued = store.memoryQueue.next(client.target, now);
	if (!requeued) throw new Error("expected requeued memory");
	expect(requeued.document.id).toBe(doc.id);
	expect(requeued.operation_id).not.toBe(firstId);
	expect(requeued.state).toBe("pending");
	expect(requeued.attempts).toBe(0);
	expect(requeued.next_attempt).toBe(0);
	await worker.tick(); // fresh submit under the new operation id
	now += 5_000;
	remoteStatus = "completed";
	await worker.tick(); // poll completes the new operation
	expect(store.memoryQueue.get(requeued.operation_id)?.state).toBe("completed");
	expect(store.memoryQueue.next(client.target, now + 5_000)).toBeNull();
});

test("dismissed rows stay for audit: never due, counted apart, forgotten with the document", () => {
	const client = new HindsightClient({ baseUrl: "http://127.0.0.1:1", bankId: "g" });
	const store = storeAt(database());
	store.memoryQueue.enqueue(client.target, doc);
	store.memoryQueue.enqueue(client.target, { ...doc, id: "exchange-2" });
	const first = store.memoryQueue.next(client.target, Date.now());
	if (!first) throw new Error("expected queued memory");
	store.memoryQueue.update(first, "blocked", 0, "Hindsight http failure (HTTP 401)");
	expect(store.memoryQueue.dismissBlocked(client.target)).toBe(1);
	expect(store.memoryQueue.counts(client.target)).toEqual({
		pending: 1,
		submitted: 0,
		completed: 0,
		blocked: 0,
		dismissed: 1,
		deleting: 0,
	});
	// Dismissed is a terminal operator verdict — next() never offers it again.
	expect(store.memoryQueue.next(client.target, Date.now())?.document.id).toBe("exchange-2");
	// /forget parks the dismissed row, then releases it once its bank
	// confirms — no dismissed row lingers after a completed forget.
	expect(store.memoryQueue.markDocumentDeleting(doc.id)).toBe(1);
	expect(store.memoryQueue.counts(client.target).deleting).toBe(1);
	expect(store.memoryQueue.confirmDeleted(doc.id, client.target)).toBe(1);
	expect(store.memoryQueue.counts(client.target).dismissed).toBe(0);
	expect(store.memoryQueue.counts(client.target).deleting).toBe(0);
});

test("parking a blocked document ends review surfaces but keeps the retry map", () => {
	const client = new HindsightClient({ baseUrl: "http://127.0.0.1:1", bankId: "g" });
	const store = storeAt(database());
	const id = store.memoryQueue.enqueue(client.target, doc);
	const item = store.memoryQueue.get(id);
	if (!item) throw new Error("expected queued memory");
	store.memoryQueue.update(
		item,
		"blocked",
		0,
		"operation missing; operator reconciliation required",
	);
	expect(store.memoryQueue.markDocumentDeleting(doc.id)).toBe(1);
	expect(store.memoryQueue.get(id)?.state).toBe("deleting");
	// Parked: never due, never re-offered as review or retry.
	expect(store.memoryQueue.next(client.target, Date.now())).toBeNull();
	expect(store.memoryQueue.blockedDetail(client.target)).toEqual([]);
	expect(store.memoryQueue.retryBlocked(client.target)).toBe(0);
	// Still the destination map a forget retry needs (#113).
	expect(store.memoryQueue.documentDestinations(doc.id)).toEqual([
		{ target: client.target, inflight: [] },
	]);
	expect(store.memoryQueue.confirmDeleted(doc.id, client.target)).toBe(1);
	expect(store.memoryQueue.get(id)).toBeNull();
	expect(store.memoryQueue.documentDestinations(doc.id)).toEqual([]);
});

test("noteBlocked latches once per document", () => {
	const store = storeAt(database());
	const queue = store.memoryQueue;
	expect(queue.noteBlocked("exchange/dm:1/1/a")).toBe(true);
	expect(queue.noteBlocked("exchange/dm:1/1/a")).toBe(false);
	expect(queue.noteBlocked("exchange/dm:1/1/a")).toBe(false); // still latched
	expect(queue.noteBlocked("exchange/dm:1/2/b")).toBe(true);
});

test("the one-notice latch survives a restart", () => {
	const path = database();
	expect(storeAt(path).memoryQueue.noteBlocked("exchange/dm:1/1/a")).toBe(true);
	// A fresh store over the same disk state = a process restart: the
	// operator must not be told twice about the same document.
	expect(storeAt(path).memoryQueue.noteBlocked("exchange/dm:1/1/a")).toBe(false);
});

test("blockedDetail abbreviates documents and caps errors for chat surfaces", () => {
	const client = new HindsightClient({ baseUrl: "http://127.0.0.1:1", bankId: "g" });
	const store = storeAt(database());
	const id = store.memoryQueue.enqueue(client.target, { ...doc, id: "exchange/dm:1/7/a7" });
	const item = store.memoryQueue.get(id);
	if (!item) throw new Error("expected queued memory");
	store.memoryQueue.update(item, "blocked", 0, "x".repeat(300));
	const detail = store.memoryQueue.blockedDetail(client.target);
	expect(detail).toHaveLength(1);
	expect(detail[0]?.document).toBe("a7"); // last path segment
	expect(detail[0]?.error?.length).toBe(120);
	expect(detail[0]?.attempts).toBe(1);
});

test("deletingCount spans every destination, separately from the current bank", () => {
	const current = new HindsightClient({ baseUrl: "http://127.0.0.1:1", bankId: "g" });
	const old = new HindsightClient({ baseUrl: "http://127.0.0.1:1", bankId: "previous" });
	const store = storeAt(database());
	store.memoryQueue.enqueue(current.target, { ...doc, id: "exchange-1" });
	store.memoryQueue.enqueue(old.target, { ...doc, id: "exchange-2" });
	expect(store.memoryQueue.deletingCount()).toBe(0);
	// A failed old-bank delete leaves its rows parked while the current
	// bank holds nothing parked — the per-target counts read zero.
	store.memoryQueue.markDocumentDeleting("exchange-2");
	expect(store.memoryQueue.counts(current.target).deleting).toBe(0);
	expect(store.memoryQueue.deletingCount()).toBe(1);
	store.memoryQueue.markDocumentDeleting("exchange-1");
	expect(store.memoryQueue.deletingCount()).toBe(2);
	store.memoryQueue.confirmDeleted("exchange-2", old.target);
	expect(store.memoryQueue.deletingCount()).toBe(1);
});

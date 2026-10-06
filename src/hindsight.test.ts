import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { HindsightClient, HindsightError, type MemoryDocument } from "./hindsight.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

function fake(handler: (request: Request) => Response | Promise<Response>): string {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
}

const document: MemoryDocument = {
	id: "exchange/one",
	content: "Operator: I prefer quiet notifications.\nGoblin: Understood.",
	conversationId: "topic:123:4",
	timestamp: "2026-09-22T10:00:00Z",
	sourceIds: ["message-1", "message-2"],
};

describe("Hindsight HTTP boundary", () => {
	test("recall is bounded and keeps fact identity, dates, and provenance", async () => {
		const requests: { path: string; auth: string | null; body: unknown }[] = [];
		const baseUrl = fake(async (request) => {
			requests.push({
				path: new URL(request.url).pathname,
				auth: request.headers.get("authorization"),
				body: await request.json(),
			});
			return Response.json({ results: [{
				id: "fact-1", text: "Quiet notifications preferred.",
				type: "world", document_id: document.id,
				occurred_start: document.timestamp,
				source_fact_ids: null,
				unused_new_field: true,
			}] });
		});
		const client = new HindsightClient({
			baseUrl, bankId: "my bank", auth: async () => "synthetic-test-credential",
		});
		const facts = await client.recall("notification preference", { maxTokens: 512 });
		expect(facts).toHaveLength(1);
		expect(facts[0]?.document_id).toBe(document.id);
		expect(facts[0]?.occurred_start).toBe(document.timestamp);
		expect(requests).toEqual([{
			path: "/v1/default/banks/my%20bank/memories/recall",
			auth: "Bearer synthetic-test-credential",
			body: { query: "notification preference", max_tokens: 512, budget: "low" },
		}]);
	});

	test("retention retries carry the same operation and document IDs; completion is separate", async () => {
		const operationId = randomUUID();
		const submissions: unknown[] = [];
		let status = "processing";
		const baseUrl = fake(async (request) => {
			if (request.method === "POST") {
				submissions.push(await request.json());
				return Response.json({
					success: true, bank_id: "goblin", items_count: 1,
					async: true, operation_id: operationId,
				});
			}
			expect(new URL(request.url).pathname).toEndWith(`/operations/${operationId}`);
			return Response.json({ operation_id: operationId, status });
		});
		const client = new HindsightClient({ baseUrl, bankId: "goblin" });
		await client.submit(document, operationId);
		await client.submit(document, operationId);
		expect(submissions[0]).toEqual(submissions[1]);
		expect(submissions[0]).toMatchObject({
			async: true, operation_id: operationId,
			items: [{
				document_id: document.id, update_mode: "replace", timestamp: document.timestamp,
				metadata: { conversation_id: document.conversationId, source_ids: JSON.stringify(document.sourceIds) },
			}],
		});
		expect((await client.operation(operationId))?.status).toBe("processing");
		status = "completed";
		expect((await client.operation(operationId))?.status).toBe("completed");
	});

	test("server cannot silently ignore retain operation identity or report success:false", async () => {
		for (const response of [
			{ success: false, bank_id: "g", items_count: 1, async: true },
			{ success: true, bank_id: "g", items_count: 1, async: false },
			{ success: true, bank_id: "g", items_count: 1, async: true, operation_id: randomUUID() },
		]) {
			const client = new HindsightClient({ bankId: "g", baseUrl: fake(() => Response.json(response)) });
			await expect(client.submit(document, randomUUID())).rejects.toMatchObject({ kind: "protocol" });
		}
	});

	test("only document/operation lookup and deletion accept missing records", async () => {
		const client = new HindsightClient({
			baseUrl: fake(() => new Response("missing", { status: 404 })), bankId: "g",
		});
		expect(await client.getDocument(document.id)).toBeNull();
		expect(await client.operation(randomUUID())).toBeNull();
		await client.deleteDocument(document.id);
		await expect(client.recall("query")).rejects.toMatchObject({ kind: "http", status: 404 });
		await expect(client.submit(document, randomUUID())).rejects.toMatchObject({ status: 404 });
	});

	test("operation lookup also accepts the API's HTTP 200 not_found status", async () => {
		const id = randomUUID();
		const client = new HindsightClient({
			bankId: "g",
			baseUrl: fake(() => Response.json({ operation_id: id, status: "not_found" })),
		});
		expect(await client.operation(id)).toBeNull();
	});

	test("document preview checks source identity and deletion requires confirmed success", async () => {
		let wrongId = false;
		let success = true;
		const baseUrl = fake((request) => {
			expect(new URL(request.url).pathname).toEndWith("/documents/exchange%2Fone");
			if (request.method === "DELETE") return Response.json({ success, document_id: document.id });
			return Response.json({
				id: wrongId ? "other" : document.id, bank_id: "g",
				original_text: document.content, created_at: document.timestamp,
				updated_at: document.timestamp, memory_unit_count: 2,
			});
		});
		const client = new HindsightClient({ baseUrl, bankId: "g" });
		expect((await client.getDocument(document.id))?.original_text).toBe(document.content);
		wrongId = true;
		await expect(client.getDocument(document.id)).rejects.toMatchObject({ kind: "protocol" });
		await client.deleteDocument(document.id);
		success = false;
		await expect(client.deleteDocument(document.id)).rejects.toMatchObject({ kind: "protocol" });
	});

	test("error classification never includes untrusted response bodies", async () => {
		for (const [status, retryable] of [[401, false], [422, false], [429, true], [503, true]] as const) {
			const client = new HindsightClient({
				baseUrl: fake(() => new Response("private upstream details", { status })), bankId: "g",
			});
			let failure: unknown;
			try { await client.recall("query"); } catch (err) { failure = err; }
			expect(failure).toBeInstanceOf(HindsightError);
			if (!(failure instanceof HindsightError)) throw new Error("expected classified error");
			expect(failure.retryable).toBe(retryable);
			expect(failure.message).not.toContain("private upstream");
		}
	});

	test("invalid, malformed, and oversized responses fail loudly", async () => {
		for (const response of [
			() => Response.json({ results: [{ text: "missing id" }] }),
			() => new Response("{invalid json"),
			() => new Response("x".repeat(1_048_577)),
		]) {
			const client = new HindsightClient({ baseUrl: fake(response), bankId: "g" });
			await expect(client.recall("query")).rejects.toMatchObject({ kind: "protocol" });
		}
	});

	test("deadline includes a stalled response body", async () => {
		const baseUrl = fake(() => new Response(new ReadableStream<Uint8Array>({
			start(controller) { controller.enqueue(new TextEncoder().encode('{"results":')); },
		})));
		const client = new HindsightClient({ baseUrl, bankId: "g", timeoutMs: 30 });
		await expect(client.recall("query")).rejects.toMatchObject({ kind: "timeout", retryable: true });
	});

	test("auth failure and auth timeout cannot leak command output or send a request", async () => {
		let calls = 0;
		const baseUrl = fake(() => {
			calls++;
			return Response.json({ results: [] });
		});
		const failed = new HindsightClient({
			baseUrl, bankId: "g", auth: async () => { throw new Error("private command output"); },
		});
		await expect(failed.recall("query")).rejects.toThrow("Hindsight auth failure");
		const stalled = new HindsightClient({
			baseUrl, bankId: "g", timeoutMs: 20, auth: () => new Promise<string>(() => {}),
		});
		await expect(stalled.recall("query")).rejects.toMatchObject({ kind: "timeout" });
		expect(calls).toBe(0);
	});

	test("already cancelled calls do not reach the server; caller cancellation is not retryable", async () => {
		let calls = 0;
		const client = new HindsightClient({
			bankId: "g", baseUrl: fake(() => { calls++; return Response.json({ results: [] }); }),
		});
		await expect(client.recall("query", { signal: AbortSignal.abort() }))
			.rejects.toMatchObject({ kind: "cancelled", retryable: false });
		expect(calls).toBe(0);
	});

	test("redirects are not followed, including credentials", async () => {
		let targetCalls = 0;
		const target = fake(() => { targetCalls++; return Response.json({ results: [] }); });
		const client = new HindsightClient({
			bankId: "g", baseUrl: fake(() => Response.redirect(target)),
			auth: async () => "synthetic-test-credential",
		});
		await expect(client.recall("query")).rejects.toMatchObject({ kind: "transport" });
		expect(targetCalls).toBe(0);
	});

	test("unsafe connection and unbounded request inputs are rejected before networking", async () => {
		for (const baseUrl of [
			"http://memory.example", "file:///tmp/db", "https://example.com?key=test",
			"https://user:synthetic@example.com", "https://example.com/#fragment",
			"not a URL", "https://user:synthetic@[invalid",
		]) {
			expect(() => new HindsightClient({ baseUrl, bankId: "g" })).toThrow("Invalid Hindsight");
		}
		const client = new HindsightClient({ baseUrl: "http://127.0.0.1:1", bankId: "g" });
		await expect(client.recall("x".repeat(8_001))).rejects.toThrow();
		await expect(client.recall("x", { maxTokens: 1_000_000 })).rejects.toThrow();
		await expect(client.submit(document, "not-a-uuid")).rejects.toThrow();
	});

	test("dot-segment identifiers cannot redirect a document or bank request", async () => {
		let calls = 0;
		const baseUrl = fake(() => { calls++; return Response.json({ results: [] }); });
		for (const id of [".", ".."]) {
			expect(() => new HindsightClient({ baseUrl, bankId: id })).toThrow("Invalid Hindsight");
			const client = new HindsightClient({ baseUrl, bankId: "g" });
			await expect(client.submit({ ...document, id }, randomUUID())).rejects.toThrow();
			await expect(client.getDocument(id)).rejects.toThrow();
			await expect(client.deleteDocument(id)).rejects.toThrow();
		}
		expect(calls).toBe(0);
	});
});

describe("memories browser list endpoints", () => {
	// Verbatim item shapes from the live 0.10.0-slim API (2026-09-30),
	// minus the fields the schema strips — the browser reads only what
	// it renders; the rest of the payload is server-owned detail.
	test("listDocuments sends the page query and reads the live envelope", async () => {
		const requests: URL[] = [];
		const baseUrl = fake((request) => {
			requests.push(new URL(request.url));
			return Response.json({
				items: [{
					id: "exchange/topic:889192981:547754/7/6206fa00",
					bank_id: "goblin",
					content_hash: "ef2a",
					created_at: "2026-09-30T01:14:46.511505+00:00",
					updated_at: "2026-09-30T01:14:46.511505+00:00",
					text_length: 2453,
					memory_unit_count: 3,
					retain_params: { context: "Telegram exchange.", metadata: {} },
					document_metadata: { source: "goblin", conversation_id: "topic:889192981:547754" },
					tags: [],
				}],
				total: 37,
				limit: 25,
				offset: 0,
			});
		});
		const client = new HindsightClient({ baseUrl, bankId: "goblin" });
		const page = await client.listDocuments({ q: "topic:889192981", limit: 25, offset: 0 });
		expect(page.total).toBe(37);
		expect(page.items).toHaveLength(1);
		expect(page.items[0]?.id).toBe("exchange/topic:889192981:547754/7/6206fa00");
		expect(page.items[0]?.memory_unit_count).toBe(3);
		expect(page.items[0]?.document_metadata?.conversation_id).toBe("topic:889192981:547754");
		expect(requests[0]?.pathname).toBe("/v1/default/banks/goblin/documents");
		expect(requests[0]?.searchParams.get("q")).toBe("topic:889192981");
		expect(requests[0]?.searchParams.get("limit")).toBe("25");
		expect(requests[0]?.searchParams.get("offset")).toBe("0");
	});

	test("listMemories filters by document and reads facts with curation state", async () => {
		const requests: URL[] = [];
		const baseUrl = fake((request) => {
			requests.push(new URL(request.url));
			return Response.json({
				items: [{
					id: "14badc40",
					text: "Fernando Cinta es el contador del usuario.",
					context: "Telegram exchange.",
					date: "2026-09-30T01:14:28.654000+00:00",
					fact_type: "world",
					document_id: "exchange/topic:1:2/7/abc",
					mentioned_at: "2026-09-30T01:14:28.654000+00:00",
					occurred_start: null,
					occurred_end: null,
					entities: "Fernando Cinta, user",
					chunk_id: "ignored",
					proof_count: 1,
					state: "valid",
					metadata: {},
				}],
				total: 1,
				limit: 200,
				offset: 0,
			});
		});
		const client = new HindsightClient({ baseUrl, bankId: "goblin" });
		const page = await client.listMemories({ documentId: "exchange/topic:1:2/7/abc", limit: 200, offset: 0 });
		expect(page.items[0]?.fact_type).toBe("world");
		expect(page.items[0]?.state).toBe("valid");
		expect(requests[0]?.searchParams.get("document_id")).toBe("exchange/topic:1:2/7/abc");
	});

	test("browse inputs are bounded and malformed envelopes fail loud", async () => {
		let served = 0;
		const baseUrl = fake(() => {
			served++;
			return Response.json({ items: [], total: 0, limit: 1, offset: 0 });
		});
		const client = new HindsightClient({ baseUrl, bankId: "goblin" });
		await expect(client.listDocuments({ q: "x".repeat(257), limit: 10, offset: 0 })).rejects.toThrow();
		await expect(client.listDocuments({ limit: 0, offset: 0 })).rejects.toThrow();
		await expect(client.listDocuments({ limit: 101, offset: 0 })).rejects.toThrow();
		await expect(client.listMemories({ documentId: ".", limit: 10, offset: 0 })).rejects.toThrow();
		expect(served).toBe(0);
		const broken = fake(() => Response.json({ items: "nope" }));
		const badClient = new HindsightClient({ baseUrl: broken, bankId: "goblin" });
		await expect(badClient.listDocuments({ limit: 10, offset: 0 })).rejects.toThrow(HindsightError);
	});
});

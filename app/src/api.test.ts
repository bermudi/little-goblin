import { afterEach, describe, expect, test } from "bun:test";
import type { ConfigPostBody } from "../../src/http/operator-wire.ts";
import {
	ApiError,
	forgetMemoryDocument,
	getConfig,
	getConversationConfig,
	getOperatorConfig,
	listMemoryDocuments,
	patchConfig,
	patchConversationConfig,
	saveOperatorConfig,
} from "./api.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("model setting scopes", () => {
	test("conversation controls address only that conversation, not app defaults", async () => {
		const requests: Request[] = [];
		globalThis.fetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				requests.push(new Request(new URL(String(input), "http://localhost"), init));
				return Response.json({
					model: "test/chat",
					thinking: "high",
					favorites: [],
					thinkingLevels: ["high"],
				});
			},
			{ preconnect: originalFetch.preconnect },
		);
		await getConversationConfig(null, "app/chat-1");
		const changed = await patchConversationConfig(null, "app/chat-1", {
			model: "test/chat",
			thinking: "high",
		});
		expect(requests.map((req) => [new URL(req.url).pathname, req.method])).toEqual([
			["/api/app/conversations/chat-1/config", "GET"],
			["/api/app/conversations/chat-1/config", "PATCH"],
		]);
		expect(await requests[1]!.json()).toEqual({ model: "test/chat", thinking: "high" });
		expect(changed.model).toBe("test/chat");
	});

	test("start-screen controls still address new-chat defaults", async () => {
		const requests: Request[] = [];
		globalThis.fetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				requests.push(new Request(new URL(String(input), "http://localhost"), init));
				return Response.json({
					model: "test/default",
					thinking: "low",
					favorites: [],
					thinkingLevels: ["low"],
				});
			},
			{ preconnect: originalFetch.preconnect },
		);
		await getConfig(null);
		await patchConfig(null, { model: "test/default" });
		expect(requests.map((req) => [new URL(req.url).pathname, req.method])).toEqual([
			["/api/app/config", "GET"],
			["/api/app/config", "POST"],
		]);
	});

	test("a rejected conversation save surfaces the server error", async () => {
		globalThis.fetch = Object.assign(
			async () => Response.json({ error: "unknown provider" }, { status: 422 }),
			{ preconnect: originalFetch.preconnect },
		);
		await expect(patchConversationConfig(null, "app/chat", { model: "missing/m" })).rejects.toThrow(
			"unknown provider",
		);
		await expect(getConversationConfig(null, "app/missing")).rejects.toBeInstanceOf(ApiError);
	});
});

describe("operator surface", () => {
	const fakeFetch = (handler: (req: Request) => Response | Promise<Response>) => {
		const requests: Request[] = [];
		globalThis.fetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				const req = new Request(new URL(String(input), "http://localhost"), init);
				requests.push(req);
				return handler(req);
			},
			{ preconnect: originalFetch.preconnect },
		);
		return requests;
	};

	test("the settings GET returns the response's etag alongside the body", async () => {
		fakeFetch(
			() =>
				new Response(
					JSON.stringify({ config: {}, providerKinds: [], searchKinds: [], fetchKinds: [] }),
					{
						status: 200,
						headers: { "content-type": "application/json", etag: '"v1"' },
					},
				),
		);
		const { data, etag } = await getOperatorConfig(null);
		expect(etag).toBe('"v1"');
		expect(data.providerKinds).toEqual([]);
	});

	test("the settings POST sends If-Match and returns the rotated etag", async () => {
		const requests = fakeFetch((req) => {
			expect(req.headers.get("if-match")).toBe('"v1"');
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json", etag: '"v2"' },
			});
		});
		const body: ConfigPostBody = {
			providers: {},
			model: "p/m",
			titleModel: "",
			favorites: [],
			thinking: "medium",
			tts: "",
			transcription: "",
			vision: "",
			search: "",
			fetch: "",
			allowedUsers: [1],
			telegram: { apiRoot: "", dmGapMinutes: 45 },
			publicUrl: "",
			http: { port: 8787 },
			memory: "",
			logLevel: "info",
		};
		const { etag } = await saveOperatorConfig("tok", body, '"v1"');
		expect(etag).toBe('"v2"');
		expect(new URL(requests[0]!.url).pathname).toBe("/api/app/settings");
		expect(requests[0]!.method).toBe("POST");
		expect(requests[0]!.headers.get("authorization")).toBe("Bearer tok");
	});

	test("memory documents take a query string; forget deletes", async () => {
		const requests = fakeFetch(() => Response.json({ items: [], total: 0, limit: 20, offset: 40 }));
		await listMemoryDocuments(null, { q: "weather", limit: 20, offset: 40 });
		const url = new URL(requests[0]!.url);
		expect(url.pathname).toBe("/api/app/memory/documents");
		expect(url.searchParams.get("q")).toBe("weather");
		expect(url.searchParams.get("offset")).toBe("40");

		const forgets = fakeFetch(() => Response.json({ ok: true, cancelled: 0, redacted: 1 }));
		const res = await forgetMemoryDocument(null, "doc-1");
		expect(res.ok).toBe(true);
		expect(forgets[0]!.method).toBe("DELETE");
		expect(new URL(forgets[0]!.url).pathname).toBe("/api/app/memory/documents/doc-1");
	});
});

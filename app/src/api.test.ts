import { afterEach, describe, expect, test } from "bun:test";
import { ApiError, getConfig, getConversationConfig, patchConfig, patchConversationConfig } from "./api.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("model setting scopes", () => {
	test("conversation controls address only that conversation, not app defaults", async () => {
		const requests: Request[] = [];
		globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
			requests.push(new Request(new URL(String(input), "http://localhost"), init));
			return Response.json({ model: "test/chat", thinking: "high", favorites: [], thinkingLevels: ["high"] });
		}, { preconnect: originalFetch.preconnect });
		await getConversationConfig(null, "app/chat-1");
		const changed = await patchConversationConfig(null, "app/chat-1", { model: "test/chat", thinking: "high" });
		expect(requests.map((req) => [new URL(req.url).pathname, req.method])).toEqual([
			["/api/app/conversations/chat-1/config", "GET"],
			["/api/app/conversations/chat-1/config", "PATCH"],
		]);
		expect(await requests[1]!.json()).toEqual({ model: "test/chat", thinking: "high" });
		expect(changed.model).toBe("test/chat");
	});

	test("start-screen controls still address new-chat defaults", async () => {
		const requests: Request[] = [];
		globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
			requests.push(new Request(new URL(String(input), "http://localhost"), init));
			return Response.json({ model: "test/default", thinking: "low", favorites: [], thinkingLevels: ["low"] });
		}, { preconnect: originalFetch.preconnect });
		await getConfig(null);
		await patchConfig(null, { model: "test/default" });
		expect(requests.map((req) => [new URL(req.url).pathname, req.method])).toEqual([
			["/api/app/config", "GET"],
			["/api/app/config", "POST"],
		]);
	});

	test("a rejected conversation save surfaces the server error", async () => {
		globalThis.fetch = Object.assign(async () => Response.json({ error: "unknown provider" }, { status: 422 }),
			{ preconnect: originalFetch.preconnect });
		await expect(patchConversationConfig(null, "app/chat", { model: "missing/m" }))
			.rejects.toThrow("unknown provider");
		await expect(getConversationConfig(null, "app/missing")).rejects.toBeInstanceOf(ApiError);
	});
});

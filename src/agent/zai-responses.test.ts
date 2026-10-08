// The shim's contract is z.ai's live wire — the SSE blocks below are
// verbatim captures from api.z.ai/api/v1/responses (glm-5.3-flash,
// reasoning.effort high, 2026-10-01), not invented fixtures. The
// end-to-end test feeds them through the real @ai-sdk/openai stream
// parser so a dialect change on either side fails loud.

import { describe, expect, test } from "bun:test";
import { createOpenAI } from "@ai-sdk/openai";
import { isZaiHost, zaiReasoningFetch } from "./zai-responses.ts";

// Verbatim z.ai SSE events (data payloads; event: lines elided in the
// capture but carried here as z.ai sends them).
const ZAI_STREAM =
	[
		`event: response.output_item.added\ndata: {"item":{"content":[],"id":"rs_resp_abc","status":"in_progress","summary":[],"type":"reasoning"},"output_index":0,"sequence_number":2,"type":"response.output_item.added"}`,
		`event: response.content_part.added\ndata: {"content_index":0,"item_id":"rs_resp_abc","output_index":0,"part":{"text":"","type":"reasoning_text"},"sequence_number":3,"type":"response.content_part.added"}`,
		`event: response.reasoning_text.delta\ndata: {"content_index":0,"delta":"s","item_id":"rs_resp_abc","output_index":0,"sequence_number":4,"type":"response.reasoning_text.delta"}`,
		`event: response.reasoning_text.delta\ndata: {"content_index":0,"delta":"omet","item_id":"rs_resp_abc","output_index":0,"sequence_number":5,"type":"response.reasoning_text.delta"}`,
		`event: response.reasoning_text.done\ndata: {"content_index":0,"item_id":"rs_resp_abc","output_index":0,"sequence_number":15,"text":"somet","type":"response.reasoning_text.done"}`,
		`event: response.content_part.done\ndata: {"content_index":0,"item_id":"rs_resp_abc","output_index":0,"part":{"text":"somet","type":"reasoning_text"},"sequence_number":16,"type":"response.content_part.done"}`,
		`event: response.output_item.done\ndata: {"item":{"content":[{"text":"somet","type":"reasoning_text"}],"encrypted_content":null,"id":"rs_resp_abc","status":"completed","summary":[],"type":"reasoning"},"output_index":0,"sequence_number":17,"type":"response.output_item.done"}`,
		`event: response.output_item.added\ndata: {"item":{"content":[],"id":"msg_resp_abc","role":"assistant","status":"in_progress","type":"message"},"output_index":1,"sequence_number":18,"type":"response.output_item.added"}`,
		`event: response.content_part.added\ndata: {"content_index":0,"item_id":"msg_resp_abc","output_index":1,"part":{"annotations":[],"text":"","type":"output_text"},"sequence_number":19,"type":"response.content_part.added"}`,
		`event: response.output_text.delta\ndata: {"content_index":0,"delta":"Hi","item_id":"msg_resp_abc","output_index":1,"sequence_number":20,"type":"response.output_text.delta"}`,
		`event: response.output_text.done\ndata: {"content_index":0,"item_id":"msg_resp_abc","output_index":1,"text":"Hi","type":"response.output_text.done"}`,
		`event: response.output_item.done\ndata: {"item":{"content":[{"text":"Hi","type":"output_text"}],"id":"msg_resp_abc","role":"assistant","status":"completed","type":"message"},"output_index":1,"sequence_number":21,"type":"response.output_item.done"}`,
		`event: response.completed\ndata: {"response":{"id":"resp_abc","model":"glm-5.3-flash","object":"response","status":"completed","usage":{"input_tokens":10,"output_tokens":20,"total_tokens":30}},"sequence_number":22,"type":"response.completed"}`,
		`data: [DONE]`,
	].join("\n\n") + "\n\n";

function sseResponse(body: string): Response {
	return new Response(new TextEncoder().encode(body), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("zaiReasoningFetch", () => {
	test("translates z.ai reasoning_text events to spec reasoning_summary events", async () => {
		const shim = zaiReasoningFetch(async () => sseResponse(ZAI_STREAM));
		const res = await shim("https://api.z.ai/api/v1/responses", {});
		const text = await res!.text();
		const dataTypes = [...text.matchAll(/data: ({.*})/g)].map(
			(m) => (JSON.parse(m[1]!) as { type: string }).type,
		);
		expect(dataTypes).toContain("response.reasoning_summary_text.delta");
		expect(dataTypes).toContain("response.reasoning_summary_part.added");
		expect(dataTypes).toContain("response.reasoning_summary_part.done");
		expect(dataTypes).not.toContain("response.reasoning_text.delta");
		expect(dataTypes).not.toContain("response.reasoning_text.done");
		// Untouched: message items, output_text, lifecycle, [DONE].
		expect(dataTypes).toContain("response.output_text.delta");
		expect(dataTypes).toContain("response.completed");
		expect(text).toContain("data: [DONE]");
	});

	test("content_index maps to summary_index", async () => {
		const shim = zaiReasoningFetch(async () => sseResponse(ZAI_STREAM));
		const res = await shim("https://api.z.ai/api/v1/responses", {});
		const text = await res!.text();
		const delta = text.match(/data: ({"type":"response\.reasoning_summary_text\.delta".*})/);
		const parsed = JSON.parse(delta![1]!) as Record<string, unknown>;
		expect(parsed.summary_index).toBe(0);
		expect(parsed.item_id).toBe("rs_resp_abc");
		expect(parsed.delta).toBe("s");
	});

	test("events split across byte boundaries still translate", async () => {
		const full = new TextEncoder().encode(ZAI_STREAM);
		// Chop mid-event: 7-byte chunks land inside JSON payloads.
		const chunks: Uint8Array[] = [];
		for (let i = 0; i < full.length; i += 7) chunks.push(full.slice(i, i + 7));
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				for (const c2 of chunks) c.enqueue(c2);
				c.close();
			},
		});
		const shim = zaiReasoningFetch(
			async () =>
				new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream; charset=utf-8" },
				}),
		);
		const res = await shim("https://api.z.ai/api/v1/responses", {});
		const text = await res!.text();
		expect(text).toContain("response.reasoning_summary_text.delta");
		expect(text).toContain('"delta":"omet"');
	});

	test("non-SSE responses pass through untouched", async () => {
		const body = JSON.stringify({ error: "nope" });
		const shim = zaiReasoningFetch(
			async () =>
				new Response(body, {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
		);
		const res = await shim("https://api.z.ai/api/v1/responses", {});
		expect(res!.status).toBe(400);
		expect(await res!.text()).toBe(body);
	});

	test("through the real SDK parser, reasoning text lands on parts", async () => {
		const model = createOpenAI({
			name: "zai",
			baseURL: "https://api.z.ai/api/v1",
			apiKey: "test",
			fetch: zaiReasoningFetch(async () => sseResponse(ZAI_STREAM)),
		}).responses("glm-5.3-flash");
		const { stream } = await model.doStream({
			prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
		});
		const parts: { type: string; delta?: string }[] = [];
		const reader = stream.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			parts.push(value as { type: string; delta?: string });
		}
		const reasoning = parts.filter((p) => p.type.startsWith("reasoning"));
		expect(reasoning.map((p) => p.type)).toEqual([
			"reasoning-start",
			"reasoning-delta",
			"reasoning-delta",
			"reasoning-end",
		]);
		expect(
			reasoning
				.filter((p) => p.type === "reasoning-delta")
				.map((p) => p.delta)
				.join(""),
		).toBe("somet");
		expect(
			parts
				.filter((p) => p.type === "text-delta")
				.map((p) => p.delta)
				.join(""),
		).toBe("Hi");
	});
});

describe("isZaiHost", () => {
	test("scopes the shim to api.z.ai", () => {
		expect(isZaiHost("https://api.z.ai/api/v1")).toBe(true);
		expect(isZaiHost("https://api.z.ai/api/coding/paas/v4")).toBe(true);
		expect(isZaiHost("https://api.openai.com/v1")).toBe(false);
		expect(isZaiHost("http://127.0.0.1:8799/v1")).toBe(false);
		expect(isZaiHost(undefined)).toBe(false);
		expect(isZaiHost("not a url")).toBe(false);
	});
});

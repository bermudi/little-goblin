// The codex model boundary: the request body must be a real
// responses-API shape — prompt conversion and effort placement are the
// contract this module exists for — and the SSE stream must map onto
// stream parts without ever passing a truncated answer off as complete.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexLanguageModel } from "./model.ts";

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (exp: number) => `${b64({ alg: "none" })}.${b64({ exp })}.sig`;

function authDir(tokens: Record<string, unknown>, extra: Record<string, unknown> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "goblin-codex-"));
	const path = join(dir, "auth.json");
	writeFileSync(path, JSON.stringify({ tokens, ...extra }));
	return path;
}

const FUTURE = Math.floor(Date.now() / 1000) + 3600;

describe("CodexLanguageModel — request shape", () => {
	function sse(frames: Record<string, unknown>[]): Response {
		const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
		return new Response(new TextEncoder().encode(body));
	}

	test("prompt converts to responses input; effort lands on reasoning.effort", async () => {
		const path = authDir({ access_token: jwt(FUTURE) });
		let sent: Record<string, unknown> = {};
		const model = new CodexLanguageModel("gpt-6-astra", path, async (_url, init) => {
			sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return sse([
				{
					type: "response.completed",
					response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 3 } } },
				},
			]);
		});
		const result = await model.doGenerate({
			prompt: [
				{ role: "system", content: "be terse" },
				{ role: "user", content: [{ type: "text", text: "hi" }] },
			],
			providerOptions: { codex: { reasoningEffort: "xhigh" } },
		});
		expect(sent.model).toBe("gpt-6-astra");
		expect(sent.instructions).toBe("be terse");
		expect(sent.store).toBe(false);
		expect(sent.stream).toBe(true);
		expect(sent.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
		const input = sent.input as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
		expect(input[0]!.role).toBe("user");
		expect(input[0]!.content[0]).toEqual({ type: "input_text", text: "hi" });
		expect(result.finishReason).toEqual({ unified: "stop", raw: "completed" });
		expect(result.usage.inputTokens.total).toBe(5);
		expect(result.usage.inputTokens.cacheRead).toBe(3);
	});

	test("the bare 'image' wildcard pins a concrete subtype in data URLs only", async () => {
		const path = authDir({ access_token: jwt(FUTURE) });
		let sent: Record<string, unknown> = {};
		const model = new CodexLanguageModel("gpt-6-astra", path, async (_url, init) => {
			sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return sse([
				{
					type: "response.completed",
					response: { status: "completed", usage: {} },
				},
			]);
		});
		await model.doGenerate({
			prompt: [
				{
					role: "user",
					content: [
						{
							type: "file",
							mediaType: "image",
							data: { type: "data", data: new Uint8Array([1, 2, 3]) },
						},
						{
							type: "file",
							mediaType: "image",
							data: { type: "url", url: new URL("https://example.com/x.png") },
						},
					],
				},
			],
		});
		const content = (sent.input as Array<{ content: Array<{ image_url: string }> }>)[0]!
			.content;
		// A data URL needs a concrete subtype — "data:image;base64" is
		// malformed. URL payloads ride through untouched.
		expect(content[0]!.image_url).toBe(
			`data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}`,
		);
		expect(content[1]!.image_url).toBe("https://example.com/x.png");
	});

	test("a tool result round-trips as function_call_output", async () => {
		const path = authDir({ access_token: jwt(FUTURE) });
		let sent: Record<string, unknown> = {};
		const model = new CodexLanguageModel("gpt-6-astra", path, async (_url, init) => {
			sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return sse([
				{
					type: "response.completed",
					response: { status: "completed", usage: {} },
				},
			]);
		});
		await model.doGenerate({
			prompt: [
				{ role: "user", content: [{ type: "text", text: "run ls" }] },
				{
					role: "assistant",
					content: [
						{ type: "tool-call", toolCallId: "call_1", toolName: "bash", input: '{"command":"ls"}' },
					],
				},
				{
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: "call_1",
							toolName: "bash",
							output: { type: "text", value: "file.txt" },
						},
					],
				},
			],
		});
		const input = sent.input as Array<Record<string, unknown>>;
		expect(input[1]).toMatchObject({ type: "function_call", call_id: "call_1", name: "bash" });
		expect(input[2]).toEqual({
			type: "function_call_output",
			call_id: "call_1",
			output: "file.txt",
		});
	});

	test("stream events map to parts — deltas, done-item fallback, tool calls", async () => {
		const path = authDir({ access_token: jwt(FUTURE) });
		const model = new CodexLanguageModel("gpt-6-astra", path, async () =>
			sse([
				{ type: "response.output_item.added", item: { type: "reasoning", id: "r1" } },
				{ type: "response.reasoning_summary_text.delta", delta: "thinking…" },
				// A message that arrives only in done — no added/delta stream —
				// must still emit its content, not vanish.
				{
					type: "response.output_item.done",
					item: {
						type: "message",
						id: "m1",
						content: [{ type: "output_text", text: "the answer" }],
					},
				},
				{
					type: "response.output_item.done",
					item: {
						type: "function_call",
						id: "f1",
						call_id: "call_1",
						name: "bash",
						arguments: "{}",
					},
				},
				{ type: "response.completed", response: { status: "completed", usage: {} } },
			]),
		);
		const r = await model.doGenerate({
			prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }],
		});
		expect(r.finishReason).toEqual({ unified: "tool-calls", raw: "completed" });
		expect(r.content.map((c) => c.type)).toEqual(["reasoning", "text", "tool-call"]);
		expect((r.content[0] as { text: string }).text).toBe("thinking…");
		expect((r.content[1] as { text: string }).text).toBe("the answer");
	});

	test("a truncated stream with partial text never counts as a completed answer", async () => {
		const path = authDir({ access_token: jwt(FUTURE) });
		const model = new CodexLanguageModel("gpt-6-astra", path, async () =>
			sse([
				{ type: "response.output_item.added", item: { type: "message", id: "m1" } },
				{ type: "response.output_text.delta", delta: "partial" },
			]),
		);
		await expect(model.doGenerate({ prompt: [] })).rejects.toThrow("before a terminal response");
	});
});

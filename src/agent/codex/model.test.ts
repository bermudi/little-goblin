// The codex model boundary: the request body must be a real
// responses-API shape — prompt conversion and effort placement are the
// contract this module exists for — and the SSE stream must map onto
// stream parts without ever passing a truncated answer off as complete.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JSONObject, LanguageModelV4Prompt } from "@ai-sdk/provider";
import { convertToModelMessages, stepCountIs, streamText, tool, type UIMessage } from "ai";
import { z } from "zod";
import { openStore } from "../../conversation.ts";
import { tmpDb, tmpDir } from "../../testkit.ts";
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
					response: {
						status: "completed",
						usage: {
							input_tokens: 5,
							output_tokens: 3,
							total_tokens: 8,
							input_tokens_details: { cached_tokens: 3 },
						},
					},
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
		const input = sent.input as Array<{
			role: string;
			content: Array<{ type: string; text: string }>;
		}>;
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
		const content = (sent.input as Array<{ content: Array<{ image_url: string }> }>)[0]!.content;
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
						{
							type: "tool-call",
							toolCallId: "call_1",
							toolName: "bash",
							input: '{"command":"ls"}',
						},
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

	test("tool-call input rides as JSON text when the SDK hands it parsed", async () => {
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
		// The real history boundary: a UIMessage tool part carries the
		// parsed input, and convertToModelMessages keeps it an object.
		const ui: UIMessage[] = [
			{ id: "u1", role: "user", parts: [{ type: "text", text: "run ls" }] },
			{
				id: "a1",
				role: "assistant",
				parts: [
					{
						type: "tool-bash",
						toolCallId: "call_1",
						state: "output-available",
						input: { command: "ls" },
						output: "file.txt",
					},
				],
			},
		];
		// Ride the SDK's own prompt conversion — the same path a turn takes.
		const result = streamText({
			model,
			messages: await convertToModelMessages(ui),
			maxRetries: 0,
		});
		await result.text;
		const input = sent.input as Array<Record<string, unknown>>;
		// Responses rejects an object here with HTTP 400 invalid_type.
		expect(input[1]).toEqual({
			type: "function_call",
			call_id: "call_1",
			name: "bash",
			arguments: '{"command":"ls"}',
		});
	});

	test("assistant text before a tool call survives as its own message", async () => {
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
						{ type: "text", text: "checking" },
						{
							type: "tool-call",
							toolCallId: "call_1",
							toolName: "bash",
							input: '{"command":"ls"}',
						},
					],
				},
			],
		});
		const input = sent.input as Array<Record<string, unknown>>;
		expect(input[1]).toEqual({
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text: "checking" }],
		});
		expect(input[2]).toMatchObject({ type: "function_call", call_id: "call_1" });
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

	test("a complete final frame without its terminating blank line still dispatches", async () => {
		const path = authDir({ access_token: jwt(FUTURE) });
		const model = new CodexLanguageModel("gpt-6-astra", path, async () => {
			// The completed frame's last byte is EOF — no trailing blank
			// line. A proxy trimming the final separator must not kill a
			// turn whose whole answer is on the wire.
			const body = [
				`data: ${JSON.stringify({
					type: "response.output_item.added",
					item: { type: "message", id: "m1" },
				})}\n\n`,
				`data: ${JSON.stringify({
					type: "response.output_text.delta",
					delta: "the answer",
				})}\n\n`,
				`data: ${JSON.stringify({
					type: "response.completed",
					response: { status: "completed", usage: {} },
				})}`,
			].join("");
			return new Response(new TextEncoder().encode(body));
		});
		const r = await model.doGenerate({
			prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }],
		});
		expect(r.finishReason).toEqual({ unified: "stop", raw: "completed" });
		expect(r.content).toEqual([
			{
				type: "text",
				text: "the answer",
				providerMetadata: {
					codex: { itemId: "m1", replayScope: expect.any(String) },
				},
			},
		]);
	});

	test("a connection cut mid-frame still fails as an ended stream, not a parse error", async () => {
		const path = authDir({ access_token: jwt(FUTURE) });
		const model = new CodexLanguageModel(
			"gpt-6-astra",
			path,
			async () => new Response(new TextEncoder().encode(`data: {"type":"response.compl`)),
		);
		await expect(model.doGenerate({ prompt: [] })).rejects.toThrow("before a terminal response");
	});
});

// ---------- reasoning retention ----------
//
// Opaque reasoning state rides providerMetadata under the `codex`
// namespace and replays only to the same model+account scope. The wire
// fixtures here are source-derived — they are NOT live-verified against
// the Codex backend.

describe("CodexLanguageModel — reasoning retention", () => {
	function sse(frames: Record<string, unknown>[]): Response {
		const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
		return new Response(new TextEncoder().encode(body));
	}

	const completed = () => ({
		type: "response.completed",
		response: { status: "completed", usage: {} },
	});

	test("the tool-step request replays the reasoning item before the call and its result", async () => {
		const path = authDir({ access_token: jwt(FUTURE), account_id: "acct-1" });
		const sent: Record<string, unknown>[] = [];
		const model = new CodexLanguageModel("gpt-6-astra", path, async (_url, init) => {
			sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			if (sent.length === 1) {
				return sse([
					{ type: "response.output_item.added", item: { type: "reasoning", id: "rs_1" } },
					{ type: "response.reasoning_summary_text.delta", delta: "checking" },
					{
						type: "response.output_item.done",
						item: {
							type: "reasoning",
							id: "rs_1",
							summary: [{ type: "summary_text", text: "checking" }],
							encrypted_content: "CIPHER-1",
						},
					},
					{
						type: "response.output_item.done",
						item: {
							type: "function_call",
							id: "fc_1",
							call_id: "call_1",
							name: "probe",
							arguments: "{}",
						},
					},
					completed(),
				]);
			}
			return sse([
				{ type: "response.output_item.added", item: { type: "message", id: "m_1" } },
				{ type: "response.output_text.delta", delta: "done" },
				completed(),
			]);
		});
		const result = streamText({
			model,
			messages: [{ role: "user", content: "run it" }],
			tools: {
				probe: tool({
					inputSchema: z.object({}),
					execute: async () => "probe-result",
				}),
			},
			stopWhen: stepCountIs(2),
			maxRetries: 0,
		});
		expect(await result.text).toBe("done");
		expect(sent.length).toBe(2);
		const input = sent[1]!.input as Array<Record<string, unknown>>;
		const types = input.map((i) => i.type);
		// The reasoning item leads the step's own output, ahead of the
		// call it reasoned toward and that call's result.
		expect(types).toEqual([
			"message",
			"reasoning",
			"function_call",
			"function_call_output",
		]);
		expect(input[1]).toEqual({
			type: "reasoning",
			id: "rs_1",
			encrypted_content: "CIPHER-1",
			summary: [{ type: "summary_text", text: "checking" }],
		});
		expect(input[2]).toMatchObject({
			type: "function_call",
			id: "fc_1",
			call_id: "call_1",
			name: "probe",
		});
	});

	test("an empty-summary reasoning part still replays its cipher", async () => {
		const path = authDir({ access_token: jwt(FUTURE), account_id: "acct-1" });
		const sent: Record<string, unknown>[] = [];
		const model = new CodexLanguageModel("gpt-6-astra", path, async (_url, init) => {
			sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return sse([
				{
					type: "response.output_item.done",
					item: {
						type: "reasoning",
						id: "rs_silent",
						summary: [],
						encrypted_content: "CIPHER-SILENT",
					},
				},
				completed(),
			]);
		});
		// First step: no deltas at all — the done-only reasoning item
		// still produces a part carrying the encrypted state.
		const first = await model.doGenerate({
			prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }],
		});
		expect(first.content).toHaveLength(1);
		const reasoning = first.content[0]!;
		expect(reasoning.type).toBe("reasoning");
		expect((reasoning as { text: string }).text).toBe("");
		const meta = reasoning.providerMetadata?.codex;
		expect(meta?.reasoningEncryptedContent).toBe("CIPHER-SILENT");
		expect(meta?.itemId).toBe("rs_silent");
		// Second step: the silent part replays with an empty summary —
		// never a summary text guessed from nothing.
		await model.doGenerate({
			prompt: [
				{ role: "user", content: [{ type: "text", text: "x" }] },
				{
					role: "assistant",
					content: [{ type: "reasoning", text: "", providerOptions: { codex: meta! } }],
				},
			],
		});
		const input = sent[1]!.input as Array<Record<string, unknown>>;
		expect(input[1]).toEqual({
			type: "reasoning",
			id: "rs_silent",
			encrypted_content: "CIPHER-SILENT",
			summary: [],
		});
	});

	test("doGenerate keeps interleaved reasoning/text/tool order and per-item metadata", async () => {
		const path = authDir({ access_token: jwt(FUTURE), account_id: "acct-1" });
		const model = new CodexLanguageModel("gpt-6-astra", path, async () =>
			sse([
				{ type: "response.output_item.added", item: { type: "reasoning", id: "rs_a" } },
				{ type: "response.reasoning_summary_text.delta", delta: "plan" },
				{
					type: "response.output_item.done",
					item: {
						type: "reasoning",
						id: "rs_a",
						summary: [{ type: "summary_text", text: "plan" }],
						encrypted_content: "CA",
					},
				},
				{
					type: "response.output_item.added",
					item: { type: "message", id: "m_a", phase: "commentary" },
				},
				{ type: "response.output_text.delta", delta: "first" },
				{
					type: "response.output_item.done",
					item: {
						type: "message",
						id: "m_a",
						phase: "commentary",
						content: [{ type: "output_text", text: "first" }],
					},
				},
				{
					type: "response.output_item.done",
					item: { type: "function_call", id: "fc_a", call_id: "call_1", name: "probe", arguments: "{}" },
				},
				{
					type: "response.output_item.done",
					item: { type: "reasoning", id: "rs_b", summary: [], encrypted_content: "CB" },
				},
				{
					type: "response.output_item.done",
					item: {
						type: "message",
						id: "m_b",
						phase: "final_answer",
						content: [{ type: "output_text", text: "last" }],
					},
				},
				completed(),
			]),
		);
		const r = await model.doGenerate({
			prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }],
		});
		expect(r.content.map((c) => c.type)).toEqual([
			"reasoning",
			"text",
			"tool-call",
			"reasoning",
			"text",
		]);
		const metaOf = (i: number) =>
			(r.content[i] as { providerMetadata?: { codex?: Record<string, unknown> } })
				.providerMetadata?.codex;
		expect(metaOf(0)).toMatchObject({
			itemId: "rs_a",
			reasoningEncryptedContent: "CA",
		});
		expect(metaOf(1)).toMatchObject({ itemId: "m_a", phase: "commentary" });
		expect(metaOf(2)).toMatchObject({ itemId: "fc_a" });
		expect(metaOf(3)).toMatchObject({ itemId: "rs_b", reasoningEncryptedContent: "CB" });
		expect(metaOf(4)).toMatchObject({ itemId: "m_b", phase: "final_answer" });
		expect((r.content[3] as { text: string }).text).toBe("");
	});

	test("a durable event round-trip keeps cipher and phase into the next request", async () => {
		const path = authDir({ access_token: jwt(FUTURE), account_id: "acct-1" });
		const sent: Record<string, unknown>[] = [];
		const model = new CodexLanguageModel("gpt-6-astra", path, async (_url, init) => {
			sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return sse([completed()]);
		});
		// What a finished turn stores: SDK-shaped UI parts with codex
		// providerMetadata — built from one live emission so the scope
		// the model stamps is the scope the replay needs.
		const emitter = new CodexLanguageModel("gpt-6-astra", path, async () =>
			sse([
				{
					type: "response.output_item.done",
					item: {
						type: "reasoning",
						id: "rs_d",
						summary: [{ type: "summary_text", text: "weighed it" }],
						encrypted_content: "CD",
					},
				},
				{
					type: "response.output_item.done",
					item: {
						type: "message",
						id: "m_d",
						phase: "final_answer",
						content: [{ type: "output_text", text: "answer" }],
					},
				},
				completed(),
			]),
		);
		const emitted = await emitter.doGenerate({
			prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }],
		});
		const stored: UIMessage = {
			id: "a1",
			role: "assistant",
			parts: emitted.content.map((c) => {
				const part = c as { type: string; text?: string; providerMetadata?: unknown };
				return {
					type: part.type,
					text: part.text,
					providerMetadata: part.providerMetadata,
				} as UIMessage["parts"][number];
			}),
		};
		const dbPath = tmpDb("goblin-codex-");
		const store = openStore(dbPath);
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		store.append(conv.id, [stored]);
		store.close();
		// Close and reopen — the disk row is the only thing that survives.
		const reopened = openStore(dbPath);
		const history = reopened.history(conv.id);
		reopened.close();
		const modelMessages = await convertToModelMessages(history);
		await model.doGenerate({
			prompt: [
				{ role: "user", content: [{ type: "text", text: "next question" }] },
				...(modelMessages as LanguageModelV4Prompt),
			],
		});
		const input = sent[0]!.input as Array<Record<string, unknown>>;
		expect(input[0]).toMatchObject({ type: "message", role: "user" });
		const reasoning = input.find((i) => i.type === "reasoning");
		expect(reasoning).toEqual({
			type: "reasoning",
			id: "rs_d",
			encrypted_content: "CD",
			summary: [{ type: "summary_text", text: "weighed it" }],
		});
		const replayedMsg = input.find(
			(i) => i.type === "message" && (i as { role?: string }).role === "assistant",
		);
		expect(replayedMsg).toMatchObject({ id: "m_d", phase: "final_answer" });
		expect(replayedMsg).not.toHaveProperty("encrypted_content");
	});

	test("a different model or account drops the opaque state — visible content stays", async () => {
		const path = authDir({ access_token: jwt(FUTURE), account_id: "acct-1" });
		const sent: Record<string, unknown>[] = [];
		// A different modelId rejects replay for its own scope; the
		// sibling auth file's different account does the same.
		const otherModel = new CodexLanguageModel("gpt-6-other", path, async (_url, init) => {
			sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return sse([completed()]);
		});
		const otherPath = authDir({ access_token: jwt(FUTURE), account_id: "acct-2" });
		const otherAccount = new CodexLanguageModel("gpt-6-astra", otherPath, async (_url, init) => {
			sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return sse([completed()]);
		});
		const emitter = new CodexLanguageModel("gpt-6-astra", path, async () =>
			sse([
				{
					type: "response.output_item.done",
					item: { type: "reasoning", id: "rs_x", summary: [], encrypted_content: "CX" },
				},
				completed(),
			]),
		);
		const emitted = await emitter.doGenerate({
			prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }],
		});
		const meta = emitted.content[0]!.providerMetadata!.codex;
		const prompt: LanguageModelV4Prompt = [
			{ role: "user" as const, content: [{ type: "text" as const, text: "q" }] },
			{
				role: "assistant" as const,
				content: [
					{
						type: "reasoning" as const,
						text: "summary",
						providerOptions: { codex: meta! },
					},
					{
						type: "text" as const,
						text: "visible",
						providerOptions: {
							codex: { ...meta, itemId: "m_x", phase: "commentary" },
						},
					},
					{
						type: "tool-call" as const,
						toolCallId: "call_1",
						toolName: "probe",
						input: "{}",
						providerOptions: { codex: { ...meta, itemId: "fc_x" } },
					},
				],
			},
			{
				role: "tool" as const,
				content: [
					{
						type: "tool-result" as const,
						toolCallId: "call_1",
						toolName: "probe",
						output: { type: "text" as const, value: "out" },
					},
				],
			},
		];
		for (const other of [otherModel, otherAccount]) {
			const r = await other.doGenerate({ prompt });
			const input = sent[sent.length - 1]!.input as Array<Record<string, unknown>>;
			// No cipher replay, no item ids — but the transcript and the
			// call still ship.
			expect(input.some((i) => i.type === "reasoning")).toBe(false);
			const msg = input.find(
				(i) => i.type === "message" && (i as { role?: string }).role === "assistant",
			) as { id?: string; content: unknown[] };
			expect(msg.id).toBeUndefined();
			expect((msg.content as { text: string }[]).map((p) => p.text).join("")).toContain(
				"visible",
			);
			const call = input.find((i) => i.type === "function_call")!;
			expect(call.call_id).toBe("call_1");
			expect(call.id).toBeUndefined();
			expect(
				r.warnings.filter((w) => w.type === "other" && w.message.includes("scope"))
					.length,
			).toBeGreaterThan(0);
		}
	});

	test("a wire reasoning item with no id replays cipher without fabricating one", async () => {
		const path = authDir({ access_token: jwt(FUTURE), account_id: "acct-1" });
		const sent: Record<string, unknown>[] = [];
		const model = new CodexLanguageModel("gpt-6-astra", path, async (_url, init) => {
			sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return sse([
				{
					// No `id` on the wire item — the adapter stamps scope and
					// cipher but must not invent an item id to send back.
					type: "response.output_item.done",
					item: {
						type: "reasoning",
						summary: [],
						encrypted_content: "C-NOID",
					},
				},
				completed(),
			]);
		});
		const first = await model.doGenerate({
			prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }],
		});
		const meta = (
			first.content[0] as unknown as { providerMetadata?: { codex: JSONObject } }
		).providerMetadata!.codex;
		expect(meta.itemId).toBeUndefined();
		expect(meta.replayScope).toBeDefined();
		await model.doGenerate({
			prompt: [
				{ role: "user", content: [{ type: "text", text: "x" }] },
				{
					role: "assistant",
					content: [{ type: "reasoning", text: "", providerOptions: { codex: meta } }],
				},
			],
		});
		const input = sent[1]!.input as Array<Record<string, unknown>>;
		expect(input[1]).toEqual({
			type: "reasoning",
			encrypted_content: "C-NOID",
			summary: [],
		});
		expect("id" in input[1]!).toBe(false);
	});

	test("foreign-namespace reasoning never replays, malformed state never forms an item", async () => {
		const path = authDir({ access_token: jwt(FUTURE), account_id: "acct-1" });
		const sent: Record<string, unknown>[] = [];
		const model = new CodexLanguageModel("gpt-6-astra", path, async (_url, init) => {
			sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return sse([completed()]);
		});
		const emitter = new CodexLanguageModel("gpt-6-astra", path, async () =>
			sse([
				{
					type: "response.output_item.done",
					item: { type: "reasoning", id: "rs_f", summary: [], encrypted_content: "CF" },
				},
				completed(),
			]),
		);
		const emitted = await emitter.doGenerate({
			prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }],
		});
		const codex = emitted.content[0]!.providerMetadata!.codex!;
		const replayScope = codex.replayScope;
		const result = await model.doGenerate({
			prompt: [
				{ role: "user", content: [{ type: "text", text: "q" }] },
				{
					role: "assistant",
					content: [
						// A foreign provider's namespace is not ours to replay.
						{
							type: "reasoning",
							text: "foreign",
							providerOptions: {
								openai: { itemId: "rs_o", reasoningEncryptedContent: "FOREIGN" },
							},
						},
						// Malformed codex state: itemId is not a string.
						{
							type: "reasoning",
							text: "broken",
							providerOptions: {
								codex: { itemId: 42, replayScope, reasoningEncryptedContent: "C" },
							},
						},
						// In-scope but cipherless — a bare summary is not a
						// replayable item.
						{
							type: "reasoning",
							text: "cipherless",
							providerOptions: { codex: { itemId: "rs_c", replayScope } },
						},
					],
				},
			],
		});
		const input = sent[0]!.input as Array<Record<string, unknown>>;
		expect(input.some((i) => i.type === "reasoning")).toBe(false);
		expect(JSON.stringify(input)).not.toContain("FOREIGN");
		expect(result.warnings.filter((w) => w.type === "other").length).toBe(3);
	});
});

// ---------- session affinity & receipts ----------
//
// session-id/thread-id/prompt_cache_key pin the backend's cache
// affinity; x-codex-turn-state is captured once per instance and echoed
// unchanged; quota receipts land on the finish part.

import { createHash } from "node:crypto";
import { codexSessionId } from "./session.ts";
import { quotaFromMetadata } from "./receipts.ts";
import { setLogFile, setLogWriter } from "../../log.ts";

describe("codexSessionId", () => {
	test("deterministic, UUID-shaped, conversation-scoped, never the raw id", () => {
		const a = codexSessionId("dm:1");
		expect(a).toBe(codexSessionId("dm:1"));
		expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(a).not.toBe(codexSessionId("dm:2"));
		expect(a).not.toContain("dm:1");
		expect(createHash("sha256").update("goblin-codex-session:dm:1").digest("hex")).toContain(
			a.replaceAll("-", "").slice(0, 20),
		);
	});
});

describe("CodexLanguageModel — session affinity", () => {
	const done = () => ({
		type: "response.completed",
		response: { status: "completed", usage: {} },
	});
	const sse = (frames: Record<string, unknown>[]) =>
		new Response(
			new TextEncoder().encode(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("")),
		);

	test("sessionId lands on headers and prompt_cache_key; absent opts send none", async () => {
		const path = authDir({ access_token: jwt(FUTURE), account_id: "acct-1" });
		const heads: Record<string, string>[] = [];
		const bodies: Record<string, unknown>[] = [];
		const withSession = new CodexLanguageModel(
			"gpt-6-astra",
			path,
			async (_url, init) => {
				const h: Record<string, string> = {};
				new Headers(init?.headers).forEach((v, k) => (h[k] = v));
				heads.push(h);
				bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
				return sse([done()]);
			},
			{ sessionId: "sess-1", subagent: "compact" },
		);
		const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "x" }] }];
		await withSession.doGenerate({ prompt });
		expect(heads[0]!["session-id"]).toBe("sess-1");
		expect(heads[0]!["thread-id"]).toBe("sess-1");
		expect(heads[0]!["x-openai-subagent"]).toBe("compact");
		expect(bodies[0]!.prompt_cache_key).toBe("sess-1");

		const bare = new CodexLanguageModel("gpt-6-astra", path, async (_url, init) => {
			const h: Record<string, string> = {};
			new Headers(init?.headers).forEach((v, k) => (h[k] = v));
			heads.push(h);
			bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return sse([done()]);
		});
		await bare.doGenerate({ prompt });
		const h2 = heads[1]!;
		expect(h2["session-id"]).toBeUndefined();
		expect(h2["thread-id"]).toBeUndefined();
		expect(h2["x-openai-subagent"]).toBeUndefined();
		expect(bodies[1]!.prompt_cache_key).toBeUndefined();
		expect(h2["x-codex-turn-state"]).toBeUndefined();
	});

	test("first turn-state wins per instance; a new instance starts blank", async () => {
		const path = authDir({ access_token: jwt(FUTURE), account_id: "acct-1" });
		const lines: string[] = [];
		setLogFile(join(tmpDir("goblin-codex-log-"), "log.jsonl"));
		setLogWriter((_p, l) => lines.push(l));
		try {
			const heads: Record<string, string>[] = [];
			let call = 0;
			const model = new CodexLanguageModel("gpt-6-astra", path, async (_url, init) => {
				const h: Record<string, string> = {};
				new Headers(init?.headers).forEach((v, k) => (h[k] = v));
				heads.push(h);
				call++;
				return new Response(
					new TextEncoder().encode(
						`data: ${JSON.stringify({
							type: "response.completed",
							response: { status: "completed", usage: {} },
						})}\n\n`,
					),
					{ headers: { "x-codex-turn-state": `ts-${call}` } },
				);
			});
			const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "x" }] }];
			await model.doGenerate({ prompt });
			await model.doGenerate({ prompt });
			await model.doGenerate({ prompt });
			expect(heads[0]!["x-codex-turn-state"]).toBeUndefined();
			expect(heads[1]!["x-codex-turn-state"]).toBe("ts-1");
			expect(heads[2]!["x-codex-turn-state"]).toBe("ts-1");
			// New instance — never leaks across turns.
			const fresh = new CodexLanguageModel("gpt-6-astra", path, async (_url, init) => {
				const h: Record<string, string> = {};
				new Headers(init?.headers).forEach((v, k) => (h[k] = v));
				heads.push(h);
				return sse([done()]);
			});
			await fresh.doGenerate({ prompt });
			expect(heads[3]!["x-codex-turn-state"]).toBeUndefined();
			// The value itself never lands in the log — only the boolean.
			expect(lines.some((l) => l.includes("ts-1"))).toBe(false);
			expect(lines.some((l) => l.includes("turnStateHeld"))).toBe(true);
		} finally {
			setLogWriter(null);
			setLogFile(null);
		}
	});
});

describe("CodexLanguageModel — receipts", () => {
	const done = () => ({
		type: "response.completed",
		response: { status: "completed", usage: {} },
	});
	const sse = (frames: Record<string, unknown>[]) =>
		new Response(
			new TextEncoder().encode(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("")),
		);
	const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "x" }] }];

	test("header quota, request id, and served model land on the finish part", async () => {
		const path = authDir({ access_token: jwt(FUTURE), account_id: "acct-1" });
		const model = new CodexLanguageModel(
			"gpt-6-astra",
			path,
			async () =>
				new Response(
					new TextEncoder().encode(`data: ${JSON.stringify(done())}\n\n`),
					{
						headers: {
							"x-codex-primary-used-percent": "42.5",
							"x-codex-primary-window-minutes": "300",
							"x-codex-primary-reset-at": "1730000000",
							"x-codex-secondary-used-percent": "7",
							"x-codex-secondary-window-minutes": "10080",
							"x-codex-limit-name": "codex",
							"x-request-id": "req-1",
							"openai-model": "gpt-6.1-sol",
						},
					},
				),
		);
		const parts: { type: string }[] = [];
		const stream = (await model.doStream({ prompt })).stream;
		const reader = stream.getReader();
		let finishMeta: unknown;
		for (;;) {
			const { done: d, value } = await reader.read();
			if (d) break;
			parts.push(value);
			if (value.type === "finish") finishMeta = value.providerMetadata;
		}
		expect(parts.some((p) => p.type === "response-metadata")).toBe(true);
		const respMeta = parts.find((p) => p.type === "response-metadata") as unknown as {
			id?: string;
			modelId?: string;
		};
		expect(respMeta.id).toBe("req-1");
		expect(respMeta.modelId).toBe("gpt-6.1-sol");
		const codex = (finishMeta as Record<string, Record<string, unknown>>).codex!;
		expect(codex.requestId).toBe("req-1");
		expect(codex.servedModel).toBe("gpt-6.1-sol");
		expect(quotaFromMetadata(finishMeta)).toEqual({
			limitName: "codex",
			primary: { usedPercent: 42.5, windowMinutes: 300, resetsAt: 1730000000 },
			secondary: { usedPercent: 7, windowMinutes: 10080, resetsAt: null },
		});
	});

	test("the codex.rate_limits SSE event overrides the header snapshot", async () => {
		const path = authDir({ access_token: jwt(FUTURE), account_id: "acct-1" });
		const model = new CodexLanguageModel(
			"gpt-6-astra",
			path,
			async () =>
				new Response(
					new TextEncoder().encode(
						[
							{
								type: "codex.rate_limits",
								rate_limits: {
									primary: {
										used_percent: 88,
										window_minutes: 300,
										reset_at: 1730000500,
									},
								},
								limit_name: "stream",
							},
							done(),
						]
							.map((f) => `data: ${JSON.stringify(f)}\n\n`)
							.join(""),
					),
					{
						headers: {
							"x-codex-primary-used-percent": "42.5",
							"x-codex-primary-window-minutes": "300",
							"x-codex-primary-reset-at": "1730000000",
						},
					},
				),
		);
		const r = await model.doGenerate({ prompt });
		expect(quotaFromMetadata(r.providerMetadata)).toEqual({
			limitName: "stream",
			primary: { usedPercent: 88, windowMinutes: 300, resetsAt: 1730000500 },
			secondary: null,
		});
	});

	test("malformed quota headers produce no quota — and no quota key", async () => {
		const path = authDir({ access_token: jwt(FUTURE), account_id: "acct-1" });
		const model = new CodexLanguageModel(
			"gpt-6-astra",
			path,
			async () =>
				new Response(new TextEncoder().encode(`data: ${JSON.stringify(done())}\n\n`), {
					headers: { "x-codex-primary-used-percent": "banana" },
				}),
		);
		const r = await model.doGenerate({ prompt });
		expect(quotaFromMetadata(r.providerMetadata)).toBeNull();
		const codex = (r.providerMetadata as Record<string, Record<string, unknown>> | undefined)
			?.codex;
		expect(codex === undefined || !("quota" in codex)).toBe(true);
	});

	test("a 429's error message names the request id and quota readout", async () => {
		const path = authDir({ access_token: jwt(FUTURE), account_id: "acct-1" });
		const model = new CodexLanguageModel(
			"gpt-6-astra",
			path,
			async () =>
				new Response("rate limited", {
					status: 429,
					headers: {
						"x-request-id": "req-429",
						"x-codex-primary-used-percent": "99",
						"x-codex-primary-reset-at": "1730000000",
					},
				}),
		);
		await expect(model.doGenerate({ prompt })).rejects.toThrow(
			/HTTP 429.*req-429.*99% used.*1730000000/,
		);
	});
});

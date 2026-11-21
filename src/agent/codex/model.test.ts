// The codex edge around the stock Responses model: request headers and
// body are the backend's contract, the `codex` namespace + replayScope
// is goblin's stored replay contract, and tool results must carry
// images (#731). Faked only at the fetch edge.
//
// Every SSE body below is a hand-built FIXTURE in the Responses event
// shape the stock model parses — not a recorded backend response.

import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4Prompt, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { log } from "../../log.ts";
import { isTransientTurnFailure, quotaExhausted } from "../provider-errors.ts";
import { fromSdkError } from "../sdk-errors.ts";
import type { FetchLike } from "./auth.ts";
import { codexModel, RESPONSES_URL } from "./model.ts";
import { quotaFromMetadata } from "./receipts.ts";
import { codexSessionId } from "./session.ts";

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (exp: number) => `${b64({ alg: "none" })}.${b64({ exp })}.sig`;
const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const ACCESS = jwt(FUTURE);

function authFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-codex-"));
	const path = join(dir, "auth.json");
	writeFileSync(path, JSON.stringify({ tokens: { access_token: ACCESS, account_id: "acct-1" } }));
	return path;
}

// ---------- fixtures ----------

type Frame = Record<string, unknown>;

const created: Frame = {
	type: "response.created",
	response: { id: "resp_1", created_at: 1, model: "gpt-6-luna" },
};

function completed(): Frame {
	return {
		type: "response.completed",
		response: {
			usage: {
				input_tokens: 5,
				input_tokens_details: { cached_tokens: 2 },
				output_tokens: 3,
				output_tokens_details: { reasoning_tokens: 1 },
			},
		},
	};
}

function reasoningItem(id: string, summary: string, cipher: string, index = 0): Frame[] {
	return [
		{ type: "response.output_item.added", output_index: index, item: { type: "reasoning", id, encrypted_content: null } },
		{ type: "response.reasoning_summary_part.added", item_id: id, output_index: index, summary_index: 0 },
		{ type: "response.reasoning_summary_text.delta", item_id: id, output_index: index, summary_index: 0, delta: summary },
		{ type: "response.reasoning_summary_part.done", item_id: id, output_index: index, summary_index: 0 },
		{ type: "response.output_item.done", output_index: index, item: { type: "reasoning", id, encrypted_content: cipher } },
	];
}

function textItem(id: string, text: string, index = 0): Frame[] {
	return [
		{ type: "response.output_item.added", output_index: index, item: { type: "message", id, phase: "final_answer" } },
		{ type: "response.output_text.delta", item_id: id, output_index: index, delta: text },
		{ type: "response.output_item.done", output_index: index, item: { type: "message", id, phase: "final_answer" } },
	];
}

function callItem(id: string, callId: string, name: string, args: string, index = 0): Frame[] {
	const item = { type: "function_call", id, call_id: callId, name, arguments: args };
	return [
		{ type: "response.output_item.added", output_index: index, item },
		{ type: "response.output_item.done", output_index: index, item: { ...item, status: "completed" } },
	];
}

const QUOTA_HEADERS = {
	"x-codex-primary-used-percent": "12.5",
	"x-codex-primary-window-minutes": "300",
	"x-codex-primary-reset-at": "1763600000",
	"x-codex-secondary-used-percent": "40",
	"x-codex-limit-name": "codex",
};

function sse(frames: Frame[], headers: Record<string, string> = {}): Response {
	const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";
	return new Response(body, { headers: { "content-type": "text/event-stream", ...headers } });
}

interface Sent {
	url: string;
	headers: Headers;
	body: Record<string, unknown>;
}

// Serves the queued responses in order; a non-streaming request gets
// the backend's observed 400 instead.
function fakeBackend(queue: Array<() => Response>): { fetch: FetchLike; sent: Sent[] } {
	const sent: Sent[] = [];
	const fetchImpl: FetchLike = async (url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		sent.push({ url: String(url), headers: new Headers(init?.headers), body });
		if (body.stream !== true) {
			return new Response(JSON.stringify({ detail: "Stream must be set to true" }), { status: 400 });
		}
		const next = queue.shift();
		if (next === undefined) throw new Error("fake backend: no response queued");
		return next();
	};
	return { fetch: fetchImpl, sent };
}

async function drain(stream: ReadableStream<LanguageModelV4StreamPart>): Promise<LanguageModelV4StreamPart[]> {
	const parts: LanguageModelV4StreamPart[] = [];
	for await (const p of stream) parts.push(p);
	return parts;
}

const userPrompt = (text: string): LanguageModelV4Prompt => [
	{ role: "user", content: [{ type: "text", text }] },
];

const inputOf = (s: Sent) => s.body.input as Array<Record<string, unknown>>;

// ---------- T1 headers ----------

describe("codexModel — request headers", () => {
	test("auth, account, beta, originator, session, subagent; turn-state echoes within an instance only", async () => {
		const path = authFile();
		const backend = fakeBackend([
			() => sse([created, ...callItem("fc_1", "call_1", "echo", '{"v":"a"}'), completed()], { "x-codex-turn-state": "ts-1" }),
			() => sse([created, ...textItem("msg_1", "done"), completed()], { "x-codex-turn-state": "ts-2" }),
			() => sse([created, ...textItem("msg_2", "fresh"), completed()]),
		]);
		const model = codexModel("gpt-6-luna", path, backend.fetch, { sessionId: "sess-1", subagent: "compact" });
		await generateText({
			model,
			prompt: "hi",
			tools: { echo: tool({ inputSchema: z.object({ v: z.string() }), execute: async ({ v }) => v }) },
			stopWhen: stepCountIs(2),
			maxRetries: 0,
		});
		expect(backend.sent.length).toBe(2);
		const [first, second] = backend.sent;
		expect(first!.url).toBe(RESPONSES_URL);
		expect(first!.headers.get("authorization")).toBe(`Bearer ${ACCESS}`);
		expect(first!.headers.get("chatgpt-account-id")).toBe("acct-1");
		expect(first!.headers.get("openai-beta")).toBe("responses=experimental");
		expect(first!.headers.get("originator")).toBe("codex_cli_rs");
		expect(first!.headers.get("accept")).toBe("text/event-stream");
		expect(first!.headers.get("session-id")).toBe("sess-1");
		expect(first!.headers.get("thread-id")).toBe("sess-1");
		expect(first!.headers.get("x-openai-subagent")).toBe("compact");
		expect(first!.headers.get("x-codex-turn-state")).toBeNull();
		// First non-empty value wins for the instance's life.
		expect(second!.headers.get("x-codex-turn-state")).toBe("ts-1");

		const fresh = codexModel("gpt-6-luna", path, backend.fetch, {});
		await generateText({ model: fresh, prompt: "again", maxRetries: 0 });
		const third = backend.sent[2]!;
		expect(third.headers.get("x-codex-turn-state")).toBeNull();
		expect(third.headers.get("session-id")).toBeNull();
		expect(third.headers.get("x-openai-subagent")).toBeNull();
	});
});

// ---------- T2 body ----------

describe("codexModel — request body", () => {
	test("system → instructions; store false; cipher include; cache key; effort from the codex namespace; stream", async () => {
		const backend = fakeBackend([() => sse([created, ...textItem("msg_1", "ok"), completed()])]);
		const model = codexModel("gpt-6-luna", authFile(), backend.fetch, { sessionId: "sess-9" });
		await generateText({
			model,
			system: "be terse",
			prompt: "hi",
			providerOptions: { codex: { reasoningEffort: "high" } },
			maxRetries: 0,
		});
		const body = backend.sent[0]!.body;
		expect(body.model).toBe("gpt-6-luna");
		expect(body.instructions).toBe("be terse");
		expect(JSON.stringify(body.input)).not.toContain("be terse");
		expect(body.store).toBe(false);
		expect(body.include).toContain("reasoning.encrypted_content");
		expect(body.prompt_cache_key).toBe("sess-9");
		expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
		expect(body.stream).toBe(true);
	});
});

// ---------- T3 / T4 replay ----------

describe("codexModel — reasoning replay", () => {
	test("in-scope reasoning replays its item id and cipher — in the tool loop and on the next turn", async () => {
		const path = authFile();
		const backend = fakeBackend([
			() =>
				sse([
					created,
					...reasoningItem("rs_1", "thinking", "CIPHER-1", 0),
					...callItem("fc_1", "call_1", "echo", '{"v":"a"}', 1),
					completed(),
				]),
			() => sse([created, ...textItem("msg_1", "a", 0), completed()]),
			() => sse([created, ...textItem("msg_2", "b", 0), completed()]),
		]);
		const turn1 = await generateText({
			model: codexModel("gpt-6-luna", path, backend.fetch, {}),
			prompt: "go",
			tools: { echo: tool({ inputSchema: z.object({ v: z.string() }), execute: async ({ v }) => v }) },
			stopWhen: stepCountIs(2),
			maxRetries: 0,
		});
		const step2 = inputOf(backend.sent[1]!);
		const reasoning = step2.find((i) => i.type === "reasoning");
		expect(reasoning).toMatchObject({ id: "rs_1", encrypted_content: "CIPHER-1" });
		expect(step2.indexOf(reasoning!)).toBeLessThan(step2.findIndex((i) => i.type === "function_call"));

		// Next turn, fresh instance, same model+account: stored parts replay.
		await generateText({
			model: codexModel("gpt-6-luna", path, backend.fetch, {}),
			messages: [{ role: "user", content: "go" }, ...turn1.steps.flatMap((s) => s.response.messages), { role: "user", content: "more" }],
			maxRetries: 0,
		});
		const next = inputOf(backend.sent[2]!);
		expect(next.find((i) => i.type === "reasoning")).toMatchObject({ id: "rs_1", encrypted_content: "CIPHER-1" });
	});

	test("foreign-scope or scopeless state never replays — visible content stays, a warn names the drop", async () => {
		const warn = spyOn(log, "warn");
		try {
			const backend = fakeBackend([() => sse([created, ...textItem("msg_9", "ok"), completed()])]);
			const model = codexModel("gpt-6-luna", authFile(), backend.fetch, {});
			const foreign = { codex: { itemId: "rs_x", replayScope: "someone-else", reasoningEncryptedContent: "FOREIGN" } };
			const prompt: LanguageModelV4Prompt = [
				{ role: "user", content: [{ type: "text", text: "q" }] },
				{
					role: "assistant",
					content: [
						{ type: "reasoning", text: "foreign thought", providerOptions: foreign },
						{ type: "reasoning", text: "legacy thought", providerOptions: { codex: { itemId: "rs_y", reasoningEncryptedContent: "NOSCOPE" } } },
						{ type: "reasoning", text: "bare thought" },
						{ type: "text", text: "visible", providerOptions: { codex: { itemId: "msg_x", replayScope: "someone-else" } } },
						{
							type: "tool-call",
							toolCallId: "call_x",
							toolName: "echo",
							input: { v: "a" },
							providerOptions: { codex: { itemId: "fc_x", replayScope: "someone-else" } },
						},
					],
				},
				{
					role: "tool",
					content: [{ type: "tool-result", toolCallId: "call_x", toolName: "echo", output: { type: "text", value: "a" } }],
				},
			];
			const { stream } = await model.doStream({ prompt });
			await drain(stream);
			const input = inputOf(backend.sent[0]!);
			const wire = JSON.stringify(input);
			expect(input.some((i) => i.type === "reasoning")).toBe(false);
			for (const leaked of ["FOREIGN", "NOSCOPE", "rs_x", "rs_y", "msg_x", "fc_x"]) {
				expect(wire).not.toContain(leaked);
			}
			expect(wire).toContain("visible");
			expect(input.some((i) => i.type === "function_call" && i.call_id === "call_x")).toBe(true);
			const drop = warn.mock.calls.find((c) => c[0] === "codex replay state dropped");
			expect(drop).toBeDefined();
			expect(String((drop![1] as { reason: string }).reason)).toContain("out of scope");
		} finally {
			warn.mockRestore();
		}
	});
});

// ---------- T5 stream output ----------

describe("codexModel — stream output", () => {
	test("parts carry codex itemId + replayScope, never `openai`; finish carries the header quota", async () => {
		const backend = fakeBackend([
			() =>
				sse(
					[
						created,
						...reasoningItem("rs_1", "hmm", "CIPHER", 0),
						...textItem("msg_1", "hello", 1),
						...callItem("fc_1", "call_1", "echo", "{}", 2),
						completed(),
					],
					QUOTA_HEADERS,
				),
		]);
		const model = codexModel("gpt-6-luna", authFile(), backend.fetch, {});
		const { stream } = await model.doStream({ prompt: userPrompt("hi") });
		const parts = await drain(stream);
		const withMeta = parts.filter(
			(p): p is Extract<LanguageModelV4StreamPart, { providerMetadata?: unknown }> =>
				"providerMetadata" in p && p.providerMetadata !== undefined,
		);
		for (const p of withMeta) expect(p.providerMetadata).not.toHaveProperty("openai");
		const metaOf = (type: string) =>
			withMeta.find((p) => p.type === type)?.providerMetadata?.codex as Record<string, unknown> | undefined;
		const scope = metaOf("reasoning-start")?.replayScope;
		expect(typeof scope).toBe("string");
		expect(metaOf("reasoning-end")).toEqual({ itemId: "rs_1", replayScope: scope, reasoningEncryptedContent: "CIPHER" });
		expect(metaOf("text-start")).toMatchObject({ itemId: "msg_1", replayScope: scope, phase: "final_answer" });
		expect(metaOf("tool-call")).toMatchObject({ itemId: "fc_1", replayScope: scope });
		const finish = parts.find((p) => p.type === "finish");
		expect(quotaFromMetadata(finish?.type === "finish" ? finish.providerMetadata : undefined)).toEqual({
			limitName: "codex",
			primary: { usedPercent: 12.5, windowMinutes: 300, resetsAt: 1763600000 },
			secondary: { usedPercent: 40, windowMinutes: null, resetsAt: null },
		});
	});
});

// ---------- T6 generate ----------

describe("codexModel — generate", () => {
	test("generateText runs over the stream (the backend 400s non-streaming) and returns text, reasoning, usage", async () => {
		const backend = fakeBackend([
			() => sse([created, ...reasoningItem("rs_1", "pondering", "C", 0), ...textItem("msg_1", "answer", 1), completed()]),
		]);
		const result = await generateText({
			model: codexModel("gpt-6-luna", authFile(), backend.fetch, {}),
			prompt: "q",
			maxRetries: 0,
		});
		expect(backend.sent[0]!.body.stream).toBe(true);
		expect(result.text).toBe("answer");
		expect(result.reasoningText).toBe("pondering");
		expect(result.usage.inputTokens).toBe(5);
		expect(result.usage.outputTokens).toBe(3);
		expect(result.usage.inputTokenDetails.cacheReadTokens).toBe(2);
		const reasoning = result.content.find((c) => c.type === "reasoning");
		expect(reasoning?.providerMetadata?.codex).toMatchObject({ itemId: "rs_1", reasoningEncryptedContent: "C" });
	});
});

// ---------- T7 tool-result image (#731) ----------

describe("codexModel — tool-result media", () => {
	test("an image in a tool result rides function_call_output as input_image", async () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const backend = fakeBackend([
			() => sse([created, ...callItem("fc_1", "call_1", "screenshot", "{}"), completed()]),
			() => sse([created, ...textItem("msg_1", "seen"), completed()]),
		]);
		await generateText({
			model: codexModel("gpt-6-luna", authFile(), backend.fetch, {}),
			prompt: "look",
			tools: {
				screenshot: tool({
					inputSchema: z.object({}),
					execute: async () => "shot",
					toModelOutput: () => ({
						type: "content",
						value: [
							{ type: "text", text: "the screen" },
							{ type: "file", mediaType: "image/png", data: { type: "data", data: png } },
						],
					}),
				}),
			},
			stopWhen: stepCountIs(2),
			maxRetries: 0,
		});
		const out = inputOf(backend.sent[1]!).find((i) => i.type === "function_call_output");
		const items = out?.output as Array<Record<string, unknown>>;
		expect(Array.isArray(items)).toBe(true);
		expect(items.some((i) => i.type === "input_text")).toBe(true);
		expect(items.some((i) => i.type === "input_image" && String(i.image_url).startsWith("data:image/png;base64,"))).toBe(true);
	});
});

// ---------- provider-error classification through the stock model ----------

describe("codexModel — failures classify as before", () => {
	test("a 429 quota body surfaces as quotaExhausted", async () => {
		// OpenAI's documented insufficient_quota envelope — the one quota
		// body provider-errors.ts names for the codex door; not observed.
		const fetchImpl: FetchLike = async () =>
			new Response(
				JSON.stringify({
					error: {
						message: "You exceeded your current quota, please check your plan and billing details.",
						type: "insufficient_quota",
						code: "insufficient_quota",
					},
				}),
				{ status: 429, headers: { "content-type": "application/json", ...QUOTA_HEADERS } },
			);
		const err = await generateText({
			model: codexModel("gpt-6-luna", authFile(), fetchImpl, {}),
			prompt: "q",
			maxRetries: 0,
		}).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).not.toBeNull();
		expect(quotaExhausted(fromSdkError(err))).not.toBeNull();
		expect(isTransientTurnFailure(fromSdkError(err))).toBe(false);
	});

	test("an in-stream response.failed overload is transient", async () => {
		const backend = fakeBackend([
			() =>
				sse([
					created,
					{
						type: "response.failed",
						sequence_number: 2,
						response: {
							error: {
								code: "server_is_overloaded",
								message: "Our servers are currently overloaded. Please try again later.",
							},
						},
					},
				]),
		]);
		const err = await generateText({
			model: codexModel("gpt-6-luna", authFile(), backend.fetch, {}),
			prompt: "q",
			maxRetries: 0,
		}).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).not.toBeNull();
		expect(isTransientTurnFailure(fromSdkError(err))).toBe(true);
		expect(quotaExhausted(fromSdkError(err))).toBeNull();
	});
});

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

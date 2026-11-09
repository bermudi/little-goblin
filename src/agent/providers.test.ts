// The model, the media it carries, and the receipts a call leaves.
// The thinking vocabulary and the ladder each model may be offered
// live in thinking.test.ts.

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { APICallError, generateText, streamText, wrapLanguageModel } from "ai";
import { z } from "zod";
import type { AuthStore } from "../auth.ts";
import { openCacheObservation } from "../cache-observation.ts";
import type { Config } from "../config.ts";
import { setLogFile } from "../log.ts";
import { generateModel, scriptedModel, textParts } from "../testkit/fake-model.ts";
import { tmpDir } from "../testkit.ts";
import {
	cacheRouteFor,
	carriesMedia,
	observedModel,
	resolveModel,
	transportRetry,
} from "./providers.ts";

// resolveModel resolves auth through a literal-key fixture — no records,
// no commands, nothing secret.
const fixtureAuth = (key: string): AuthStore => ({
	resolve: async () => key,
	has: () => true,
	names: () => [],
});

const cfg: Config = {
	providers: {
		zai: { kind: "openai-compatible", baseUrl: "https://api.z.ai/api/coding/paas/v4", auth: "zai" },
		// Probe-verified 2026-09-27: on the Responses door, documents
		// ride in user messages AND tool outputs.
		zai_responses: { kind: "responses", baseUrl: "https://api.z.ai/api/v1", auth: "zai" },
		relay_responses: { kind: "responses", baseUrl: "https://relay.example/v1", auth: "other" },
		other: { kind: "openai-compatible", baseUrl: "https://example.com/v1", auth: "other" },
		// Dotted name — the shape the SDK's first-segment lookup rule exists for.
		"z.ai": { kind: "openai-compatible", baseUrl: "https://api.z.ai/api/paas/v4", auth: "zai" },
		// The 1min.AI relay — text-only for every model it lists
		// (docs.1min.ai/docs/api/openai-compatible).
		onemin: {
			kind: "openai-compatible",
			baseUrl: "https://api.1min.ai/openai/v1",
			auth: "onemin",
		},
		openrouter: { kind: "openrouter", auth: "openrouter" },
		codex: { kind: "codex", webSearch: "live" },
	},
	model: "zai/glm-5.3-flash",
	tts: false,
	favorites: [],
	modelFallbacks: [],
	thinking: "medium",
	operators: [1],
	allowedUsers: [1],
	telegram: { enabled: true, dmGapMinutes: 45, richReplies: true, showReasoning: false },
	http: { port: 8787 },
	logLevel: "info",
};

const FULL = ["off", "low", "medium", "high", "xhigh", "max"] as const;

describe("carriesMedia — what the pipe can deliver, per position", () => {
	test("responses carries probe-verified types only: images and PDFs, in both positions", () => {
		expect(carriesMedia("responses", "application/pdf")).toBe(true);
		expect(carriesMedia("responses", "image/png")).toBe(true);
		expect(carriesMedia("responses", "application/pdf", "tool-result")).toBe(true);
		expect(carriesMedia("responses", "image/png", "tool-result")).toBe(true);
		// Server-side rejection, probe 2026-09-27: "Failed to parse the file."
		expect(carriesMedia("responses", "video/mp4")).toBe(false);
		expect(carriesMedia("responses", "application/zip")).toBe(false);
	});

	test("openai-compatible emits image/video/pdf parts in user messages — and stringifies tool results", () => {
		expect(carriesMedia("openai-compatible", "application/pdf")).toBe(true);
		expect(carriesMedia("openai-compatible", "video/mp4")).toBe(true);
		// getAudioFormat expresses wav/mp3/mpeg only; anything else throws
		// at request build — Telegram voice notes are audio/ogg.
		expect(carriesMedia("openai-compatible", "audio/mpeg")).toBe(true);
		expect(carriesMedia("openai-compatible", "audio/ogg")).toBe(false);
		expect(carriesMedia("openai-compatible", "application/zip")).toBe(false);
		// The converter stringifies tool-result content — a PDF there
		// would ride as base64 JSON text in every later request.
		expect(carriesMedia("openai-compatible", "application/pdf", "tool-result")).toBe(false);
		expect(carriesMedia("openai-compatible", "image/png", "tool-result")).toBe(false);
	});

	test("openrouter normalizes everything in both positions; codex is user-position only", () => {
		expect(carriesMedia("openrouter", "application/zip")).toBe(true);
		expect(carriesMedia("openrouter", "application/pdf", "tool-result")).toBe(true);
		expect(carriesMedia("codex", "application/pdf")).toBe(true);
		expect(carriesMedia("codex", "video/mp4")).toBe(false);
		// toolResultText filters content to text — the payload would drop.
		expect(carriesMedia("codex", "application/pdf", "tool-result")).toBe(false);
	});

	test("unknown kinds carry the universal minimum, user messages only", () => {
		expect(carriesMedia("mystery", "image/jpeg")).toBe(true);
		expect(carriesMedia("mystery", "image/jpeg", "tool-result")).toBe(false);
		expect(carriesMedia("mystery", "application/pdf")).toBe(false);
	});
});

describe("carriesMedia — 1min's relay is text-only", () => {
	// "All models on this endpoint accept text only, including models
	// with vl in their names" — the pipe gate must override the kind's
	// shape and any catalog truth about the model id (models.dev lists
	// qwen3-vl-plus under alibaba as image-capable; through this relay
	// an image part would be a rejected field).
	const base = "https://api.1min.ai/openai/v1";

	test("no media rides the pipe in any position", () => {
		expect(carriesMedia("openai-compatible", "image/jpeg", "user", base)).toBe(false);
		expect(carriesMedia("openai-compatible", "image/png", "user", base)).toBe(false);
		expect(carriesMedia("openai-compatible", "application/pdf", "user", base)).toBe(false);
		expect(carriesMedia("openai-compatible", "video/mp4", "user", base)).toBe(false);
		expect(carriesMedia("openai-compatible", "audio/mpeg", "user", base)).toBe(false);
		expect(carriesMedia("openai-compatible", "image/png", "tool-result", base)).toBe(false);
	});

	test("the same kind off the relay keeps its shape", () => {
		expect(carriesMedia("openai-compatible", "image/png")).toBe(true);
		expect(carriesMedia("openai-compatible", "application/pdf")).toBe(true);
	});
});

describe("resolveModel — 1min streams ask for usage (includeUsage)", () => {
	// The wire pin: what the provider the config builds actually POSTs.
	// 1min reports stream usage only under stream_options.include_usage
	// (docs.1min.ai/docs/api/openai-compatible → Streaming, errors, and
	// retries); a fetch stub captures the request body and serves one
	// complete SSE exchange so doStream settles.
	async function captureWire(providerName: string): Promise<{
		url: string;
		authorization: unknown;
		body: Record<string, unknown>;
	}> {
		const model = await resolveModel(cfg, fixtureAuth("fixture-key"), `${providerName}/gpt-5.4`);
		let url = "";
		let authorization: unknown = null;
		let body: Record<string, unknown> = {};
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: unknown, init?: { headers?: unknown }) => {
			url = String(input);
			const headers = init?.headers;
			// The SDK passes a plain record here; grab the bearer line only.
			if (headers && typeof headers === "object" && "authorization" in headers) {
				authorization = headers.authorization;
			}
			body = JSON.parse(String(init && "body" in init ? init.body : "{}"));
			return new Response(
				'data: {"id":"1","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
					'data: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n' +
					"data: [DONE]\n\n",
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		}) as typeof fetch;
		try {
			const stream = await (model as unknown as LanguageModelV4).doStream({
				prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
			});
			const reader = stream.stream.getReader();
			for (;;) {
				const { done } = await reader.read();
				if (done) break;
			}
		} finally {
			globalThis.fetch = originalFetch;
		}
		return { url, authorization, body };
	}

	test("a 1min provider POSTs chat/completions with stream_options.include_usage", async () => {
		const wire = await captureWire("onemin");
		expect(wire.url).toBe("https://api.1min.ai/openai/v1/chat/completions");
		expect(wire.authorization).toBe("Bearer fixture-key");
		expect(wire.body.stream).toBe(true);
		expect(wire.body.stream_options).toEqual({ include_usage: true });
	});

	test("the same kind off the relay sends no stream_options at all", async () => {
		const wire = await captureWire("other");
		expect(wire.url).toBe("https://example.com/v1/chat/completions");
		expect("stream_options" in wire.body).toBe(false);
	});
});

describe("observedModel — correlated call receipts", () => {
	const userPrompt = (text: string) => ({
		prompt: [
			{ role: "system" as const, content: "sys" },
			{ role: "user" as const, content: [{ type: "text" as const, text }] },
		],
		tools: [
			{
				type: "function" as const,
				name: "probe",
				description: "probe",
				inputSchema: { type: "object" },
			},
		],
		temperature: 0.2,
	});
	const finish = (
		input: number,
		output: number,
		cacheRead?: number,
		cacheWrite?: number,
	): LanguageModelV4StreamPart => ({
		type: "finish",
		finishReason: { unified: "stop", raw: undefined },
		usage: {
			inputTokens: {
				total: input,
				noCache: undefined,
				cacheRead,
				cacheWrite,
			},
			outputTokens: { total: output, text: undefined, reasoning: undefined },
		},
	});

	function logLines(path: string): Record<string, unknown>[] {
		return readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	}

	async function drain(stream: ReadableStream<LanguageModelV4StreamPart>) {
		const reader = stream.getReader();
		const parts: LanguageModelV4StreamPart[] = [];
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			parts.push(value);
		}
		return parts;
	}

	test("stream calls pass identical params through and close on the provider finish", async () => {
		const db = new Database(":memory:");
		const obs = openCacheObservation(db);
		const scripted = scriptedModel([[{ type: "stream-start", warnings: [] }, finish(10, 3, 5, 2)]]);
		const dir = tmpDir();
		const logPath = join(dir, "goblin.log");
		setLogFile(logPath);
		try {
			const wrapped = observedModel(scripted.model, {
				conversation: "conv-1",
				observation: obs,
				route: {
					provider: "fake",
					kind: "openai-compatible",
					base: "https://x",
					modelRef: "fake/fake-1",
				},
			}) as LanguageModelV4;
			const params = userPrompt("hi");
			const result = await wrapped.doStream(params);
			expect(scripted.streamCalls[0]).toEqual(params);
			expect(await drain(result.stream)).toEqual([
				{ type: "stream-start", warnings: [] },
				finish(10, 3, 5, 2),
			]);
			const lines = logLines(logPath);
			const start = lines.find((l) => l.msg === "model call")!;
			const usage = lines.find((l) => l.msg === "model call usage")!;
			expect(start.callId).toBeString();
			expect(usage.callId).toBe(start.callId);
			expect(usage.routeKey).toBe(start.routeKey);
			expect(usage).toMatchObject({
				conversation: "conv-1",
				inputTokens: 10,
				cacheReadTokens: 5,
				cacheWriteTokens: 2,
				outputTokens: 3,
				prefixRelation: "first",
			});
			const row = db
				.query<{ status: string; cache_read: number; input_tokens: number }, [string]>(
					"SELECT status, cache_read, input_tokens FROM model_cache_calls WHERE call_id = ?",
				)
				.get(start.callId as string)!;
			expect(row).toEqual({ status: "completed", cache_read: 5, input_tokens: 10 });
		} finally {
			setLogFile(null);
			db.close();
		}
	});

	test("concurrent calls on one conversation carry distinct callIds from start to usage", async () => {
		const db = new Database(":memory:");
		const obs = openCacheObservation(db);
		const scripted = scriptedModel([], {
			extra: { parts: [finish(1, 1)], delayMs: 5, pace: new Set([finish(1, 1)]) },
		});
		const dir = tmpDir();
		const logPath = join(dir, "goblin.log");
		setLogFile(logPath);
		try {
			const wrapped = observedModel(scripted.model, {
				conversation: "conv-1",
				observation: obs,
			}) as LanguageModelV4;
			const params = userPrompt("hi");
			const [a, b] = await Promise.all([wrapped.doStream(params), wrapped.doStream(params)]);
			await Promise.all([drain(a.stream), drain(b.stream)]);
			const lines = logLines(logPath);
			const starts = lines.filter((l) => l.msg === "model call");
			const usages = lines.filter((l) => l.msg === "model call usage");
			expect(starts).toHaveLength(2);
			expect(usages).toHaveLength(2);
			const ids = new Set(starts.map((l) => l.callId));
			expect(ids.size).toBe(2);
			for (const u of usages) expect(ids.has(u.callId as string)).toBe(true);
			expect(
				db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM model_cache_calls").get()!.n,
			).toBe(2);
		} finally {
			setLogFile(null);
			db.close();
		}
	});

	test("a provider rejection, a mid-stream error and a cancel all settle failed — never completed", async () => {
		const db = new Database(":memory:");
		const obs = openCacheObservation(db);
		const dir = tmpDir();
		const logPath = join(dir, "goblin.log");
		setLogFile(logPath);
		try {
			const rejecting = scriptedModel([new Error("http 503")]);
			const wReject = observedModel(rejecting.model, {
				conversation: "conv-1",
				observation: obs,
			}) as LanguageModelV4;
			await expect(wReject.doStream(userPrompt("a"))).rejects.toThrow("http 503");
			const erring = scriptedModel([
				[
					{ type: "text-delta", id: "t1", delta: "x" },
					{ type: "error", error: new Error("boom") },
				],
			]);
			const wErr = observedModel(erring.model, {
				conversation: "conv-1",
				observation: obs,
			}) as LanguageModelV4;
			const errResult = await wErr.doStream(userPrompt("b"));
			const seen = await drain(errResult.stream);
			expect(seen.map((p) => p.type)).toEqual(["text-delta", "error"]);
			const open = scriptedModel([{ cancelError: new Error("cancel boom"), parts: [] }]);
			const wCancel = observedModel(open.model, {
				conversation: "conv-1",
				observation: obs,
			}) as LanguageModelV4;
			const cancelResult = await wCancel.doStream(userPrompt("c"));
			await expect(cancelResult.stream.cancel()).rejects.toThrow("cancel boom");
			const lines = logLines(logPath);
			const failed = lines.filter((l) => l.msg === "model call failed");
			expect(failed).toHaveLength(3);
			const statuses = db
				.query<{ status: string }, []>(
					"SELECT status FROM model_cache_calls ORDER BY started_ms, rowid",
				)
				.all()
				.map((r) => r.status);
			expect(statuses).toEqual(["failed", "failed", "failed"]);
			expect(lines.filter((l) => l.msg === "model call usage")).toHaveLength(0);
		} finally {
			setLogFile(null);
			db.close();
		}
	});

	test("a failed finish write still rejects with the original error and the failed rollback is logged", async () => {
		const db = new Database(":memory:");
		const obs = openCacheObservation(db);
		const dir = tmpDir();
		const logPath = join(dir, "goblin.log");
		setLogFile(logPath);
		try {
			db.run(`CREATE TEMP TRIGGER fail_completed
				BEFORE UPDATE OF status ON model_cache_calls
				WHEN NEW.status = 'completed'
				BEGIN SELECT RAISE(ABORT, 'SENTINEL-FINISH-FAILURE'); END`);
			db.run(`CREATE TEMP TRIGGER fail_failed
				BEFORE UPDATE OF status ON model_cache_calls
				WHEN NEW.status = 'failed'
				BEGIN SELECT RAISE(ABORT, 'SENTINEL-ROLLBACK-FAILURE'); END`);
			const scripted = scriptedModel([[{ type: "stream-start", warnings: [] }, finish(10, 3)]]);
			const wrapped = observedModel(scripted.model, {
				conversation: "conv-1",
				observation: obs,
				route: {
					provider: "fake",
					kind: "openai-compatible",
					base: "https://x",
					modelRef: "fake/fake-1",
				},
			}) as LanguageModelV4;
			const result = await wrapped.doStream(userPrompt("hi"));
			await expect(drain(result.stream)).rejects.toThrow("SENTINEL-FINISH-FAILURE");
			const lines = logLines(logPath);
			const start = lines.find((l) => l.msg === "model call")!;
			const rollback = lines.filter((l) => l.msg === "model call rollback failed");
			expect(rollback).toHaveLength(1);
			expect(rollback[0]).toMatchObject({
				callId: start.callId,
				conversation: "conv-1",
				model: "fake/fake-1",
				errorName: "provider-error",
			});
			expect(lines.filter((l) => l.msg === "model call usage")).toHaveLength(0);
			expect(JSON.stringify(lines)).not.toContain("SENTINEL-ROLLBACK-FAILURE");
		} finally {
			setLogFile(null);
			db.close();
		}
	});

	test("a clean close without a finish part is not a success receipt", async () => {
		const db = new Database(":memory:");
		const obs = openCacheObservation(db);
		const scripted = scriptedModel([[{ type: "text-delta", id: "t1", delta: "x" }]]);
		const dir = tmpDir();
		const logPath = join(dir, "goblin.log");
		setLogFile(logPath);
		try {
			const wrapped = observedModel(scripted.model, {
				conversation: "conv-1",
				observation: obs,
			}) as LanguageModelV4;
			const result = await wrapped.doStream(userPrompt("hi"));
			await drain(result.stream);
			const lines = logLines(logPath);
			expect(lines.filter((l) => l.msg === "model call usage")).toHaveLength(0);
			expect(lines.filter((l) => l.msg === "model call failed")).toHaveLength(1);
			expect(
				db.query<{ status: string }, []>("SELECT status FROM model_cache_calls").get()!.status,
			).toBe("failed");
		} finally {
			setLogFile(null);
			db.close();
		}
	});

	test("generate calls record usage with the same correlation", async () => {
		const db = new Database(":memory:");
		const obs = openCacheObservation(db);
		const dir = tmpDir();
		const logPath = join(dir, "goblin.log");
		setLogFile(logPath);
		try {
			const generated = generateModel(() => ({
				content: [{ type: "text" as const, text: "ok" }],
				finishReason: { unified: "stop" as const, raw: undefined },
				warnings: [],
				usage: {
					inputTokens: {
						total: 4,
						noCache: undefined,
						cacheRead: 0,
						cacheWrite: undefined,
					},
					outputTokens: { total: 1, text: undefined, reasoning: undefined },
				},
			}));
			const wrapped = observedModel(generated.model, {
				conversation: "conv-1",
				purpose: "compaction",
				observation: obs,
			}) as LanguageModelV4;
			const params = userPrompt("summarize");
			const result = await wrapped.doGenerate(params);
			expect(generated.generateCalls[0]).toEqual(params);
			const lines = logLines(logPath);
			const start = lines.find((l) => l.msg === "model call")!;
			const usage = lines.find((l) => l.msg === "model call usage")!;
			expect(usage.callId).toBe(start.callId);
			expect(usage.cacheReadTokens).toBe(0);
			expect(usage.cacheWriteTokens).toBeNull();
			expect(usage.purpose).toBe("compaction");
			expect(result.content).toEqual([{ type: "text", text: "ok" }]);
		} finally {
			setLogFile(null);
			db.close();
		}
	});

	test("without an owner the receipts still correlate and nothing is persisted", async () => {
		const scripted = scriptedModel([], { extra: { parts: [finish(2, 1)] } });
		const dir = tmpDir();
		const logPath = join(dir, "goblin.log");
		setLogFile(logPath);
		try {
			const wrapped = observedModel(scripted.model, { purpose: "topic-title" }) as LanguageModelV4;
			const result = await wrapped.doStream(userPrompt("t"));
			await drain(result.stream);
			const lines = logLines(logPath);
			const usage = lines.find((l) => l.msg === "model call usage")!;
			expect(usage.callId).toBe(lines.find((l) => l.msg === "model call")!.callId);
			expect(usage.idleMs).toBeUndefined();
		} finally {
			setLogFile(null);
		}
	});
});

describe("cacheRouteFor — the hashed route identity", () => {
	test("each kind pins a credential-free base", () => {
		expect(cacheRouteFor(cfg, "zai/glm-5.3")).toEqual({
			provider: "zai",
			kind: "openai-compatible",
			base: "https://api.z.ai/api/coding/paas/v4",
			modelRef: "zai/glm-5.3",
		});
		expect(cacheRouteFor(cfg, "zai_responses/glm-5.3")?.base).toBe("https://api.z.ai/api/v1");
		expect(cacheRouteFor(cfg, "openrouter/anthropic/claude")?.base).toBe(
			"https://openrouter.ai/api/v1",
		);
		expect(cacheRouteFor(cfg, "codex/gpt-5.3")?.base).toBe(
			"https://chatgpt.com/backend-api/codex/responses",
		);
		expect(cacheRouteFor(cfg, "missing/x")).toBeUndefined();
	});

	test("a credential/query/fragment-bearing baseUrl hashes only origin and path", () => {
		const dirty: Config = {
			...cfg,
			providers: {
				relay: {
					kind: "openai-compatible",
					baseUrl: "https://user:pass@relay.example/v1?key=abc#frag",
					auth: "x",
				},
			},
		};
		expect(cacheRouteFor(dirty, "relay/m")?.base).toBe("https://relay.example/v1");
	});
});

describe("failure lines carry only safe categories", () => {
	test("an APICallError with a sentinel body/headers leaks nothing into telemetry lines", async () => {
		const db = new Database(":memory:");
		const obs = openCacheObservation(db);
		const dir = tmpDir();
		const logPath = join(dir, "goblin.log");
		setLogFile(logPath);
		const sentinel = "SENTINEL-BODY-https://key.example/secret-9x";
		const apiError = new APICallError({
			message: "ignored",
			url: "https://api.example/v1/chat",
			requestBodyValues: { prompt: sentinel },
			statusCode: 503,
			responseHeaders: { "x-auth": sentinel },
			responseBody: sentinel,
		});
		try {
			const failing = generateModel(() => {
				throw apiError;
			});
			const wrapped = observedModel(failing.model, {
				conversation: "conv-1",
				observation: obs,
			}) as LanguageModelV4;
			let caught: unknown;
			try {
				await wrapped.doGenerate({
					prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
				});
			} catch (error) {
				caught = error;
			}
			expect(caught).toBe(apiError);
			const lines = readFileSync(logPath, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l) as Record<string, unknown>);
			const failed = lines.filter((l) => l.msg === "model call failed");
			expect(failed).toHaveLength(1);
			expect(failed[0]).toMatchObject({
				stage: "invoke",
				errorName: "provider-error",
				httpStatus: 503,
			});
			expect(JSON.stringify(failed)).not.toContain(sentinel);
			expect(JSON.stringify(failed)).not.toContain("api.example");
		} finally {
			setLogFile(null);
			db.close();
		}
	});
});

describe("resolveModel — provider quota walls skip the SDK's own retries", () => {
	const ZAI_QUOTA =
		'{"error":{"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-28 08:50:34"}}';
	const THROTTLE = '{"error":{"message":"Too many requests, slow down"}}';

	// Fake at the HTTP edge: the real provider, parser and SDK retry loop run.
	async function attempts(body: string, run: "generate" | "stream", status = 429): Promise<number> {
		return (await attempt(body, run, status)).calls;
	}
	async function attempt(
		body: string,
		run: "generate" | "stream",
		status = 429,
	): Promise<{ calls: number; caught: unknown }> {
		const original = globalThis.fetch;
		let calls = 0;
		let caught: unknown;
		globalThis.fetch = (async () => {
			calls++;
			// retry-after-ms: 0 keeps the SDK's backoff instant.
			return new Response(body, {
				status,
				headers: { "content-type": "application/json", "retry-after-ms": "0" },
			});
		}) as unknown as typeof fetch;
		try {
			const model = await resolveModel(cfg, fixtureAuth("k"), "other/m");
			if (run === "generate") {
				await generateText({ model, prompt: "hi", maxRetries: 2 }).catch((e: unknown) => {
					caught = e;
				});
			} else {
				const result = streamText({ model, prompt: "hi", maxRetries: 2, onError: () => {} });
				await result.consumeStream({ onError: () => {} });
			}
		} finally {
			globalThis.fetch = original;
		}
		return { calls, caught };
	}

	for (const run of ["generate", "stream"] as const) {
		test(`${run}: quota 429 makes exactly one attempt`, async () => {
			expect(await attempts(ZAI_QUOTA, run)).toBe(1);
		});
		test(`${run}: a plain 429 throttle still spends the retry ladder`, async () => {
			expect(await attempts(THROTTLE, run)).toBe(3);
		});
		test(`${run}: a 503 without quota prose still spends the retry ladder`, async () => {
			expect(await attempts('{"error":{"message":"upstream overloaded"}}', run, 503)).toBe(3);
		});
		test(`${run}: a 503 whose body is the quota prose makes exactly one attempt`, async () => {
			// Pins current behavior: the filter keys on prose, not status.
			expect(await attempts(ZAI_QUOTA, run, 503)).toBe(1);
		});
	}

	test("the rethrown quota error keeps every field and logs one warn line", async () => {
		const dir = tmpDir();
		const logPath = join(dir, "goblin.log");
		setLogFile(logPath);
		let caught: unknown;
		try {
			({ caught } = await attempt(ZAI_QUOTA, "generate"));
		} finally {
			setLogFile(null);
		}
		expect(APICallError.isInstance(caught)).toBe(true);
		const err = caught as APICallError;
		expect(err.isRetryable).toBe(false);
		expect(err.statusCode).toBe(429);
		expect(err.responseBody).toBe(ZAI_QUOTA);
		expect(err.url).toBe("https://example.com/v1/chat/completions");
		const warns = readFileSync(logPath, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as Record<string, unknown>)
			.filter((l) => l.msg === "provider quota exhausted; SDK retries skipped");
		expect(warns).toHaveLength(1);
		expect(warns[0]).toMatchObject({
			level: "warn",
			model: "other/m",
			statusCode: 429,
			resetAt: "2026-10-28 08:50:34",
		});
	});
});

describe("transportRetry — raw transport failures retry before the call is lost (#191)", () => {
	// The SDK ladder retries only errors it flagged itself; a raw fetch
	// TypeError (ECONNRESET/ECONNREFUSED before the first byte) spent
	// nothing and one blip killed the call.
	const blip = (): TypeError =>
		new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 1.2.3.4:443") });

	const wrapped = (model: LanguageModelV4, ref = "other/m") =>
		wrapLanguageModel({ model, middleware: transportRetry(ref, cfg, 0) }) as LanguageModelV4;

	test("stream: a transient throw retries the identical call and completes", async () => {
		const failing = scriptedModel([blip(), textParts("ok")]);
		const model = wrapped(failing.model as unknown as LanguageModelV4);
		const result = streamText({ model, prompt: "hi", maxRetries: 0, onError: () => {} });
		const text = await result.text;
		expect(text).toBe("ok");
		expect(failing.streamCalls).toHaveLength(2);
	});

	test("generate: exhaustion rethrows the last error after the full ladder", async () => {
		const last = blip();
		const inner = scriptedModel([]).model as unknown as LanguageModelV4;
		const calls: unknown[] = [];
		const model = wrapped({
			...inner,
			async doGenerate(o: never) {
				calls.push(o);
				throw last;
			},
		} as unknown as LanguageModelV4);
		let caught: unknown;
		await generateText({ model, prompt: "hi", maxRetries: 0 }).catch((e: unknown) => {
			caught = e;
		});
		expect(caught).toBe(last);
		// 1 attempt + the lane's SDK-default budget of 2 retries.
		expect(calls).toHaveLength(3);
	});

	test("an APICallError keeps the SDK's own ladder — no transport retry", async () => {
		const apiError = new APICallError({
			message: "upstream had a hiccup",
			url: "https://example.com/v1/chat/completions",
			requestBodyValues: {},
			statusCode: 503,
		});
		const calls: unknown[] = [];
		const inner = scriptedModel([]).model as unknown as LanguageModelV4;
		const model = wrapped({
			...inner,
			async doGenerate(o: never) {
				calls.push(o);
				throw apiError;
			},
		} as unknown as LanguageModelV4);
		let caught: unknown;
		await generateText({ model, prompt: "hi", maxRetries: 0 }).catch((e: unknown) => {
			caught = e;
		});
		expect(caught).toBe(apiError);
		expect(calls).toHaveLength(1);
	});

	test("a non-transient plain error is not retried", async () => {
		const calls: unknown[] = [];
		const inner = scriptedModel([]).model as unknown as LanguageModelV4;
		const model = wrapped({
			...inner,
			async doGenerate(o: never) {
				calls.push(o);
				throw new Error("bad request shape");
			},
		} as unknown as LanguageModelV4);
		await generateText({ model, prompt: "hi", maxRetries: 0 }).catch(() => undefined);
		expect(calls).toHaveLength(1);
	});

	test("the 1min rule carries: budget 0 means no transport retries", async () => {
		const inner = scriptedModel([]).model as unknown as LanguageModelV4;
		const calls: unknown[] = [];
		const model = wrapLanguageModel({
			model: {
				...inner,
				async doGenerate(o: never) {
					calls.push(o);
					throw blip();
				},
			} as unknown as LanguageModelV4,
			middleware: transportRetry("onemin/m", cfg, 0),
		}) as LanguageModelV4;
		await generateText({ model, prompt: "hi", maxRetries: 0 }).catch(() => undefined);
		expect(calls).toHaveLength(1);
	});

	test("an aborted signal never retries", async () => {
		const controller = new AbortController();
		const calls: unknown[] = [];
		const inner = scriptedModel([]).model as unknown as LanguageModelV4;
		const model = wrapped({
			...inner,
			async doStream(o: never) {
				calls.push(o);
				controller.abort();
				throw blip();
			},
		} as unknown as LanguageModelV4);
		await Promise.resolve(
			streamText({
				model,
				prompt: "hi",
				maxRetries: 0,
				abortSignal: controller.signal,
				onError: () => {},
			}).text,
		).catch(() => undefined);
		expect(calls).toHaveLength(1);
	});

	test("each retry logs one line with attempt and delay", async () => {
		const dir = tmpDir();
		const logPath = join(dir, "goblin.log");
		setLogFile(logPath);
		try {
			const failing = scriptedModel([blip(), blip(), textParts("ok")]);
			const model = wrapped(failing.model as unknown as LanguageModelV4);
			await streamText({ model, prompt: "hi", maxRetries: 0, onError: () => {} }).text;
			const lines = readFileSync(logPath, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l) as Record<string, unknown>);
			const retries = lines.filter((l) => l.msg === "model call transport retry");
			expect(retries).toHaveLength(2);
			expect(retries[0]).toMatchObject({
				model: "other/m",
				call: "stream",
				attempt: 1,
				delayMs: 0,
			});
			expect(retries[1]).toMatchObject({ attempt: 2, delayMs: 0 });
		} finally {
			setLogFile(null);
		}
	});

	test("resolveModel wires it in: a codex blip retries the raw throw", async () => {
		// The codex lane is where raw transport throws actually occur —
		// SDK-native providers normalize a failed fetch into an
		// isRetryable APICallError the SDK ladder already retries.
		const dir = tmpDir();
		const authFile = join(dir, "auth.json");
		writeFileSync(authFile, JSON.stringify({ tokens: { access_token: "t" } }));
		const c: Config = {
			...cfg,
			providers: { ...cfg.providers, codex: { kind: "codex", authFile, webSearch: "live" } },
		};
		const original = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			if (calls === 1) throw blip();
			return new Response(
				new TextEncoder().encode(
					`data: ${JSON.stringify({
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
					})}\n\n`,
				),
			);
		}) as unknown as typeof fetch;
		try {
			const model = await resolveModel(c, fixtureAuth("k"), "codex/gpt-6.1-sol");
			const result = await generateText({ model, prompt: "hi", maxRetries: 0 });
			expect(result.finishReason).toBe("stop");
			expect(calls).toBe(2);
		} finally {
			globalThis.fetch = original;
		}
	});
});

describe("resolveModel — codex session opts", () => {
	test("session/subagent land on the codex model; other kinds ignore them", async () => {
		const dir = tmpDir();
		const authFile = join(dir, "auth.json");
		writeFileSync(authFile, JSON.stringify({ tokens: { access_token: "t" } }));
		const c: Config = {
			...cfg,
			providers: {
				codex: { kind: "codex", authFile, webSearch: "live" },
				zai: { kind: "openai-compatible", baseUrl: "https://api.z.ai/api/paas/v4", auth: "zai" },
			},
		};
		// Fake at the HTTP edge: the wrapped codex model sends the request.
		const original = globalThis.fetch;
		const seen: Headers[] = [];
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
			seen.push(new Headers(init?.headers));
			return new Response("{}", { status: 400, headers: { "content-type": "application/json" } });
		}) as unknown as typeof fetch;
		try {
			const codex = await resolveModel(c, fixtureAuth("fixture-key"), "codex/gpt-6.1-sol", {
				sessionId: "s-1",
				subagent: "compact",
			});
			await generateText({ model: codex, prompt: "hi", maxRetries: 0 }).catch(() => undefined);
		} finally {
			globalThis.fetch = original;
		}
		expect(seen).toHaveLength(1);
		expect(seen[0]!.get("session-id")).toBe("s-1");
		expect(seen[0]!.get("thread-id")).toBe("s-1");
		expect(seen[0]!.get("x-openai-subagent")).toBe("compact");
		// Non-codex kinds accept and ignore the same opts.
		const other = await resolveModel(c, fixtureAuth("fixture-key"), "zai/glm-5.3", {
			sessionId: "s-1",
		});
		expect(typeof other).not.toBe("string");
	});
});

describe("resolveModel — z.ai responses replays statelessly", () => {
	// The SDK's Responses converter defaults store:true and substitutes an
	// item_reference for every assistant part carrying openai.itemId, so
	// prior prose reaches Zhipu only as ids it must resolve. The
	// zaiStatelessReplay middleware forces openai.store:false before
	// serialization, replaying text/tools inline. These pins run at the
	// fetch edge with a deliberate 400 — the serializer's wire shape is the
	// contract; nothing reaches a provider. Fictitious strings only.
	const PROSE = "fictitious earlier prose QUOTED-NUMBER-240";
	const CALL_ID = "call_fictitious_1";

	const replayPrompt = {
		prompt: [
			{ role: "system" as const, content: "fictitious system" },
			{ role: "user" as const, content: [{ type: "text" as const, text: "fictitious ask" }] },
			{
				role: "assistant" as const,
				content: [
					{
						type: "reasoning" as const,
						text: "fictitious reasoning",
						providerOptions: { openai: { itemId: "rs_fictitious_1" } },
					},
					{
						type: "text" as const,
						text: PROSE,
						providerOptions: { openai: { itemId: "msg_fictitious_1" } },
					},
				],
			},
			{
				role: "assistant" as const,
				content: [
					{
						type: "tool-call" as const,
						toolCallId: CALL_ID,
						toolName: "local_probe",
						input: "{}",
						providerOptions: { openai: { itemId: "fc_fictitious_1" } },
					},
				],
			},
			{
				role: "tool" as const,
				content: [
					{
						type: "tool-result" as const,
						toolCallId: CALL_ID,
						toolName: "local_probe",
						output: { type: "text" as const, value: "fictitious result" },
					},
				],
			},
			{
				role: "assistant" as const,
				content: [
					{
						type: "text" as const,
						text: "fictitious final prose",
						providerOptions: { openai: { itemId: "msg_fictitious_2" } },
					},
				],
			},
			{ role: "user" as const, content: [{ type: "text" as const, text: "fictitious reply" }] },
		],
	};

	const wireBodySchema = z.object({
		store: z.boolean().optional(),
		parallel_tool_calls: z.boolean().optional(),
		input: z.array(
			z.looseObject({
				type: z.string().optional(),
				role: z.string().optional(),
				id: z.string().optional(),
				call_id: z.string().optional(),
				content: z.unknown().optional(),
			}),
		),
	});

	// Intercept at fetch, return a fixed 400: the SDK rejects with
	// APICallError and the intercepted body is the serialization pin.
	async function captureBody(
		modelRef: string,
		call: "generate" | "stream",
		providerOptions?: ProviderOptions,
	) {
		let body: unknown;
		const original = globalThis.fetch;
		globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
			body = JSON.parse(String(init?.body ?? "{}"));
			return new Response(JSON.stringify({ error: { message: "offline pin" } }), {
				status: 400,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;
		try {
			// The stub must be installed before resolution: the z.ai SSE shim
			// binds globalThis.fetch at model construction.
			const model = await resolveModel(cfg, fixtureAuth("fixture-key"), modelRef);
			const v4 = model as LanguageModelV4;
			const options = {
				...replayPrompt,
				...(providerOptions === undefined ? {} : { providerOptions }),
			};
			const pending = call === "generate" ? v4.doGenerate(options) : v4.doStream(options);
			await expect(pending).rejects.toThrow(APICallError);
		} finally {
			globalThis.fetch = original;
		}
		return wireBodySchema.parse(body);
	}

	for (const call of ["generate", "stream"] as const) {
		test(`${call}: store:false replays assistant prose and tools inline, never item_reference`, async () => {
			// The configured provider is named zai_responses — not "openai" —
			// which is exactly the namespace gotcha: the converter reads the
			// canonical openai namespace, so forcing it there is the fix.
			const wire = await captureBody("zai_responses/glm-5.3", call, {
				openai: { store: true, parallelToolCalls: false },
			});
			expect(wire.store).toBe(false);
			expect(wire.parallel_tool_calls).toBe(false);
			expect(wire.input.filter((i) => i.type === "item_reference")).toHaveLength(0);
			expect(
				wire.input.filter(
					(i) => i.role === "assistant" && JSON.stringify(i.content).includes(PROSE),
				),
			).toHaveLength(1);
			const calls = wire.input.filter((i) => i.type === "function_call");
			const outputs = wire.input.filter((i) => i.type === "function_call_output");
			expect(calls.map((i) => i.call_id)).toContain(CALL_ID);
			expect(outputs.map((i) => i.call_id)).toContain(CALL_ID);
		});
	}

	test("a non-z.ai responses provider keeps SDK defaults: references, store untouched", async () => {
		const wire = await captureBody("relay_responses/glm-5.3", "generate", {
			openai: { store: true },
		});
		expect(wire.store).not.toBe(false);
		expect(wire.input.filter((i) => i.type === "item_reference").length).toBeGreaterThan(0);
		expect(
			wire.input.filter((i) => i.role === "assistant" && JSON.stringify(i.content).includes(PROSE)),
		).toHaveLength(0);
	});
});

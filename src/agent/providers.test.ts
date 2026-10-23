// The model, the media it carries, and the receipts a call leaves.
// The thinking vocabulary and the ladder each model may be offered
// live in thinking.test.ts.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { Config } from "../config.ts";
import { openCacheObservation } from "../cache-observation.ts";
import { setLogFile } from "../log.ts";
import { tmpDir } from "../testkit.ts";
import { APICallError } from "ai";
import { generateModel, scriptedModel } from "../testkit/fake-model.ts";
import type { AuthStore } from "../auth.ts";
import { cacheRouteFor, carriesMedia, observedModel, resolveModel } from "./providers.ts";

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
		codex: { kind: "codex" },
	},
	model: "zai/glm-5.3-flash",
	tts: false,
	favorites: [],
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

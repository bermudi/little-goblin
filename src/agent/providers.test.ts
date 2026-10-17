// thinkingOptions is a boundary contract: the operator vocabulary must
// land on knobs each provider family actually has. GLM's per-generation
// semantics (docs.z.ai/guides) motivated this test — send glm-5.3 an
// effort it doesn't list and the API silently upgrades to max.
// thinkingLevelsFor is the same table read the other way: what the app
// and the mini app may offer.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type {
	LanguageModelV4,
	LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import type { Config } from "../config.ts";
import { openCacheObservation } from "../cache-observation.ts";
import { setLogFile } from "../log.ts";
import { tmpDir } from "../testkit.ts";
import { APICallError } from "ai";
import { generateModel, scriptedModel } from "../testkit/fake-model.ts";
import { _primeOpenRouterCatalog } from "./models-dev.ts";
import {
	cacheRouteFor,
	carriesMedia,
	observedModel,
	thinkingLevelsFor,
	thinkingOptions,
} from "./providers.ts";

const cfg: Config = {
	providers: {
		zai: { kind: "openai-compatible", baseUrl: "https://api.z.ai/api/coding/paas/v4", auth: "zai" },
		// The Responses door (devpack endpoint table) — probe-verified
		// 2026-09-27: documents ride in user messages AND tool outputs.
		zai_responses: { kind: "responses", baseUrl: "https://api.z.ai/api/v1", auth: "zai" },
		relay_responses: { kind: "responses", baseUrl: "https://relay.example/v1", auth: "other" },
		other: { kind: "openai-compatible", baseUrl: "https://example.com/v1", auth: "other" },
		// Free-form name with a dot — the exact shape the SDK's lookup
		// key rule (first dot-separated segment) exists for.
		"z.ai": { kind: "openai-compatible", baseUrl: "https://api.z.ai/api/paas/v4", auth: "zai" },
		openrouter: { kind: "openrouter", auth: "openrouter" },
		codex: { kind: "codex" },
	},
	model: "zai/glm-5.3-flash",
	tts: false,
	favorites: [],
	thinking: "medium",
	operators: [1],
	allowedUsers: [1],
	telegram: { dmGapMinutes: 45, richReplies: true, showReasoning: false },
	http: { port: 8787 },
	logLevel: "info",
};

const FULL = ["off", "low", "medium", "high", "xhigh", "max"] as const;

describe("thinkingLevelsFor — the offered set", () => {
	test("glm-5.3+ has no off — thinking is forced", () => {
		expect(thinkingLevelsFor("openai-compatible", "glm-5.3-flash")).toEqual(["low", "high", "max"]);
	});
	test("glm-5.2 toggles and tops out at max", () => {
		expect(thinkingLevelsFor("openai-compatible", "glm-5.2")).toEqual(["off", "high", "max"]);
	});
	test("older glm is a bare toggle", () => {
		expect(thinkingLevelsFor("openai-compatible", "glm-4.6")).toEqual(["off", "low"]);
	});
	test("gpt ladders: no off; gpt-6 adds max", () => {
		expect(thinkingLevelsFor("codex", "gpt-5.3-codex")).toEqual(["low", "medium", "high", "xhigh"]);
		expect(thinkingLevelsFor("codex", "gpt-6-astra")).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	});
	test("family ladders follow the bare model id under any kind", () => {
		// A glm-5.3 is forced-thinking wherever it's served — even via a
		// relay that nests a vendor prefix or an unknown provider kind.
		expect(thinkingLevelsFor("openrouter", "z-ai/glm-5.3")).toEqual(["low", "high", "max"]);
		expect(thinkingLevelsFor("openai-compatible", "gpt-6-astra")).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		expect(thinkingLevelsFor("", "glm-5.3")).toEqual(["low", "high", "max"]);
	});
	test("openrouter falls to the per-route catalog", () => {
		_primeOpenRouterCatalog(
			new Map([
				["effort/model", new Set(["reasoning_effort", "tools"])],
				["toggle/model", new Set(["reasoning", "tools"])],
				["plain/model", new Set(["tools"])],
			]),
		);
		expect(thinkingLevelsFor("openrouter", "effort/model")).toEqual(FULL);
		expect(thinkingLevelsFor("openrouter", "toggle/model")).toEqual(["off", "low"]);
		expect(thinkingLevelsFor("openrouter", "plain/model")).toEqual(["off"]);
		// Unlisted → unknown, not unsupported: full vocabulary, fail loud.
		expect(thinkingLevelsFor("openrouter", "unknown/model")).toEqual(FULL);
		_primeOpenRouterCatalog(null);
	});
	test("everything else gets the full vocabulary", () => {
		expect(thinkingLevelsFor("openai-compatible", "whatever-9")).toEqual(FULL);
		expect(thinkingLevelsFor("openrouter", "x/y")).toEqual(FULL);
	});
});

describe("thinkingOptions — glm-5.3+ (forced thinking, effort low|high|max)", () => {
	test("off and medium clamp to real rungs; low/high/max pass through", () => {
		const eff = (l: "off" | "low" | "medium" | "high" | "xhigh" | "max") =>
			thinkingOptions(cfg, "zai/glm-5.3-flash", l);
		expect(eff("off")).toEqual({
			zai: { thinking: { type: "enabled" }, reasoningEffort: "low" },
		});
		expect(eff("low")).toEqual({
			zai: { thinking: { type: "enabled" }, reasoningEffort: "low" },
		});
		expect(eff("medium")).toEqual({
			zai: { thinking: { type: "enabled" }, reasoningEffort: "high" },
		});
		expect(eff("high")).toEqual({
			zai: { thinking: { type: "enabled" }, reasoningEffort: "high" },
		});
		expect(eff("xhigh")).toEqual({
			zai: { thinking: { type: "enabled" }, reasoningEffort: "max" },
		});
		expect(eff("max")).toEqual({
			zai: { thinking: { type: "enabled" }, reasoningEffort: "max" },
		});
	});
});

describe("thinkingOptions — glm-5.2 (toggle + effort high|max)", () => {
	// "other" is a generic openai-compatible endpoint serving real
	// generations — on z.ai's coding-plan URL these ids alias to 5.3-gen.
	test("off sends the disabled toggle, never an effort", () => {
		expect(thinkingOptions(cfg, "other/glm-5.2", "off")).toEqual({
			other: { thinking: { type: "disabled" } },
		});
	});
	test("low collapses up to high — GLM's own collapse direction", () => {
		expect(thinkingOptions(cfg, "other/glm-5.2", "low")).toEqual({
			other: { thinking: { type: "enabled" }, reasoningEffort: "high" },
		});
	});
	test("max reaches the top rung", () => {
		expect(thinkingOptions(cfg, "other/glm-5.2", "max")).toEqual({
			other: { thinking: { type: "enabled" }, reasoningEffort: "max" },
		});
	});
});

describe("thinkingOptions — older glm (toggle only)", () => {
	test("off disables; anything else enables with no effort key", () => {
		expect(thinkingOptions(cfg, "other/glm-4.6", "off")).toEqual({
			other: { thinking: { type: "disabled" } },
		});
		expect(thinkingOptions(cfg, "other/glm-4.6", "high")).toEqual({
			other: { thinking: { type: "enabled" } },
		});
	});
});

describe("z.ai coding plan — older glm ids alias to 5.3-gen", () => {
	// docs.z.ai/devpack: the plan only serves glm-5.3/5.3-flash and routes
	// glm-5.2/5.1→5.3, glm-4.7→5.3-flash. An "older" id on that endpoint
	// runs a forced-thinking model, so levels and the wire map follow the
	// endpoint, not the id. cfg.zai's baseUrl is the coding-plan URL.
	test("offered set is the 5.3 ladder for any glm id", () => {
		expect(
			thinkingLevelsFor("openai-compatible", "glm-4.6", "https://api.z.ai/api/coding/paas/v4"),
		).toEqual(["low", "high", "max"]);
	});
	test("the general paas endpoint still serves real generations", () => {
		expect(
			thinkingLevelsFor("openai-compatible", "glm-4.6", "https://api.z.ai/api/paas/v4"),
		).toEqual(["off", "low"]);
	});
	test("wire mapping follows the routed model", () => {
		expect(thinkingOptions(cfg, "zai/glm-4.6", "medium")).toEqual({
			zai: { thinking: { type: "enabled" }, reasoningEffort: "high" },
		});
		expect(thinkingOptions(cfg, "zai/glm-4.6", "off")).toEqual({
			zai: { thinking: { type: "enabled" }, reasoningEffort: "low" },
		});
	});
});

describe("thinkingOptions — codex and gpt (reasoning_effort ladder)", () => {
	test("off lands on the floor; real rungs pass through", () => {
		expect(thinkingOptions(cfg, "codex/gpt-6-astra", "off")).toEqual({
			codex: { reasoningEffort: "low" },
		});
		expect(thinkingOptions(cfg, "codex/gpt-6-astra", "xhigh")).toEqual({
			codex: { reasoningEffort: "xhigh" },
		});
		expect(thinkingOptions(cfg, "codex/gpt-6-astra", "max")).toEqual({
			codex: { reasoningEffort: "max" },
		});
	});
	test("a stored max on a 5.x model clamps to its top rung", () => {
		expect(thinkingOptions(cfg, "codex/gpt-5.3-codex", "max")).toEqual({
			codex: { reasoningEffort: "xhigh" },
		});
	});
	test("gpt via an openai-compatible relay clamps the same way", () => {
		expect(thinkingOptions(cfg, "other/gpt-6-astra", "off")).toEqual({
			other: { reasoningEffort: "low" },
		});
		expect(thinkingOptions(cfg, "other/gpt-6-astra", "max")).toEqual({
			other: { reasoningEffort: "max" },
		});
	});
});

describe("thinkingOptions — provider options key", () => {
	// The openai-compatible provider resolves options under
	// name.split(".")[0] — keying under the full name silently drops
	// them. Every model family must follow the rule.
	test("a dotted provider name keys options under its first segment", () => {
		expect(thinkingOptions(cfg, "z.ai/glm-5.2", "high")).toEqual({
			z: { thinking: { type: "enabled" }, reasoningEffort: "high" },
		});
		expect(thinkingOptions(cfg, "z.ai/gpt-6-astra", "off")).toEqual({
			z: { reasoningEffort: "low" },
		});
		expect(thinkingOptions(cfg, "z.ai/whatever-9", "medium")).toEqual({
			z: { reasoningEffort: "medium" },
		});
	});
});

describe("thinkingOptions — non-glm openai-compatible and openrouter", () => {
	test("generic endpoint keeps the reasoning_effort passthrough", () => {
		expect(thinkingOptions(cfg, "other/whatever-9", "medium")).toEqual({
			other: { reasoningEffort: "medium" },
		});
		expect(thinkingOptions(cfg, "other/whatever-9", "off")).toEqual({
			other: { reasoningEffort: "low" },
		});
	});
	test("openrouter: off is enabled:false, levels pass through", () => {
		expect(thinkingOptions(cfg, "openrouter/x/y", "off")).toEqual({
			openrouter: { reasoning: { enabled: false, exclude: true } },
		});
		expect(thinkingOptions(cfg, "openrouter/x/y", "high")).toEqual({
			openrouter: { reasoning: { effort: "high" } },
		});
	});
	test("openrouter per-route: toggle-only enables, non-reasoners send nothing", () => {
		_primeOpenRouterCatalog(
			new Map([
				["toggle/model", new Set(["reasoning"])],
				["plain/model", new Set(["tools"])],
			]),
		);
		expect(thinkingOptions(cfg, "openrouter/toggle/model", "high")).toEqual({
			openrouter: { reasoning: { enabled: true } },
		});
		expect(thinkingOptions(cfg, "openrouter/plain/model", "high")).toBeUndefined();
		// "off" is still enabled:false even on a non-reasoner — trivially true.
		expect(thinkingOptions(cfg, "openrouter/plain/model", "off")).toEqual({
			openrouter: { reasoning: { enabled: false, exclude: true } },
		});
		_primeOpenRouterCatalog(null);
	});
});

describe("responses kind — the /api/v1 door", () => {
	test("glm on the coding endpoint is forced-thinking, whichever door", () => {
		expect(thinkingLevelsFor("responses", "glm-5.3-flash", "https://api.z.ai/api/v1")).toEqual([
			"low",
			"high",
			"max",
		]);
		// The endpoint aliases older glm ids to the 5.3 generation it serves.
		expect(thinkingLevelsFor("responses", "glm-4.6", "https://api.z.ai/api/v1")).toEqual([
			"low",
			"high",
			"max",
		]);
	});

	test("the /api/v1 door matches with or without a trailing slash, and only that path", () => {
		// glm-5.2's own ladder is off|high|max — low|high|max proves the
		// coding-endpoint arm fired, whichever way the base URL is spelled.
		expect(thinkingLevelsFor("responses", "glm-5.2", "https://api.z.ai/api/v1/")).toEqual([
			"low",
			"high",
			"max",
		]);
		expect(thinkingLevelsFor("openai-compatible", "glm-5.2", "https://api.z.ai/api/v1/")).toEqual([
			"low",
			"high",
			"max",
		]);
		// The general paas path is not the coding door — 5.2 keeps its ladder.
		expect(
			thinkingLevelsFor("openai-compatible", "glm-5.2", "https://api.z.ai/api/paas/v4"),
		).toEqual(["off", "high", "max"]);
	});

	test("glm thinking maps to the OpenAI effort knob (probe: low→7, high→37 reasoning tokens)", () => {
		expect(thinkingOptions(cfg, "zai_responses/glm-5.3-flash", "off")).toEqual({
			zai_responses: { reasoningEffort: "low" },
		});
		expect(thinkingOptions(cfg, "zai_responses/glm-5.3-flash", "medium")).toEqual({
			zai_responses: { reasoningEffort: "high" },
		});
		expect(thinkingOptions(cfg, "zai_responses/glm-5.3-flash", "xhigh")).toEqual({
			zai_responses: { reasoningEffort: "max" },
		});
	});

	test("non-glm models pass the level through; off means the floor", () => {
		expect(thinkingOptions(cfg, "relay_responses/gpt-6-astra", "high")).toEqual({
			relay_responses: { reasoningEffort: "high" },
		});
		expect(thinkingOptions(cfg, "relay_responses/gpt-6-astra", "off")).toEqual({
			relay_responses: { reasoningEffort: "low" },
		});
	});
});

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
		const scripted = scriptedModel([
			[{ type: "stream-start", warnings: [] }, finish(10, 3, 5, 2)],
		]);
		const dir = tmpDir();
		const logPath = join(dir, "goblin.log");
		setLogFile(logPath);
		try {
			const wrapped = observedModel(scripted.model, {
				conversation: "conv-1",
				observation: obs,
				route: { provider: "fake", kind: "openai-compatible", base: "https://x", modelRef: "fake/fake-1" },
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
				[{ type: "text-delta", id: "t1", delta: "x" }, { type: "error", error: new Error("boom") }],
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
			expect(failed[0]).toMatchObject({ stage: "invoke", errorName: "provider-error", httpStatus: 503 });
			expect(JSON.stringify(failed)).not.toContain(sentinel);
			expect(JSON.stringify(failed)).not.toContain("api.example");
		} finally {
			setLogFile(null);
			db.close();
		}
	});
});

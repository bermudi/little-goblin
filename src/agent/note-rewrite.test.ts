// The one-off rewrite call through the real SDK seam (house pattern —
// vision.test.ts): the fake sits at the LanguageModel provider edge, so
// generateText, observedModel, thinkingOptions, and the abort wiring
// all run as production code. What the fake captures is what a provider
// would actually receive.

import { beforeAll, describe, expect, test } from "bun:test";
import type { LanguageModel } from "ai";
import { APICallError } from "@ai-sdk/provider";
import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import type { AuthStore } from "../auth.ts";
import type { Config, ConfigRef } from "../config.ts";
import { setLogFile, setLogWriter } from "../log.ts";
import { generateNoteRewrite, NOTE_REWRITE_INSTRUCTIONS } from "./note-rewrite.ts";

beforeAll(() => {
	setLogFile(null);
	setLogWriter(null);
});

const NO_AUTH: AuthStore = {
	resolve: () => Promise.resolve("unused"),
	has: () => false,
	names: () => [],
};

const testConfig = (model = "zai/glm-5.3-flash", thinking: Config["thinking"] = "medium"): Config =>
	({
		providers: {
			zai: { kind: "openai-compatible", baseUrl: "https://example.com/v1", auth: "zai" },
		},
		model,
		tts: false,
		favorites: [],
		thinking,
		allowedUsers: [1],
		telegram: { dmGapMinutes: 45 },
		http: { port: 8787 },
		logLevel: "info",
	}) as Config;

interface Recorded {
	prompt: LanguageModelV4CallOptions["prompt"];
	providerOptions: LanguageModelV4CallOptions["providerOptions"];
	maxOutputTokens: number | undefined;
	abortSignal: AbortSignal | undefined;
	tools: unknown;
}

type Responder = (
	opts: LanguageModelV4CallOptions,
) => LanguageModelV4GenerateResult | Promise<LanguageModelV4GenerateResult>;

const answer = (text: string, finishReason: "stop" | "length" = "stop"): LanguageModelV4GenerateResult => ({
	content: [{ type: "text", text }],
	finishReason: { unified: finishReason, raw: undefined },
	warnings: [],
	usage: {
		inputTokens: { total: 10, noCache: undefined, cacheRead: 4, cacheWrite: undefined },
		outputTokens: { total: 3, text: undefined, reasoning: undefined },
	},
});

// The provider-edge fake; `resolvedAs` records the modelRef resolve was
// asked for so tests see which configured model the call used.
function setup(respond: Responder) {
	const calls: Recorded[] = [];
	const resolvedAs: string[] = [];
	const model = {
		specificationVersion: "v4",
		provider: "fake",
		modelId: "fake-1",
		supportedUrls: {},
		async doGenerate(opts: LanguageModelV4CallOptions) {
			calls.push({
				prompt: opts.prompt,
				providerOptions: opts.providerOptions,
				maxOutputTokens: opts.maxOutputTokens,
				abortSignal: opts.abortSignal,
				tools: opts.tools,
			});
			return respond(opts);
		},
	} as unknown as LanguageModel;
	const configRef: ConfigRef = { current: testConfig(), ttsDown: false };
	const deps = {
		configRef,
		auth: NO_AUTH,
		resolve: (_cfg: Config, _auth: AuthStore, modelRef: string) => {
			resolvedAs.push(modelRef);
			return Promise.resolve(model);
		},
	};
	return { calls, resolvedAs, deps, configRef };
}

const QUERY = { noteId: "n-1", selection: "some **old** text", instruction: "make it terse" };

describe("generateNoteRewrite", () => {
	test("the configured root model/thinking drives one bare generate", async () => {
		const { calls, resolvedAs, deps } = setup(() => answer("terse text"));
		const out = await generateNoteRewrite(deps, QUERY);
		expect(out).toBe("terse text");
		// Root cfg.model — not titleModel, not a vision pick.
		expect(resolvedAs).toEqual(["zai/glm-5.3-flash"]);
		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		// The lead-authored instructions ride verbatim as the system
		// head; the user message is the JSON envelope and nothing else.
		const system = call.prompt.filter((m) => m.role === "system");
		expect(system).toHaveLength(1);
		expect((system[0] as { content: string }).content).toBe(NOTE_REWRITE_INSTRUCTIONS);
		const user = call.prompt.filter((m) => m.role === "user");
		expect(user).toHaveLength(1);
		expect((user[0] as { content: unknown[] }).content).toEqual([
			{ type: "text", text: JSON.stringify({ selection: QUERY.selection, instruction: QUERY.instruction }) },
		]);
		// thinking=medium on a GLM route produces provider options; no tools.
		expect(call.providerOptions).toBeTruthy();
		expect(call.tools === undefined || (call.tools as unknown[]).length === 0).toBe(true);
		expect(call.maxOutputTokens).toBe(8192);
	});

	test("literal Markdown — including a fence — passes through untouched", async () => {
		const md = "```ts\nconst x = 1;\n```\n\n**bold** and a [link](https://x)";
		const { deps } = setup(() => answer(md));
		expect(await generateNoteRewrite(deps, QUERY)).toBe(md);
	});

	test("empty output, truncation, and provider errors all refuse", async () => {
		for (const respond of [
			() => answer("   \n  "),
			() => answer("half a passage", "length"),
			() => {
				throw new Error("provider 502");
			},
		]) {
			const { deps } = setup(respond);
			await expect(generateNoteRewrite(deps, QUERY)).rejects.toThrow();
		}
	});

	test("a retryable provider refusal is not retried — maxRetries 0", async () => {
		const { calls, deps } = setup(() => {
			throw new APICallError({
				message: "provider 503",
				url: "https://example.invalid",
				requestBodyValues: {},
				statusCode: 503,
				isRetryable: true,
			});
		});
		await expect(generateNoteRewrite(deps, QUERY)).rejects.toThrow("provider 503");
		expect(calls).toHaveLength(1);
	});

	test("model resolution failures log the same failure line", async () => {
		const lines: string[] = [];
		setLogFile("/tmp/note-rewrite-test.log");
		setLogWriter((_path, line) => lines.push(line));
		try {
			const deps = {
				...setup(() => answer("x")).deps,
				resolve: () => Promise.reject(new Error("auth ref missing")),
			};
			await expect(
				generateNoteRewrite(deps, QUERY),
			).rejects.toThrow("auth ref missing");
		} finally {
			setLogWriter(null);
			setLogFile(null);
		}
		const rewrite = lines
			.map((l) => JSON.parse(l) as { msg?: string; outcome?: string; error?: string })
			.filter((l) => l.msg === "note rewrite");
		expect(rewrite).toHaveLength(1);
		expect(rewrite[0]!.outcome).toBe("failed");
		expect(rewrite[0]!.error).toContain("auth ref missing");
	});

	test("empty output is a failure, never logged as ok", async () => {
		const lines: string[] = [];
		setLogFile("/tmp/note-rewrite-test.log");
		setLogWriter((_path, line) => lines.push(line));
		try {
			const { deps } = setup(() => answer("   "));
			await expect(generateNoteRewrite(deps, QUERY)).rejects.toThrow("empty rewrite");
		} finally {
			setLogWriter(null);
			setLogFile(null);
		}
		const outcomes = lines
			.map((l) => JSON.parse(l) as { msg?: string; outcome?: string })
			.filter((l) => l.msg === "note rewrite")
			.map((l) => l.outcome);
		expect(outcomes).toEqual(["failed"]);
	});

	test("the caller's abort signal propagates — no usable proposal", async () => {
		const controller = new AbortController();
		const { calls, deps } = setup(
			(opts) =>
				new Promise<LanguageModelV4GenerateResult>((_resolve, reject) => {
					const s = opts.abortSignal;
					if (s === undefined) return;
					// Cooperative cancellation — a provider checks the flag,
					// it can't rely on a listener for a past abort.
					if (s.aborted) {
						reject(s.reason as Error);
						return;
					}
					s.addEventListener("abort", () => reject(s.reason as Error));
				}),
		);
		const pending = generateNoteRewrite(deps, { ...QUERY, signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toThrow();
		expect(calls).toHaveLength(1);
		expect(calls[0]!.abortSignal?.aborted).toBe(true);
	});

	test("a config change between calls picks up the new model", async () => {
		const { resolvedAs, deps, configRef } = setup(() => answer("x"));
		await generateNoteRewrite(deps, QUERY);
		configRef.current = testConfig("zai/glm-5.2");
		await generateNoteRewrite(deps, QUERY);
		expect(resolvedAs).toEqual(["zai/glm-5.3-flash", "zai/glm-5.2"]);
	});
});

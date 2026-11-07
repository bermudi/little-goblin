import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	LanguageModelV4,
	LanguageModelV4CallOptions,
	LanguageModelV4FunctionTool,
	LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { recordedModel, requestHash, StaleRecordingError } from "./model-replay.ts";
import { tmpDir } from "../testkit.ts";

const RERECORD = "GOBLIN_MODEL_RECORD=1 bun test src/testkit/model-replay.test.ts";

function inner(parts: LanguageModelV4StreamPart[], modelId = "inner-1"): LanguageModelV4 {
	return {
		specificationVersion: "v4",
		provider: "fake",
		modelId,
		supportedUrls: {},
		async doGenerate(): Promise<never> {
			throw new Error("unimplemented doGenerate");
		},
		async doStream() {
			return {
				stream: new ReadableStream<LanguageModelV4StreamPart>({
					start(controller) {
						for (const part of parts) controller.enqueue(part);
						controller.close();
					},
				}),
			};
		},
	};
}

async function collect(
	model: LanguageModelV4,
	options: LanguageModelV4CallOptions,
): Promise<LanguageModelV4StreamPart[]> {
	const { stream } = await model.doStream(options);
	const reader = stream.getReader();
	const parts: LanguageModelV4StreamPart[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		parts.push(value);
	}
	return parts;
}

const fnTool = (
	name: string,
	description: string,
	inputSchema: LanguageModelV4FunctionTool["inputSchema"],
): LanguageModelV4FunctionTool => ({ type: "function", name, description, inputSchema });

const baseOptions = (
	over: Partial<LanguageModelV4CallOptions> = {},
): LanguageModelV4CallOptions => ({
	prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
	...over,
});

describe("requestHash", () => {
	test("ignores key order, providerOptions at any depth, abortSignal and headers", () => {
		const tool = fnTool("probe", "desc", { type: "object", properties: {} });
		const a = requestHash(
			baseOptions({
				tools: [tool],
				toolChoice: { type: "auto" },
				providerOptions: { codex: { reasoningEffort: "none" } },
			}),
		);
		// Same request, keys reordered and ignored fields added.
		const reorderedPrompt: LanguageModelV4CallOptions["prompt"] = [
			{
				role: "user",
				content: [{ type: "text", text: "hi", providerOptions: { x: { y: 1 } } }],
			},
		];
		const b = requestHash(
			baseOptions({
				prompt: reorderedPrompt,
				toolChoice: { type: "auto" },
				tools: [
					{
						inputSchema: { properties: {}, type: "object" },
						description: "desc",
						name: "probe",
						type: "function",
						providerOptions: { codex: { nested: true } },
					},
				],
				headers: { "x-test": "1" },
				abortSignal: new AbortController().signal,
				maxOutputTokens: 64,
			}),
		);
		expect(b).toBe(a);
	});

	test("changes when the prompt, a tool description, or a tool schema changes", () => {
		const tool = fnTool("probe", "desc", { type: "object" });
		const base = requestHash(baseOptions({ tools: [tool] }));
		expect(
			requestHash(
				baseOptions({
					prompt: [{ role: "user", content: [{ type: "text", text: "bye" }] }],
					tools: [tool],
				}),
			),
		).not.toBe(base);
		expect(
			requestHash(baseOptions({ tools: [fnTool("probe", "other desc", { type: "object" })] })),
		).not.toBe(base);
		expect(
			requestHash(
				baseOptions({ tools: [fnTool("probe", "desc", { type: "object", required: ["a"] })] }),
			),
		).not.toBe(base);
		expect(requestHash(baseOptions({ tools: [tool], toolChoice: { type: "none" } }))).not.toBe(
			base,
		);
	});
});

describe("recordedModel", () => {
	test("a missing cassette is a stale error naming the path and the re-record command", async () => {
		const path = join(tmpDir(), "missing.json");
		const model = recordedModel({ path, rerecord: RERECORD });
		const err = await collect(model, baseOptions()).then(
			() => {
				throw new Error("expected doStream to reject");
			},
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(StaleRecordingError);
		expect((err as Error).message).toContain(path);
		expect((err as Error).message).toContain(RERECORD);
	});

	test("a hash mismatch is a stale error naming the path and the re-record command", async () => {
		const path = join(tmpDir(), "stale.json");
		writeFileSync(
			path,
			`${JSON.stringify({ version: 1, model: "inner-1", requestHash: "0".repeat(64), parts: [] })}\n`,
		);
		const model = recordedModel({ path, rerecord: RERECORD });
		const err = await collect(model, baseOptions()).then(
			() => {
				throw new Error("expected doStream to reject");
			},
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(StaleRecordingError);
		expect((err as Error).message).toContain(path);
		expect((err as Error).message).toContain(RERECORD);
	});

	test("an invalid cassette throws a normal error with the path, not a stale error", async () => {
		const options = baseOptions();
		const path = join(tmpDir(), "invalid.json");
		writeFileSync(
			path,
			`${JSON.stringify({
				version: 1,
				model: "inner-1",
				requestHash: requestHash(options),
				parts: [{ type: "bogus-part" }],
			})}\n`,
		);
		const model = recordedModel({ path, rerecord: RERECORD });
		const err = await collect(model, options).then(
			() => {
				throw new Error("expected doStream to reject");
			},
			(e: unknown) => e,
		);
		expect(err).not.toBeInstanceOf(StaleRecordingError);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain(path);
	});

	test("record scrubs reasoning, response metadata, providerMetadata and usage", async () => {
		const path = join(tmpDir(), "recorded.json");
		const parts: LanguageModelV4StreamPart[] = [
			{ type: "stream-start", warnings: [{ type: "unsupported", feature: "x" }] },
			{ type: "reasoning-start", id: "r1" },
			{ type: "reasoning-delta", id: "r1", delta: "SECRET-SENTINEL" },
			{ type: "reasoning-end", id: "r1" },
			{ type: "response-metadata", id: "resp-1", modelId: "inner-1" },
			{ type: "text-start", id: "t1" },
			{ type: "text-delta", id: "t1", delta: "hi", providerMetadata: { t: { s: 1 } } },
			{ type: "text-end", id: "t1" },
			{
				type: "tool-call",
				toolCallId: "c1",
				toolName: "probe",
				input: "{}",
				providerMetadata: { codex: { secret: "SECRET-SENTINEL" } },
			},
			{
				type: "finish",
				finishReason: { unified: "tool-calls", raw: "completed" },
				usage: {
					inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
					outputTokens: { total: 9, text: 5, reasoning: 4 },
					raw: { account: "SECRET-SENTINEL" },
				},
				providerMetadata: { codex: { quota: "SECRET-SENTINEL" } },
			},
		];
		const model = recordedModel({ path, rerecord: RERECORD, record: inner(parts) });
		await collect(model, baseOptions());
		const saved = readFileSync(path, "utf8");
		expect(saved).not.toContain("SECRET-SENTINEL");
		expect(saved).not.toContain("reasoning");
		expect(saved).not.toContain("providerMetadata");
		const cassette = JSON.parse(saved) as { parts: LanguageModelV4StreamPart[] };
		expect(cassette.parts.map((p) => p.type)).toEqual([
			"stream-start",
			"text-start",
			"text-delta",
			"text-end",
			"tool-call",
			"finish",
		]);
	});

	test("replay emits exactly what record emitted; substitute changes emitted input only", async () => {
		const path = join(tmpDir(), "roundtrip.json");
		const parts: LanguageModelV4StreamPart[] = [
			{ type: "stream-start", warnings: [] },
			{ type: "tool-input-start", id: "c1", toolName: "probe" },
			{ type: "tool-input-delta", id: "c1", delta: '{"responsibility":"r-12"}' },
			{ type: "tool-input-end", id: "c1" },
			{
				type: "tool-call",
				toolCallId: "c1",
				toolName: "probe",
				input: '{"responsibility":"r-12"}',
			},
			{
				type: "finish",
				finishReason: { unified: "tool-calls", raw: undefined },
				usage: {
					inputTokens: {
						total: 1,
						noCache: undefined,
						cacheRead: undefined,
						cacheWrite: undefined,
					},
					outputTokens: { total: 1, text: undefined, reasoning: undefined },
				},
			},
		];
		const substitute = { "r-12": "resp-real-id" };
		const recorded = recordedModel({
			path,
			rerecord: RERECORD,
			substitute,
			record: inner(parts),
		});
		const emittedRecord = await collect(recorded, baseOptions());
		const replayed = recordedModel({ path, rerecord: RERECORD, substitute });
		const emittedReplay = await collect(replayed, baseOptions());
		expect(emittedReplay).toEqual(emittedRecord);
		const toolCall = emittedReplay.find((p) => p.type === "tool-call");
		expect(toolCall?.type === "tool-call" && toolCall.input).toContain("resp-real-id");
		const delta = emittedReplay.find((p) => p.type === "tool-input-delta");
		expect(delta?.type === "tool-input-delta" && delta.delta).toContain("resp-real-id");
		const saved = readFileSync(path, "utf8");
		expect(saved).toContain("r-12");
		expect(saved).not.toContain("resp-real-id");
	});

	test("record rejects on an inner error part and writes nothing", async () => {
		const path = join(tmpDir(), "errored.json");
		const parts: LanguageModelV4StreamPart[] = [
			{ type: "stream-start", warnings: [] },
			{ type: "text-start", id: "t1" },
			{ type: "error", error: new Error("provider exploded") },
		];
		const model = recordedModel({ path, rerecord: RERECORD, record: inner(parts) });
		const err = await collect(model, baseOptions()).then(
			() => {
				throw new Error("expected doStream to reject");
			},
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain(path);
		expect(existsSync(path)).toBe(false);
	});

	test("record rejects when the inner stream ends without a finish part", async () => {
		const path = join(tmpDir(), "unfinished.json");
		const parts: LanguageModelV4StreamPart[] = [
			{ type: "stream-start", warnings: [] },
			{ type: "text-start", id: "t1" },
			{ type: "text-delta", id: "t1", delta: "truncated" },
		];
		const model = recordedModel({ path, rerecord: RERECORD, record: inner(parts) });
		const err = await collect(model, baseOptions()).then(
			() => {
				throw new Error("expected doStream to reject");
			},
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain(path);
		expect(existsSync(path)).toBe(false);
	});
});

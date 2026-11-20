// These fakes pin AI SDK generateText/doGenerate result and tool-call wire behavior.
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { APICallError } from "@ai-sdk/provider";
import { defineTool } from "../tool.ts";
import { generateModel } from "../testkit/fake-model.ts";
import { generate } from "./generate.ts";

describe("generate", () => {
	test("returns model text, finish reason, and complete usage", async () => {
		const fake = generateModel(() => ({
			content: [{ type: "text", text: "answer" }],
			finishReason: { unified: "stop", raw: undefined },
			warnings: [],
			usage: {
				inputTokens: { total: 12, noCache: 5, cacheRead: 4, cacheWrite: 3 },
				outputTokens: { total: 7, text: 6, reasoning: 1 },
			},
		}));
		const result = await generate({
			call: { model: fake.model },
			instructions: "system",
			prompt: "user",
		});
		expect(result).toEqual({
			text: "answer",
			finishReason: "stop",
			usage: {
				inputTokens: 12,
				inputTokenDetails: {
					noCacheTokens: 5,
					cacheReadTokens: 4,
					cacheWriteTokens: 3,
				},
				outputTokens: 7,
				outputTokenDetails: { textTokens: 6, reasoningTokens: 1 },
				totalTokens: 19,
			},
			steps: 1,
			toolCalls: 0,
		});
	});

	test("executes goblin tools, counts calls and steps, and respects the step cap", async () => {
		const fake = generateModel((_options, index) =>
			index === 0
				? {
						content: [
							{
								type: "tool-call",
								toolCallId: "call-1",
								toolName: "probe",
								input: '{"value":"ran"}',
							},
						],
						finishReason: { unified: "tool-calls", raw: undefined },
						warnings: [],
						usage: {
							inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
							outputTokens: { total: 1, text: undefined, reasoning: undefined },
						},
					}
				: {
						content: [{ type: "text", text: "done" }],
						finishReason: { unified: "stop", raw: undefined },
						warnings: [],
						usage: {
							inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
							outputTokens: { total: 1, text: undefined, reasoning: undefined },
						},
					},
		);
		const executed: string[] = [];
		const result = await generate({
			call: { model: fake.model },
			instructions: "system",
			prompt: "user",
			tools: {
				probe: defineTool({
					description: "Record execution",
					input: z.object({ value: z.string() }),
					execute: ({ value }) => {
						executed.push(value);
						return value;
					},
				}),
			},
			maxSteps: 2,
		});
		expect(executed).toEqual(["ran"]);
		expect(result).toMatchObject({ text: "done", steps: 2, toolCalls: 1 });
		expect(fake.generateCalls).toHaveLength(2);
	});

	test("rejects an already-aborted signal", async () => {
		const fake = generateModel(() => {
			throw new Error("model must not run");
		});
		const controller = new AbortController();
		controller.abort();
		await expect(
			generate({
				call: { model: fake.model },
				instructions: "system",
				prompt: "user",
				signal: controller.signal,
			}),
		).rejects.toThrow();
		expect(fake.generateCalls).toHaveLength(1);
		expect(fake.generateCalls[0]?.abortSignal?.aborted).toBe(true);
	});

	test("passes model-call options through to the provider", async () => {
		const fake = generateModel(() => ({
			content: [{ type: "text", text: "ok" }],
			finishReason: { unified: "stop", raw: undefined },
			warnings: [],
			usage: {
				inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
				outputTokens: { total: 1, text: undefined, reasoning: undefined },
			},
		}));
		await generate({
			call: {
				model: fake.model,
				providerOptions: { "openai-compatible": { reasoningEffort: "low" } },
				maxRetries: 0,
				maxOutputTokens: 123,
			},
			instructions: "system",
			prompt: "user",
		});
		expect(fake.generateCalls[0]).toMatchObject({
			providerOptions: { "openai-compatible": { reasoningEffort: "low" } },
			maxOutputTokens: 123,
		});
		expect(fake.generateCalls).toHaveLength(1);

		const retryFake = generateModel(() => {
			throw new APICallError({
				message: "retryable",
				url: "https://example.invalid",
				requestBodyValues: {},
				statusCode: 503,
				isRetryable: true,
			});
		});
		await expect(
			generate({
				call: { model: retryFake.model, maxRetries: 0 },
				instructions: "system",
				prompt: "user",
			}),
		).rejects.toThrow("retryable");
		expect(retryFake.generateCalls).toHaveLength(1);
	});
});

import { describe, expect, test } from "bun:test";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText } from "ai";
import { openStore } from "../conversation.ts";
import { resolveSkillRef } from "../agent/skill-inject.ts";
import { useHome, tmpDb } from "../testkit.ts";
import { defineTool } from "../tool.ts";
import { toToolSet } from "./ai-sdk-tools.ts";
import { generateModel, textResult } from "../testkit/fake-model.ts";
import { ADDITIONAL_TOOLS_PREFIX } from "../agent/tool-declarations.ts";
import { makePrefixFlush, makePrefixSummarizer } from "./prefix-summary.ts";
import { buildModelView, type ViewContext } from "./view.ts";
import { z } from "zod";

describe("prefix split request identity", () => {
	test("the cut request is the last turn wire request through the cut event parts", async () => {
		useHome("goblin-prefix-cut-");
		const store = openStore(tmpDb("goblin-prefix-cut-"));
		const conv = store.resolve({ kind: "dm", chatId: 74 }, "/w");
		try {
			const detail = [
				{
					id: "u1",
					role: "user" as const,
					parts: [{ type: "text" as const, text: "do the work" }],
				},
				{
					id: "a1",
					role: "assistant" as const,
					parts: [
						{ type: "step-start" as const },
						{
							type: "tool-bash" as const,
							toolCallId: "call-1",
							state: "output-available" as const,
							input: { command: "true" },
							output: "ok",
						},
						{ type: "text" as const, text: "completed first step" },
						{ type: "step-start" as const },
						{ type: "text" as const, text: "later step" },
					],
				},
			];
			store.append(conv.id, detail, { anchorSeq: 1 });
			const wireRequests: Record<string, unknown>[] = [];
			const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
				if (typeof init?.body !== "string") throw new Error("fake provider received no JSON request body");
				const parsed: unknown = JSON.parse(init.body);
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
					throw new Error("fake provider request was not a JSON object");
				}
				const body = parsed as Record<string, unknown>;
				wireRequests.push(body);
				if (body.stream === true) {
					const id = `chatcmpl-${wireRequests.length}`;
					const chunks = [
						{
							id,
							object: "chat.completion.chunk",
							created: 1,
							model: "fake-1",
							choices: [
								{ index: 0, delta: { role: "assistant", content: "turn reply" }, finish_reason: null },
							],
						},
						{
							id,
							object: "chat.completion.chunk",
							created: 1,
							model: "fake-1",
							choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						},
					];
					return new Response(
						`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
						{ headers: { "content-type": "text/event-stream" } },
					);
				}
				return new Response(
					JSON.stringify({
						id: `chatcmpl-${wireRequests.length}`,
						object: "chat.completion",
						created: 1,
						model: "fake-1",
						choices: [
							{
								index: 0,
								message: { role: "assistant", content: "checkpoint" },
								finish_reason: "stop",
							},
						],
						usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
					}),
					{ headers: { "content-type": "application/json" } },
				);
			}) as typeof fetch;
			const model = createOpenAICompatible({
				name: "fake",
				baseURL: "https://fake.provider/v1",
				apiKey: "test-key",
				fetch: fakeFetch,
			}).chatModel("fake-1");
			const goblinTools = {
				bash: defineTool({
					description: "A no-op shell check.",
					input: z.object({ command: z.string() }),
					execute: () => "unused",
				}),
			};
			const sdkTools = toToolSet(goblinTools);
			expect(
				makePrefixFlush({
					conv,
					step: {
						modelRef: "fake/fake-1",
						model,
						system: "Frozen system.",
						inputModalities: undefined,
						carries: () => false,
						keepProviderExecuted: false,
					},
					store,
					tools: sdkTools,
					noteExecutor: async () => "unused",
					foldCeiling: () => null,
					assertAuthority: () => {},
				}),
			).toBeNull();
			const context: ViewContext = {
				convId: conv.id,
				modelRef: "fake/fake-1",
				tools: goblinTools,
				modalities: undefined,
				carries: () => false,
				keepProviderExecuted: false,
				skillRef: resolveSkillRef,
			};
			const fullMessages = await buildModelView(context, {
				entries: store.modelEntries(conv.id),
				prior: [],
				current: null,
				partial: null,
				summarySeq: store.memoryEligibility(conv.id).summarySeq,
				ownedSeqs: [],
				assertAuthority: () => {},
			});
			await streamText({
				model,
				instructions: "Frozen system.",
				tools: sdkTools,
				messages: fullMessages,
			}).text;
			const fullTurnRequest = wireRequests[0]!;

			const prefix = makePrefixSummarizer({
				conv,
				step: {
					modelRef: "fake/fake-1",
					model,
					system: "Frozen system.",
					inputModalities: undefined,
					carries: () => false,
					keepProviderExecuted: false,
				},
				store,
				tools: sdkTools,
				foldCeiling: () => null,
				assertAuthority: () => {},
			});
			const checkpointInstruction =
				"The latest user request above and the work after it are the beginning of one long turn that compaction split; the turn's later messages follow this checkpoint verbatim and do not need to be reconstructed. Earlier conversation is summarized separately.\n\n" +
				"Create a concise checkpoint of that request and the progress shown since it, in the operator's dominant language. This checkpoint will be placed before the later messages so the turn can continue with the necessary context.\n\n" +
				"## Original Request\n[What did the user ask for?]\n\n" +
				"## Progress So Far\n- [Key decisions and work completed in these messages]\n\n" +
				"## Context Needed to Continue\n- [Information from these messages needed to understand the later work]\n\n" +
				"Only summarize information explicitly present above. Do not infer or recreate later messages.";
			await prefix.call(
				[{ role: "user", text: checkpointInstruction }],
				new AbortController().signal,
				{ seq: 2, part: 3 },
			);
			const splitRequest = wireRequests[1]!;
			const turnMessages = fullTurnRequest.messages;
			const splitMessages = splitRequest.messages;
			expect(Array.isArray(turnMessages)).toBe(true);
			expect(Array.isArray(splitMessages)).toBe(true);
			if (!Array.isArray(turnMessages) || !Array.isArray(splitMessages)) {
				throw new Error("fake provider captured malformed wire messages");
			}
			const suffixAt = turnMessages.findIndex((message) =>
				JSON.stringify(message).includes("later step"),
			);
			expect(suffixAt).toBeGreaterThan(0);
			const turnMessagesThroughCut = turnMessages.slice(0, suffixAt);
			expect(splitMessages.slice(0, turnMessagesThroughCut.length)).toEqual(turnMessagesThroughCut);
			expect(splitRequest.tools).toEqual(fullTurnRequest.tools);
			const finalMessage = splitMessages.at(-1);
			if (typeof finalMessage !== "object" || finalMessage === null || !("content" in finalMessage)) {
				throw new Error("split request has no final message content");
			}
			const finalContent = finalMessage.content;
			const instructionText =
				typeof finalContent === "string"
					? finalContent
					: Array.isArray(finalContent)
						? finalContent
								.filter(
									(part): part is { type: string; text: string } =>
										typeof part === "object" &&
										part !== null &&
										"type" in part &&
										part.type === "text" &&
										"text" in part &&
										typeof part.text === "string",
								)
								.map((part) => part.text)
								.join("")
						: "";
			expect(instructionText).toBe(checkpointInstruction);
		} finally {
			store.close();
		}
	});

	test("a Codex flush declares the turn's tools when no tool stamp is stored yet", async () => {
		useHome("goblin-prefix-flush-tools-");
		const store = openStore(tmpDb("goblin-prefix-flush-tools-"));
		const conv = store.resolve({ kind: "dm", chatId: 75 }, "/w");
		try {
			store.append(conv.id, [
				{ id: "u1", role: "user" as const, parts: [{ type: "text" as const, text: "remember I like tea" }] },
				{ id: "a1", role: "assistant" as const, parts: [{ type: "text" as const, text: "noted" }] },
			], { anchorSeq: 1 });
			const fake = generateModel(() => textResult("done"));
			const sdkTools = toToolSet({
				note: defineTool({
					description: "Save a durable note.",
					input: z.object({ body: z.string() }),
					execute: () => "unused",
				}),
			});
			const flush = makePrefixFlush({
				conv,
				step: {
					modelRef: "codex/gpt-6-luna",
					model: fake.model,
					system: "Frozen system.",
					inputModalities: undefined,
					carries: () => false,
					keepProviderExecuted: true,
					toolsInInput: true,
				},
				store,
				tools: sdkTools,
				noteExecutor: async () => "saved",
				foldCeiling: () => null,
				assertAuthority: () => {},
			});
			if (flush === null) throw new Error("flush was not built");
			await flush(null, false, new AbortController().signal);
			const prompt = JSON.stringify(fake.generateCalls[0]?.prompt ?? []);
			expect(prompt).toContain(ADDITIONAL_TOOLS_PREFIX);
			expect(prompt).toContain("Save a durable note.");
		} finally {
			store.close();
		}
	});
});

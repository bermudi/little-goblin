import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { streamText, stepCountIs, tool } from "ai";
import { z } from "zod";
import {
	ADDITIONAL_TOOLS_PREFIX,
	INCREMENTAL_TOOLS_NOTICE,
} from "../tool-declarations.ts";
import type { FetchLike } from "./auth.ts";
import { resolveCodexAuthFile } from "./auth.ts";
import { codexModel } from "./model.ts";

const LIVE = process.env.GOBLIN_CODEX_LIVE === "1";
const CACHE_FILLER_SENTENCE =
	"The public cache test repeats this plain sentence to make a long, stable prompt prefix. ";
const CACHE_FILLER = CACHE_FILLER_SENTENCE.repeat(
	Math.ceil(6000 / CACHE_FILLER_SENTENCE.length),
).slice(0, 6000);

interface Seen {
	bodies: Record<string, unknown>[];
}

function observingFetch(): { fetch: FetchLike; seen: Seen } {
	const seen: Seen = { bodies: [] };
	return {
		seen,
		fetch: async (input, init) => {
			seen.bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return globalThis.fetch(input, init);
		},
	};
}

function declaration(name: string, description: string) {
	return {
		type: "function" as const,
		name,
		description,
		parameters: {
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			properties: {},
			additionalProperties: false,
		},
		strict: false,
	};
}

const inputOf = (body: Record<string, unknown> | undefined) =>
	(body?.input ?? []) as Array<Record<string, unknown>>;

test(
	"tool declaration changes append and the model calls the newly added tool (live)",
	async () => {
		if (!LIVE) return;
		const auth = resolveCodexAuthFile(undefined).path;
		const sessionId = randomUUID();
		const one = observingFetch();
		const initialDeclaration = declaration("old_probe", "Return the word old.");
		const initialSystemMessage = {
			role: "system" as const,
			content: `${ADDITIONAL_TOOLS_PREFIX}${JSON.stringify([initialDeclaration])}`,
			providerOptions: { codex: { inInput: true } },
		};
		const initialUserMessage = {
			role: "user" as const,
			content: `${CACHE_FILLER}\nReply with the single word ready.`,
		};
		const first = streamText({
			model: codexModel("gpt-6-luna", auth, one.fetch, { sessionId }),
			messages: [
				initialSystemMessage,
				initialUserMessage,
			],
			tools: {
				old_probe: tool({
					description: initialDeclaration.description,
					inputSchema: z.object({}),
					providerOptions: { openai: { omitFromRequestTools: true } },
					execute: async () => "old",
				}),
			},
			allowSystemInMessages: true,
			maxRetries: 0,
		});
		expect((await first.text).length).toBeGreaterThan(0);
		const firstInput = inputOf(one.seen.bodies[0]);
		expect(firstInput.some((item) => item.type === "additional_tools")).toBe(true);
		const previous = (await first.steps).flatMap((step) => step.response.messages);

		const updatedDeclaration = declaration("old_probe", "Return the word updated.");
		const addedDeclaration = declaration("new_probe", "Return the word newly-added.");
		const two = observingFetch();
		let calledNewTool = false;
		const second = streamText({
			model: codexModel("gpt-6-luna", auth, two.fetch, { sessionId }),
			messages: [
				initialSystemMessage,
				initialUserMessage,
				...previous,
				{
					role: "user",
					content: "Call new_probe exactly once, then answer with its result.",
				},
				{
					role: "system",
					content: INCREMENTAL_TOOLS_NOTICE,
					providerOptions: { codex: { inInput: true } },
				},
				{
					role: "system",
					content: `${ADDITIONAL_TOOLS_PREFIX}${JSON.stringify([updatedDeclaration, addedDeclaration])}`,
					providerOptions: { codex: { inInput: true } },
				},
			],
			tools: {
				old_probe: tool({
					description: updatedDeclaration.description,
					inputSchema: z.object({}),
					providerOptions: { openai: { omitFromRequestTools: true } },
					execute: async () => "updated",
				}),
				new_probe: tool({
					description: addedDeclaration.description,
					inputSchema: z.object({}),
					providerOptions: { openai: { omitFromRequestTools: true } },
					execute: async () => {
						calledNewTool = true;
						return "newly-added";
					},
				}),
			},
			allowSystemInMessages: true,
			stopWhen: stepCountIs(2),
			maxRetries: 0,
		});
		expect(await second.text).toContain("newly-added");
		expect(calledNewTool).toBe(true);
		const input = inputOf(two.seen.bodies[0]);
		expect(JSON.stringify(input.slice(0, firstInput.length))).toBe(JSON.stringify(firstInput));
		expect(input.some((item) => item.type === "additional_tools")).toBe(true);
		const usage = (await second.steps)[0]?.usage;
		expect(usage?.inputTokenDetails.cacheReadTokens ?? 0).toBeGreaterThan(0);
	},
	240_000,
);

import { expect, test } from "bun:test";
import { streamText, stepCountIs, tool } from "ai";
import { z } from "zod";
import type { FetchLike } from "./auth.ts";
import { resolveCodexAuthFile } from "./auth.ts";
import { codexModel } from "./model.ts";

const LIVE = process.env.GOBLIN_CODEX_LIVE === "1";
const PREFIX = "GOBLIN_ADDITIONAL_TOOLS:";

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
		const one = observingFetch();
		const initialDeclaration = declaration("old_probe", "Return the word old.");
		const first = streamText({
			model: codexModel("gpt-6-luna", auth, one.fetch, {}),
			messages: [
				{
					role: "system",
					content: `${PREFIX}${JSON.stringify([initialDeclaration])}`,
					providerOptions: { codex: { inInput: true } },
				},
				{ role: "user", content: "Reply with the single word ready." },
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
		expect(inputOf(one.seen.bodies[0]).some((item) => item.type === "additional_tools")).toBe(true);
		const previous = (await first.steps).flatMap((step) => step.response.messages);

		const updatedDeclaration = declaration("old_probe", "Return the word updated.");
		const addedDeclaration = declaration("new_probe", "Return the word newly-added.");
		const notice =
			"This is an incremental tools update. Previously declared tools remain available unless explicitly marked unavailable. A tool declared again here is available again, and its latest definition replaces the earlier one.\nStill unavailable: none.";
		const two = observingFetch();
		let calledNewTool = false;
		const second = streamText({
			model: codexModel("gpt-6-luna", auth, two.fetch, {}),
			messages: [
				{
					role: "system",
					content: `${PREFIX}${JSON.stringify([initialDeclaration])}`,
					providerOptions: { codex: { inInput: true } },
				},
				...previous,
				{
					role: "system",
					content: notice,
					providerOptions: { codex: { inInput: true } },
				},
				{
					role: "system",
					content: `${PREFIX}${JSON.stringify([updatedDeclaration, addedDeclaration])}`,
					providerOptions: { codex: { inInput: true } },
				},
				{ role: "user", content: "Call new_probe exactly once, then answer with its result." },
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
		expect(input.some((item) => item.type === "additional_tools")).toBe(true);
		const usage = (await second.steps)[0]?.usage;
		expect(usage?.inputTokenDetails.cacheReadTokens ?? 0).toBeGreaterThan(0);
	},
	240_000,
);

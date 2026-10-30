// Live drift check for Codex reasoning retention — run after a codex
// backend change or an adapter change to the replay path:
//
//   GOBLIN_CODEX_LIVE=1 bun test src/agent/codex/model.live.test.ts
//
// This drives ONE real two-step exchange on the operator's own codex
// auth (gpt-6.1-sol, high effort): step 1 forces a reasoning item plus
// a trivial echo tool call, step 2's request body must carry the
// replayed reasoning item. It costs two billed generations and nothing
// else — no writes beyond the requests themselves. Never print tokens,
// ciphers, or request bodies; assertions are on shapes only. Red means
// the retention wire moved: re-check the SSE events and the input-item
// shape against the codex backend and fix the adapter.

import { expect, test } from "bun:test";
import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { CodexLanguageModel } from "./model.ts";
import { resolveCodexAuthFile } from "./auth.ts";

const LIVE = process.env.GOBLIN_CODEX_LIVE === "1";

test(
	"a tool-step request replays the encrypted reasoning item (live)",
	async () => {
		if (!LIVE) return;
		const auth = resolveCodexAuthFile(undefined);
		const bodies: Record<string, unknown>[] = [];
		const model = new CodexLanguageModel("gpt-6.1-sol", auth.path, async (url, init) => {
			bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return fetch(url, init);
		});
		const result = streamText({
			model,
			system:
				"You are a protocol-contract probe. Follow the user's task exactly. Use only the provided tool when requested. Do not browse or run commands.",
			messages: [
				{
					role: "user",
					content:
						"Find the smallest positive integer n such that n mod 17 = 5, n mod 19 = 7, and n mod 23 = 11. Use goblin_contract_echo exactly once to pass your candidate as value. After its result, answer with that integer only.",
				},
			],
			tools: {
				goblin_contract_echo: tool({
					inputSchema: z.object({ value: z.string() }),
					execute: async ({ value }: { value: string }) => value,
				}),
			},
			providerOptions: { codex: { reasoningEffort: "high" } },
			stopWhen: stepCountIs(2),
			maxRetries: 0,
		});
		const text = await result.text;
		expect(text.length).toBeGreaterThan(0);
		expect(bodies.length).toBe(2);
		const step1 = (await result.steps)[0]!;
		const types = step1.content.map((c) => c.type);
		expect(
			types,
			`step-1 content ${types.join(",")} reasoningTokens ${step1.usage.outputTokenDetails?.reasoningTokens ?? "?"}`,
		).toContain("reasoning");
		const input = bodies[1]!.input as Array<Record<string, unknown>>;
		const reasoningIdx = input.findIndex((i) => i.type === "reasoning");
		const callIdx = input.findIndex((i) => i.type === "function_call");
		expect(reasoningIdx).toBeGreaterThanOrEqual(0);
		expect(callIdx).toBeGreaterThanOrEqual(0);
		expect(reasoningIdx).toBeLessThan(callIdx);
		expect(typeof input[reasoningIdx]!.encrypted_content).toBe("string");
		expect((input[reasoningIdx]!.encrypted_content as string).length).toBeGreaterThan(0);
	},
	120_000,
);

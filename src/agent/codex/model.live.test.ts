// Live drift check for Codex reasoning retention — run after a codex
// backend change or an adapter change to the replay path:
//
//   GOBLIN_CODEX_LIVE=1 bun test src/agent/codex/model.live.test.ts
//
// This drives ONE real two-step exchange on the operator's own codex
// auth (gpt-6.1-sol, high effort): step 1 forces a reasoning item plus
// a trivial echo tool call, step 2's request body must carry the
// replayed reasoning item. It also observes the receipts surface —
// response headers are captured, step 1's finish metadata must carry a
// quota with a primary window, and whether request 2 echoed a
// turn-state header is recorded (assert-free: the backend's turn-state
// policy over HTTP is what we're learning). It costs two billed
// generations and nothing else — no writes beyond the requests
// themselves. Never print tokens, ciphers, or request bodies;
// assertions are on shapes only. Red means the retention wire moved:
// re-check the SSE events and the input-item shape against the codex
// backend and fix the adapter.

import { expect, test } from "bun:test";
import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { log } from "../../log.ts";
import { CodexLanguageModel } from "./model.ts";
import { quotaFromMetadata } from "./receipts.ts";
import { resolveCodexAuthFile } from "./auth.ts";

const LIVE = process.env.GOBLIN_CODEX_LIVE === "1";

test(
	"a tool-step request replays the encrypted reasoning item (live)",
	async () => {
		if (!LIVE) return;
		const auth = resolveCodexAuthFile(undefined);
		const bodies: Record<string, unknown>[] = [];
		const respHeaders: Record<string, string>[] = [];
		const reqHeaders: Record<string, string>[] = [];
		const model = new CodexLanguageModel("gpt-6.1-sol", auth.path, async (url, init) => {
			bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			const h: Record<string, string> = {};
			new Headers(init?.headers).forEach((v, k) => (h[k] = v));
			reqHeaders.push(h);
			const res = await fetch(url, init);
			const rh: Record<string, string> = {};
			res.headers.forEach((v, k) => (rh[k] = v));
			respHeaders.push(rh);
			return res;
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
		// Receipts: step 1's finish metadata must carry a quota with a
		// primary window.
		const quota = quotaFromMetadata(step1.providerMetadata);
		expect(
			quota?.primary,
			`quota ${JSON.stringify(quota)}`,
		).not.toBeNull();
		// Assert-free observation: does the backend issue x-codex-turn-state
		// over HTTP, and did request 2 echo it? Value never printed.
		const issued = respHeaders[0]!["x-codex-turn-state"] !== undefined;
		const echoed = reqHeaders[1]!["x-codex-turn-state"] !== undefined;
		log.info("codex live turn-state observation", {
			issued,
			echoed,
			windowMinutes: quota?.primary?.windowMinutes ?? null,
			usedPercent: quota?.primary?.usedPercent ?? null,
		});
	},
	120_000,
);

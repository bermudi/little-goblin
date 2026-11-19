// Live drift check for the codex edge on the stock Responses model —
// run after a codex backend change, an `@ai-sdk/openai` upgrade, or an
// edge change:
//
//   GOBLIN_CODEX_LIVE=1 bun test src/agent/codex/model.live.test.ts
//
// Real billed calls on the operator's own codex auth, nothing else (no
// writes beyond the requests themselves):
//   L1 gpt-6.1-terra, high effort: a tool step replays the encrypted
//      reasoning item; step 1's finish metadata carries a header quota.
//   L2 gpt-6-luna: a number only visible in a normal-font image tool result
//      reaches the model (#731). Colour quadrants and a 5×7 bitmap font proved
//      unreliable on luna (2026-11-19); a normal rendered font read correctly.
//   L3 gpt-6-luna: a hosted web_search turn, replayed into turn 2 from
//      its stored (codex-namespace) parts, is accepted.
//   L4 gpt-6-luna: generateText (side-job path) works over the stream.
//   L5 gpt-6-luna search turn replayed into a gpt-6.1-terra turn (a
//      different replayScope): the scopeless web_search_call item is
//      accepted cross-model.
// Never print tokens, ciphers, or request bodies; assertions are on
// shapes only. Red means the wire moved: re-check against the backend
// and fix the edge in model.ts.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { generateText, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { log } from "../../log.ts";
import { toToolSet } from "../../turn/ai-sdk-tools.ts";
import type { FetchLike } from "./auth.ts";
import { resolveCodexAuthFile } from "./auth.ts";
import { codexModel } from "./model.ts";
import { quotaFromMetadata } from "./receipts.ts";

const LIVE = process.env.GOBLIN_CODEX_LIVE === "1";

interface Observed {
	bodies: Record<string, unknown>[];
	reqHeaders: Headers[];
	respHeaders: Headers[];
	statuses: number[];
}

function observingFetch(): { fetch: FetchLike; seen: Observed } {
	const seen: Observed = { bodies: [], reqHeaders: [], respHeaders: [], statuses: [] };
	return {
		seen,
		fetch: async (url, init) => {
			seen.bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			seen.reqHeaders.push(new Headers(init?.headers));
			const res = await fetch(url, init);
			seen.respHeaders.push(res.headers);
			seen.statuses.push(res.status);
			return res;
		},
	};
}

const inputOf = (body: Record<string, unknown> | undefined) =>
	(body?.input ?? []) as Array<Record<string, unknown>>;

test(
	"L1: a tool-step request replays the encrypted reasoning item; finish carries the quota (live)",
	async () => {
		if (!LIVE) return;
		const { fetch: f, seen } = observingFetch();
		const model = codexModel("gpt-6.1-terra", resolveCodexAuthFile(undefined).path, f, {});
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
		expect(seen.bodies.length).toBe(2);
		const step1 = (await result.steps)[0]!;
		const types = step1.content.map((c) => c.type);
		expect(types, `step-1 content ${types.join(",")}`).toContain("reasoning");
		const input = inputOf(seen.bodies[1]);
		const reasoningIdx = input.findIndex((i) => i.type === "reasoning");
		const callIdx = input.findIndex((i) => i.type === "function_call");
		expect(reasoningIdx).toBeGreaterThanOrEqual(0);
		expect(callIdx).toBeGreaterThan(reasoningIdx);
		expect(typeof input[reasoningIdx]!.id).toBe("string");
		expect(typeof input[reasoningIdx]!.encrypted_content).toBe("string");
		const quota = quotaFromMetadata(step1.providerMetadata);
		expect(quota?.primary ?? null, `quota present: ${quota !== null}`).not.toBeNull();
		log.info("codex live turn-state observation", {
			issued: seen.respHeaders[0]!.get("x-codex-turn-state") !== null,
			echoed: seen.reqHeaders[1]!.get("x-codex-turn-state") !== null,
			windowMinutes: quota?.primary?.windowMinutes ?? null,
		});
	},
	180_000,
);

test(
	"L2: an image in a tool result reaches the model (live, #731)",
	async () => {
		if (!LIVE) return;
		const { fetch: f, seen } = observingFetch();
		// The number is unknowable without reading the image.
		const png: Uint8Array = readFileSync(new URL("./fixtures/number-7241.png", import.meta.url));
		const result = await generateText({
			model: codexModel("gpt-6-luna", resolveCodexAuthFile(undefined).path, f, {}),
			prompt:
				"Call the screenshot tool exactly once. Then reply with only the number shown in the image.",
			tools: {
				screenshot: tool({
					inputSchema: z.object({}),
					execute: async () => "captured",
					toModelOutput: () => ({
						type: "content",
						value: [
							{ type: "text", text: "Screenshot attached." },
							{ type: "file", mediaType: "image/png", data: { type: "data", data: png } },
						],
					}),
				}),
			},
			stopWhen: stepCountIs(2),
			maxRetries: 0,
		});
		const out = inputOf(seen.bodies[1]).find((i) => i.type === "function_call_output");
		const items = Array.isArray(out?.output) ? (out.output as Array<Record<string, unknown>>) : [];
		const image = items.find((i) => i.type === "input_image");
		// The bytes on the wire are exactly the test PNG.
		const url = String(image?.image_url ?? "");
		expect(url.startsWith("data:image/png;base64,")).toBe(true);
		expect(Buffer.from(url.slice("data:image/png;base64,".length), "base64").equals(Buffer.from(png))).toBe(true);
		const digits = result.text.replace(/\D/g, "");
		log.info("codex live image-number observation", { expected: "7241", replyDigits: digits });
		expect(digits, `digits in reply: ${digits}`).toContain("7241");
	},
	180_000,
);

const TURN1_PROMPT =
	"Use web search to find the official OpenAI documentation page about the Responses API web search tool, then answer with its URL only.";

test(
	"L3: a hosted web_search turn replays from its stored parts into the next request (live)",
	async () => {
		if (!LIVE) return;
		const auth = resolveCodexAuthFile(undefined).path;
		const hosted = toToolSet({ web_search: { hosted: "codex.web_search", args: { externalWebAccess: true } } });
		const one = observingFetch();
		const turn1 = streamText({
			model: codexModel("gpt-6-luna", auth, one.fetch, {}),
			messages: [{ role: "user", content: TURN1_PROMPT }],
			tools: hosted,
			providerOptions: { codex: { reasoningEffort: "low" } },
			stopWhen: stepCountIs(2),
			maxRetries: 0,
		});
		const text1 = await turn1.text;
		expect(text1.length).toBeGreaterThan(0);
		const steps1 = await turn1.steps;
		const content1 = steps1.flatMap((s) => s.content);
		expect(
			content1.some((c) => c.type === "tool-call" && c.toolName === "web_search" && c.providerExecuted === true),
			`turn-1 content ${content1.map((c) => c.type).join(",")}`,
		).toBe(true);
		const stored = steps1.flatMap((s) => s.response.messages);
		expect(JSON.stringify(stored)).not.toContain('"openai"');

		const two = observingFetch();
		const turn2 = streamText({
			model: codexModel("gpt-6-luna", auth, two.fetch, {}),
			messages: [{ role: "user", content: TURN1_PROMPT }, ...stored, { role: "user", content: "Reply with the word ok." }],
			tools: hosted,
			providerOptions: { codex: { reasoningEffort: "low" } },
			maxRetries: 0,
		});
		const text2 = await turn2.text;
		expect(two.seen.statuses[0]).toBe(200);
		expect(text2.length).toBeGreaterThan(0);
		const input2 = inputOf(two.seen.bodies[0]);
		log.info("codex live hosted-search observation", {
			replayedWebSearchCall: input2.some((i) => i.type === "web_search_call"),
			replayedReasoning: input2.some((i) => i.type === "reasoning"),
			sourceCount: content1.filter((c) => c.type === "source").length,
		});
	},
	240_000,
);

test(
	"L4: generateText returns text over the stream (live)",
	async () => {
		if (!LIVE) return;
		const { fetch: f, seen } = observingFetch();
		const result = await generateText({
			model: codexModel("gpt-6-luna", resolveCodexAuthFile(undefined).path, f, {}),
			prompt: "Reply with the single word: pong",
			maxRetries: 0,
		});
		expect(seen.bodies[0]!.stream).toBe(true);
		expect(result.text.toLowerCase()).toContain("pong");
	},
	120_000,
);

test(
	"L5: a hosted web_search turn replays into a different model's turn (live)",
	async () => {
		if (!LIVE) return;
		const auth = resolveCodexAuthFile(undefined).path;
		const hosted = toToolSet({ web_search: { hosted: "codex.web_search", args: { externalWebAccess: true } } });
		const turn1 = streamText({
			model: codexModel("gpt-6-luna", auth, observingFetch().fetch, {}),
			messages: [{ role: "user", content: TURN1_PROMPT }],
			tools: hosted,
			providerOptions: { codex: { reasoningEffort: "low" } },
			stopWhen: stepCountIs(2),
			maxRetries: 0,
		});
		expect((await turn1.text).length).toBeGreaterThan(0);
		const steps1 = await turn1.steps;
		const content1 = steps1.flatMap((s) => s.content);
		expect(
			content1.some((c) => c.type === "tool-call" && c.toolName === "web_search" && c.providerExecuted === true),
			`turn-1 content ${content1.map((c) => c.type).join(",")}`,
		).toBe(true);
		const stored = steps1.flatMap((s) => s.response.messages);

		const two = observingFetch();
		const turn2 = streamText({
			model: codexModel("gpt-6.1-terra", auth, two.fetch, {}),
			messages: [{ role: "user", content: TURN1_PROMPT }, ...stored, { role: "user", content: "Reply with the word ok." }],
			tools: hosted,
			providerOptions: { codex: { reasoningEffort: "low" } },
			maxRetries: 0,
		});
		const text2 = await turn2.text;
		expect(two.seen.statuses[0]).toBe(200);
		expect(text2.length).toBeGreaterThan(0);
		const input2 = inputOf(two.seen.bodies[0]);
		expect(input2.some((i) => i.type === "web_search_call")).toBe(true);
		log.info("codex live cross-scope search observation", {
			replayedWebSearchCalls: input2.filter((i) => i.type === "web_search_call").length,
			replayedReasoning: input2.some((i) => i.type === "reasoning"),
		});
	},
	240_000,
);

// Pipe probe for #606: does each provider's tool-result pipe carry an
// image-bearing tool output to the model? Drives ONE real two-step
// exchange per provider kind that has a sanctioned test model
// (AGENTS.md → Tests): openrouter/minimax/minimax-m3.1-flash and
// codex/gpt-6-luna. The `responses` and `openai-compatible` kinds have
// no sanctioned model — their converter evidence is code-level only
// (see design/tools.md).
//
// The tool's toModelOutput returns the AI SDK content shape goblin's
// image variant maps to: a text part plus a file part carrying raw PNG
// bytes. A fetch wrapper captures each request body; the post-tool
// request body is checked for image content inside the tool message,
// and the model's answer is checked for actual image comprehension
// (the probe PNG is four colored quadrants with a black cross).
//
// Credentials resolve through goblin's own auth file
// (GOBLIN_PROBE_AUTH_FILE, default ~/goblin/auth.jsonl) — values are
// never printed. Run from the repo root:
//
//   bun scripts/probe-tool-image.ts
//
// Costs two billed generations per provider. Prints shapes only —
// never tokens, keys, or image bytes.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stepCountIs, streamText, tool } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import { loadAuthFile } from "../src/auth.ts";
import { codexModel } from "../src/agent/codex/model.ts";
import { resolveCodexAuthFile } from "../src/agent/codex/auth.ts";

const AUTH_FILE = process.env.GOBLIN_PROBE_AUTH_FILE ?? join(homedir(), "goblin", "auth.jsonl");
const PNG_PATH = process.env.GOBLIN_PROBE_PNG ?? "/tmp/probe606/probe.png";

const png = new Uint8Array(readFileSync(PNG_PATH));

const FRAME_OUTPUT = {
	type: "content" as const,
	value: [
		{
			type: "text" as const,
			text: "probe frame: four colored quadrants, black cross at center",
		},
		{
			type: "file" as const,
			mediaType: "image/png",
			data: { type: "data" as const, data: png },
		},
	],
};

function imageBearingSpots(body: Record<string, unknown>): string[] {
	// Collect every spot in the request body that carries image content.
	const hits: string[] = [];
	const walk = (v: unknown, path: string): void => {
		if (typeof v === "string") {
			if (v.startsWith("data:image/") || v.includes("image_url") || v.includes("input_image"))
				hits.push(`${path}: ${v.slice(0, 70)}`);
			return;
		}
		if (Array.isArray(v)) {
			v.forEach((item, i) => walk(item, `${path}[${i}]`));
			return;
		}
		if (typeof v === "object" && v !== null) {
			for (const [k, item] of Object.entries(v)) {
				if (
					k === "image" ||
					k === "image_url" ||
					k === "input_image" ||
					k === "file" ||
					k === "mediaType"
				)
					hits.push(`${path}.${k}: ${JSON.stringify(item)?.slice(0, 90)}`);
				walk(item, `${path}.${k}`);
			}
		}
	};
	walk(body, "$");
	return hits;
}

function captureBodies(sink: Record<string, unknown>[]): typeof fetch {
	return (async (url: unknown, init?: unknown) => {
		try {
			sink.push(
				JSON.parse(
					String((init as RequestInit | undefined)?.body ?? "{}"),
				) as Record<string, unknown>,
			);
		} catch {
			sink.push({ unparseable: true });
		}
		return fetch(url as string, init as RequestInit);
	}) as typeof fetch;
}

async function probe(
	name: string,
	model: Parameters<typeof streamText>[0]["model"],
	bodies: Record<string, unknown>[],
): Promise<void> {
	const result = streamText({
		model,
		system: "You are a pipe probe. Call the tool exactly once when asked, then answer the question.",
		messages: [
			{
				role: "user",
				content:
					"Call probe_frame exactly once. Then look at the image in its result and tell me the four quadrant colors, top-left first.",
			},
		],
		tools: {
			probe_frame: tool({
				inputSchema: z.object({}),
				execute: async () => "probe frame captured",
				toModelOutput: async () => FRAME_OUTPUT,
			}),
		},
		stopWhen: stepCountIs(3),
		maxRetries: 0,
	});
	const text = await result.text;
	const steps = await result.steps;
	console.log(`\n=== ${name} ===`);
	console.log(`requests captured: ${bodies.length}, steps: ${steps.length}`);
	console.log(`model answer: ${text.slice(0, 300)}`);
	for (const [i, body] of bodies.entries()) {
		const hits = imageBearingSpots(body);
		console.log(`request ${i + 1}: image-bearing spots = ${hits.length}`);
		for (const h of hits.slice(0, 8)) console.log(`  ${h}`);
	}
}

async function main(): Promise<void> {
	const auth = loadAuthFile(AUTH_FILE);

	// --- openrouter: chat completions, tool message content → image_url ---
	const orKey = await auth.resolve("openrouter");
	const orBodies: Record<string, unknown>[] = [];
	const orModel = createOpenRouter({
		apiKey: orKey,
		fetch: captureBodies(orBodies),
	}).chat("minimax/minimax-m3.1-flash");
	await probe("openrouter/minimax-m3.1-flash", orModel, orBodies);

	// --- codex: custom Responses adapter, gpt-6-luna ---
	const codexAuth = resolveCodexAuthFile(undefined);
	const cxBodies: Record<string, unknown>[] = [];
	const cxModel = codexModel(
		"gpt-6-luna",
		codexAuth.path,
		captureBodies(cxBodies),
		{},
	);
	await probe("codex/gpt-6-luna", cxModel, cxBodies);
}

try {
	await main();
} catch (err) {
	console.error("probe failed:", err instanceof Error ? err.message : err);
	process.exit(1);
}

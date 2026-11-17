// Pipe probe for #606, claude-code leg: does an MCP `image` content
// block in a bridged tool result reach claude-haiku-5-5 as an actual
// image? Drives ONE real exchange through the production path —
// createToolBridge → callToolResult (MCP image block) → the Claude
// Agent SDK → the model.
//
// The probe tool's toModelOutput returns goblin's content shape (text
// + image parts); the bridge maps it to MCP content blocks. The text
// part deliberately does NOT name the quadrant colors, so a correct
// answer can only come from the image arriving.
//
// Credentials resolve through goblin's own auth file
// (GOBLIN_PROBE_AUTH_FILE, default ~/goblin/auth.jsonl) — the token is
// handed to the child env only, never printed. Run from the repo root:
//
//   bun scripts/probe-tool-image-claude.ts
//
// Costs one subscription generation. Prints the model's answer and
// the tool's execution — never tokens, keys, or image bytes.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { loadAuthFile } from "../src/auth.ts";
import { defineTool } from "../src/tool.ts";
import { createToolBridge } from "../src/agent/claude-code/tools.ts";
import { liveQuery } from "../src/agent/claude-code/mod.ts";
import type { ClaudeEvent } from "../src/agent/claude-code/translate.ts";

const AUTH_FILE = process.env.GOBLIN_PROBE_AUTH_FILE ?? join(homedir(), "goblin", "auth.jsonl");
const PNG_PATH = process.env.GOBLIN_PROBE_PNG ?? "/tmp/probe606/probe.png";
const MODEL = process.env.GOBLIN_PROBE_MODEL ?? "claude-haiku-5-5";

const png = new Uint8Array(readFileSync(PNG_PATH));

async function main(): Promise<void> {
	const auth = loadAuthFile(AUTH_FILE);
	if (!auth.has("claude-code")) {
		throw new Error(`no \`claude-code\` record in ${AUTH_FILE}`);
	}
	const token = await auth.resolve("claude-code");
	const configDir = mkdtempSync(join(tmpdir(), "goblin-claude-probe-"));

	let toolRan = false;
	const bridge = createToolBridge({
		convId: "probe606",
		tools: {
			probe_frame: defineTool({
				description: "Captures the current desktop frame",
				input: z.object({}),
				execute: async () => {
					toolRan = true;
					return "frame captured";
				},
				toModelOutput: () => ({
					type: "content",
					value: [
						{
							type: "text",
							text: "probe frame: four colored quadrants, black cross at center",
						},
						{ type: "image", mediaType: "image/png", data: png },
					],
				}),
			}),
		},
	});

	const events: ClaudeEvent[] = [];
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), 120_000);
	try {
		for await (const ev of liveQuery({
			prompt: {
				blocks: [
					{
						kind: "text",
						text: "Call the probe_frame tool exactly once. Then look at the image in its result and tell me the four quadrant colors, top-left first.",
					},
				],
			},
			options: {
				model: MODEL,
				systemPrompt:
					"You are a pipe probe. Call the tool exactly once when asked, then answer the question.",
				maxTurns: 3,
				thinking: { type: "disabled" },
				mcpServers: { goblin: bridge.server() },
				allowedTools: bridge.allowedTools(),
				cwd: configDir,
				env: {
					PATH: process.env.PATH ?? "/usr/bin",
					HOME: configDir,
					CLAUDE_CONFIG_DIR: configDir,
					CLAUDE_CODE_OAUTH_TOKEN: token,
					DISABLE_AUTOUPDATER: "1",
					CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
				},
				abortController: abort,
			},
		})) {
			events.push(ev);
		}
	} finally {
		clearTimeout(timer);
	}

	const result = events.find((e) => e.type === "result");
	const text = events
		.filter((e): e is Extract<ClaudeEvent, { type: "assistant" }> => e.type === "assistant")
		.flatMap((e) => e.message.content)
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "")
		.join("");

	console.log(`\n=== claude-code/${MODEL} ===`);
	console.log(`tool executed in-process: ${toolRan}`);
	console.log(`result isError: ${result?.type === "result" ? result.isError : "no result"}`);
	console.log(`model answer: ${text.slice(0, 400)}`);
}

try {
	await main();
} catch (err) {
	console.error("probe failed:", err instanceof Error ? err.message : err);
	process.exit(1);
}

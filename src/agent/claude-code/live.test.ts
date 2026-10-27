// Live drift check for the claude-code engine: pins the real CLI's
// event stream against the structural types in translate.ts.
//     GOBLIN_CLAUDE_CODE_LIVE=1 \
//     GOBLIN_CLAUDE_CODE_AUTH_FILE=<path-to-auth.jsonl> \
//     bun test src/agent/claude-code/live.test.ts
// Resolves the `claude-code` record through the given auth file — the
// only secret-adjacent environment value is its path. Spends
// subscription quota (one text query + one tool round-trip): run after
// claude-agent-sdk upgrades, not on a schedule. The child's
// CLAUDE_CONFIG_DIR is a per-run temp dir — prod state is never
// touched, and nothing writes ~/.claude.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { loadAuthFile } from "../../auth.ts";
import { liveQuery } from "./mod.ts";
import { createToolBridge } from "./tools.ts";
import type { ClaudeEvent } from "./translate.ts";

const LIVE = process.env.GOBLIN_CLAUDE_CODE_LIVE === "1";
const AUTH_FILE = process.env.GOBLIN_CLAUDE_CODE_AUTH_FILE ?? "";
const MODEL = process.env.GOBLIN_CLAUDE_CODE_MODEL ?? "claude-sonnet-4-5";

describe.skipIf(!LIVE)("claude-code live drift (GOBLIN_CLAUDE_CODE_LIVE=1)", () => {
	let token = "";
	let configDir = "";

	beforeAll(() => {
		if (AUTH_FILE === "") {
			throw new Error(
				"GOBLIN_CLAUDE_CODE_AUTH_FILE is unset — point it at an auth.jsonl with a `claude-code` record; never pass the token itself",
			);
		}
		const auth = loadAuthFile(AUTH_FILE);
		if (!auth.has("claude-code")) {
			throw new Error(`no \`claude-code\` record in ${AUTH_FILE}`);
		}
		// Resolved here, handed to the child env only — never logged.
		return auth.resolve("claude-code").then((t) => {
			token = t;
			configDir = mkdtempSync(join(tmpdir(), "goblin-claude-drift-"));
		});
	});

	afterAll(() => {
		// The temp config dir stays for post-mortem inspection, like the
		// subagent drift artifacts; tmp cleanup owns it.
	});

	async function collect(
		prompt: string,
		over: Partial<Parameters<typeof liveQuery>[0]["options"]> = {},
	): Promise<ClaudeEvent[]> {
		const events: ClaudeEvent[] = [];
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), 120_000);
		try {
			for await (const ev of liveQuery({
				prompt: { blocks: [{ kind: "text", text: prompt }] },
				options: {
					model: MODEL,
					systemPrompt: "You are a drift probe. Obey the instruction exactly.",
					maxTurns: 1,
					thinking: { type: "disabled" },
					mcpServers: {},
					allowedTools: [],
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
					...over,
				},
			})) {
				events.push(ev);
			}
		} finally {
			clearTimeout(timer);
		}
		return events;
	}

	test("a text query produces the pinned frame sequence with real usage", async () => {
		const events = await collect("Reply with exactly: drift-ok");
		const types = events.map((e) => e.type);
		expect(types).toContain("result");
		const result = events.find((e) => e.type === "result");
		expect(result?.type === "result" && !result.isError).toBe(true);
		if (result?.type !== "result") return;
		// The result carries modelUsage keyed by model with camelCase
		// totals, and the main-loop usage with the cache split.
		expect(result.usage).toMatchObject({
			input_tokens: expect.any(Number),
			output_tokens: expect.any(Number),
		});
		expect(result.modelUsage).not.toBeNull();
		const assistant = events.filter((e) => e.type === "assistant");
		expect(assistant.length).toBeGreaterThanOrEqual(1);
		if (assistant[0]?.type !== "assistant") return;
		expect(assistant[0].message.role).toBe("assistant");
		expect(Array.isArray(assistant[0].message.content)).toBe(true);
		const text = assistant
			.filter((e): e is Extract<ClaudeEvent, { type: "assistant" }> => e.type === "assistant")
			.flatMap((e) => e.message.content)
			.filter((b) => b.type === "text")
			.map((b) => b.text ?? "")
			.join("");
		expect(text.toLowerCase()).toContain("drift-ok");
	}, 180_000);

	test("streaming events ride the full block lifecycle", async () => {
		// includePartialMessages is part of liveQuery's fixed options;
		// this probe re-asserts the stream frames exist in lifecycle order.
		const events = await collect("Reply with exactly: stream-ok");
		const streams = events.filter(
			(e): e is Extract<ClaudeEvent, { type: "stream" }> => e.type === "stream",
		);
		const kinds = streams.map((s) => s.event.type);
		expect(kinds).toContain("message_start");
		expect(kinds).toContain("content_block_delta");
		expect(kinds).toContain("message_stop");
		const delta = streams.find((s) => s.event.type === "content_block_delta");
		if (delta?.event.type === "content_block_delta") {
			expect(["text_delta", "thinking_delta", "signature_delta"]).toContain(delta.event.delta.type);
		}
	}, 180_000);

	test("a bridged tool executes in-process and echoes its result", async () => {
		const bridge = createToolBridge({
			convId: "drift",
			tools: {
				drift_probe: tool({
					description: "Returns the fixed string drift-tool-ok",
					inputSchema: z.object({}),
					execute: async () => "drift-tool-ok",
				}),
			},
		});
		let executed = false;
		const wrapped = {
			convId: "drift",
			tools: {
				drift_probe: tool({
					description: "Returns the fixed string drift-tool-ok",
					inputSchema: z.object({}),
					execute: async () => {
						executed = true;
						return "drift-tool-ok";
					},
				}),
			},
		};
		const b2 = createToolBridge(wrapped);
		void bridge;
		const events: ClaudeEvent[] = [];
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), 120_000);
		try {
			for await (const ev of liveQuery({
				prompt: {
					blocks: [
						{
							kind: "text",
							text: "Call the drift_probe tool exactly once, then reply with exactly: tool-ok",
						},
					],
				},
				options: {
					model: MODEL,
					systemPrompt: "You are a drift probe. Obey the instruction exactly.",
					maxTurns: 3,
					thinking: { type: "disabled" },
					mcpServers: { goblin: b2.server() },
					allowedTools: b2.allowedTools(),
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
		// The handler ran in goblin's process (in-process MCP bridge).
		expect(executed).toBe(true);
		// A tool_use block and its echo both appeared with matching ids.
		const toolUse = events
			.filter((e): e is Extract<ClaudeEvent, { type: "assistant" }> => e.type === "assistant")
			.flatMap((e) => e.message.content)
			.find((b) => b.type === "tool_use");
		expect(toolUse).toMatchObject({ name: "drift_probe" });
		const echo = events.find(
			(e): e is Extract<ClaudeEvent, { type: "user" }> =>
				e.type === "user" &&
				typeof e.content !== "string" &&
				e.content.some((b) => b.type === "tool_result" && toolUse && b.tool_use_id === toolUse.id),
		);
		expect(echo).toBeDefined();
		// And adoption finds the exact output.
		expect(b2.adoptResult("drift_probe", {})).toMatchObject({ output: "drift-tool-ok" });
		const result = events.find((e) => e.type === "result");
		expect(result?.type === "result" && !result.isError).toBe(true);
	}, 180_000);
});

// Live drift check for the claude-code engine: pins the real CLI's
// event stream against the structural types in translate.ts.
//     GOBLIN_CLAUDE_CODE_LIVE=1 \
//     GOBLIN_CLAUDE_CODE_AUTH_FILE=<path-to-auth.jsonl> \
//     bun test src/agent/claude-code/live.test.ts
// Resolves the `claude-code` record through the given auth file — the
// only secret-adjacent environment value is its path. Spends
// subscription quota (text queries, tool round-trips, a mid-turn steer): run after
// claude-agent-sdk upgrades, not on a schedule. The child's
// CLAUDE_CONFIG_DIR is a per-run temp dir — prod state is never
// touched, and nothing writes ~/.claude.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { openCacheObservation } from "../../cache-observation.ts";
import { cacheTtlMs } from "./engine.ts";
import { defineTool } from "../../tool.ts";
import { loadAuthFile } from "../../auth.ts";
import { liveQuery } from "./mod.ts";
import { steerChannel } from "./steers.ts";
import { createToolBridge } from "./tools.ts";
import type { ClaudeEvent } from "./translate.ts";

const LIVE = process.env.GOBLIN_CLAUDE_CODE_LIVE === "1";
const AUTH_FILE = process.env.GOBLIN_CLAUDE_CODE_AUTH_FILE ?? "";
const MODEL = process.env.GOBLIN_CLAUDE_CODE_MODEL ?? "claude-haiku-5-5";

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
				drift_probe: defineTool({
					description: "Returns the fixed string drift-tool-ok",
					input: z.object({}),
					execute: async () => "drift-tool-ok",
				}),
			},
		});
		let executed = false;
		const wrapped = {
			convId: "drift",
			tools: {
				drift_probe: defineTool({
					description: "Returns the fixed string drift-tool-ok",
					input: z.object({}),
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
		// Raw SDK frames retain the MCP namespace; only the engine strips it.
		expect(toolUse).toMatchObject({ name: "mcp__goblin__drift_probe" });
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

	test("parallel bridged calls execute under the CLI's own tool_use ids", async () => {
		const executed: Array<{ tag: string; toolCallId: string }> = [];
		const bridge = createToolBridge({
			convId: "drift",
			tools: {
				drift_tag: defineTool({
					description: "Returns the tag it was given",
					input: z.object({ tag: z.string() }),
					execute: async ({ tag }, { toolCallId }) => {
						executed.push({ tag, toolCallId });
						await new Promise((r) => setTimeout(r, 300));
						return `tag-${tag}`;
					},
				}),
			},
		});
		const events = await collect(
			"In ONE message, call drift_tag twice in parallel: once with tag x and once with tag y. Then reply with exactly: tags-ok",
			{ maxTurns: 3, mcpServers: { goblin: bridge.server() }, allowedTools: bridge.allowedTools() },
		);
		const toolUses = events
			.filter((e): e is Extract<ClaudeEvent, { type: "assistant" }> => e.type === "assistant")
			.flatMap((e) => e.message.content)
			.filter((b) => b.type === "tool_use")
			.map((b) => ({ tag: (b.input as { tag: string }).tag, toolCallId: b.id ?? "" }));
		expect(toolUses).toHaveLength(2);
		expect(toolUses.every((u) => u.toolCallId.startsWith("toolu_"))).toBe(true);
		expect([...executed].sort((a, b) => a.tag.localeCompare(b.tag))).toEqual(
			[...toolUses].sort((a, b) => a.tag.localeCompare(b.tag)),
		);
	}, 180_000);

	// #582: a steer pushed while a bridged tool runs (the engine's
	// afterCall seam) goes in with priority "next": the CLI acks it by
	// uuid and answers it in the SAME CLI turn — one result, no
	// follow-up turn.
	test("a steer sent before a tool result folds into the next request", async () => {
		const steers = steerChannel();
		const uuid = crypto.randomUUID();
		const bridge = createToolBridge({
			convId: "drift",
			tools: {
				drift_wait: defineTool({
					description: "Waits briefly, then returns waited",
					input: z.object({}),
					execute: async () => {
						await new Promise((r) => setTimeout(r, 1000));
						return "waited";
					},
				}),
			},
			afterCall: async () => {
				steers.push({
					uuid,
					prompt: {
						blocks: [{ kind: "text", text: "Also include the word PINEAPPLE in your reply." }],
					},
				});
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
							text: "Call the drift_wait tool exactly once, then reply with exactly: wait-ok",
						},
					],
				},
				steers,
				options: {
					model: MODEL,
					systemPrompt:
						"You are a drift probe. Obey the instructions exactly, including ones that arrive mid-task.",
					maxTurns: 5,
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
					persistSession: false,
				},
			})) {
				events.push(ev);
				// The engine stops at the result frame; so does the probe.
				if (ev.type === "result") break;
			}
		} finally {
			steers.close();
			clearTimeout(timer);
		}
		const foldedAt = events.findIndex((e) => e.type === "folded" && e.uuids.includes(uuid));
		const resultAt = events.findIndex((e) => e.type === "result");
		expect(foldedAt).toBeGreaterThanOrEqual(0);
		expect(foldedAt).toBeLessThan(resultAt);
		const result = events[resultAt];
		expect(result?.type === "result" && !result.isError).toBe(true);
		const reply = events
			.slice(foldedAt)
			.filter((e): e is Extract<ClaudeEvent, { type: "assistant" }> => e.type === "assistant")
			.flatMap((e) => e.message.content)
			.filter((b) => b.type === "text")
			.map((b) => b.text ?? "")
			.join("");
		expect(reply.toUpperCase()).toContain("PINEAPPLE");
	}, 180_000);

	// #418: the whole point of the native session — turn two resumes the
	// persisted session at the head uuid turn one ended on, with only the
	// new ask as its prompt, and the model still knows what it was told.
	test("a persisted session resumes at its head and keeps turn-one context", async () => {
		const sessionId = crypto.randomUUID();
		const codeWord = "VELVET-OTTER-42";
		const assistantUuid = (events: ClaudeEvent[]): string | undefined => {
			const last = events.filter((e) => e.type === "assistant").at(-1);
			return last?.type === "assistant" ? last.uuid : undefined;
		};
		const replyText = (events: ClaudeEvent[]): string =>
			events
				.filter((e): e is Extract<ClaudeEvent, { type: "assistant" }> => e.type === "assistant")
				.flatMap((e) => e.message.content)
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join("");

		const first = await collect(
			`Remember this code word exactly: ${codeWord}. Reply with exactly: noted`,
			{ persistSession: true, sessionId },
		);
		const firstResult = first.find((e) => e.type === "result");
		expect(firstResult?.type === "result" && !firstResult.isError).toBe(true);
		const head = assistantUuid(first);
		expect(typeof head).toBe("string");

		// The delta-only second turn: no replay of turn one's prompt —
		// just the question, resumed at the recorded head.
		const second = await collect("What is the code word I gave you? Reply with only the code word.", {
			persistSession: true,
			resume: sessionId,
			resumeSessionAt: head,
		});
		const secondResult = second.find((e) => e.type === "result");
		expect(secondResult?.type === "result" && !secondResult.isError).toBe(true);
		expect(replyText(second).toLowerCase()).toContain(codeWord.toLowerCase());
	}, 360_000);

	test("forked compaction summary reads the warmed turn prefix", async () => {
		// Padded past the provider's minimum cacheable prefix, so a miss
		// means the fork changed the prefix, not that it was too short.
		// The run id keeps an earlier run's cached prefix from turning the
		// warm call into a pure read (no write, so no lifetime reported).
		const systemPrompt = `You are a drift probe. Obey the instruction exactly. Run ${crypto.randomUUID()}.\n${Array.from(
			{ length: 900 },
			(_, i) => `Reference line ${i}: the probe keeps this text stable across requests.`,
		).join("\n")}`;
		const sessionId = crypto.randomUUID();
		const warm = await collect("Reply with exactly: prefix-warmed", {
			systemPrompt,
			persistSession: true,
			sessionId,
		});
		const warmResult = warm.find((e) => e.type === "result");
		expect(warmResult?.type === "result" && !warmResult.isError).toBe(true);
		// The warm call writes the padded prefix to cache; its assistant
		// frame (what finishStep reads) names the lifetime — 1h on a
		// subscription (#734).
		const firstAssistant = warm.find((e) => e.type === "assistant");
		if (firstAssistant?.type !== "assistant") {
			throw new Error("live Claude call emitted no assistant frame");
		}
		const oneHour = firstAssistant.message.usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0;
		expect(oneHour).toBeGreaterThan(0);
		const ttlMs = cacheTtlMs(firstAssistant.message.usage);
		const db = new Database(":memory:");
		const observation = openCacheObservation(db);
		observation
			.begin({
				callId: "live-cache-lifetime",
				conversationId: "app/live-cache-lifetime",
				purpose: null,
				model: MODEL,
				routeKey: "live-route",
				headHash: "h",
				requestHash: "r",
				settingsHash: "s",
				promptHashes: ["live"],
			})
			.finish(undefined, ttlMs);
		expect(
			db.query<{ cache_ttl_ms: number | null }, [string]>(
				"SELECT cache_ttl_ms FROM model_cache_calls WHERE call_id = ?",
			).get("live-cache-lifetime")?.cache_ttl_ms,
		).toBe(3_600_000);
		db.close();
		const head = warm
			.filter((e): e is Extract<ClaudeEvent, { type: "assistant" }> => e.type === "assistant")
			.at(-1)?.uuid;
		expect(typeof head).toBe("string");
		if (typeof head !== "string") return;

		const fork = await collect("Summarize the preceding test exchange in one short sentence.", {
			systemPrompt,
			resume: sessionId,
			resumeSessionAt: head,
			forkSession: true,
			persistSession: false,
			maxTurns: 1,
		});
		const result = fork.find((e) => e.type === "result");
		expect(result?.type === "result" && !result.isError).toBe(true);
		const usage = result?.type === "result" ? result.usage : null;
		const counts = (u: unknown) =>
			typeof u === "object" && u !== null
				? Object.fromEntries(Object.entries(u).filter(([, v]) => typeof v === "number"))
				: u;
		process.stderr.write(
			`fork usage — result: ${JSON.stringify(counts(usage))}; assistant: ${JSON.stringify(
				fork.filter((e) => e.type === "assistant").map((e) => counts(e.message.usage)),
			)}\n`,
		);
		expect(usage?.cache_read_input_tokens ?? 0).toBeGreaterThan(0);
	}, 360_000);
});

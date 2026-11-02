// The claude-code engine's public surface. This module and its siblings
// are the ONLY importers of @anthropic-ai/claude-agent-sdk
// (module-boundaries.test.ts); everything the engine needs from the
// vendor is adapted into the pinned shapes of translate.ts here.

import { randomUUID } from "node:crypto";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { query as vendorQuery } from "@anthropic-ai/claude-agent-sdk";
import { log } from "../../log.ts";
import type { AuthStore } from "../../auth.ts";
import type { CacheObservation } from "../../cache-observation.ts";
import type { ConfigRef } from "../../config.ts";
import type { StreamOutcome, WireMember } from "../../turn/stream.ts";
import type { MediaPosition } from "../attachments.ts";
import type { ClaudeCodeThinking } from "../thinking.ts";
import { claudeChildEnv } from "./auth.ts";
import { type ClaudeEngineConfig, type ClaudeRunDeps, driveClaude } from "./engine.ts";
import type {
	ClaudeEvent,
	ClaudeQuery,
	ClaudeQueryCall,
	ClaudeToolResultBlock,
	PromptContent,
} from "./translate.ts";

// ---------- the step the runtime builds for a claude-code model ----------

export interface ClaudeStep {
	engine: "claude-code";
	/** Config ref "provider/model-id" — labels, telemetry, cache routes. */
	label: string;
	/** The bare model id the child CLI resolves. */
	modelId: string;
	/** auth.jsonl record holding the subscription token. */
	auth: string;
	/** The assembled system prompt (agent/step.ts builds it). */
	system: string;
	thinking: ClaudeCodeThinking;
	// View-assembly gates, same contract as ModelStep's.
	inputModalities?: Set<string> | undefined;
	carries?: ((mediaType: string, position: MediaPosition) => boolean) | undefined;
	contextWindow?: number | undefined;
	/** Optional tool-loop cap; unset = no step budget (design/model.md). */
	maxTurns?: number | undefined;
}

// ---------- the vendor adapter ----------

// PromptContent → the vendor's input: ONE user message yielded on an
// async iterable (the only prompt form that carries media blocks),
// then input closes. The CLI reads the message, runs its loop, and
// pulls again post-turn to find the iterator done.
type VendorBlock = Extract<SDKUserMessage["message"]["content"], unknown[]>[number];

function vendorPrompt(prompt: PromptContent): AsyncIterable<SDKUserMessage> {
	const content: VendorBlock[] = prompt.blocks.map((block): VendorBlock => {
		switch (block.kind) {
			case "text":
				return { type: "text", text: block.text };
			case "image":
				// carriesMedia admits exactly these four image types on the
				// claude-code lane; the cast pins what the gate guaranteed.
				return {
					type: "image",
					source: {
						type: "base64",
						media_type: block.mediaType as "image/gif" | "image/jpeg" | "image/png" | "image/webp",
						data: block.data,
					},
				};
			case "document":
				return {
					type: "document",
					source: {
						type: "base64",
						media_type: "application/pdf" as const,
						data: block.data,
					},
					...(block.filename !== undefined ? { filename: block.filename } : {}),
				};
		}
	});
	return (async function* (): AsyncIterable<SDKUserMessage> {
		yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
	})();
}

// SDKMessage → the pinned ClaudeEvent union. Frames this engine does
// not consume (system chatter, task notifications, hook progress,
// subagent sidechains — parent_tool_use_id set) drop to null.
export function pinEvent(msg: SDKMessage): ClaudeEvent | null {
	switch (msg.type) {
		case "system":
			if (msg.subtype === "init") {
				return {
					type: "init",
					sessionId: msg.session_id,
					...(typeof msg.model === "string" ? { model: msg.model } : {}),
					...("claude_code_version" in msg && typeof msg.claude_code_version === "string"
						? { cliVersion: msg.claude_code_version }
						: {}),
					tools: msg.tools,
					mcpServers: msg.mcp_servers,
				};
			}
			return null;
		case "stream_event":
			if (msg.parent_tool_use_id !== null) return null;
			return { type: "stream", event: msg.event };
		case "assistant": {
			if (msg.parent_tool_use_id !== null) return null;
			return {
				type: "assistant",
				message: msg.message,
				...(msg.error !== undefined ? { error: msg.error } : {}),
			};
		}
		case "user": {
			if (msg.parent_tool_use_id !== null) return null;
			const content =
				typeof msg.message.content === "string"
					? msg.message.content
					: (msg.message.content as unknown[]).filter(
							(b): b is ClaudeToolResultBlock =>
								typeof b === "object" &&
								b !== null &&
								(b as { type?: unknown }).type === "tool_result",
						);
			return {
				type: "user",
				content,
				...(msg.tool_use_result !== undefined ? { toolUseResult: msg.tool_use_result } : {}),
			};
		}
		case "result": {
			// SDKResultError carries errors: string[] instead of result — one
			// projection covers both.
			const text =
				"result" in msg && typeof msg.result === "string"
					? msg.result
					: `${msg.subtype}: ${"errors" in msg ? ((msg.errors as string[]) ?? []).join("; ") : ""}`;
			return {
				type: "result",
				subtype: msg.subtype,
				isError: msg.is_error,
				result: text,
				numTurns: msg.num_turns,
				durationMs: msg.duration_ms,
				totalCostUsd: msg.total_cost_usd,
				usage: msg.usage,
				modelUsage: msg.modelUsage,
				...(msg.terminal_reason !== undefined
					? { terminalReason: msg.terminal_reason as string | null }
					: {}),
			};
		}
		default:
			return null;
	}
}

// The live query: vendor options carry the pinned knobs plus the
// locked harness isolation (no built-in tools, no settings files, no
// session persistence — the engine's own ToolSet through the MCP
// bridge is the whole tool surface).
export function liveQuery(call: ClaudeQueryCall): AsyncIterable<ClaudeEvent> {
	const { prompt, options } = call;
	const vendor = vendorQuery({
		prompt: vendorPrompt(prompt),
		options: {
			model: options.model,
			systemPrompt: options.systemPrompt,
			...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
			thinking: options.thinking,
			...(options.effort !== undefined ? { effort: options.effort } : {}),
			mcpServers: options.mcpServers as never,
			allowedTools: options.allowedTools,
			// allowedTools only auto-approves; `tools: []` is what actually
			// removes the CLI's built-in tools (Bash, Read, Edit, ...).
			tools: [],
			cwd: options.cwd,
			env: options.env,
			abortController: options.abortController,
			...(options.stderr !== undefined ? { stderr: options.stderr } : {}),
			settingSources: [],
			includePartialMessages: true,
			persistSession: false,
			// The prompt is machine-assembled from the conversation view —
			// no @path expansion, no slash-command dispatch on it.
			verbatimPrompts: true,
		},
	});
	return (async function* (): AsyncIterable<ClaudeEvent> {
		for await (const msg of vendor) {
			const pinned = pinEvent(msg);
			if (pinned !== null) yield pinned;
		}
	})();
}

// ---------- the engine handle the runtime holds ----------

export interface ClaudeEngine {
	/** Runs one turn. Sibling of driveStream; same deps, ClaudeStep-shaped step. */
	run<M extends WireMember>(deps: ClaudeRunDeps<M>): Promise<StreamOutcome>;
	/**
	 * Text-only compaction summary — same engine, no tools, one call.
	 * Matches the compaction seam's summarize(system, prompt, signal).
	 */
	compact(input: {
		modelId: string;
		auth: string;
		system: string;
		prompt: string;
		signal: AbortSignal;
	}): Promise<string>;
}

export function createClaudeEngine(init: {
	auth: AuthStore;
	configRef: ConfigRef;
	observation?: CacheObservation | undefined;
	configDir?: string | undefined;
	query?: ClaudeQuery | undefined;
}): ClaudeEngine {
	const config: ClaudeEngineConfig = {
		query: init.query ?? liveQuery,
		auth: init.auth,
		configRef: init.configRef,
		...(init.observation !== undefined ? { observation: init.observation } : {}),
		...(init.configDir !== undefined ? { configDir: init.configDir } : {}),
	};
	return {
		run: (deps) => driveClaude(config, deps),
		compact: (input) => compactText(config, input),
	};
}

// ---------- compaction (text-only, same engine) ----------

async function compactText(
	config: ClaudeEngineConfig,
	input: {
		modelId: string;
		auth: string;
		system: string;
		prompt: string;
		signal: AbortSignal;
	},
): Promise<string> {
	const abortController = new AbortController();
	const onAbort = (): void => {
		abortController.abort();
	};
	input.signal.addEventListener("abort", onAbort, { once: true });
	const callId = randomUUID();
	const started = Date.now();
	log.info("model call", { call: "compaction", callId, model: input.modelId });
	try {
		const childEnv = await claudeChildEnv(config.auth, input.auth, config.configDir);
		let text = "";
		for await (const ev of config.query({
			prompt: { blocks: [{ kind: "text", text: input.prompt }] },
			options: {
				model: input.modelId,
				systemPrompt: input.system,
				maxTurns: 1,
				thinking: { type: "disabled" },
				mcpServers: {},
				allowedTools: [],
				cwd: process.cwd(),
				env: childEnv.env,
				abortController,
			},
		})) {
			if (ev.type === "assistant") {
				text += ev.message.content
					.filter((b) => b.type === "text" && typeof b.text === "string")
					.map((b) => b.text)
					.join("");
			}
			if (ev.type === "result" && ev.isError) {
				throw new Error(ev.result);
			}
		}
		log.info("model call usage", {
			call: "compaction",
			callId,
			model: input.modelId,
			ms: Date.now() - started,
			chars: text.length,
		});
		return text;
	} catch (err) {
		// Boundary logging only: rethrown unchanged for the caller.
		log.error("model call failed", err, { call: "compaction", callId, model: input.modelId });
		throw err;
	} finally {
		input.signal.removeEventListener("abort", onAbort);
	}
}

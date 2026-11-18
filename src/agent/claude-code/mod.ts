// The claude-code engine's public surface. This module and its siblings
// are the ONLY importers of @anthropic-ai/claude-agent-sdk
// (module-boundaries.test.ts); everything the engine needs from the
// vendor is adapted into the pinned shapes of translate.ts here.

import { randomUUID, type UUID } from "node:crypto";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { query as vendorQuery } from "@anthropic-ai/claude-agent-sdk";
import { log } from "../../log.ts";
import type { AuthStore } from "../../auth.ts";
import type { CacheObservation } from "../../cache-observation.ts";
import type { ConfigRef } from "../../config.ts";
import { splitModelRef } from "../../config-schema.ts";
import type { ClaudeSessionStore } from "../../claude-sessions.ts";
import type { Tools } from "../../tool.ts";
import type { StreamOutcome, WireMember } from "../../turn/stream.ts";
import type { MediaPosition } from "../attachments.ts";
import type { ClaudeCodeThinking } from "../thinking.ts";
import { claudeChildEnv } from "./auth.ts";
import { type ClaudeEngineConfig, type ClaudeRunDeps, driveClaude } from "./engine.ts";
import { isClaudeStep, type TurnEngine } from "../../turn/engine.ts";
import type {
	ClaudeEvent,
	ClaudeQuery,
	ClaudeQueryCall,
	ClaudeToolResultBlock,
	PromptContent,
	SteerChannel,
} from "./translate.ts";
import { createToolBridge, refuseToolExecutors } from "./tools.ts";

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

// PromptContent → the vendor's input: the prompt as ONE user message on
// an async iterable (the only prompt form that carries media blocks).
// A turn query keeps the iterable open: each folded steer follows as
// another user message with priority "next" — the CLI adds it to its
// next model call (probed live 2026-11-15: "now" aborts the running
// tools instead, "later" waits for a new CLI turn). Without a steer
// channel input closes after the prompt; the CLI reads the message,
// runs its loop, and pulls again post-turn to find the iterator done.
type VendorBlock = Extract<SDKUserMessage["message"]["content"], unknown[]>[number];

function vendorBlocks(prompt: PromptContent): VendorBlock[] {
	return prompt.blocks.map((block): VendorBlock => {
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
}

function vendorPrompt(
	prompt: PromptContent,
	steers: SteerChannel | undefined,
): AsyncIterable<SDKUserMessage> {
	return (async function* (): AsyncIterable<SDKUserMessage> {
		yield {
			type: "user",
			message: { role: "user", content: vendorBlocks(prompt) },
			parent_tool_use_id: null,
		};
		if (steers === undefined) return;
		for await (const steer of steers) {
			yield {
				type: "user",
				message: { role: "user", content: vendorBlocks(steer.prompt) },
				parent_tool_use_id: null,
				priority: "next",
				// The engine mints these with randomUUID().
				uuid: steer.uuid as UUID,
			};
		}
	})();
}

// The CLI's ack for streamed user messages: `user_message_uuids` rides
// the folding turn's frames (documented on stream and assistant frames,
// observed on the requesting status and result frames too).
export function foldedUuids(msg: SDKMessage): string[] | null {
	const raw: unknown = (msg as { user_message_uuids?: unknown }).user_message_uuids;
	if (!Array.isArray(raw)) return null;
	const uuids = raw.filter((u): u is string => typeof u === "string");
	return uuids.length > 0 ? uuids : null;
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
			if (msg.subtype === "compact_boundary") {
				const meta = msg.compact_metadata;
				return {
					type: "compact_boundary",
					trigger: meta.trigger,
					preTokens: meta.pre_tokens,
					...(meta.post_tokens !== undefined ? { postTokens: meta.post_tokens } : {}),
					uuid: msg.uuid,
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
				...(typeof msg.uuid === "string" ? { uuid: msg.uuid } : {}),
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
				...(typeof msg.uuid === "string" ? { uuid: msg.uuid } : {}),
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
				...(typeof msg.uuid === "string" ? { uuid: msg.uuid } : {}),
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
	const { prompt, steers, options } = call;
	const vendor = vendorQuery({
		prompt: vendorPrompt(prompt, steers),
		options: {
			model: options.model,
			systemPrompt: options.systemPrompt,
			...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
			thinking: options.thinking,
			...(options.effort !== undefined ? { effort: options.effort } : {}),
			mcpServers: options.mcpServers as never,
			allowedTools: options.allowedTools,
			...(options.canUseTool !== undefined ? { canUseTool: options.canUseTool } : {}),
			// allowedTools only auto-approves; `tools: []` is what actually
			// removes the CLI's built-in tools (Bash, Read, Edit, ...).
			tools: [],
			cwd: options.cwd,
			env: options.env,
			abortController: options.abortController,
			...(options.stderr !== undefined ? { stderr: options.stderr } : {}),
			settingSources: [],
			includePartialMessages: true,
			// Turn queries persist (#418): a fresh sessionId mints the
			// file, resume+resumeSessionAt continues a recorded one. The
			// throwaway summary query passes neither.
			persistSession: options.persistSession === true,
			...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
			...(options.resume !== undefined ? { resume: options.resume } : {}),
			...(options.resumeSessionAt !== undefined
				? { resumeSessionAt: options.resumeSessionAt }
				: {}),
			...(options.forkSession !== undefined ? { forkSession: options.forkSession } : {}),
			// The prompt is machine-assembled from the conversation view —
			// no @path expansion, no slash-command dispatch on it. The
			// native /compact query alone opts out (#418).
			verbatimPrompts: options.verbatimPrompts !== false,
		},
	});
	return (async function* (): AsyncIterable<ClaudeEvent> {
		for await (const msg of vendor) {
			const uuids = foldedUuids(msg);
			if (uuids !== null) yield { type: "folded", uuids };
			const pinned = pinEvent(msg);
			if (pinned !== null) yield pinned;
		}
	})();
}

// ---------- the engine handle the runtime holds ----------

export interface ClaudeEngine extends TurnEngine<ClaudeStep> {
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
	/**
	 * Native session compaction (#418): resumes the recorded session at
	 * its head and runs /compact inside it — Claude compacts its own
	 * transcript while goblin's fold summarizes separately. Returns the
	 * session's head uuid after the query (the record's new anchor), or
	 * null when no record exists for the key. Throws on provider failure
	 * — the record is dropped inside, so the next turn starts fresh.
	 */
	nativeCompact(input: {
		conversationId: string;
		modelRef: string;
		signal: AbortSignal;
	}): Promise<string | null>;
	forkSummarize?(input: {
		conversationId: string;
		modelRef: string;
		step: ClaudeStep;
		tools: Tools;
		foldedThroughSeq: number;
		prompt: string;
		signal: AbortSignal;
		cut?: { seq: number; part: number };
	}): Promise<string>;
}

export function createClaudeEngine(init: {
	auth: AuthStore;
	configRef: ConfigRef;
	observation?: CacheObservation | undefined;
	configDir?: string | undefined;
	query?: ClaudeQuery | undefined;
	sessions?: ClaudeSessionStore | undefined;
	bridgeFactory?: typeof createToolBridge | undefined;
}): ClaudeEngine {
	const config: ClaudeEngineConfig = {
		query: init.query ?? liveQuery,
		auth: init.auth,
		configRef: init.configRef,
		...(init.observation !== undefined ? { observation: init.observation } : {}),
		...(init.configDir !== undefined ? { configDir: init.configDir } : {}),
		...(init.sessions !== undefined ? { sessions: init.sessions } : {}),
		...(init.bridgeFactory !== undefined ? { bridgeFactory: init.bridgeFactory } : {}),
	};
	return {
		id: "claude-code",
		accepts: isClaudeStep,
		run: (deps) => driveClaude(config, deps),
		compact: (input) => compactText(config, input),
		nativeCompact: (input) => nativeCompactSession(config, input),
		forkSummarize: (input) => forkSummary(config, input),
	};
}

// ---------- compaction (text-only, same engine) ----------

async function forkSummary(
	config: ClaudeEngineConfig,
	input: {
		conversationId: string;
		modelRef: string;
		step: ClaudeStep;
		tools: Tools;
		foldedThroughSeq: number;
		prompt: string;
		signal: AbortSignal;
		cut?: { seq: number; part: number };
	},
): Promise<string> {
	const sessions = config.sessions;
	if (input.cut !== undefined) throw claudeSummaryFallback("split-checkpoint", "native session cannot be cut at a split checkpoint");
	if (sessions === undefined) throw claudeSummaryFallback("no-session-record", "native session store is unavailable");
	const record = sessions.get(input.conversationId, input.modelRef);
	if (record === null) throw claudeSummaryFallback("no-session-record", "no native session record");
	if (record.seenSeq < input.foldedThroughSeq) {
		throw claudeSummaryFallback("session-behind-fold", `native session seen seq ${record.seenSeq} is below folded seq ${input.foldedThroughSeq}`);
	}
	input.signal.throwIfAborted();
	const controller = new AbortController();
	const onAbort = (): void => controller.abort(input.signal.reason);
	input.signal.addEventListener("abort", onAbort, { once: true });
	const callId = randomUUID();
	const started = Date.now();
	log.info("model call", {
		call: "compaction",
		callId,
		model: input.modelRef,
		session: record.sessionId,
		mode: "fork",
	});
	try {
		const childEnv = await claudeChildEnv(config.auth, input.step.auth, config.configDir);
		const bridge = (config.bridgeFactory ?? createToolBridge)({
			convId: input.conversationId,
			tools: refuseToolExecutors(input.tools),
			signal: controller.signal,
		});
		let text = "";
		let usage: import("./translate.ts").ClaudeUsage | null = null;
		for await (const ev of config.query({
			prompt: { blocks: [{ kind: "text", text: input.prompt }] },
			options: {
				model: input.step.modelId,
				systemPrompt: input.step.system,
				maxTurns: 1,
				thinking:
					input.step.thinking.disabled === true
						? { type: "disabled" }
						: { type: "adaptive" },
				...(input.step.thinking.effort !== undefined ? { effort: input.step.thinking.effort } : {}),
				mcpServers: { goblin: bridge.server() },
				allowedTools: bridge.allowedTools(),
				canUseTool: async (toolName) => {
					log.info("claude compaction tool denied", {
						conversation: input.conversationId,
						tool: toolName,
					});
					return {
						behavior: "deny",
						message: "Tool execution is disabled during a compaction summary.",
					};
				},
				cwd: childEnv.workdir,
				env: childEnv.env,
				abortController: controller,
				resume: record.sessionId,
				resumeSessionAt: record.headUuid,
				forkSession: true,
				persistSession: false,
			},
		})) {
			if (ev.type === "assistant") {
				usage = ev.message.usage ?? usage;
				text += ev.message.content
					.filter((block) => block.type === "text" && typeof block.text === "string")
					.map((block) => block.text)
					.join("");
			}
			if (ev.type === "result" && ev.isError) throw new Error(ev.result);
		}
		log.info("model call usage", {
			call: "compaction",
			callId,
			model: input.modelRef,
			ms: Date.now() - started,
			inputTokens: usage?.input_tokens ?? null,
			cacheReadTokens: usage?.cache_read_input_tokens ?? null,
			cacheWriteTokens: usage?.cache_creation_input_tokens ?? null,
			outputTokens: usage?.output_tokens ?? null,
			chars: text.length,
		});
		return text;
	} catch (err) {
		log.error("model call failed", err, { call: "compaction", callId, model: input.modelRef });
		throw claudeSummaryFallback("fork-failed", err instanceof Error ? err.message : String(err), err);
	} finally {
		input.signal.removeEventListener("abort", onAbort);
	}
}

function claudeSummaryFallback(reason: string, message: string, cause?: unknown): Error {
	const error = new Error(message, cause === undefined ? undefined : { cause });
	error.name = "ClaudeSummaryFallbackError";
	Object.assign(error, { reason });
	return error;
}

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
				cwd: childEnv.workdir,
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

// ---------- native session compaction (#418) ----------

// Claude compacts its own transcript: resume the recorded session at
// its head and send /compact as a real command — verbatimPrompts off,
// the one query where slash dispatch is wanted. The record's head
// advances to the last chain uuid the query emitted (any frame with a
// uuid, last wins); seen_seq/reply_seq are untouched — the goblin fold
// owns those semantics. A provider failure drops the record: the next
// turn starts fresh from goblin's folded view. An aborted (fenced)
// attempt leaves the record alone.
async function nativeCompactSession(
	config: ClaudeEngineConfig,
	input: { conversationId: string; modelRef: string; signal: AbortSignal },
): Promise<string | null> {
	const sessions = config.sessions;
	if (sessions === undefined) return null;
	const { provider, modelId } = splitModelRef(input.modelRef);
	const p = config.configRef.current.providers[provider];
	if (p?.kind !== "claude-code") return null;
	const record = sessions.get(input.conversationId, input.modelRef);
	if (record === null) return null;

	const abortController = new AbortController();
	const onAbort = (): void => {
		abortController.abort();
	};
	input.signal.addEventListener("abort", onAbort, { once: true });
	const callId = randomUUID();
	const started = Date.now();
	log.info("model call", {
		call: "claude-native-compact",
		callId,
		model: input.modelRef,
		session: record.sessionId,
	});
	try {
		const childEnv = await claudeChildEnv(config.auth, p.auth ?? "claude-code", config.configDir);
		let headUuid: string | null = null;
		for await (const ev of config.query({
			prompt: { blocks: [{ kind: "text", text: "/compact" }] },
			options: {
				model: modelId,
				systemPrompt: "You are goblin.",
				maxTurns: 1,
				thinking: { type: "disabled" },
				mcpServers: {},
				allowedTools: [],
				cwd: childEnv.workdir,
				env: childEnv.env,
				abortController,
				resume: record.sessionId,
				resumeSessionAt: record.headUuid,
				persistSession: true,
				verbatimPrompts: false,
			},
		})) {
			if ("uuid" in ev && typeof ev.uuid === "string") headUuid = ev.uuid;
			if (ev.type === "compact_boundary") {
				log.info("claude native compaction boundary", {
					conversation: input.conversationId,
					model: input.modelRef,
					trigger: ev.trigger,
					preTokens: ev.preTokens,
					postTokens: ev.postTokens ?? null,
				});
			}
			if (ev.type === "result" && ev.isError) {
				throw new Error(ev.result);
			}
		}
		if (headUuid !== null) {
			sessions.put({
				conversationId: input.conversationId,
				modelRef: input.modelRef,
				sessionId: record.sessionId,
				headUuid,
				seenSeq: record.seenSeq,
				replySeq: record.replySeq,
			});
		}
		log.info("model call usage", {
			call: "claude-native-compact",
			callId,
			model: input.modelRef,
			ms: Date.now() - started,
		});
		return headUuid ?? record.headUuid;
	} catch (err) {
		if (!input.signal.aborted) {
			sessions.drop(input.conversationId, input.modelRef, "native compaction failed");
		}
		log.error("claude native compaction failed", err, {
			conversation: input.conversationId,
			model: input.modelRef,
		});
		throw err;
	} finally {
		input.signal.removeEventListener("abort", onAbort);
	}
}

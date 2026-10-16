import { createHash, randomUUID } from "node:crypto";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type {
	LanguageModelV4CallOptions,
	LanguageModelV4StreamPart,
	LanguageModelV4Usage,
} from "@ai-sdk/provider";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
	APICallError,
	wrapLanguageModel,
	type LanguageModel,
	type LanguageModelMiddleware,
} from "ai";
import type { AuthStore } from "../auth.ts";
import type { CacheObservation } from "../cache-observation.ts";
import { splitModelRef, thinkingLevels, type Config, type ThinkingLevel } from "../config.ts";
import { log } from "../log.ts";
import { codexModel, RESPONSES_URL } from "./codex/model.ts";
import type { MediaPosition } from "./attachments.ts";
import { isZaiHost, zaiReasoningFetch } from "./zai-responses.ts";
import { openrouterSupportedParams } from "./models-dev.ts";

export async function resolveModel(
	config: Config,
	auth: AuthStore,
	modelRef: string,
): Promise<LanguageModel> {
	const { provider, modelId } = splitModelRef(modelRef);
	const p = config.providers[provider];
	if (!p) {
		throw new Error(`model "${modelRef}": provider "${provider}" not in goblin.json5 providers`);
	}
	switch (p.kind) {
		case "openai-compatible":
			return createOpenAICompatible({
				name: provider,
				baseURL: p.baseUrl,
				apiKey: await auth.resolve(p.auth),
			}).chatModel(modelId);
		case "responses":
			// z.ai emits raw reasoning_text events; the shim maps them to the
			// reasoning_summary shape expected by the SDK. `name` keeps options
			// keyed to this config provider.
			return createOpenAI({
				name: provider,
				baseURL: p.baseUrl,
				apiKey: await auth.resolve(p.auth),
				...(isZaiHost(p.baseUrl) ? { fetch: zaiReasoningFetch() } : {}),
			}).responses(modelId);
		case "openrouter": {
			const apiKey = await auth.resolve(p.auth);
			// Provider metadata types lag exactOptionalPropertyTypes; the runtime
			// value still has the LanguageModel shape.
			return createOpenRouter({ apiKey }).chat(modelId) as unknown as LanguageModel;
		}
		case "codex":
			return codexModel(modelId, p.authFile);
	}
}

// Catalog modalities describe what a model accepts; this predicate describes
// what the SDK converter can carry at each position. Unsupported media falls
// back to its saved path rather than becoming silently corrupted content.
export function carriesMedia(
	kind: string,
	mediaType: string,
	position: MediaPosition = "user",
): boolean {
	switch (kind) {
		case "responses":
			// Responses maps file parts in user and function_call_output content.
			return mediaType.startsWith("image/") || mediaType === "application/pdf";
		case "openai-compatible":
			// Tool-result content is stringified, so no media survives this position.
			if (position === "tool-result") return false;
			// The SDK audio formatter accepts wav/mp3/mpeg only; Telegram ogg
			// therefore falls back instead of failing request construction.
			return (
				mediaType.startsWith("image/") ||
				mediaType.startsWith("video/") ||
				mediaType === "audio/wav" ||
				mediaType === "audio/mp3" ||
				mediaType === "audio/mpeg" ||
				mediaType === "application/pdf"
			);
		case "openrouter":
			// OpenRouter maps media in both user and tool-result content.
			return true;
		case "codex":
			// Codex accepts images/PDFs in user messages, text only in results.
			return (
				position === "user" && (mediaType.startsWith("image/") || mediaType === "application/pdf")
			);
		default:
			return position === "user" && mediaType.startsWith("image/");
	}
}
export interface CacheRoute {
	provider: string;
	kind: string;
	base: string;
	modelRef: string;
}

export function cacheRouteFor(config: Config, modelRef: string): CacheRoute | undefined {
	const { provider } = splitModelRef(modelRef);
	const p = config.providers[provider];
	if (p === undefined) return undefined;
	switch (p.kind) {
		case "openai-compatible":
		case "responses": {
			const url = new URL(p.baseUrl);
			return { provider, kind: p.kind, base: url.origin + url.pathname, modelRef };
		}
		case "openrouter":
			return { provider, kind: p.kind, base: "https://openrouter.ai/api/v1", modelRef };
		case "codex": {
			const url = new URL(RESPONSES_URL);
			return { provider, kind: p.kind, base: url.origin + url.pathname, modelRef };
		}
	}
}

const sha256hex = (json: string) => createHash("sha256").update(json).digest("hex");

// The telemetry route identity: a configured route via cacheRouteFor, or
// the inferred provider/modelId fallback below (which also pins the call's
// purpose so its key can't collide with configured lanes). The pruning
// policy profiles key on this hash, so the byte shape is frozen.
export function cacheRouteKey(route: CacheRoute & { purpose?: string | null }): string {
	return sha256hex(JSON.stringify(route));
}

// The settings hash pins the non-prompt call surface — providerOptions and
// the sampling/format knobs. Object key order is load-bearing: pruning
// profiles key on this exact hash.
export function hashCacheSettings(fields: {
	providerOptions?: LanguageModelV4CallOptions["providerOptions"];
	temperature?: LanguageModelV4CallOptions["temperature"];
	topP?: LanguageModelV4CallOptions["topP"];
	topK?: LanguageModelV4CallOptions["topK"];
	toolChoice?: LanguageModelV4CallOptions["toolChoice"];
	responseFormat?: LanguageModelV4CallOptions["responseFormat"];
}): string {
	return sha256hex(
		JSON.stringify({
			providerOptions: fields.providerOptions ?? null,
			temperature: fields.temperature ?? null,
			topP: fields.topP ?? null,
			topK: fields.topK ?? null,
			toolChoice: fields.toolChoice ?? null,
			responseFormat: fields.responseFormat ?? null,
		}),
	);
}

const SAFE_ERROR_NAMES = new Set(["AbortError", "Error", "TypeError"]);

function safeErrorFields(error: unknown): Record<string, unknown> {
	const fields: Record<string, unknown> = {
		errorName:
			error instanceof Error && SAFE_ERROR_NAMES.has(error.name)
				? error.name
				: "provider-error",
	};
	if (APICallError.isInstance(error)) {
		const status = error.statusCode;
		if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
			fields.httpStatus = status;
		}
	}
	return fields;
}

// Hash at the model boundary, the only seam that sees every call. `headHash`
// isolates system/tools; with that head unchanged, `requestHash` should evolve
// by prompt append rather than history rewrite.
export function observedModel(
	model: LanguageModel,
	context: {
		conversation?: string;
		purpose?: string;
		observation?: CacheObservation | undefined;
		route?: CacheRoute | undefined;
	},
): LanguageModel {
	if (typeof model === "string") return model;
	const label = context.route?.modelRef ?? `${model.provider}/${model.modelId}`;
	const routeKey = cacheRouteKey(
		context.route ?? {
			provider: model.provider,
			kind: "inferred",
			base: "unknown",
			modelRef: model.modelId,
			purpose: context.purpose ?? null,
		},
	);
	const baseFields = {
		...(context.conversation !== undefined ? { conversation: context.conversation } : {}),
		...(context.purpose !== undefined ? { purpose: context.purpose } : {}),
		model: label,
		routeKey,
		routeEvidence: context.route === undefined ? "inferred" : "configured",
	};
	const beginCall = (type: "generate" | "stream", params: LanguageModelV4CallOptions) => {
		// Hash the leading system messages and tools as the request head.
		const headHash = sha256hex(
			JSON.stringify({
				system: params.prompt.filter((m) => m.role === "system"),
				tools: params.tools ?? null,
			}),
		);
		const requestHash = sha256hex(JSON.stringify(params.prompt));
		const settingsHash = hashCacheSettings(params);
		const promptHashes = params.prompt.map((m) => sha256hex(JSON.stringify(m)));
		const callId = randomUUID();
		const obs = context.observation?.begin({
			callId,
			conversationId: context.conversation ?? null,
			purpose: context.purpose ?? null,
			model: label,
			routeKey,
			headHash,
			requestHash,
			settingsHash,
			promptHashes,
		});
		log.info("model call", {
			...baseFields,
			callId,
			call: type,
			messages: params.prompt.length,
			headHash: headHash.slice(0, 16),
			requestHash: requestHash.slice(0, 16),
			settingsHash: settingsHash.slice(0, 16),
			...(obs
				? {
						idleMs: obs.idleMs,
						prefixRelation: obs.prefixRelation,
						sharedMessages: obs.sharedMessages,
					}
				: {}),
		});
		return { callId, obs };
	};
	const usageFields = (usage: LanguageModelV4Usage) => ({
		inputTokens: usage.inputTokens.total ?? null,
		cacheReadTokens: usage.inputTokens.cacheRead ?? null,
		cacheWriteTokens: usage.inputTokens.cacheWrite ?? null,
		outputTokens: usage.outputTokens.total ?? null,
	});
	const finishCall = (call: ReturnType<typeof beginCall>, usage: LanguageModelV4Usage) => {
		call.obs?.finish(usage);
		log.info("model call usage", {
			...baseFields,
			callId: call.callId,
			...usageFields(usage),
			...(call.obs
				? { idleMs: call.obs.idleMs, prefixRelation: call.obs.prefixRelation }
				: {}),
		});
	};
	const failCall = (
		call: ReturnType<typeof beginCall>,
		stage: "invoke" | "read" | "provider-error" | "cancel" | "no-finish",
		error?: unknown,
	) => {
		call.obs?.fail();
		log.error("model call failed", undefined, {
			...baseFields,
			callId: call.callId,
			stage,
			...(error === undefined ? {} : safeErrorFields(error)),
		});
	};
	const middleware: LanguageModelMiddleware = {
		wrapGenerate: async ({ doGenerate, params }) => {
			const call = beginCall("generate", params);
			let result;
			try {
				result = await doGenerate();
			} catch (error) {
				failCall(call, "invoke", error);
				throw error;
			}
			finishCall(call, result.usage);
			return result;
		},
		wrapStream: async ({ doStream, params }) => {
			const call = beginCall("stream", params);
			let result;
			try {
				result = await doStream();
			} catch (error) {
				failCall(call, "invoke", error);
				throw error;
			}
			const reader = result.stream.getReader();
			let settled = false;
			let cancelled = false;
			return {
				...result,
				stream: new ReadableStream<LanguageModelV4StreamPart>({
					async pull(controller) {
						try {
							const { done, value } = await reader.read();
							if (cancelled) return;
							if (done) {
								if (!settled) {
									failCall(call, "no-finish");
									settled = true;
								}
								controller.close();
								return;
							}
							if (value.type === "finish" && !settled) {
								try {
									finishCall(call, value.usage);
								} catch (storageError) {
									try {
										call.obs?.fail();
									} catch {}
									settled = true;
									controller.error(storageError);
									return;
								}
								settled = true;
							} else if (value.type === "error" && !settled) {
								try {
									failCall(call, "provider-error", value.error);
								} catch (storageError) {
									settled = true;
									controller.error(storageError);
									return;
								}
								settled = true;
							}
							controller.enqueue(value);
						} catch (error) {
							if (cancelled) return;
							if (!settled) {
								failCall(call, "read", error);
								settled = true;
							}
							controller.error(error);
						}
					},
					async cancel(reason) {
						cancelled = true;
						try {
							if (!settled) {
								failCall(call, "cancel");
								settled = true;
							}
						} finally {
							try {
								await reader.cancel(reason);
							} catch (cleanupError) {
								log.error("model call stream cancel failed", undefined, {
									...baseFields,
									callId: call.callId,
									stage: "cancel",
									...safeErrorFields(cleanupError),
								});
								throw cleanupError;
							}
						}
					},
				}),
			};
		},
	};
	return wrapLanguageModel({ model, middleware });
}

// Map thinking levels to provider-specific controls and clamp known ladders.
export function thinkingOptions(
	config: Config,
	modelRef: string,
	level: ThinkingLevel,
): ProviderOptions | undefined {
	const { provider, modelId } = splitModelRef(modelRef);
	const p = config.providers[provider];
	if (!p) return undefined;
	const bare = modelId.split("/").pop() ?? modelId;
	switch (p.kind) {
		case "openrouter": {
			// "off" disables reasoning; pairing it with effort may be rejected.
			if (level === "off") {
				return { openrouter: { reasoning: { enabled: false, exclude: true } } };
			}
			// For non-off levels, omit settings on known non-reasoning routes;
			// unknown catalog entries pass through for endpoint validation.
			const params = openrouterSupportedParams(modelId);
			if (params && !params.has("reasoning") && !params.has("reasoning_effort")) {
				return undefined;
			}
			if (params && !params.has("reasoning_effort")) {
				return { openrouter: { reasoning: { enabled: true } } };
			}
			return { openrouter: { reasoning: { effort: level } } };
		}
		case "openai-compatible":
			return openaiCompatibleThinking(provider, bare, level, p.baseUrl);
		case "responses": {
			// Responses GLM uses a forced-thinking effort ladder; "off" is the floor.
			const key = provider.split(".")[0]!.trim();
			if (bare.startsWith("glm-")) {
				const effort = {
					off: "low",
					low: "low",
					medium: "high",
					high: "high",
					xhigh: "max",
					max: "max",
				}[level];
				return { [key]: { reasoningEffort: effort } };
			}
			return { [key]: { reasoningEffort: level === "off" ? "low" : level } };
		}
		case "codex":
			// Codex has no "off" rung, so clamp to its available effort ladder.
			return {
				codex: { reasoningEffort: clampToLadder(gptLevels(bare), level) },
			};
	}
}

// The model family determines the honest knob. z.ai coding endpoints alias
// every GLM id to the forced-thinking generation.
function openaiCompatibleThinking(
	provider: string,
	modelId: string,
	level: ThinkingLevel,
	baseUrl?: string,
): ProviderOptions {
	// Options use the first dot-separated provider segment ("z.ai" → "z").
	const key = provider.split(".")[0]!.trim();
	if (modelId.startsWith("glm-")) {
		return glmThinking(key, modelId, level, zaiCodingEndpoint(baseUrl));
	}
	if (modelId.startsWith("gpt-")) {
		return {
			[key]: { reasoningEffort: clampToLadder(gptLevels(modelId), level) },
		};
	}
	// Generic providers expose effort only; "off" falls to the lowest effort.
	return { [key]: { reasoningEffort: level === "off" ? "low" : level } };
}

// Match z.ai's coding chat and Responses doors, but not the general paas path.
function zaiCodingEndpoint(baseUrl?: string): boolean {
	if (!baseUrl) return false;
	try {
		const u = new URL(baseUrl);
		if (u.hostname !== "api.z.ai") return false;
		// Compare non-empty segments so a trailing slash does not matter.
		const segments = u.pathname.split("/").filter(Boolean);
		return segments.includes("coding") || segments.join("/") === "api/v1";
	} catch {
		return false;
	}
}

// Return the active model's honest ladder; unknown models retain the full
// vocabulary so unsupported values fail at the endpoint rather than here.
export function thinkingLevelsFor(
	kind: string,
	modelId: string,
	baseUrl?: string,
): readonly ThinkingLevel[] {
	// Detect from the bare id, including relayed names; z.ai coding aliases all
	// GLM ids to its forced-thinking ladder.
	const bare = modelId.split("/").pop() ?? modelId;
	if (bare.startsWith("glm-")) {
		if ((kind === "openai-compatible" || kind === "responses") && zaiCodingEndpoint(baseUrl)) {
			return ["low", "high", "max"];
		}
		const { major, minor } = glmVersion(bare);
		if (major > 5 || (major === 5 && minor >= 3)) return ["low", "high", "max"];
		if (major === 5 && minor === 2) return ["off", "high", "max"];
		return ["off", "low"];
	}
	if (kind === "codex" || bare.startsWith("gpt-")) {
		return gptLevels(bare);
	}
	if (kind === "openrouter") {
		return openrouterLevels(openrouterSupportedParams(modelId));
	}
	return thinkingLevels;
}

// GPT-6 adds `max`; older GPT ladders stop at `xhigh`. "off" is clamped
// to the lowest available effort.
function gptLevels(modelId: string): readonly ThinkingLevel[] {
	const major = Number(/^gpt-(\d+)/.exec(modelId)?.[1] ?? 0);
	if (major >= 6) return ["low", "medium", "high", "xhigh", "max"];
	return ["low", "medium", "high", "xhigh"];
}

// Clamp to the nearest rung at or above the requested vocabulary level.
function clampToLadder(ladder: readonly ThinkingLevel[], level: ThinkingLevel): ThinkingLevel {
	const idx = thinkingLevels.indexOf(level);
	return ladder.find((l) => thinkingLevels.indexOf(l) >= idx) ?? ladder[ladder.length - 1]!;
}

// OpenRouter's catalog distinguishes effort, toggle-only, and non-reasoning
// routes; a cold catalog preserves the request so the provider can reject it.
function openrouterLevels(params: Set<string> | null): readonly ThinkingLevel[] {
	if (!params) return thinkingLevels;
	if (!params.has("reasoning") && !params.has("reasoning_effort")) {
		return ["off"];
	}
	if (!params.has("reasoning_effort")) return ["off", "low"];
	return thinkingLevels;
}

// GLM 5.3+ uses forced thinking with low/high/max effort; 5.2 combines a
// toggle with high/max, while older generations expose only a toggle.
// Future major versions follow the forced-thinking mapping.
function glmThinking(
	key: string,
	modelId: string,
	level: ThinkingLevel,
	forced53 = false,
): ProviderOptions {
	const { major, minor } = glmVersion(modelId);
	if (forced53 || major > 5 || (major === 5 && minor >= 3)) {
		const effort = {
			off: "low",
			low: "low",
			medium: "high",
			high: "high",
			xhigh: "max",
			max: "max",
		}[level];
		return {
			[key]: { thinking: { type: "enabled" }, reasoningEffort: effort },
		};
	}
	if (major === 5 && minor === 2) {
		if (level === "off") return { [key]: { thinking: { type: "disabled" } } };
		const effort = {
			low: "high",
			medium: "high",
			high: "high",
			xhigh: "max",
			max: "max",
		}[level];
		return {
			[key]: { thinking: { type: "enabled" }, reasoningEffort: effort },
		};
	}
	return { [key]: { thinking: { type: level === "off" ? "disabled" : "enabled" } } };
}

function glmVersion(modelId: string): { major: number; minor: number } {
	const m = /^glm-(\d+)\.(\d+)/.exec(modelId);
	return { major: m ? Number(m[1]) : 0, minor: m ? Number(m[2]) : 0 };
}

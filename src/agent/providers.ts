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
import { splitModelRef, type Config, type ThinkingLevel } from "../config.ts";
import { log } from "../log.ts";
import { codexModel, RESPONSES_URL } from "./codex/model.ts";
import type { MediaPosition } from "./attachments.ts";
import { isZaiHost, zaiReasoningFetch } from "./zai-responses.ts";
import { thinkingOptions as thinkingOptionsFor } from "./thinking.ts";

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
			// z.ai emits raw reasoning_text events the SDK's schema drops;
			// the shim maps them to reasoning_summary. `name` keeps options
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

// What the SDK converter can carry at each position — not what the model
// accepts (that's the catalog). Unsupported media falls back to its saved
// path rather than becoming silently corrupted content.
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

// Pruning profiles key on this hash — the byte shape is frozen. The
// inferred fallback pins the call's purpose so its key can't collide
// with configured lanes.
export function cacheRouteKey(route: CacheRoute & { purpose?: string | null }): string {
	return sha256hex(JSON.stringify(route));
}

// Object key order is load-bearing: pruning profiles key on this exact hash.
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

// The SDK's prepareToolChoice normalizes an omitted toolChoice to
// {type:"auto"} BEFORE the middleware boundary sees the call options —
// receipts hash that shape, so the pruning gate (and any profile copied
// from telemetry) must hash the identical bytes or never match.
export function turnCallSettings(
	config: Config,
	modelRef: string,
	thinking: ThinkingLevel,
): {
	providerOptions: LanguageModelV4CallOptions["providerOptions"];
	toolChoice: { type: "auto" };
} {
	return {
		providerOptions: thinkingOptionsFor(config, modelRef, thinking),
		toolChoice: { type: "auto" },
	};
}

const SAFE_ERROR_NAMES = new Set(["AbortError", "Error", "TypeError"]);

function safeErrorFields(error: unknown): Record<string, unknown> {
	const fields: Record<string, unknown> = {
		errorName:
			error instanceof Error && SAFE_ERROR_NAMES.has(error.name) ? error.name : "provider-error",
	};
	if (APICallError.isInstance(error)) {
		const status = error.statusCode;
		if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
			fields.httpStatus = status;
		}
	}
	return fields;
}

// headHash isolates system/tools; with that head unchanged, requestHash
// should evolve by prompt append rather than history rewrite.
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
			...(call.obs ? { idleMs: call.obs.idleMs, prefixRelation: call.obs.prefixRelation } : {}),
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
									} catch (rollbackError) {
										log.warn("model call rollback failed", {
											...baseFields,
											callId: call.callId,
											...safeErrorFields(rollbackError),
										});
									}
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

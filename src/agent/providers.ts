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
import type { MediaPosition } from "./attachments.ts";
import { codexModel, RESPONSES_URL, type CodexModelOptions } from "./codex/model.ts";
import { isOneMinHost, modelCallMaxRetries } from "./onemin.ts";
import { isTransientTurnFailure, quotaExhausted } from "./provider-errors.ts";
import { thinkingOptions as thinkingOptionsFor } from "./thinking.ts";
import { isZaiHost, zaiReasoningFetch, zaiStatelessReplay } from "./zai-responses.ts";

// Every chat-turn, compaction, title and reviewer model comes through
// here, so the quota filter lives here once. The SDK retries only
// APICallErrors flagged isRetryable and offers no skip hook; a provider
// quota wall (days, not seconds) would burn its whole ladder first.
// The rethrow keeps every field — only the retry verdict changes.
export async function resolveModel(
	config: Config,
	auth: AuthStore,
	modelRef: string,
	// Codex-only request identity — non-codex kinds ignore it.
	opts: CodexModelOptions = {},
): Promise<LanguageModel> {
	const model = await resolveProviderModel(config, auth, modelRef, opts);
	return wrapLanguageModel({
		model: wrapLanguageModel({ model, middleware: transportRetry(modelRef, config) }),
		middleware: quotaNoRetry(modelRef),
	});
}

// The SDK retry ladder's initialDelayInMs default — the transport retry
// keeps the ladder's delay story.
const TRANSPORT_RETRY_DELAY_MS = 2000;

// A stopped call must not hold its lane for the full backoff.
function awaitRetryDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (ms <= 0 || signal?.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(finish, ms);
		function finish(): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		}
		signal?.addEventListener("abort", finish, { once: true });
	});
}

// The transport twin of the SDK's retry ladder. The SDK retries only
// errors it flagged itself (APICallError isRetryable — 5xx, throttles),
// so a raw fetch TypeError / ECONNRESET before the first byte exhausted
// nothing and one dropped connection killed the call (issue #191). Same
// envelope as the SDK ladder — the lane's own retry rule (1min bills
// every attempt, so it keeps 0), exponential backoff from 2s — but a
// different predicate: the transient classifier on throws the SDK will
// not flag. Flagged errors keep the SDK's own ladder untouched, so the
// two never compound.
export function transportRetry(
	modelRef: string,
	config: Pick<Config, "providers">,
	// Tests zero the delay; production keeps the SDK ladder's default.
	initialDelayMs = TRANSPORT_RETRY_DELAY_MS,
): LanguageModelMiddleware {
	const maxRetries = modelCallMaxRetries(config, modelRef) ?? 2;
	const attempt = <T>(
		run: () => PromiseLike<T>,
		call: "generate" | "stream",
		signal: AbortSignal | undefined,
	): Promise<T> =>
		(async () => {
			for (let retry = 0; ; retry++) {
				try {
					return await run();
				} catch (error) {
					if (
						retry >= maxRetries ||
						signal?.aborted ||
						APICallError.isInstance(error) ||
						!isTransientTurnFailure(error)
					) {
						throw error;
					}
					const delayMs = initialDelayMs * 2 ** retry;
					log.warn("model call transport retry", error, {
						model: modelRef,
						call,
						attempt: retry + 1,
						delayMs,
					});
					await awaitRetryDelay(delayMs, signal);
				}
			}
		})();
	return {
		wrapGenerate: ({ doGenerate, params }) => attempt(doGenerate, "generate", params.abortSignal),
		wrapStream: ({ doStream, params }) => attempt(doStream, "stream", params.abortSignal),
	};
}

function quotaNoRetry(modelRef: string): LanguageModelMiddleware {
	const filter = (error: unknown): unknown => {
		if (!APICallError.isInstance(error) || error.isRetryable !== true) return error;
		const quota = quotaExhausted(error);
		if (quota === null) return error;
		log.warn("provider quota exhausted; SDK retries skipped", {
			model: modelRef,
			statusCode: error.statusCode,
			...(quota.resetAt === undefined ? {} : { resetAt: quota.resetAt }),
		});
		return new APICallError({
			message: error.message,
			url: error.url,
			requestBodyValues: error.requestBodyValues,
			...(error.statusCode === undefined ? {} : { statusCode: error.statusCode }),
			...(error.responseHeaders === undefined ? {} : { responseHeaders: error.responseHeaders }),
			...(error.responseBody === undefined ? {} : { responseBody: error.responseBody }),
			cause: error.cause,
			isRetryable: false,
			data: error.data,
		});
	};
	return {
		wrapGenerate: async ({ doGenerate }) => {
			try {
				return await doGenerate();
			} catch (error) {
				throw filter(error);
			}
		},
		wrapStream: async ({ doStream }) => {
			try {
				return await doStream();
			} catch (error) {
				throw filter(error);
			}
		},
	};
}

async function resolveProviderModel(
	config: Config,
	auth: AuthStore,
	modelRef: string,
	opts: CodexModelOptions,
): Promise<Exclude<LanguageModel, string>> {
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
				// 1min reports stream usage only under
				// stream_options.include_usage — supported there, so ask for
				// it: without it every usage log line is null.
				...(isOneMinHost(p.baseUrl) ? { includeUsage: true } : {}),
			}).chatModel(modelId);
		case "responses": {
			// z.ai emits raw reasoning_text events the SDK's schema drops;
			// the shim maps them to reasoning_summary.
			const model = createOpenAI({
				name: provider,
				baseURL: p.baseUrl,
				apiKey: await auth.resolve(p.auth),
				...(isZaiHost(p.baseUrl) ? { fetch: zaiReasoningFetch() } : {}),
			}).responses(modelId);
			if (!isZaiHost(p.baseUrl)) return model;
			log.info("model adapter resolved", {
				model: modelRef,
				adapter: "zai-stateless-replay",
				reason: "zhipu responses replays assistant items inline (store:false)",
			});
			return wrapLanguageModel({ model, middleware: zaiStatelessReplay() });
		}
		case "openrouter": {
			const apiKey = await auth.resolve(p.auth);
			// Provider metadata types lag exactOptionalPropertyTypes; the runtime
			// value still has the LanguageModel shape.
			return createOpenRouter({ apiKey }).chat(modelId) as unknown as Exclude<LanguageModel, string>;
		}
		case "codex":
			return codexModel(modelId, p.authFile, fetch, opts);
		case "claude-code":
			// Engine-driven: the subscription path has no LanguageModel —
			// buildStep routes claude-code conversations to the parallel
			// engine (agent/claude-code/) instead of streamText. Reaching
			// this arm means a caller tried the API lane; fail loud rather
			// than fabricate a model.
			throw new Error(
				`model "${modelRef}": provider kind "claude-code" is engine-driven — there is no LanguageModel to resolve`,
			);
	}
}

// What the SDK converter can carry at each position — not what the model
// accepts (that's the catalog). Unsupported media falls back to its saved
// path rather than becoming silently corrupted content.
export function carriesMedia(
	kind: string,
	mediaType: string,
	position: MediaPosition = "user",
	baseUrl?: string,
): boolean {
	// 1min's relay accepts text only — every model it lists, including
	// the vl ids (docs → "All models on this endpoint accept text
	// only"). The catalog gate may say a model id sees images; this
	// pipe never carries them.
	if (isOneMinHost(baseUrl)) return false;
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
		case "claude-code":
			// The Messages API takes images/PDFs in user content; the engine
			// maps view FileParts to prompt content blocks there. Tool results
			// ride the bridge as text — no media through that position.
			// Images are limited to the four types the Messages API accepts;
			// others fall back to the attachment text placeholder.
			return (
				position === "user" &&
				(["image/gif", "image/jpeg", "image/png", "image/webp"].includes(mediaType) ||
					mediaType === "application/pdf")
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
		case "claude-code":
			// The logical upstream is the Anthropic Messages API — the cache
			// semantics the subscription lane actually rides. The route key
			// just needs to be stable and distinct from API-key routes.
			return {
				provider,
				kind: p.kind,
				base: "https://api.anthropic.com/v1/messages",
				modelRef,
			};
	}
}

const sha256hex = (json: string) => createHash("sha256").update(json).digest("hex");

// The prompt-hash trio the observed-model middleware computes per call.
// Exported so the claude engine hashes its own request shape with the
// same primitives — each side stays byte-stable across turns, which is
// all cache observation needs (routes are keyed per modelRef anyway).
export function callHashes(
	prompt: readonly unknown[],
	tools: unknown,
): { headHash: string; requestHash: string; promptHashes: string[] } {
	return {
		headHash: sha256hex(
			JSON.stringify({
				system: (prompt as { role?: unknown }[]).filter((m) => m.role === "system"),
				tools: tools ?? null,
			}),
		),
		requestHash: sha256hex(JSON.stringify(prompt)),
		promptHashes: prompt.map((m) => sha256hex(JSON.stringify(m))),
	};
}

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
		const { headHash, requestHash, promptHashes } = callHashes(params.prompt, params.tools);
		const settingsHash = hashCacheSettings(params);
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

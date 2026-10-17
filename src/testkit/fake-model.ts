// Shared provider-edge model fakes — the LanguageModelV4 skeleton suites
// used to hand-roll per file: scripted doStream attempts, recorded wire
// options, canonical part lists. Still a boundary fake — no module
// mocks — just not copied nine times. Test support only: only
// *.test.ts files import this directory; nothing here runs in prod.

import type {
	LanguageModelV4,
	LanguageModelV4CallOptions,
	LanguageModelV4GenerateResult,
	LanguageModelV4FinishReason,
	LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import type { LanguageModel } from "ai";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// What a drive() attempt is handed: the call's wire options plus a
// controller that swallows closed-stream throws (a cancelled stream's
// enqueue throws — racing cancellation is the norm in these tests).
export interface StreamDrive {
	options: LanguageModelV4CallOptions;
	enqueue(part: LanguageModelV4StreamPart): void;
	close(): void;
}

export type StreamAttempt =
	// enqueued verbatim, then the stream closes
	| LanguageModelV4StreamPart[]
	// doStream rejects — a provider-side rejection
	| Error
	// the stream errors on read
	| { readError: Error }
	// enqueues parts (default none), stays open; reader.cancel rejects
	| { cancelError: Error; parts?: LanguageModelV4StreamPart[] }
	// paced pushes — delayMs before each part in `pace` (all parts when
	// pace is unset); abortSignal checked each step
	| {
			parts: LanguageModelV4StreamPart[];
			delayMs?: number;
			pace?: ReadonlySet<LanguageModelV4StreamPart>;
	  }
	// free-form: the test drives the stream itself (gate promises, staged
	// parts). The stream closes only if drive calls ctx.close(); the
	// optional cancel hook rides the underlying-source cancel — a gate
	// awaited there models a slow provider cleanup.
	| {
			drive(ctx: StreamDrive): void | Promise<void>;
			cancel?(): void | Promise<void>;
	  };

export function finishPart(
	unified: LanguageModelV4FinishReason["unified"],
	inputTokens = 1,
	outputTokens = 1,
	cache?: { read?: number; write?: number },
): LanguageModelV4StreamPart {
	return {
		type: "finish",
		finishReason: { unified, raw: undefined },
		usage: {
			inputTokens: {
				total: inputTokens,
				noCache: undefined,
				cacheRead: cache?.read,
				cacheWrite: cache?.write,
			},
			outputTokens: { total: outputTokens, text: undefined, reasoning: undefined },
		},
	};
}

export function textParts(text: string | string[], inputTokens = 1): LanguageModelV4StreamPart[] {
	const deltas = typeof text === "string" ? [text] : text;
	return [
		{ type: "stream-start", warnings: [] },
		{ type: "text-start", id: "t1" },
		...deltas.map((delta): LanguageModelV4StreamPart => ({ type: "text-delta", id: "t1", delta })),
		{ type: "text-end", id: "t1" },
		finishPart("stop", inputTokens, deltas.length),
	];
}

export function toolCallPart(
	toolCallId: string,
	toolName = "probe",
	input = "{}",
): LanguageModelV4StreamPart {
	return { type: "tool-call", toolCallId, toolName, input };
}

// One-line doGenerate answer — the shape a provider returns for a
// finished text generation.
export function textResult(
	text: string,
	unified: LanguageModelV4FinishReason["unified"] = "stop",
): LanguageModelV4GenerateResult {
	return {
		content: [{ type: "text", text }],
		finishReason: { unified, raw: undefined },
		warnings: [],
		usage: {
			inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
			outputTokens: { total: 1, text: undefined, reasoning: undefined },
		},
	};
}

export interface ScriptedModel {
	model: LanguageModel;
	// Every doStream/doGenerate call's raw wire options, in order —
	// tests project what they need (prompt, toolChoice, abortSignal).
	streamCalls: LanguageModelV4CallOptions[];
	generateCalls: LanguageModelV4CallOptions[];
}

export function scriptedModel(
	attempts: StreamAttempt[],
	opts: {
		// Calls past the script — default is a loud unexpected-call error.
		extra?: StreamAttempt;
		// Per-call dynamic attempt: consulted when no scripted entry covers
		// the index — a model whose parts depend on the wire options
		// (toolChoice probes, open-ended loops) or on the call count.
		onStream?: (
			options: LanguageModelV4CallOptions,
			index: number,
		) => StreamAttempt | Promise<StreamAttempt>;
		modelId?: string;
		onGenerate?: (
			options: LanguageModelV4CallOptions,
			index: number,
		) => LanguageModelV4GenerateResult | Promise<LanguageModelV4GenerateResult>;
	} = {},
): ScriptedModel {
	const streamCalls: LanguageModelV4CallOptions[] = [];
	const generateCalls: LanguageModelV4CallOptions[] = [];
	const model: LanguageModelV4 = {
		specificationVersion: "v4",
		provider: "fake",
		modelId: opts.modelId ?? "fake-1",
		supportedUrls: {},
		async doGenerate(options: LanguageModelV4CallOptions) {
			generateCalls.push(options);
			if (!opts.onGenerate) throw new Error("unimplemented doGenerate");
			return opts.onGenerate(options, generateCalls.length - 1);
		},
		async doStream(options: LanguageModelV4CallOptions) {
			streamCalls.push(options);
			const index = streamCalls.length - 1;
			const attempt =
				attempts[index] ?? (await opts.onStream?.(options, index)) ?? opts.extra;
			if (attempt === undefined) throw new Error("unexpected extra model request");
			if (attempt instanceof Error) throw attempt;
			if (Array.isArray(attempt)) {
				return {
					stream: new ReadableStream<LanguageModelV4StreamPart>({
						start(controller) {
							for (const part of attempt) controller.enqueue(part);
							controller.close();
						},
					}),
				};
			}
			if ("readError" in attempt) {
				return {
					stream: new ReadableStream<LanguageModelV4StreamPart>({
						start(controller) {
							controller.error(attempt.readError);
						},
					}),
				};
			}
			if ("cancelError" in attempt) {
				return {
					stream: new ReadableStream<LanguageModelV4StreamPart>({
						start(controller) {
							for (const part of attempt.parts ?? []) controller.enqueue(part);
							// Deliberately left open — reader.cancel exercises cleanup.
						},
						cancel() {
							throw attempt.cancelError;
						},
					}),
				};
			}
			if ("drive" in attempt) {
				const { drive, cancel } = attempt;
				return {
					stream: new ReadableStream<LanguageModelV4StreamPart>({
						async start(controller) {
							await drive({
								options,
								enqueue(part) {
									try {
										controller.enqueue(part);
									} catch {
										/* closed by cancel */
									}
								},
								close() {
									try {
										controller.close();
									} catch {
										/* already closed */
									}
								},
							});
						},
						...(cancel ? { cancel: () => cancel() } : {}),
					}),
				};
			}
			const signal = options.abortSignal;
			return {
				stream: new ReadableStream<LanguageModelV4StreamPart>({
					async start(controller) {
						for (const part of attempt.parts) {
							if (signal?.aborted) break;
							if (attempt.delayMs && (attempt.pace === undefined || attempt.pace.has(part)))
								await sleep(attempt.delayMs);
							try {
								controller.enqueue(part);
							} catch {
								break; // closed by abort
							}
						}
						try {
							controller.close();
						} catch {
							/* already closed */
						}
					},
				}),
			};
		},
	};
	return { model: model as unknown as LanguageModel, streamCalls, generateCalls };
}

// The common case: every call streams the same text deltas; delayMs
// paces the deltas only — framing parts land immediately so a slow body
// models a silent stream, not a slow handshake.
export function textModel(
	deltas: string | string[],
	opts: { delayMs?: number; modelId?: string } = {},
): ScriptedModel {
	const parts = textParts(deltas);
	return scriptedModel([], {
		modelId: opts.modelId ?? "fake-1",
		extra: {
			parts,
			delayMs: opts.delayMs ?? 0,
			pace: new Set(parts.filter((p) => p.type === "text-delta")),
		},
	});
}

// The generate arm's common case: every doGenerate is answered by
// `respond`; doStream stays a loud unexpected-call error.
export function generateModel(
	respond: (
		options: LanguageModelV4CallOptions,
		index: number,
	) => LanguageModelV4GenerateResult | Promise<LanguageModelV4GenerateResult>,
	opts: { modelId?: string } = {},
): ScriptedModel {
	return scriptedModel([], { modelId: opts.modelId ?? "fake-1", onGenerate: respond });
}

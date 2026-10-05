// Normalize explicit filter failures into stream errors so streamText's
// step-local retry can handle HTTP rejections and finish-reason filters
// as well as SSE error chunks. No retries here: the runtime owns the
// one-per-turn budget. Ordinary assistant refusal text is never inspected.

import type {
	LanguageModelV4StreamPart,
	LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { wrapLanguageModel, type LanguageModel } from "ai";
import { isContentFilter, ProviderContentFilterError } from "./provider-errors.ts";
import { log } from "../log.ts";

export function filterErrorStream(model: LanguageModel, conversation: string): LanguageModel {
	if (typeof model === "string") return model;
	return wrapLanguageModel({
		model,
		middleware: {
			wrapStream: async ({ doStream }) => {
				let result: LanguageModelV4StreamResult;
				try {
					result = await doStream();
				} catch (error) {
					if (!isContentFilter(error)) throw error;
					return {
						stream: new ReadableStream<LanguageModelV4StreamPart>({
							start(controller) {
								controller.enqueue({ type: "error", error });
								controller.close();
							},
						}),
					};
				}
				const reader = result.stream.getReader();
				// The SDK drops tools when it retries, but flushes them on a
				// terminal error. Keep this attempt's tools here until a clean
				// finish, so even an exhausted filter cannot execute them.
				const buffered: LanguageModelV4StreamPart[] = [];
				let cancelled = false;
				return {
					...result,
					stream: new ReadableStream<LanguageModelV4StreamPart>({
						async pull(controller) {
							const flush = () => {
								for (const part of buffered) controller.enqueue(part);
								buffered.length = 0;
							};
							try {
								// A buffered part produces no output. Keep reading until
								// there is something to enqueue or the stream ends:
								// ReadableStream won't call pull again just because this
								// invocation returned without satisfying its pending read.
								while (!cancelled) {
									const { done, value } = await reader.read();
									if (cancelled) return;
									if (done) {
										flush();
										controller.close();
									} else if (
										(value.type === "error" && isContentFilter(value.error)) ||
										(value.type === "finish" && value.finishReason.unified === "content-filter")
									) {
										buffered.length = 0;
										const error = value.type === "error"
											? value.error
											: new ProviderContentFilterError(value.finishReason, value.usage);
										try {
											await reader.cancel(error);
										} catch (cleanupError) {
											// Cleanup must not erase the already-classified failure.
											log.error("provider filtered stream cancellation failed", cleanupError, {
												conversation,
												model: `${model.provider}/${model.modelId}`,
												filter: String(error),
											});
										}
										if (cancelled) return;
										controller.enqueue({ type: "error", error });
										controller.close();
									} else if (value.type === "finish" || value.type === "error") {
										flush();
										controller.enqueue(value);
									} else if (buffered.length > 0 || isToolPart(value)) {
										buffered.push(value);
										continue;
									} else {
										controller.enqueue(value);
									}
									return;
								}
							} catch (error) {
								if (cancelled) return;
								if (!isContentFilter(error)) {
									controller.error(error);
									return;
								}
								buffered.length = 0;
								controller.enqueue({ type: "error", error });
								controller.close();
							}
						},
						cancel(reason: unknown) {
							cancelled = true;
							buffered.length = 0;
							return reader.cancel(reason);
						},
					}),
				};
			},
		},
	});
}

function isToolPart(part: LanguageModelV4StreamPart): boolean {
	return part.type === "tool-input-start" || part.type === "tool-input-delta" ||
		part.type === "tool-input-end" || part.type === "tool-call" ||
		part.type === "tool-result" || part.type === "tool-approval-request";
}

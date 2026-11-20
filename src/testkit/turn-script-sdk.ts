import { APICallError, type LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { aiSdkEngine } from "../turn/ai-sdk-engine.ts";
import type { ModelStep } from "../turn/ai-sdk-step.ts";
import { finishPart, scriptedModel, type StreamAttempt } from "./fake-model.ts";
import type { ScriptCall, ScriptPart, ScriptedModel, ScriptUsage } from "./turn-script.ts";

export interface SdkScriptedModel extends ScriptedModel {
	/** Full serialized AI SDK call options, for tests that pin provider request identity. */
	callOptions(): string[];
}

function streamParts(parts: ScriptPart[], usage?: ScriptUsage, finish?: "length" | "content-filter"): LanguageModelV4StreamPart[] {
	const out: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
	let id = 0;
	for (const part of parts) {
		if (part.type === "text" || part.type === "reasoning") {
			const key = `${part.type}-${++id}`;
			if (part.type === "text") {
				out.push(
					{ type: "text-start", id: key },
					{ type: "text-delta", id: key, delta: part.text },
					{ type: "text-end", id: key },
				);
			} else {
				out.push(
					{ type: "reasoning-start", id: key },
					{ type: "reasoning-delta", id: key, delta: part.text },
					{ type: "reasoning-end", id: key },
				);
			}
		} else {
			out.push({
				type: "tool-call",
				toolCallId: part.toolCallId ?? `script-${id++}`,
				toolName: part.toolName,
				input: JSON.stringify(part.input),
			});
		}
	}
	const hasTool = parts.some((p) => p.type === "tool-call");
	out.push(
		finishPart(
			finish ?? (hasTool ? "tool-calls" : "stop"),
			usage?.input ?? 1,
			usage?.output ?? 1,
			usage === undefined
				? undefined
				: {
						...(usage.cacheRead !== undefined ? { read: usage.cacheRead } : {}),
						...(usage.cacheWrite !== undefined ? { write: usage.cacheWrite } : {}),
					},
		),
	);
	return out;
}

const errorFor = (error: { message: string; status?: number }): Error =>
	error.status === undefined
		? new Error(error.message)
		: new APICallError({
				message: error.message,
				url: "https://fake.invalid",
				requestBodyValues: {},
				statusCode: error.status,
				isRetryable: false,
			});

export function sdkScript(opts: { label?: string; system?: string } = {}): SdkScriptedModel {
	const queue: ScriptCall[] = [];
	const requests: string[] = [];
	const callOptions: string[] = [];
	let callCount = 0;
	const active = scriptedModel([], {
		onStream(options, index) {
			callCount = index + 1;
			requests.push(JSON.stringify(options.prompt));
			callOptions.push(JSON.stringify(options));
			const call = queue.shift();
			if (call === undefined) throw new Error("ai-sdk script exhausted: unexpected model call");
			if (call.kind === "fail" && call.parts.length === 0) throw errorFor(call.error);
			const parts = streamParts(
				call.parts,
				call.kind === "fail" ? undefined : call.usage,
				call.kind === "reply" ? call.finish : undefined,
			);
			if (call.kind === "fail") return { readError: errorFor(call.error), parts: parts.slice(0, -1) };
			if (call.kind === "hold") {
				// Hold mid-step: before the finish and, when the call ends in
				// text, before that part's end.
				const tail = call.parts.at(-1)?.type === "text" ? 2 : 1;
				return {
					drive: async ({ enqueue, close }) => {
						for (const part of parts.slice(0, -tail)) enqueue(part);
						call.entered?.();
						await call.gate;
						for (const part of parts.slice(-tail)) enqueue(part);
						close();
					},
				};
			}
			return parts satisfies StreamAttempt;
		},
	});
	return {
		engineId: "ai-sdk",
		step: () => ({ engine: "ai-sdk", model: active.model, system: opts.system ?? "test", label: opts.label ?? "fake/fake-1", maxRetries: 0 } satisfies ModelStep),
		engines: [aiSdkEngine],
		script: (...calls) => {
			queue.push(...calls);
		},
		calls: () => callCount,
		requests: () => [...requests],
		callOptions: () => [...callOptions],
	};
}

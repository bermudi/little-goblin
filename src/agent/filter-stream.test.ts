import { describe, expect, test } from "bun:test";
import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { filterErrorStream } from "./filter-stream.ts";
import { ProviderContentFilterError } from "./provider-errors.ts";

const toolParts: LanguageModelV4StreamPart[] = [
	{ type: "tool-input-start", id: "call", toolName: "probe" },
	{ type: "tool-input-delta", id: "call", delta: "{" },
	{ type: "tool-input-delta", id: "call", delta: "}" },
	{ type: "tool-input-end", id: "call" },
	{ type: "tool-call", toolCallId: "call", toolName: "probe", input: "{}" },
];

function finish(reason: "tool-calls" | "content-filter"): LanguageModelV4StreamPart {
	return {
		type: "finish",
		finishReason: { unified: reason, raw: undefined },
		usage: {
			inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
			outputTokens: { total: 1, text: undefined, reasoning: undefined },
		},
	};
}

interface StreamSource {
	start(controller: ReadableStreamDefaultController<LanguageModelV4StreamPart>): void;
	cancel?(): void;
}

async function wrappedStream(source: StreamSource) {
	const model: LanguageModelV4 = {
		specificationVersion: "v4",
		provider: "test",
		modelId: "tool-stream",
		supportedUrls: {},
		doGenerate() {
			throw new Error("unused");
		},
		async doStream() {
			return { stream: new ReadableStream<LanguageModelV4StreamPart>(source) };
		},
	};
	const wrapped = filterErrorStream(model, "test");
	if (typeof wrapped === "string" || wrapped.specificationVersion !== "v4") {
		throw new Error("expected wrapped v4 model");
	}
	return (await wrapped.doStream({ prompt: [] })).stream;
}

async function collect(parts: LanguageModelV4StreamPart[]): Promise<LanguageModelV4StreamPart[]> {
	const stream = await wrappedStream({
		start(controller) {
			controller.enqueue({ type: "stream-start", warnings: [] });
			for (const part of parts) controller.enqueue(part);
			controller.close();
		},
	});
	const reader = stream.getReader();
	const output: LanguageModelV4StreamPart[] = [];
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return output;
			output.push(value);
		}
	} finally {
		reader.releaseLock();
	}
}

describe("provider filter stream", () => {
	test("a complete chunked tool call drains instead of deadlocking on buffered parts", async () => {
		const end = finish("tool-calls");
		const output = await collect([...toolParts, end]);
		expect(output).toEqual([{ type: "stream-start", warnings: [] }, ...toolParts, end]);
	}, 1_000);

	for (const [name, failure] of [
		["error chunk", { type: "error", error: new ProviderContentFilterError() }],
		["filter finish", finish("content-filter")],
	] satisfies [string, LanguageModelV4StreamPart][]) {
		test(`${name} after chunked tool input discards the entire buffered call`, async () => {
			const output = await collect([...toolParts, failure]);
			expect(output.map((part) => part.type)).toEqual(["stream-start", "error"]);
		}, 1_000);
	}

	test("cancelling while a buffered tool waits for its finish cancels the provider", async () => {
		let cancelled = false;
		const stream = await wrappedStream({
			start(controller) {
				controller.enqueue({ type: "stream-start", warnings: [] });
				for (const part of toolParts) controller.enqueue(part);
				// Intentionally remain open: cancellation must settle the pending read.
			},
			cancel() {
				cancelled = true;
			},
		});
		const reader = stream.getReader();
		expect((await reader.read()).value?.type).toBe("stream-start");
		const pending = reader.read();
		await reader.cancel();
		expect(await pending).toEqual({ done: true, value: undefined });
		expect(cancelled).toBe(true);
		reader.releaseLock();
	}, 1_000);
});

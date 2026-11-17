import { describe, expect, test } from "bun:test";
import type { MessageChunk } from "../message.ts";
import type { TurnDone, TurnSink } from "./sink.ts";

const core = {
	onTextDelta(_delta: string) {},
	onReasoningDelta(_delta: string) {},
	onToolCall(_toolName: string, _input: unknown) {},
	onDone(_done: TurnDone) {},
};

describe("TurnSink delivery", () => {
	test("delivery is a discriminant for the chunk callback", () => {
		// @ts-expect-error Streaming sinks must provide their chunk callback.
		const missingChunk: TurnSink = { ...core, delivery: "stream" };
		// @ts-expect-error Headless sinks cannot provide a chunk callback.
		const unexpectedChunk: TurnSink = { ...core, delivery: "headless", onStreamChunk(_chunk: MessageChunk) {} };

		const sink: TurnSink = { ...core, delivery: "headless" };
		expect([sink.delivery, missingChunk, unexpectedChunk].length).toBe(3);
	});
});

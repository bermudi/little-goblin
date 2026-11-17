import { expect, test } from "bun:test";
import type {
	DynamicToolUIPart,
	FinishReason as SDKFinishReason,
	LanguageModelUsage,
	ToolUIPart,
	UIMessage,
	UIMessageChunk,
} from "ai";
import type {
	DynamicToolPart,
	FinishReason,
	Message,
	MessageChunk,
	MessagePart,
	ToolPart,
	Usage,
} from "./message.ts";

type Assignable<A, B> = [A] extends [B] ? true : false;
type BothWays<A, B> = Assignable<A, B> extends true
	? Assignable<B, A> extends true
		? true
		: false
	: false;
type Assert<T extends true> = T;

type MessageDrift = Assert<BothWays<Message, UIMessage>>;
type MessagePartDrift = Assert<BothWays<MessagePart, UIMessage["parts"][number]>>;
type MessageChunkDrift = Assert<BothWays<MessageChunk, UIMessageChunk>>;
type UsageDrift = Assert<BothWays<Usage, LanguageModelUsage>>;
type FinishReasonDrift = Assert<BothWays<FinishReason, SDKFinishReason>>;
type ToolPartDrift = Assert<BothWays<ToolPart, ToolUIPart>>;
type DynamicToolPartDrift = Assert<BothWays<DynamicToolPart, DynamicToolUIPart>>;

const driftChecks: [
	MessageDrift,
	MessagePartDrift,
	MessageChunkDrift,
	UsageDrift,
	FinishReasonDrift,
	ToolPartDrift,
	DynamicToolPartDrift,
] = [true, true, true, true, true, true, true];

test("goblin message type drift assertions compile", () => {
	expect(driftChecks).toHaveLength(7);
});

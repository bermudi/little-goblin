import { expect, test } from "bun:test";
import type {
	AssistantContent as SDKAssistantContent,
	ModelMessage as SDKModelMessage,
	UserContent as SDKUserContent,
} from "ai";
import type {
	ToolContent as SDKToolContent,
	ToolResultOutput as SDKToolResultOutput,
} from "@ai-sdk/provider-utils";
import type {
	AssistantContent,
	PromptMessage,
	ToolContent,
	ToolResultOutput,
	UserContent,
} from "./prompt-message.ts";

type Assignable<A, B> = [A] extends [B] ? true : false;
type BothWays<A, B> = Assignable<A, B> extends true
	? Assignable<B, A> extends true
		? true
		: false
	: false;
type Assert<T extends true> = T;

type PromptMessageDrift = Assert<BothWays<PromptMessage, SDKModelMessage>>;
type AssistantContentDrift = Assert<BothWays<AssistantContent, SDKAssistantContent>>;
type ToolContentDrift = Assert<BothWays<ToolContent, SDKToolContent>>;
type UserContentDrift = Assert<BothWays<UserContent, SDKUserContent>>;
type ToolResultOutputDrift = Assert<BothWays<ToolResultOutput, SDKToolResultOutput>>;

const driftChecks: [
	PromptMessageDrift,
	AssistantContentDrift,
	ToolContentDrift,
	UserContentDrift,
	ToolResultOutputDrift,
] = [true, true, true, true, true];

test("goblin prompt message type drift assertions compile", () => {
	expect(driftChecks).toHaveLength(5);
});

// Rule-based tool-call repair: which broken inputs get rewritten and
// which stay broken. The streamText integration pins the boundary —
// a repaired call executes with the parsed input, an unrepairable one
// surfaces to the model as a tool error exactly as before.

import { describe, expect, test } from "bun:test";
import {
	InvalidToolInputError,
	NoSuchToolError,
	stepCountIs,
	streamText,
	tool,
	type ToolCallRepairFunction,
	type ToolSet,
} from "ai";
import type { LanguageModelV4ToolCall } from "@ai-sdk/provider";
import { z } from "zod";
import { finishPart, scriptedModel, textParts, toolCallPart } from "../testkit/fake-model.ts";
import { makeToolCallRepair } from "./tool-repair.ts";

type RepairOptions = Parameters<ToolCallRepairFunction<ToolSet>>[0];

const repair = makeToolCallRepair("conv-test");

function call(input: string, toolName = "probe"): LanguageModelV4ToolCall {
	return { type: "tool-call", toolCallId: "tc-1", toolName, input };
}

function opts(
	input: string,
	properties: Record<string, unknown>,
	error?: RepairOptions["error"],
): RepairOptions {
	return {
		instructions: undefined,
		system: undefined,
		messages: [],
		toolCall: call(input),
		tools: {},
		inputSchema: async () => ({ type: "object", properties }),
		error: error ?? new InvalidToolInputError({ toolInput: input, toolName: "probe", cause: null }),
	};
}

describe("makeToolCallRepair", () => {
	test("trailing-comma input is repaired via JSON5", async () => {
		const out = await repair(opts('{"a": 1, "b": [2, 3],}', { a: { type: "number" } }));
		expect(out).not.toBeNull();
		expect(JSON.parse(out!.input)).toEqual({ a: 1, b: [2, 3] });
	});

	test("a stringified array on an array-typed property is substituted", async () => {
		const out = await repair(
			opts('{"items": "[{\\"n\\": 1}]", "note": "x"}', {
				items: { type: "array" },
				note: { type: "string" },
			}),
		);
		expect(out).not.toBeNull();
		expect(JSON.parse(out!.input)).toEqual({ items: [{ n: 1 }], note: "x" });
	});

	test("object types hidden inside anyOf still substitute", async () => {
		const out = await repair(
			opts('{"cfg": "{\\"k\\": true}"}', {
				cfg: { anyOf: [{ type: "string" }, { type: "object" }] },
			}),
		);
		expect(out).not.toBeNull();
		expect(JSON.parse(out!.input)).toEqual({ cfg: { k: true } });
	});

	test("a string that does not parse to the declared kind stays", async () => {
		// Array-typed prop holding a JSON object string: no rule applies.
		const out = await repair(opts('{"items": "{\\"n\\": 1}"}', { items: { type: "array" } }));
		expect(out).toBeNull();
	});

	test("valid JSON with a semantic error is not repaired", async () => {
		const out = await repair(opts('{"a": "not a number"}', { a: { type: "number" } }));
		expect(out).toBeNull();
	});

	test("NoSuchToolError is never repaired", async () => {
		const out = await repair(
			opts("{}", {}, new NoSuchToolError({ toolName: "nope", availableTools: ["probe"] })),
		);
		expect(out).toBeNull();
	});

	test("truncated garbage is not repaired", async () => {
		const out = await repair(opts('{"a": "unterminated', { a: { type: "number" } }));
		expect(out).toBeNull();
	});
});

describe("streamText integration", () => {
	test("a stringified arg executes the tool with parsed input", async () => {
		const seen: unknown[] = [];
		const probe = tool({
			inputSchema: z.object({ payload: z.object({ n: z.number() }) }),
			execute: async (input) => {
				seen.push(input);
				return "ok";
			},
		});
		const scripted = scriptedModel([
			[{ type: "stream-start", warnings: [] }, toolCallPart("tc-1", "probe", '{"payload":"{\\"n\\":7}"}'), finishPart("tool-calls")],
			textParts("done"),
		]);
		const result = streamText({
			model: scripted.model,
			tools: { probe },
			prompt: "call it",
			stopWhen: stepCountIs(2),
			repairToolCall: makeToolCallRepair("conv-it"),
		});
		expect(await result.text).toBe("done");
		expect(seen).toEqual([{ payload: { n: 7 } }]);
	});

	test("an unrepairable call still surfaces as a tool error to the model", async () => {
		const seen: unknown[] = [];
		const probe = tool({
			inputSchema: z.object({ payload: z.object({ n: z.number() }) }),
			execute: async (input) => {
				seen.push(input);
				return "ok";
			},
		});
		const scripted = scriptedModel([
			[
				{ type: "stream-start", warnings: [] },
				toolCallPart("tc-1", "probe", '{"payload": {"n": '),
				finishPart("tool-calls"),
			],
			textParts("recovered"),
		]);
		const result = streamText({
			model: scripted.model,
			tools: { probe },
			prompt: "call it",
			stopWhen: stepCountIs(2),
			repairToolCall: makeToolCallRepair("conv-it"),
		});
		expect(await result.text).toBe("recovered");
		expect(seen).toEqual([]); // execute never ran
		const steps = await result.steps;
		expect(steps[0]!.toolCalls[0]!.invalid).toBe(true);
		// The error rode the next step's prompt as a tool message — the
		// unchanged no-repair path.
		const secondPrompt = JSON.stringify(scripted.streamCalls[1]!.prompt);
		expect(secondPrompt).toContain("error-text");
		expect(secondPrompt).toContain("InvalidToolInputError");
	});
});

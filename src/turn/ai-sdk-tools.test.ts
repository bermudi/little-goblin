import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineTool } from "../tool.ts";
import { toToolSet } from "./ai-sdk-tools.ts";

describe("toToolSet", () => {
	test("preserves function tool names, descriptions, order, and execution context", async () => {
		const abortSignal = new AbortController().signal;
		let received: unknown;
		const tools = toToolSet({
			first: defineTool({
				description: "first description",
				input: z.object({ value: z.string() }),
				execute(input, context) {
					received = { input, context };
					return "ok";
				},
				toModelOutput({ output }) {
					return { type: "text", value: output };
				},
			}),
			second: defineTool({
				description: "second description",
				input: z.object({}),
				execute: () => "done",
			}),
		});
		expect(Object.keys(tools)).toEqual(["first", "second"]);
		expect(tools.first?.description).toBe("first description");
		const first = tools.first?.execute;
		if (first === undefined) throw new Error("missing first executor");
		await Reflect.apply(first, undefined, [
			{ value: "v" },
			{ toolCallId: "call-1", abortSignal },
		]);
		expect(received).toEqual({
			input: { value: "v" },
			context: { toolCallId: "call-1", abortSignal },
		});
		const toModelOutput = tools.first?.toModelOutput;
		if (toModelOutput === undefined) throw new Error("missing model output mapper");
		expect(
			await Reflect.apply(toModelOutput, undefined, [
				{ output: "shaped", toolCallId: "call-2", input: { value: "v" } },
			]),
		).toEqual({ type: "text", value: "shaped" });
	});

	test("maps hosted codex search to the provider-defined tool", () => {
		const tools = toToolSet({
			web_search: {
				hosted: "codex.web_search",
				args: { externalWebAccess: true },
			},
		});
		expect(tools.web_search).toMatchObject({
			type: "provider",
			id: "codex.web_search",
			args: { externalWebAccess: true },
		});
	});
});

import { describe, expect, test } from "bun:test";
import { asSchema } from "ai";
import { isHosted, inputJsonSchema } from "./tool.ts";
import { toToolSet } from "./turn/ai-sdk-tools.ts";
import { makeTools } from "./agent/tools/mod.ts";

describe("goblin tool input schemas", () => {
	test("match the AI SDK schemas for every mounted function tool", () => {
		const tools = makeTools({ cwd: "/tmp" });
		for (const [name, definition] of Object.entries(tools)) {
			if (isHosted(definition)) continue;
			const sdkTool = toToolSet({ [name]: definition })[name];
			if (sdkTool === undefined) throw new Error(`missing SDK tool ${name}`);
			expect(inputJsonSchema(definition)).toEqual(
				asSchema(sdkTool.inputSchema).jsonSchema,
			);
		}
	});
});

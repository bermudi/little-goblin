// Bridge unit tests: validation, toModelOutput shaping, FIFO adoption,
// and the degraded schema fallback — driven through invoke() (the same
// closures the MCP registration holds), no child CLI.

import { describe, expect, test } from "bun:test";
import { jsonSchema, type ToolSet, tool } from "ai";
import { z } from "zod";
import { createToolBridge } from "./tools.ts";

function tools(): ToolSet {
	return {
		echo: tool({
			description: "echo",
			inputSchema: z.object({ message: z.string(), times: z.number().optional() }),
			execute: async ({ message, times }) => `echo:${message}:${times ?? 1}`,
		}),
		ui: tool({
			description: "wire-schema tool",
			inputSchema: jsonSchema<{ kind: string }>({
				type: "object",
				properties: {
					kind: { type: "string" },
					opts: { type: "object", additionalProperties: true },
				},
				required: ["kind"],
			}),
			execute: async (input) => `ui:${input.kind}`,
		}),
		shaper: tool({
			description: "shapes its model output",
			inputSchema: z.object({}),
			execute: async () => ({ payload: "raw" }),
			toModelOutput: () => ({ type: "json", value: { shaped: true } }),
		}),
		loose: tool({
			description: "non-object schema",
			inputSchema: jsonSchema({ type: "string" }),
			execute: async (input) => `loose:${String(input)}`,
		}),
	};
}

describe("createToolBridge", () => {
	test("the model surface is exactly goblin's ToolSet names", () => {
		const b = createToolBridge({ convId: "c", tools: tools() });
		expect(b.toolNames()).toEqual(["echo", "ui", "shaper", "loose"]);
		expect(b.allowedTools()).toEqual(["mcp__goblin"]);
	});

	test("invoke parses zod args and returns the exact execution output", async () => {
		const b = createToolBridge({ convId: "c", tools: tools() });
		const r = await b.invoke("echo", { message: "hi", times: 2 });
		expect(r).toEqual({ output: "echo:hi:2", error: null });
	});

	test("invalid arguments become a loud error result, never an execution", async () => {
		const b = createToolBridge({ convId: "c", tools: tools() });
		const r = await b.invoke("echo", { message: 42 });
		expect(r.output).toBeNull();
		expect(r.error).toContain("invalid arguments for echo");
		expect(r.error).toContain("message");
	});

	test("jsonSchema tools parse through their derived shape", async () => {
		const b = createToolBridge({ convId: "c", tools: tools() });
		const r = await b.invoke("ui", { kind: "note" });
		expect(r).toEqual({ output: "ui:note", error: null });
	});

	test("toModelOutput shapes the model-facing text without touching adoption", async () => {
		const b = createToolBridge({ convId: "c", tools: tools() });
		const r = await b.invoke("shaper", {});
		// Adoption carries the tool's real output, not the shaped form.
		expect(r).toEqual({ output: { payload: "raw" }, error: null });
	});

	test("a non-object schema degrades to a permissive arg wrapper", async () => {
		const b = createToolBridge({ convId: "c", tools: tools() });
		const r = await b.invoke("loose", { args: "anything" });
		expect(r.output).toBe("loose:[object Object]");
	});

	test("adoptResult prefers the exact (name, input) match, FIFO otherwise", async () => {
		const b = createToolBridge({ convId: "c", tools: tools() });
		await b.invoke("echo", { message: "first" });
		await b.invoke("echo", { message: "second" });
		const exact = b.adoptResult("echo", { message: "second" });
		expect(exact?.output).toBe("echo:second:1");
		const fifo = b.adoptResult("echo", null);
		expect(fifo?.output).toBe("echo:first:1");
		expect(b.adoptResult("echo", null)).toBeNull();
	});

	test("an execution error adopts with its error text", async () => {
		const failing: ToolSet = {
			failing: tool({
				description: "f",
				inputSchema: z.object({}),
				execute: async (): Promise<string> => {
					throw new Error("boom");
				},
			}),
		};
		const b = createToolBridge({ convId: "c", tools: failing });
		const r = await b.invoke("failing", {});
		expect(r).toEqual({ output: null, error: "boom" });
	});

	test("unknown tools fail loud, never throw", async () => {
		const b = createToolBridge({ convId: "c", tools: {} });
		const r = await b.invoke("ghost", {});
		expect(r.error).toContain("no bridged tool named ghost");
	});
});

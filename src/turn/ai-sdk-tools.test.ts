import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineTool } from "../tool.ts";
import {
	omitFunctionToolsFromRequest,
	persistableToolSet,
	restoreToolSet,
	ToolExecuteError,
	toolSetDeclarations,
	toToolSet,
} from "./ai-sdk-tools.ts";
import { declarationsOf } from "../agent/tool-declarations.ts";

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

	test("content outputs translate to SDK file parts; text/json pass through", async () => {
		const png = new Uint8Array([1, 2, 3]);
		const tools = toToolSet({
			frame: defineTool({
				description: "frame",
				input: z.object({}),
				execute: () => "x",
				toModelOutput: () => ({
					type: "content",
					value: [
						{ type: "text", text: "caption" },
						{ type: "image", mediaType: "image/png", data: png },
					],
				}),
			}),
			plain: defineTool({
				description: "plain",
				input: z.object({}),
				execute: () => "x",
				toModelOutput: () => ({ type: "json", value: { a: 1 } }),
			}),
		});
		const frameOut = tools.frame?.toModelOutput;
		if (frameOut === undefined) throw new Error("missing mapper");
		const shaped = (await Reflect.apply(frameOut, undefined, [
			{ output: "x", toolCallId: "c", input: {} },
		])) as { type: string; value: Array<Record<string, unknown>> };
		expect(shaped.type).toBe("content");
		expect(shaped.value[0]).toEqual({ type: "text", text: "caption" });
		expect(shaped.value[1]).toEqual({
			type: "file",
			mediaType: "image/png",
			data: { type: "data", data: png },
		});
		const plainOut = tools.plain?.toModelOutput;
		if (plainOut === undefined) throw new Error("missing mapper");
		expect(
			await Reflect.apply(plainOut, undefined, [{ output: "x", toolCallId: "c", input: {} }]),
		).toEqual({ type: "json", value: { a: 1 } });
	});

	test("maps hosted codex search to the stock OpenAI web search tool", () => {
		const tools = toToolSet({
			web_search: {
				hosted: "codex.web_search",
				args: { externalWebAccess: true },
			},
		});
		expect(tools.web_search).toMatchObject({
			type: "provider",
			id: "openai.web_search",
			args: { externalWebAccess: true },
		});
	});

	test("omits only function tools from the request and preserves their options", () => {
		const tools = toToolSet({
			local: defineTool({
				description: "local",
				input: z.object({}),
				execute: () => "ok",
			}),
			web_search: { hosted: "codex.web_search", args: { externalWebAccess: true } },
		});
		const omitted = omitFunctionToolsFromRequest(tools);
		expect(omitted.local?.providerOptions?.openai).toMatchObject({
			omitFromRequestTools: true,
		});
		expect(omitted.web_search).toBe(tools.web_search);
	});

	test("hosted search survives the persisted tool-set round trip", async () => {
		const persisted = await persistableToolSet({
			web_search: { hosted: "codex.web_search", args: { externalWebAccess: false } },
		});
		if ("unpersistable" in persisted) throw new Error("hosted search was unpersistable");
		expect(restoreToolSet(JSON.parse(persisted.json)).web_search).toMatchObject({
			type: "provider",
			id: "openai.web_search",
			args: { externalWebAccess: false },
		});
	});
});

describe("ToolExecuteError", () => {
	test("keeps the tool message and original cause", () => {
		const cause = new Error("fetch failed — parallel: timed out");
		const error = new ToolExecuteError(cause.message, cause);

		expect(error.message).toBe("fetch failed — parallel: timed out");
		expect(error.cause).toBe(cause);
	});
});

describe("toolSetDeclarations", () => {
	test("matches the turn's declarations for live and restored tool sets", async () => {
		const tools = {
			zod: defineTool({
				description: "Zod input.",
				input: z.object({ path: z.string(), limit: z.number().optional() }),
				execute: () => "unused",
			}),
			raw: defineTool({
				description: "Raw JSON schema input.",
				input: z.object({ q: z.string() }),
				jsonSchema: { type: "object", properties: { q: { type: "string", description: "query" } }, required: ["q"] },
				execute: () => "unused",
			}),
			web_search: { hosted: "codex.web_search", args: { externalWebAccess: false } },
		} as const;
		const expected = JSON.stringify(declarationsOf(tools));
		expect(JSON.stringify(await toolSetDeclarations(toToolSet(tools)))).toBe(expected);
		const persisted = await persistableToolSet(tools);
		if ("unpersistable" in persisted) throw new Error(`${persisted.unpersistable} was unpersistable`);
		expect(JSON.stringify(await toolSetDeclarations(restoreToolSet(JSON.parse(persisted.json))))).toBe(expected);
	});
});

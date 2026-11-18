import { createProviderDefinedToolFactory } from "@ai-sdk/provider-utils";
import { jsonSchema, tool, type ToolSet } from "ai";
import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import { z } from "zod";
import { isHosted, type Tool, type ToolOutput, type Tools } from "../tool.ts";

export class ToolExecuteError extends Error {
	constructor(message: string, cause: unknown) {
		super(message, { cause });
		this.name = "ToolExecuteError";
	}
}

export const codexWebSearch = createProviderDefinedToolFactory<
	Record<string, unknown>,
	{ externalWebAccess: boolean }
>({
	id: "codex.web_search",
	inputSchema: z.looseObject({}),
});

// Goblin's content output → the SDK's ToolResultOutput content shape:
// text passes through, an image becomes a file part whose data payload
// is the raw bytes. Providers that cannot carry media in a tool result
// stringify or drop the file part themselves (design/tools.md).
function toSdkToolOutput(output: ToolOutput): ToolResultOutput {
	if (output.type !== "content") return output;
	return {
		type: "content",
		value: output.value.map((part) =>
			part.type === "text"
				? { type: "text" as const, text: part.text }
				: {
						type: "file" as const,
						mediaType: part.mediaType,
						data: { type: "data" as const, data: part.data },
					},
		),
	};
}

function toSdkTool(definition: Exclude<Tool, { hosted: string }>) {
	const toModelOutput = definition.toModelOutput;
	const inputSchema =
		definition.jsonSchema === undefined
			? definition.input
			: jsonSchema(definition.jsonSchema, {
					validate: async (value: unknown) => {
						const parsed = await definition.input.safeParseAsync(value);
						return parsed.success
							? { success: true, value: parsed.data }
							: { success: false, error: parsed.error };
					},
				});
	return tool({
		description: definition.description,
		inputSchema,
		async execute(input, options) {
			try {
				return await definition.execute(input, {
					toolCallId: options.toolCallId,
					...(options.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
				});
			} catch (err) {
				throw new ToolExecuteError(err instanceof Error ? err.message : String(err), err);
			}
		},
		...(toModelOutput !== undefined
			? {
					toModelOutput: async (options) =>
						toSdkToolOutput(await toModelOutput(options)),
				}
			: {}),
	});
}

export function toToolSet(tools: Tools): ToolSet {
	const out: ToolSet = {};
	for (const [name, definition] of Object.entries(tools)) {
		out[name] = isHosted(definition)
			? codexWebSearch(definition.args)
			: toSdkTool(definition);
	}
	return out;
}

import { createProviderDefinedToolFactory } from "@ai-sdk/provider-utils";
import { jsonSchema, tool, type ToolSet } from "ai";
import { z } from "zod";
import { isHosted, type Tool, type Tools } from "../tool.ts";

export const codexWebSearch = createProviderDefinedToolFactory<
	Record<string, unknown>,
	{ externalWebAccess: boolean }
>({
	id: "codex.web_search",
	inputSchema: z.looseObject({}),
});

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
		execute(input, options) {
			return definition.execute(input, {
				toolCallId: options.toolCallId,
				...(options.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
			});
		},
		...(toModelOutput !== undefined
			? { toModelOutput: (options) => toModelOutput(options) }
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

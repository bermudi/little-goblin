import { createProviderDefinedToolFactory } from "@ai-sdk/provider-utils";
import { asSchema, jsonSchema, tool, type ToolSet } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import { z } from "zod";
import { isHosted, type Tool, type ToolOutput, type Tools } from "../tool.ts";

const storedToolSchema = z.object({
	name: z.string().min(1),
	type: z.enum(["function", "provider"]).optional(),
	description: z.string().optional(),
	id: z.string().optional(),
	args: z.record(z.string(), z.unknown()).optional(),
	inputSchema: z.record(z.string(), z.unknown()),
	providerOptions: z.record(z.string(), z.unknown()).optional(),
	isProviderExecuted: z.boolean().optional(),
	modelOutput: z.boolean().optional(),
}).strict();
const storedToolsSchema = z.array(storedToolSchema);

export type SDKToolSet = ToolSet;

export async function persistableToolSet(
	tools: Tools,
): Promise<{ tools: ToolSet; json: string } | { unpersistable: string }> {
	const sdkTools = toToolSet(tools);
	const persisted: z.infer<typeof storedToolSchema>[] = [];
	for (const [name, definition] of Object.entries(sdkTools)) {
		if (definition.type !== "provider" && typeof definition.description === "function") {
			return { unpersistable: name };
		}
		if (
			definition.type === "provider" &&
			(definition.id === undefined || definition.args === undefined)
		) {
			throw new Error(`provider tool ${name} is missing id or args`);
		}
		const inputSchema = await asSchema(definition.inputSchema).jsonSchema;
		const record: Record<string, unknown> = {
			name,
			inputSchema: inputSchema as Record<string, unknown>,
			...(definition.type === "provider"
				? {
						type: "provider" as const,
						id: definition.id,
						args: definition.args as Record<string, unknown>,
						isProviderExecuted: definition.isProviderExecuted,
					}
				: {
						type: "function" as const,
						...(typeof definition.description === "string"
							? { description: definition.description }
							: {}),
					}),
				...("providerOptions" in definition && definition.providerOptions !== undefined
					? { providerOptions: definition.providerOptions as Record<string, unknown> }
					: {}),
				...("toModelOutput" in definition && definition.toModelOutput !== undefined
					? { modelOutput: true }
					: {}),
		};
		persisted.push(storedToolSchema.parse(JSON.parse(JSON.stringify(record)) as unknown));
	}
	const parsed = storedToolsSchema.parse(persisted);
	return { tools: restoreToolSet(parsed), json: JSON.stringify(parsed) };
}

export function storedModelOutputTools(value: unknown): string[] {
	return storedToolsSchema
		.parse(value)
		.filter((stored) => stored.modelOutput === true)
		.map((stored) => stored.name);
}

export function restoreToolSet(value: unknown): ToolSet {
	const records = storedToolsSchema.parse(value);
	const tools: ToolSet = {};
	for (const stored of records) {
		if (stored.type === "provider") {
			if (stored.id === undefined || stored.args === undefined) {
				throw new Error(`stored provider tool ${stored.name} is missing id or args`);
			}
			const factory = createProviderDefinedToolFactory<Record<string, unknown>, Record<string, unknown>>({
				id: stored.id as `${string}.${string}`,
				inputSchema: jsonSchema<Record<string, unknown>>(stored.inputSchema),
			});
			tools[stored.name] = factory(stored.args);
		} else {
			tools[stored.name] = ({
				...(stored.description !== undefined ? { description: stored.description } : {}),
				inputSchema: jsonSchema<Record<string, unknown>>(stored.inputSchema),
				...(stored.providerOptions !== undefined
					? { providerOptions: stored.providerOptions as ProviderOptions }
					: {}),
			} as unknown as ToolSet[string]);
		}
	}
	return tools;
}

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

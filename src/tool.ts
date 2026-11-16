import { z } from "zod";
import type { JSONObject, JSONValue } from "./message.ts";

export interface ToolCallContext {
	toolCallId: string;
	abortSignal?: AbortSignal;
}

export type ToolOutput =
	| { type: "text"; value: string }
	| { type: "json"; value: JSONValue };

export interface FunctionTool<I, O> {
	description: string;
	input: z.ZodType<I>;
	/** A model-facing override used only by the ui tool. */
	jsonSchema?: JSONObject;
	execute(input: I, context: ToolCallContext): Promise<O> | O;
	toModelOutput?(options: {
		output: O;
		toolCallId: string;
		input: I;
	}): ToolOutput | Promise<ToolOutput>;
}

export interface HostedTool {
	hosted: "codex.web_search";
	args: { externalWebAccess: boolean };
}

export type Tool = FunctionTool<unknown, unknown> | HostedTool;
export type Tools = Record<string, Tool>;

export function defineTool<I, O>(tool: FunctionTool<I, O>): FunctionTool<I, O> {
	return tool;
}

export function isHosted(tool: Tool): tool is HostedTool {
	return "hosted" in tool;
}

function isJsonValue(value: unknown): value is JSONValue {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return true;
	}
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (typeof value !== "object") return false;
	return Object.values(value).every((item) => item === undefined || isJsonValue(item));
}

function isJSONObject(value: unknown): value is JSONObject {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.values(value).every((item) => item === undefined || isJsonValue(item))
	);
}

function addAdditionalProperties(schema: JSONObject): JSONObject {
	const type = schema.type;
	if (type === "object" || (Array.isArray(type) && type.includes("object"))) {
		const additional = schema.additionalProperties;
		schema.additionalProperties =
			isJSONObject(additional)
				? addAdditionalProperties(additional)
				: false;
		const properties = schema.properties;
		if (isJSONObject(properties)) {
			for (const [key, property] of Object.entries(properties)) {
				if (isJSONObject(property)) {
					Object.assign(properties, {
						[key]: addAdditionalProperties(property),
					});
				}
			}
		}
	}
	const items = schema.items;
	if (isJSONObject(items)) {
		schema.items = addAdditionalProperties(items);
	} else if (Array.isArray(items)) {
		schema.items = items.map((item) =>
			isJSONObject(item)
				? addAdditionalProperties(item)
				: item,
		);
	}
	for (const key of ["anyOf", "allOf", "oneOf", "definitions"] as const) {
		const group = schema[key];
		if (Array.isArray(group)) {
			schema[key] = group.map((item) =>
				isJSONObject(item)
					? addAdditionalProperties(item)
					: item,
			);
		} else if (isJSONObject(group)) {
			const definitions: JSONObject = { ...group };
			for (const [name, definition] of Object.entries(definitions)) {
				if (isJSONObject(definition)) {
					definitions[name] = addAdditionalProperties(definition);
				}
			}
			schema[key] = definitions;
		}
	}
	return schema;
}

export function zodInputJsonSchema<I>(input: z.ZodType<I>): JSONObject {
	const schema: unknown = z.toJSONSchema(input, {
		target: "draft-7",
		io: "input",
		reused: "inline",
	});
	if (!isJSONObject(schema)) throw new Error("Zod emitted a non-object tool input schema");
	return addAdditionalProperties(schema);
}

export function inputJsonSchema(tool: FunctionTool<unknown, unknown>): JSONObject;
export function inputJsonSchema(tool: HostedTool): JSONObject;
export function inputJsonSchema(tool: Tool): JSONObject;
export function inputJsonSchema(tool: Tool): JSONObject {
	return isHosted(tool)
		? zodInputJsonSchema(z.looseObject({}))
		: (tool.jsonSchema ?? zodInputJsonSchema(tool.input));
}

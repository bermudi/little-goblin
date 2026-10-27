// The bridge: goblin's fenced ToolSet → SDK MCP tool registrations.
//
// Execution topology: createSdkMcpServer handlers run IN THIS PROCESS —
// the child CLI only orchestrates model calls. The ToolSet the runtime
// hands the engine is already wrapped by Runtime.fenceTools (authority
// re-check, journal dispatch/result/error rows), so the bridge adds no
// fencing and no journaling of its own; it validates arguments with the
// tool's own schema, executes, and returns goblin-shaped results.
//
// Id namespaces: the SDK's tool() handler receives no tool_use id (its
// `extra` is opaque), so the bridge mints journal ids that only its own
// results queue uses. The engine pairs stream-frame tool_use ids with
// queued results (FIFO, exact (name, input) match preferred) to emit
// exact goblin outputs on the wire. The two namespaces never mix.

import { asSchema } from "ai";
import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import { createSdkMcpServer, tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ToolSet } from "ai";
import { log } from "../../log.ts";

export const MCP_SERVER_NAME = "goblin";

export interface BridgeResult {
	name: string;
	input: unknown;
	output: unknown;
	error: string | null;
}

export interface ToolBridge {
	/** The mcpServers value for the query options — one server, goblin's tools. */
	server(): unknown;
	/** The allowedTools form covering every bridged tool. */
	allowedTools(): string[];
	/** FIFO result adoption: the best unconsumed result for this tool call. */
	adoptResult(name: string, input: unknown): BridgeResult | null;
	/** Every bridged tool name — the surface the model actually sees. */
	toolNames(): string[];
}

// A JSON-Schema'd tool's object schema, decomposed property-by-property
// into zod (z.fromJSONSchema preserves each property's shape; optionality
// comes from the required list). Tools whose schema is not a plain
// object fall back to a permissive record — their model-facing schema
// degrades, never their validation (the handler still validates with the
// tool's own schema before executing).
function rawShapeFor(json: unknown): Record<string, z.ZodType> | null {
	if (typeof json !== "object" || json === null) return null;
	const schema = json as {
		type?: unknown;
		properties?: unknown;
		required?: unknown;
	};
	if (schema.type !== "object" || typeof schema.properties !== "object") return null;
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	const shape: Record<string, z.ZodType> = {};
	for (const [key, prop] of Object.entries(schema.properties as Record<string, unknown>)) {
		try {
			const field = z.fromJSONSchema(prop as Parameters<typeof z.fromJSONSchema>[0]);
			shape[key] = required.has(key) ? field : field.optional();
		} catch {
			return null;
		}
	}
	return shape;
}

function issueText(err: unknown): string {
	if (err instanceof z.ZodError) {
		return err.issues
			.slice(0, 5)
			.map((i) => `${i.path.join(".")}: ${i.message}`)
			.join("; ");
	}
	return err instanceof Error ? err.message : String(err);
}

// The model-facing result for goblin's toModelOutput contract: text
// rides as text, json serializes, denial/error carry their marker — the
// same mapping the AI SDK performs for the API lane.
function callToolResult(output: ToolResultOutput): {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
} {
	switch (output.type) {
		case "text":
			return { content: [{ type: "text", text: output.value }] };
		case "json":
			return { content: [{ type: "text", text: JSON.stringify(output.value) }] };
		case "execution-denied":
			return {
				content: [
					{
						type: "text",
						text: `[execution denied${"reason" in output && output.reason ? `: ${output.reason}` : ""}]`,
					},
				],
				isError: true,
			};
		case "error-text":
			return { content: [{ type: "text", text: output.value }], isError: true };
		default:
			return { content: [{ type: "text", text: JSON.stringify(output) }] };
	}
}

// The default model-facing form of a goblin tool output when the tool
// declares no toModelOutput: the AI SDK stringifies non-text outputs
// onto the wire; the bridge does the same.
function resultText(output: unknown): string {
	if (typeof output === "string") return output;
	return JSON.stringify(output) ?? "undefined";
}

export interface ToolBridgeDeps {
	convId: string;
	tools: ToolSet;
}

export function createToolBridge(deps: ToolBridgeDeps): ToolBridge {
	const { convId, tools } = deps;
	const results: BridgeResult[] = [];
	let callSeq = 0;
	const definitions: Array<ReturnType<typeof sdkTool>> = [];
	const names: string[] = [];

	for (const [name, t] of Object.entries(tools)) {
		const execute = t.execute;
		if (execute === undefined) continue;
		const description = typeof t.description === "string" ? t.description : name;
		const schema = asSchema(t.inputSchema);
		const shape = rawShapeFor(schema.jsonSchema);
		names.push(name);
		definitions.push(
			sdkTool(
				name,
				description,
				shape ?? { args: z.unknown().optional() },
				async (
					input: Record<string, unknown>,
				): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> => {
					const callId = `claude-${(callSeq += 1)}`;
					// Parsed input or a loud tool error — the model sees the
					// issues and can re-ask, like the API lane's tool errors.
					let args: unknown;
					try {
						if (schema.validate === undefined) {
							// A schema with no validator (raw jsonSchema pass-
							// through): the CLI validated the zod properties we
							// derived; execute's own guards are the backstop.
							args = input;
						} else {
							args = await schema.validate(input);
						}
					} catch (err) {
						const errorText = `invalid arguments for ${name}: ${issueText(err)}`;
						log.warn("tool call rejected", {
							conversation: convId,
							tool: name,
							arg: JSON.stringify(input ?? null).slice(0, 200),
							error: errorText.slice(0, 300),
						});
						results.push({ name, input, output: null, error: errorText });
						return { content: [{ type: "text", text: errorText }], isError: true };
					}
					try {
						const output = await execute(args as never, {
							toolCallId: callId,
							messages: [] as never,
							context: {} as never,
						});
						results.push({ name, input: args, output, error: null });
						if (t.toModelOutput === undefined) {
							return { content: [{ type: "text", text: resultText(output) }] };
						}
						const shaped = await t.toModelOutput({
							output,
							toolCallId: callId,
							input: args as never,
						});
						return callToolResult(shaped);
					} catch (err) {
						const errorText = err instanceof Error ? err.message : String(err);
						results.push({ name, input: args, output: null, error: errorText });
						return { content: [{ type: "text", text: errorText }], isError: true };
					}
				},
			),
		);
	}

	const server = createSdkMcpServer({
		name: MCP_SERVER_NAME,
		version: "1",
		tools: definitions,
	});

	return {
		server: () => server,
		allowedTools: () => [`mcp__${MCP_SERVER_NAME}`],
		toolNames: () => names,
		adoptResult: (name, input) => {
			// Prefer an exact (name, input) match — identical parallel calls
			// fall through to FIFO order, which is the CLI's dispatch order.
			const inputJson = JSON.stringify(input ?? null);
			const exact = results.findIndex(
				(r) => r.name === name && JSON.stringify(r.input ?? null) === inputJson,
			);
			const idx = exact >= 0 ? exact : results.findIndex((r) => r.name === name);
			if (idx < 0) return null;
			return results.splice(idx, 1)[0] ?? null;
		},
	};
}

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
// queued results (earliest-dispatched completed record, exact canonical
// (name, input) match preferred) to emit exact goblin outputs on the
// wire. The two namespaces never mix.

import { randomUUID } from "node:crypto";
import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import { createSdkMcpServer, tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import type { ToolSet } from "ai";
import { asSchema } from "ai";
import { z } from "zod";
import { log } from "../../log.ts";
import { stableStringify } from "../../loop-detect.ts";

export const MCP_SERVER_NAME = "goblin";

export interface BridgeResult {
	name: string;
	input: unknown;
	output: unknown;
	error: string | null;
}

// A reserved queue slot: pushed when the handler is dispatched, filled
// when it completes. Only done records are adoptable — parallel calls
// of one tool then pair by dispatch order, never completion order.
interface QueuedResult extends BridgeResult {
	done: boolean;
}

export interface BridgeInvokeResult {
	output: unknown;
	error: string | null;
}

export interface ToolBridge {
	/** The mcpServers value for the query options — one server, goblin's tools. */
	server(): unknown;
	/** The allowedTools form covering every bridged tool. */
	allowedTools(): string[];
	/** Result adoption: the best unconsumed completed result for this tool call. */
	adoptResult(name: string, input: unknown): BridgeResult | null;
	/** Every bridged tool name — the surface the model actually sees. */
	toolNames(): string[];
	/**
	 * Execute a bridged tool's handler directly — the same closure the MCP
	 * registration holds. Tests drive real executions through this without
	 * the child CLI; nothing in-process calls it in production.
	 */
	invoke(name: string, input: unknown): Promise<BridgeInvokeResult>;
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
	/** The turn's abort signal, forwarded to every tool execute. */
	signal?: AbortSignal | undefined;
}

export function createToolBridge(deps: ToolBridgeDeps): ToolBridge {
	const { convId, tools, signal } = deps;
	const results: QueuedResult[] = [];
	type McpResponse = {
		content: Array<{ type: "text"; text: string }>;
		isError?: boolean;
	};
	const handlers = new Map<
		string,
		(input: Record<string, unknown>) => Promise<{ response: McpResponse; record: QueuedResult }>
	>();
	const names: string[] = [];
	const bridgeId = randomUUID().slice(0, 8);
	let callSeq = 0;

	for (const [name, t] of Object.entries(tools)) {
		const execute = t.execute;
		if (execute === undefined) continue;
		const schema = asSchema(t.inputSchema);
		names.push(name);
		handlers.set(
			name,
			async (
				input: Record<string, unknown>,
			): Promise<{ response: McpResponse; record: QueuedResult }> => {
				// Monotonic per bridge, plus a random bridge prefix so ids stay
				// unique across turns (the bridge is rebuilt every turn).
				const callId = `claude-${bridgeId}-${++callSeq}`;
				// Reserve this call's queue slot before the first await so
				// array order is dispatch order, not completion order.
				const record: QueuedResult = { name, input, output: null, error: null, done: false };
				results.push(record);
				// Parsed input or a loud tool error — the model sees the
				// issues and can re-ask, like the API lane's tool errors.
				// Schema.validate is safeParse-shaped ({success, value|error}).
				let args: unknown;
				if (schema.validate === undefined) {
					// A schema with no validator (raw jsonSchema pass-
					// through): the CLI validated the zod properties we
					// derived; execute's own guards are the backstop.
					args = input;
				} else {
					const parsed = await schema.validate(input);
					if (!parsed.success) {
						const errorText = `invalid arguments for ${name}: ${issueText(parsed.error)}`;
						log.warn("tool call rejected", {
							conversation: convId,
							tool: name,
							arg: JSON.stringify(input ?? null).slice(0, 200),
							error: errorText.slice(0, 300),
						});
						record.error = errorText;
						record.done = true;
						return {
							response: { content: [{ type: "text", text: errorText }], isError: true },
							record,
						};
					}
					args = parsed.value;
				}
				try {
					const output = await execute(args as never, {
						toolCallId: callId,
						...(signal !== undefined ? { abortSignal: signal } : {}),
						messages: [] as never,
						context: {} as never,
					});
					record.output = output;
					record.done = true;
					if (t.toModelOutput === undefined) {
						return { response: { content: [{ type: "text", text: resultText(output) }] }, record };
					}
					const shaped = await t.toModelOutput({
						output,
						toolCallId: callId,
						input: args as never,
					});
					return { response: callToolResult(shaped), record };
				} catch (err) {
					const errorText = err instanceof Error ? err.message : String(err);
					record.error = errorText;
					record.done = true;
					return {
						response: { content: [{ type: "text", text: errorText }], isError: true },
						record,
					};
				}
			},
		);
	}
	const definitions: Array<ReturnType<typeof sdkTool>> = [];
	for (const [name, t] of Object.entries(tools)) {
		const handler = handlers.get(name);
		if (handler === undefined) continue;
		const description = typeof t.description === "string" ? t.description : name;
		const shape = rawShapeFor(asSchema(t.inputSchema).jsonSchema);
		definitions.push(
			sdkTool(name, description, shape ?? { args: z.unknown().optional() }, async (input) => {
				const { response } = await handler(input);
				return response;
			}),
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
		invoke: async (name, input) => {
			const handler = handlers.get(name);
			if (handler === undefined) {
				return { output: null, error: `no bridged tool named ${name}` };
			}
			const { response, record } = await handler(input as Record<string, unknown>);
			if (response.isError === true) {
				return {
					output: null,
					error: record.error ?? response.content[0]?.text ?? "tool failed",
				};
			}
			return { output: record.output, error: null };
		},
		adoptResult: (name, input) => {
			// Only completed records are adoptable (the CLI reports a tool
			// result only after the handler returned). Prefer an exact
			// (name, input) match — canonicalized, since the stream frame's
			// raw input and the record's may differ in key order; identical
			// parallel calls fall through to the earliest-dispatched record.
			const inputJson = stableStringify(input ?? null);
			const exact = results.findIndex(
				(r) => r.done && r.name === name && stableStringify(r.input ?? null) === inputJson,
			);
			const idx =
				exact >= 0 ? exact : results.findIndex((r) => r.done && r.name === name);
			if (idx < 0) return null;
			return results.splice(idx, 1)[0] ?? null;
		},
	};
}

// Generic rule-based tool-call repair, wired into streamText as
// repairToolCall. Rules only — never a model re-ask: NoSuchToolError is
// declined outright (repair must not guess tool names), truncated input
// is declined (a cut JSON document can't be completed safely). What IS
// repaired: JSON5-strict syntax slips (trailing commas, unquoted keys)
// and stringified object/array arguments — a top-level property whose
// schema type is object/array (anyOf/oneOf included) holding a JSON
// string gets parsed into place. The SDK re-validates the returned call
// once; a repair that still doesn't validate surfaces as a tool error
// to the model, unchanged from no repair at all.

import {
	InvalidToolInputError,
	NoSuchToolError,
	type ToolCallRepairFunction,
	type ToolSet,
} from "ai";
import JSON5 from "json5";
import { log } from "../log.ts";

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

// The object/array kinds a JSON-schema node admits, peeking one level
// into anyOf/oneOf unions (enough for the schemas our tools emit).
function schemaKinds(node: unknown): Set<"object" | "array"> {
	const kinds = new Set<"object" | "array">();
	if (!isPlainObject(node)) return kinds;
	if (node.type === "object" || node.type === "array") kinds.add(node.type);
	for (const union of ["anyOf", "oneOf"] as const) {
		const subs = node[union];
		if (Array.isArray(subs)) for (const sub of subs) schemaKinds(sub).forEach((k) => kinds.add(k));
	}
	return kinds;
}

export function makeToolCallRepair(convId: string): ToolCallRepairFunction<ToolSet> {
	return async ({ toolCall, inputSchema, error }) => {
		const tool = toolCall.toolName;
		const decline = (reason: string): null => {
			log.info("tool call not repaired", { conversation: convId, tool, reason });
			return null;
		};
		if (NoSuchToolError.isInstance(error)) return decline("no-such-tool");
		if (!InvalidToolInputError.isInstance(error)) return decline("unexpected-error");

		let parsed: unknown;
		let usedJson5 = false;
		try {
			parsed = JSON.parse(toolCall.input);
		} catch {
			try {
				parsed = JSON5.parse(toolCall.input);
				usedJson5 = true;
			} catch {
				return decline("unparseable-input");
			}
		}

		const fixes: string[] = [];
		if (usedJson5) fixes.push("json5");

		const fixed = isPlainObject(parsed) ? { ...parsed } : parsed;
		if (isPlainObject(fixed)) {
			let schema: unknown = {};
			try {
				schema = await inputSchema({ toolName: tool });
			} catch {
				// No schema to check against — stringified-arg repair can't
				// tell an object from an intended string, so it stays off.
			}
			const props = isPlainObject(schema) && isPlainObject(schema.properties) ? schema.properties : {};
			for (const [key, value] of Object.entries(fixed)) {
				if (typeof value !== "string") continue;
				const kinds = schemaKinds(props[key]);
				if (kinds.size === 0) continue;
				let inner: unknown;
				try {
					inner = JSON.parse(value);
				} catch {
					continue;
				}
				const kind = Array.isArray(inner) ? "array" : isPlainObject(inner) ? "object" : null;
				if (kind === null || !kinds.has(kind)) continue;
				fixed[key] = inner;
				fixes.push(`stringified:${key}`);
			}
		}

		// Strict-JSON input with nothing substituted means the mismatch is
		// semantic (wrong types, missing fields) — no rule applies.
		if (fixes.length === 0) return decline("no-applicable-rule");
		log.info("tool call repaired", { conversation: convId, tool, fixes });
		return { ...toolCall, input: JSON.stringify(fixed) };
	};
}

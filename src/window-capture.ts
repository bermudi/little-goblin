// The context window, captured at the source — pi-mono's session-share
// mechanism (a trailing entry carrying the system prompt and tool
// schemas), adapted to goblin: prepareStep already holds the exact
// outbound prompt of every model call, so the final step's window is
// serialized once and stored per conversation, latest wins. Never a
// reconstruction: the stored row is what a model call actually saw.
//
// Media bytes ride the prompt as inline data; the capture stubs them to
// byte counts (the transcript already shows the media itself — a second
// megabyte store per turn buys nothing). Everything textual — system
// prompt, tool schemas, every message part — is verbatim.

import type { Database } from "bun:sqlite";
import { asSchema, type ToolSet } from "ai";
import { z } from "zod";
import type { PromptSegments } from "./turn/itemize.ts";

export interface WindowTool {
	name: string;
	description: string | null;
	// JSON Schema of the tool input — null when the SDK's async schema
	// converter hadn't materialized it (the same floor itemize counts).
	parameters: unknown;
}

export interface WindowCapture {
	v: 1;
	system: string;
	tools: WindowTool[];
	// ModelMessage[] as sent, media bytes stubbed — unknown here so the
	// wire can carry it without importing server prompt types.
	messages: unknown[];
	// Serialized characters per segment (turn/itemize.ts keys).
	segments: PromptSegments;
}

export interface StoredWindow {
	capturedMs: number;
	model: string;
	step: number;
	capture: WindowCapture;
}

export function serializeToolDefs(tools: ToolSet): WindowTool[] {
	const out: WindowTool[] = [];
	for (const [name, tool] of Object.entries(tools)) {
		const description = typeof tool.description === "string" ? tool.description : null;
		const js = asSchema(tool.inputSchema).jsonSchema;
		// An async schema converter can't be read synchronously —
		// same floor rule the itemizer measures under.
		const parameters =
			typeof (js as { then?: unknown }).then === "function" ? null : (js as unknown);
		out.push({ name, description, parameters });
	}
	return out;
}

// JSON.stringify turns a Uint8Array into a numeric-dictionary monster;
// every binary leaf becomes a byte-count stub instead, and URLs —
// stringified as {} by JSON — become their text.
export function stubBinary(value: unknown, depth = 0): unknown {
	if (
		value instanceof Uint8Array ||
		value instanceof ArrayBuffer ||
		(ArrayBuffer.isView(value) && !(value instanceof DataView))
	) {
		return { omitted: "bytes", count: value.byteLength };
	}
	if (value instanceof URL || typeof value === "string" || typeof value === "number") return value;
	if (value === null || typeof value !== "object" || depth > 24) {
		return value === undefined ? null : value;
	}
	if (Array.isArray(value)) return value.map((item) => stubBinary(item, depth + 1));
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		out[key] = stubBinary(item, depth + 1);
	}
	return out;
}

const captureSchema = z.object({
	v: z.literal(1),
	system: z.string(),
	tools: z.array(
		z.object({
			name: z.string(),
			description: z.string().nullable(),
			parameters: z.unknown(),
		}),
	),
	messages: z.array(z.unknown()),
	segments: z.object({
		identity: z.number(),
		environment: z.number(),
		project: z.number(),
		agentsMd: z.number(),
		userMd: z.number(),
		skills: z.number(),
		toolDefs: z.number(),
		history: z.number(),
		toolResults: z.number(),
	}),
});

const rowSchema = z.object({
	captured_ms: z.number(),
	model: z.string(),
	step: z.number(),
	payload: z.instanceof(Uint8Array),
});

export function openWindowCapture(
	db: Database,
	options?: { now?: () => number },
): {
	record(
		conversationId: string,
		input: { model: string; step: number; capture: WindowCapture },
	): void;
	read(conversationId: string): StoredWindow | null;
} {
	const now = options?.now ?? Date.now;
	db.run(`CREATE TABLE IF NOT EXISTS context_windows (
		conversation_id TEXT PRIMARY KEY,
		captured_ms INTEGER NOT NULL,
		model TEXT NOT NULL,
		step INTEGER NOT NULL,
		payload BLOB NOT NULL
	)`);
	const qPut = db.query(
		`INSERT OR REPLACE INTO context_windows (conversation_id, captured_ms, model, step, payload)
		VALUES (?, ?, ?, ?, ?)`,
	);
	const qGet = db.query(
		"SELECT captured_ms, model, step, payload FROM context_windows WHERE conversation_id = ?",
	);
	return {
		record(conversationId, input) {
			// The stub lands here, not at the caller: a raw byte array must
			// never reach JSON, and the stub is what keeps rows bounded.
			const capture: WindowCapture = {
				...input.capture,
				messages: stubBinary(input.capture.messages) as unknown[],
			};
			const json = JSON.stringify(capture);
			qPut.run(
				conversationId,
				now(),
				input.model,
				input.step,
				Bun.gzipSync(new TextEncoder().encode(json)),
			);
		},
		read(conversationId) {
			const raw = rowSchema.nullable().parse(qGet.get(conversationId));
			if (raw === null) return null;
			let parsed: unknown;
			try {
				parsed = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(raw.payload)));
			} catch (err) {
				throw new Error(
					`stored context window for ${conversationId} failed to decode: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			const capture = captureSchema.parse(parsed);
			return { capturedMs: raw.captured_ms, model: raw.model, step: raw.step, capture };
		},
	};
}

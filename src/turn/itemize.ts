// Window itemization: what occupies the context window of a step. The
// provider reports only a total input figure per call, so segments are
// measured in serialized characters at prepareStep time and the /context
// endpoint scales them to the last step's reported input tokens. Exact
// in aggregate, an estimate per segment (the wire's chat template adds
// per-message overhead no caller can see).

import { asSchema, type ModelMessage, type ToolSet } from "ai";
import { PROMPT_SECTIONS } from "../agent/prompt.ts";

export interface PromptSegments {
	/** SOUL.md / persona head — everything before the first section heading. */
	identity: number;
	/** The ## environment block (fixed scaffolding, tool bullets). */
	environment: number;
	/** The ## project — block (instructions, notes index, project AGENTS.md). */
	project: number;
	agentsMd: number;
	userMd: number;
	skills: number;
	/** Tool definitions — name, description, JSON schema per tool. */
	toolDefs: number;
	/** All messages in the step's prompt. */
	history: number;
	/** Subset of history: tool-call inputs plus tool-result outputs. */
	toolResults: number;
}

// Split order = builder order in prompt.ts. Each heading search starts
// after the previous match, so operator content that happens to repeat
// a heading inside SOUL.md shifts attribution, never the total.
const SYSTEM_ORDER = [
	{ segment: "environment", heading: "environment" },
	{ segment: "project", heading: "project" },
	{ segment: "agentsMd", heading: "agents" },
	{ segment: "userMd", heading: "user" },
	{ segment: "skills", heading: "skills" },
] as const satisfies readonly {
	segment: keyof PromptSegments;
	heading: keyof typeof PROMPT_SECTIONS;
}[];

export function splitSystemPrompt(
	text: string,
): Pick<PromptSegments, "identity" | "environment" | "project" | "agentsMd" | "userMd" | "skills"> {
	const segments = { identity: 0, environment: 0, project: 0, agentsMd: 0, userMd: 0, skills: 0 };
	const markers = SYSTEM_ORDER.map(({ segment, heading }) => ({
		key: segment,
		needle: `\n${PROMPT_SECTIONS[heading]}`,
		at: -1,
	}));
	let cursor = 0;
	for (const m of markers) {
		m.at = text.indexOf(m.needle, cursor);
		if (m.at === -1) continue;
		cursor = m.at + m.needle.length;
	}
	// Everything before the first found heading is identity; each gap
	// between headings belongs to the heading that opened it; the tail
	// after the last heading belongs to that last section.
	let prevKey: keyof PromptSegments | null = null;
	let prevAt = 0;
	for (const m of markers) {
		if (m.at === -1) continue;
		const chunk = m.at - prevAt;
		if (prevKey === null) segments.identity = chunk;
		else segments[prevKey] = chunk;
		prevKey = m.key;
		prevAt = m.at;
	}
	const tail = text.length - prevAt;
	if (prevKey === null) segments.identity = tail;
	else segments[prevKey] = tail;
	return segments;
}

// The SDK contract promises JSON-serializable values. Violations are
// programming errors and must reach the turn's error boundary.
function jsonLen(value: unknown): number {
	if (value === undefined) return 0;
	return JSON.stringify(value).length;
}

// Media rides the wire base64'd (~4/3 of raw bytes); a URL only sends
// its own text.
function dataLen(value: unknown): number {
	if (typeof value === "string") return value.length;
	if (value instanceof URL) return String(value).length;
	if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
		return Math.ceil((value.byteLength * 4) / 3);
	}
	if (typeof value === "object" && value !== null) {
		const o = value as { data?: unknown; url?: unknown; image?: unknown };
		if (o.data !== undefined) return dataLen(o.data);
		if (o.image !== undefined) return dataLen(o.image);
		if (typeof o.url === "string") return o.url.length;
	}
	return jsonLen(value);
}

// Fixed cost for one image/file part in the pre-emption estimate, in
// chars (chars/4 ≈ 2k tokens). Base64 length is the right gauge for the
// wire but a wild overestimate of what a provider bills for media.
export const MEDIA_ESTIMATE_CHARS = 8000;

function partChars(
	part: unknown,
	mediaChars: (part: unknown) => number = dataLen,
): { history: number; tool: number } {
	if (typeof part === "string") return { history: part.length, tool: 0 };
	if (typeof part !== "object" || part === null) return { history: 0, tool: 0 };
	const p = part as { type?: string; text?: unknown; input?: unknown; output?: unknown };
	if (p.type === "text" || p.type === "reasoning") {
		return { history: typeof p.text === "string" ? p.text.length : 0, tool: 0 };
	}
	if (p.type === "tool-call") return { history: jsonLen(p.input), tool: jsonLen(p.input) };
	if (p.type === "tool-result") {
		const out = p.output as { type?: string; value?: unknown } | undefined;
		const n =
			out !== null && typeof out === "object" && (out.type === "text" || out.type === "error-text")
				? typeof out.value === "string"
					? out.value.length
					: 0
				: jsonLen(p.output);
		return { history: n, tool: n };
	}
	if (p.type === "image" || p.type === "file") return { history: mediaChars(part), tool: 0 };
	return { history: jsonLen(part), tool: 0 };
}

function messageChars(
	message: ModelMessage,
	mediaChars: (part: unknown) => number = dataLen,
): { history: number; tool: number } {
	const content = message.content as unknown;
	if (typeof content === "string") return { history: content.length, tool: 0 };
	if (!Array.isArray(content)) return { history: 0, tool: 0 };
	let history = 0;
	let tool = 0;
	for (const part of content) {
		const n = partChars(part, mediaChars);
		history += n.history;
		tool += n.tool;
	}
	return { history, tool };
}

// zod → JSON-Schema conversion is ~0.45 ms/tool and the tool set is
// constant across a turn's steps, while measurePrompt runs per step:
// convert once per tool object, reuse thereafter.
const jsonSchemaByTool = new WeakMap<object, unknown>();

function toolDefsChars(tools: ToolSet): number {
	let total = 0;
	for (const [name, t] of Object.entries(tools)) {
		let size = name.length;
		if (typeof t.description === "string") size += t.description.length;
		let js = jsonSchemaByTool.get(t);
		if (js === undefined) {
			js = asSchema(t.inputSchema).jsonSchema;
			jsonSchemaByTool.set(t, js);
		}
		// An async schema converter can't be measured synchronously —
		// the name+description floor still counts.
		if (typeof (js as { then?: unknown }).then !== "function") size += jsonLen(js);
		total += size + 16; // envelope: role markers, name field, nesting
	}
	return total;
}

export function measurePrompt(
	system: string,
	tools: ToolSet,
	messages: readonly ModelMessage[],
): PromptSegments {
	let history = 0;
	let toolResults = 0;
	for (const m of messages) {
		const n = messageChars(m);
		history += n.history;
		toolResults += n.tool;
	}
	return {
		...splitSystemPrompt(system),
		toolDefs: toolDefsChars(tools),
		history,
		toolResults,
	};
}

// History size for the compaction pre-emption arms, which convert chars
// to tokens at /4: media is charged a fixed cost, not its base64 length,
// so one inlined photo cannot read as a six-figure token span.
export function estimateHistoryChars(messages: readonly ModelMessage[]): number {
	let total = 0;
	for (const m of messages) total += messageChars(m, () => MEDIA_ESTIMATE_CHARS).history;
	return total;
}

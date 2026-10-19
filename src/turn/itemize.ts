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
] as const satisfies readonly { segment: keyof PromptSegments; heading: keyof typeof PROMPT_SECTIONS }[];

export function splitSystemPrompt(text: string): Pick<
	PromptSegments,
	"identity" | "environment" | "project" | "agentsMd" | "userMd" | "skills"
> {
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

// JSON.stringify can only throw on cycles/host objects; the AI SDK
// contracts here promise JSON-serializable values, so a 0 is an honest
// "unmeasurable sliver", not a swallowed failure — it keeps one weird
// part from costing the whole itemization.
function jsonLen(value: unknown): number {
	if (value === undefined) return 0;
	try {
		return JSON.stringify(value).length;
	} catch {
		return 0;
	}
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

function partChars(part: unknown): { history: number; tool: number } {
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
	if (p.type === "image" || p.type === "file") return { history: dataLen(part), tool: 0 };
	return { history: jsonLen(part), tool: 0 };
}

function messageChars(message: ModelMessage): { history: number; tool: number } {
	const content = message.content as unknown;
	if (typeof content === "string") return { history: content.length, tool: 0 };
	if (!Array.isArray(content)) return { history: 0, tool: 0 };
	let history = 0;
	let tool = 0;
	for (const part of content) {
		const n = partChars(part);
		history += n.history;
		tool += n.tool;
	}
	return { history, tool };
}

function toolDefsChars(tools: ToolSet): number {
	let total = 0;
	for (const [name, t] of Object.entries(tools)) {
		let size = name.length;
		if (typeof t.description === "string") size += t.description.length;
		try {
			const js = asSchema(t.inputSchema).jsonSchema;
			// An async schema converter can't be measured synchronously —
			// the name+description floor still counts.
			if (typeof (js as { then?: unknown }).then !== "function") size += jsonLen(js);
		} catch {
			// Estimator only — the definition still occupies the window.
		}
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

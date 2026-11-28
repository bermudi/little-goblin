
import type { PromptMessage } from "../prompt-message.ts";
import { inputJsonSchema, isHosted, type Tools } from "../tool.ts";
import { PROMPT_SECTIONS } from "../agent/prompt.ts";

export interface PromptSegments {
	identity: number;
	environment: number;
	project: number;
	botMemory?: number;
	agentsMd: number;
	userMd: number;
	skills: number;
	toolDefs: number;
	history: number;
	toolResults: number;
}

const SYSTEM_ORDER = [
	{ segment: "environment", heading: "environment" },
	{ segment: "project", heading: "project" },
	{ segment: "botMemory", heading: "botMemory" },
	{ segment: "agentsMd", heading: "agents" },
	{ segment: "userMd", heading: "user" },
	{ segment: "skills", heading: "skills" },
] as const satisfies readonly {
	segment: keyof PromptSegments;
	heading: keyof typeof PROMPT_SECTIONS;
}[];

export function splitSystemPrompt(
	text: string,
): Pick<PromptSegments, "identity" | "environment" | "project" | "botMemory" | "agentsMd" | "userMd" | "skills"> {
	const segments: Pick<PromptSegments, "identity" | "environment" | "project" | "botMemory" | "agentsMd" | "userMd" | "skills"> = {
		identity: 0, environment: 0, project: 0, agentsMd: 0, userMd: 0, skills: 0,
	};
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

function jsonLen(value: unknown): number {
	if (value === undefined) return 0;
	return JSON.stringify(value).length;
}

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
		if (
			out !== null &&
			typeof out === "object" &&
			out.type === "content" &&
			Array.isArray(out.value)
		) {
			let n = 0;
			for (const v of out.value as unknown[]) {
				const vp = v as { type?: unknown; text?: unknown };
				n += vp.type === "text" ? (typeof vp.text === "string" ? vp.text.length : 0) : mediaChars(v);
			}
			return { history: n, tool: n };
		}
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
	message: PromptMessage,
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

const jsonSchemaByTool = new WeakMap<object, unknown>();

function toolDefsChars(tools: Tools): number {
	let total = 0;
	for (const [name, t] of Object.entries(tools)) {
		let size = name.length;
		if (!isHosted(t)) size += t.description.length;
		let js = jsonSchemaByTool.get(t);
		if (js === undefined) {
			js = inputJsonSchema(t);
			jsonSchemaByTool.set(t, js);
		}
		if (typeof (js as { then?: unknown }).then !== "function") size += jsonLen(js);
		total += size + 16;
	}
	return total;
}

export function measurePrompt(
	system: string,
	tools: Tools,
	messages: readonly PromptMessage[],
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

export function estimateHistoryChars(messages: readonly PromptMessage[]): number {
	let total = 0;
	for (const m of messages) total += messageChars(m, () => MEDIA_ESTIMATE_CHARS).history;
	return total;
}

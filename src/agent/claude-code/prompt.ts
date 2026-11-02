// The assembled view → one SDK user message. The engine runs one
// query() per turn and replays the whole conversation into it (per-turn
// full replay, no durable SDK sessions), so the serializer is a pure
// function of the view: the same events must serialize to the same
// bytes, and turn N+1's prompt is turn N's prompt with the new exchange
// appended — the prefix-stability invariant the API lane gets from
// append-only ModelMessages, preserved here by construction.
//
// Media rides as Anthropic content blocks at its transcript position
// (the view only inlines what this provider's carries() gate admitted);
// prior-turn reasoning is dropped (thinking blocks cannot be replayed
// without their signatures); old tool calls render as compact records
// with a stable truncation marker.

import type { ModelMessage } from "ai";
import type { PromptContent } from "./translate.ts";

const TOOL_RESULT_CAP = 4000;
const truncationNote = (n: number): string => `[… ${n} characters truncated]`;

// FilePart data / ImagePart image: base64 text, a data: URL, or raw
// bytes. Anthropic blocks take bare base64.
function toBase64(data: unknown): string | null {
	if (typeof data === "string") {
		if (data.startsWith("data:")) {
			const comma = data.indexOf(",");
			return comma < 0 ? null : data.slice(comma + 1);
		}
		return data;
	}
	if (data instanceof Uint8Array) {
		return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64");
	}
	if (data instanceof ArrayBuffer) {
		return Buffer.from(data).toString("base64");
	}
	return null;
}

type PromptBlock = Extract<PromptContent["blocks"][number], { kind: "image" | "document" }>;

function mediaBlock(mediaType: string, data: unknown, filename?: string): PromptBlock | null {
	const b64 = toBase64(data);
	if (b64 === null) return null;
	// Anthropic image blocks carry no filename; documents do.
	if (mediaType.startsWith("image/")) return { kind: "image", mediaType, data: b64 };
	if (mediaType === "application/pdf")
		return {
			kind: "document",
			mediaType,
			data: b64,
			...(filename !== undefined ? { filename } : {}),
		};
	return null;
}

function capped(text: string): string {
	if (text.length <= TOOL_RESULT_CAP) return text;
	const keep = TOOL_RESULT_CAP - 24;
	return `${text.slice(0, keep)}${truncationNote(text.length - keep)}`;
}

// The AI SDK's ToolResultOutput shapes, rendered to text.
function outputText(output: unknown): string {
	if (typeof output === "string") return output;
	if (typeof output === "object" && output !== null && "type" in output) {
		const o = output as { type: string; value?: unknown; reason?: string };
		switch (o.type) {
			case "text":
				return String(o.value ?? "");
			case "json":
				return JSON.stringify(o.value) ?? "undefined";
			case "execution-denied":
				return `[execution denied${o.reason ? `: ${o.reason}` : ""}]`;
			case "error-text":
				return String(o.value ?? "");
		}
	}
	try {
		return JSON.stringify(output) ?? "undefined";
	} catch {
		return String(output);
	}
}

interface PartLike {
	type: string;
	[key: string]: unknown;
}

function textOf(part: PartLike): string {
	return typeof part.text === "string" ? part.text : "";
}

// One ModelMessage → transcript blocks. Role markers are fixed strings;
// every choice here is deterministic so the bytes never move for the
// same history.
function messageBlocks(msg: ModelMessage, out: PromptContent["blocks"]): void {
	const content = typeof msg.content === "string" ? [msg.content] : (msg.content as PartLike[]);
	switch (msg.role) {
		case "system":
			// The view keeps no system rows (the system prompt rides the
			// query options) — defensive rendering only.
			out.push({ kind: "text", text: `[system] ${msg.content}` });
			return;
		case "user": {
			const texts: string[] = [];
			for (const part of content) {
				if (typeof part === "string") {
					texts.push(part);
					continue;
				}
				if (part.type === "text") {
					texts.push(textOf(part));
				} else if (part.type === "file") {
					const block = mediaBlock(
						typeof part.mediaType === "string" ? part.mediaType : "",
						part.data,
						typeof part.filename === "string" ? part.filename : undefined,
					);
					if (block !== null) out.push(block);
					else {
						texts.push(
							typeof part.filename === "string"
								? `[attachment: ${part.filename}]`
								: `[attachment: ${String(part.mediaType)}]`,
						);
					}
				} else if (part.type === "image") {
					const block = mediaBlock(
						typeof part.mediaType === "string" ? part.mediaType : "image/png",
						part.image,
					);
					if (block !== null) out.push(block);
					else texts.push("[image]");
				}
			}
			out.push({ kind: "text", text: `[operator]\n${texts.join("\n\n")}` });
			return;
		}
		case "assistant": {
			const texts: string[] = [];
			const calls: string[] = [];
			for (const part of content) {
				if (typeof part === "string") continue;
				if (part.type === "text") {
					texts.push(textOf(part));
				} else if (part.type === "reasoning") {
					// Dropped — thinking blocks cannot replay without signatures.
				} else if (part.type === "tool-call") {
					calls.push(
						`[tool call: ${String(part.toolName)}]\n${capped(safeJson(part.input ?? {}))}`,
					);
				}
			}
			const body = [...texts, ...calls].join("\n\n");
			out.push({ kind: "text", text: `[goblin]\n${body}` });
			return;
		}
		case "tool": {
			for (const part of content) {
				if (typeof part === "string") continue;
				if (part.type === "tool-result") {
					out.push({
						kind: "text",
						text: `[tool result]\n${capped(outputText(part.output))}`,
					});
				}
			}
			return;
		}
	}
}

export function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return String(value);
	}
}

const TRAILER =
	"The transcript above is this conversation's history so far, newest last. You are goblin; answer the operator's latest message(s) as the next goblin reply.";

export function serializePrompt(messages: readonly ModelMessage[]): PromptContent {
	const blocks: PromptContent["blocks"] = [];
	for (const msg of messages) messageBlocks(msg, blocks);
	blocks.push({ kind: "text", text: TRAILER });
	return { blocks };
}

// The byte-stable text projection — hashing and log lines key on this,
// never on the block array (whose media encoding may legitimately vary).
export function promptText(prompt: PromptContent): string {
	return prompt.blocks
		.map((b) => (b.kind === "text" ? b.text : `[${b.kind}: ${b.mediaType}]`))
		.join("\n\n");
}

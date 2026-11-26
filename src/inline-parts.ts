import type { Message, MessagePart } from "./message.ts";

const INLINE_PART_TYPES = new Set(["data-attachment", "data-note", "data-skill"]);
const LABEL_CAP = 120;

export function skillMarkerText(name: string): string {
	return `[skill: ${name}]`;
}

export function tempSkillMarkerText(name: string, url: string): string {
	let host = url;
	try {
		host = new URL(url).host;
	} catch {
		host = url;
	}
	return `[temp skill: ${name} (${host})]`;
}

export function tempSkillNameOf(path: string): string {
	const segs = path.split("/").filter(Boolean);
	return segs.length >= 2 ? (segs[segs.length - 2] as string) : "";
}

export function inlineChipLabel(kind: "file" | "note" | "skill", name: string): string {
	const cleaned = name
		.replace(/[\[\]\r\n]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned === "") return kind;
	return cleaned.length <= LABEL_CAP ? cleaned : (cleaned.slice(0, LABEL_CAP) as string);
}

function partData(part: MessagePart): Record<string, unknown> | null {
	if (!INLINE_PART_TYPES.has(part.type)) return null;
	const data = (part as { data?: unknown }).data;
	if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
	return data as Record<string, unknown>;
}

export function isInlinePart(part: MessagePart): boolean {
	return partData(part)?.inline === true;
}

export function hasInlineParts(parts: readonly MessagePart[]): boolean {
	return parts.some(isInlinePart);
}

function textOf(part: MessagePart): string {
	const t = (part as { text?: unknown }).text;
	return typeof t === "string" ? t : "";
}

function fileProseName(data: Record<string, unknown>): string {
	return typeof data.filename === "string" ? data.filename : "";
}

function noteProseTitle(data: Record<string, unknown>): string {
	return typeof data.title === "string" ? data.title : "";
}

function skillProseName(data: Record<string, unknown>): string {
	if (typeof data.name === "string") return data.name;
	if (typeof data.path === "string") return tempSkillNameOf(data.path);
	return "";
}

export function proseOf(parts: readonly MessagePart[]): string {
	let out = "";
	for (const part of parts) {
		if (part.type === "text") {
			out += textOf(part);
		} else if (isInlinePart(part)) {
			const data = partData(part) as Record<string, unknown>;
			out += `[${inlineChipLabel(
				part.type === "data-attachment" ? "file" : part.type === "data-note" ? "note" : "skill",
				part.type === "data-attachment"
					? fileProseName(data)
					: part.type === "data-note"
						? noteProseTitle(data)
						: skillProseName(data),
			)}]`;
		}
	}
	return out.trim();
}

function withoutInline(data: Record<string, unknown>): Record<string, unknown> {
	const rest = { ...data };
	delete rest.inline;
	return rest;
}

interface Mention {
	label: string;
	part: MessagePart;
}

export function inlineMentions(message: Message): Message {
	if (message.role !== "user" || !hasInlineParts(message.parts)) return message;

	const imageNo = new Map<string, number>();
	const fileNo = new Map<string, number>();
	const labels = new Map<string, string>();
	const mentions = new Map<string, Mention>();
	const textPieces: string[] = [];
	const rest: MessagePart[] = [];

	for (const part of message.parts) {
		if (part.type === "text") {
			textPieces.push(textOf(part));
			continue;
		}
		const data = partData(part);
		if (data === null || data.inline !== true) {
			rest.push(part);
			continue;
		}
		if (part.type === "data-attachment") {
			const path = typeof data.path === "string" ? data.path : null;
			if (path === null) {
				textPieces.push(`[${inlineChipLabel("file", fileProseName(data))}]`);
				continue;
			}
			const isImage =
				typeof data.mediaType === "string" && data.mediaType.startsWith("image/");
			const numbering = isImage ? imageNo : fileNo;
			if (!numbering.has(path)) {
				const n = numbering.size + 1;
				numbering.set(path, n);
				const label = `[${isImage ? "image" : "file"} ${n}: ${inlineChipLabel(
					"file",
					fileProseName(data),
				)}]`;
				labels.set(path, label);
				mentions.set(path, { label, part });
			}
			textPieces.push(labels.get(path) as string);
			continue;
		}
		if (part.type === "data-note") {
			const id = typeof data.id === "string" ? data.id : null;
			if (id === null) {
				textPieces.push(`[${inlineChipLabel("note", noteProseTitle(data))}]`);
				continue;
			}
			const key = `note:${id}`;
			if (!mentions.has(key)) {
				mentions.set(key, { label: "", part });
			}
			textPieces.push(
				`[note: ${inlineChipLabel("note", noteProseTitle(data))} (id ${id})]`,
			);
			continue;
		}
		const isTemp = typeof data.url === "string" && typeof data.path === "string";
		const isCatalog = typeof data.name === "string";
		if (!isTemp && !isCatalog) {
			textPieces.push("[skill]");
			continue;
		}
		const key = isTemp
			? `skill:${(data.url as string)}\n${(data.path as string)}`
			: `skill:name:${(data.name as string)}`;
		if (!mentions.has(key)) {
			mentions.set(key, { label: "", part });
		}
		textPieces.push(
			isTemp
				? tempSkillMarkerText(tempSkillNameOf(data.path as string), data.url as string)
				: skillMarkerText(data.name as string),
		);
	}

	const parts: MessagePart[] = [{ type: "text", text: textPieces.join("") }];
	for (const mention of mentions.values()) {
		if (mention.label !== "") {
			parts.push({ type: "text", text: mention.label });
		}
		const data = partData(mention.part) as Record<string, unknown>;
		parts.push({
			...(mention.part as { type: string; id?: string }),
			data: withoutInline(data),
		} as MessagePart);
	}
	parts.push(...rest);
	return { ...message, parts };
}

import { z } from "zod";
import type { UIMessage } from "ai";
import { quoteBlock } from "./QuoteFab.tsx";

const refSchema = z
	.object({
		path: z.string().min(1),
		sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
		mediaType: z.string(),
		filename: z.string(),
		size: z.number(),
		transcript: z.string().optional(),
		transcriptionError: z.string().optional(),
		speech: z.boolean().optional(),
	})
	.strict();

export const fileChipSchema = z.discriminatedUnion("state", [
	z
		.object({
			kind: z.literal("file"),
			state: z.literal("ready"),
			ref: refSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("file"),
			state: z.literal("uploading"),
			uploadId: z.string().min(1),
			filename: z.string(),
			mediaType: z.string(),
			size: z.number(),
			speech: z.literal(true).optional(),
		})
		.strict(),
]);

export const noteChipSchema = z
	.object({
		kind: z.literal("note"),
		id: z.string().min(1),
		title: z.string(),
	})
	.strict();

export const skillChipRefSchema = z.union([
	z
		.object({
			name: z.string().min(1),
		})
		.strict(),
	z
		.object({
			url: z.string().min(1),
			path: z.string().min(1),
		})
		.strict(),
]);

export const skillChipSchema = z
	.object({
		kind: z.literal("skill"),
		ref: skillChipRefSchema,
	})
	.strict();

export const quoteChipSchema = z.object({
	kind: z.literal("quote"),
	id: z.string().min(1),
	text: z.string().min(1),
	speaker: z.enum(["user", "assistant"]).nullable(),
	messageId: z.string().min(1).optional(),
	comment: z.string().min(1).optional(),
}).strict();

export const chipSchema = z.union([fileChipSchema, noteChipSchema, skillChipSchema, quoteChipSchema]);

const draftItemSchema = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("text"),
			text: z.string(),
		})
		.strict(),
	z
		.object({
			type: z.literal("chip"),
			chip: chipSchema,
		})
		.strict(),
]);

export const draftSchema = z
	.object({
		items: z.array(draftItemSchema),
		shelf: z.array(fileChipSchema),
	})
	.strict();

export type FileChip = z.infer<typeof fileChipSchema>;
export type FileRef = z.infer<typeof refSchema>;
export type NoteChip = z.infer<typeof noteChipSchema>;
export type SkillChip = z.infer<typeof skillChipSchema>;
export type QuoteChip = z.infer<typeof quoteChipSchema>;
export type Chip = z.infer<typeof chipSchema>;
export type DraftItem = z.infer<typeof draftItemSchema>;
export type Draft = z.infer<typeof draftSchema>;

export function parseChip(value: unknown): Chip | null {
	const res = chipSchema.safeParse(value);
	return res.success ? res.data : null;
}

export function emptyDraft(): Draft {
	return { items: [], shelf: [] };
}

export function textDraft(text: string): Draft {
	return text === "" ? emptyDraft() : { items: [{ type: "text", text }], shelf: [] };
}

export function chipKey(chip: Chip): string {
	switch (chip.kind) {
		case "file":
			return chip.state === "ready" ? `file:${chip.ref.path}` : `file:${chip.uploadId}`;
		case "note":
			return `note:${chip.id}`;
		case "skill":
			return "name" in chip.ref ? `skill:${chip.ref.name}` : `skill:${chip.ref.url}\n${chip.ref.path}`;
		case "quote":
			return `quote:${chip.id}`;
	}
}

export function isImageChip(chip: Chip): boolean {
	if (chip.kind !== "file") return false;
	const mediaType = chip.state === "ready" ? chip.ref.mediaType : chip.mediaType;
	return mediaType.startsWith("image/");
}

function sameRef(
	a: FileChip & { state: "ready" },
	b: FileChip & { state: "ready" },
): boolean {
	return (
		a.ref.path === b.ref.path &&
		a.ref.sha256 === b.ref.sha256 &&
		a.ref.mediaType === b.ref.mediaType &&
		a.ref.filename === b.ref.filename &&
		a.ref.size === b.ref.size &&
		a.ref.transcript === b.ref.transcript &&
		a.ref.transcriptionError === b.ref.transcriptionError &&
		a.ref.speech === b.ref.speech
	);
}

function sameChip(a: Chip, b: Chip): boolean {
	if (a.kind !== b.kind || chipKey(a) !== chipKey(b)) return false;
	if (a.kind === "file" && b.kind === "file") {
		if (a.state !== b.state) return false;
		if (a.state === "ready" && b.state === "ready") return sameRef(a, b);
		if (a.state !== "ready" && b.state !== "ready")
			return (
				a.uploadId === b.uploadId &&
				a.filename === b.filename &&
				a.mediaType === b.mediaType &&
				a.size === b.size &&
				a.speech === b.speech
			);
		return false;
	}
	if (a.kind === "note" && b.kind === "note") return a.id === b.id && a.title === b.title;
	if (a.kind === "skill" && b.kind === "skill")
		return "name" in a.ref && "name" in b.ref
			? a.ref.name === b.ref.name
			: "url" in a.ref && "url" in b.ref
				? a.ref.url === b.ref.url && a.ref.path === b.ref.path
				: false;
	if (a.kind === "quote" && b.kind === "quote")
		return a.id === b.id && a.text === b.text && a.speaker === b.speaker &&
			a.messageId === b.messageId && a.comment === b.comment;
	return false;
}

export function normalizeDraft(draft: Draft): Draft {
	const items: DraftItem[] = [];
	for (const item of draft.items) {
		if (item.type === "text") {
			if (item.text === "") continue;
			const last = items[items.length - 1];
			if (last !== undefined && last.type === "text") {
				items[items.length - 1] = { type: "text", text: last.text + item.text };
				continue;
			}
			items.push(item);
			continue;
		}
		items.push(item);
	}
	const shelf: FileChip[] = [];
	const seen = new Set<string>();
	const itemChips = draft.items.flatMap((i) =>
		i.type === "chip" && i.chip.kind === "file" ? [i.chip] : [],
	);
	for (const chip of [...draft.shelf, ...itemChips]) {
		if (!isImageChip(chip)) continue;
		const key = chipKey(chip);
		if (seen.has(key)) continue;
		seen.add(key);
		shelf.push(chip);
	}
	return { items, shelf };
}

export function isEmptyDraft(draft: Draft): boolean {
	return (
		draft.items.every((i) => i.type === "text" && i.text.trim() === "") && draft.shelf.length === 0
	);
}

export function sameDraft(a: Draft, b: Draft): boolean {
	if (a.items.length !== b.items.length || a.shelf.length !== b.shelf.length) return false;
	for (let i = 0; i < a.items.length; i++) {
		const x = a.items[i] as DraftItem;
		const y = b.items[i] as DraftItem;
		if (x.type !== y.type) return false;
		if (x.type === "text" && y.type === "text" && x.text !== y.text) return false;
		if (x.type === "chip" && y.type === "chip" && !sameChip(x.chip, y.chip)) return false;
	}
	for (let i = 0; i < a.shelf.length; i++) {
		if (!sameChip(a.shelf[i] as FileChip, b.shelf[i] as FileChip)) return false;
	}
	return true;
}

export function draftText(draft: Draft): string {
	return normalizeDraft(draft)
		.items.filter((i): i is { type: "text"; text: string } => i.type === "text")
		.map((i) => i.text)
		.join("\n");
}

export function unsentRemainder(current: Draft, sent: Draft): Draft {
	const live = normalizeDraft(current);
	const gone = normalizeDraft(sent);
	if (sameDraft(live, gone)) return emptyDraft();
	let consumed = 0;
	let tail: string | null = null;
	for (let i = 0; i < gone.items.length; i++) {
		const s = gone.items[i] as DraftItem;
		const c = live.items[i] as DraftItem | undefined;
		if (c === undefined) return current;
		const last = i === gone.items.length - 1;
		if (s.type === "text" && c.type === "text") {
			if (s.text === c.text) {
				consumed = i + 1;
				continue;
			}
			if (last && c.text.startsWith(s.text)) {
				tail = c.text.slice(s.text.length);
				consumed = i + 1;
				continue;
			}
			return current;
		}
		if (s.type === "chip" && c.type === "chip" && sameChip(s.chip, c.chip)) {
			consumed = i + 1;
			continue;
		}
		return current;
	}
	const items: DraftItem[] = [];
	if (tail !== null && tail !== "") items.push({ type: "text", text: tail });
	items.push(...live.items.slice(consumed));
	const sentKeys = new Set([
		...gone.items.flatMap((i) =>
			i.type === "chip" && i.chip.kind === "file" && isImageChip(i.chip) ? [chipKey(i.chip)] : [],
		),
		...gone.shelf.flatMap((c) => (isImageChip(c) ? [chipKey(c)] : [])),
	]);
	const shelf = live.shelf.filter((chip) => !sentKeys.has(chipKey(chip)));
	return { items, shelf };
}

function chipToPart(chip: Chip): UIMessage["parts"][number] | null {
	if (chip.kind === "file") {
		if (chip.state !== "ready") return null;
		return {
			type: "data-attachment",
			data: { ...chip.ref, inline: true },
		} as UIMessage["parts"][number];
	}
	if (chip.kind === "note") {
		return {
			type: "data-note",
			data: { id: chip.id, title: chip.title, inline: true },
		} as UIMessage["parts"][number];
	}
	if (chip.kind === "quote") return null;
	return {
		type: "data-skill",
		data: { ...chip.ref, inline: true },
	} as UIMessage["parts"][number];
}

export function draftToParts(draft: Draft): UIMessage["parts"] {
	const expanded: DraftItem[] = [];
	let previousWasQuote = false;
	for (const item of draft.items) {
		if (item.type === "chip" && item.chip.kind === "quote") {
			const previous = expanded[expanded.length - 1];
			if (previous?.type === "text") {
				if (previousWasQuote) previous.text = previous.text.slice(0, -2);
				else previous.text = previous.text.replace(/\s+$/, "");
			}
			expanded.push({
				type: "text",
				text: `\n\n${quoteBlock(item.chip.text, item.chip.speaker ?? undefined)}${item.chip.comment ? `\n\n${item.chip.comment}` : ""}\n\n`,
			});
			previousWasQuote = true;
			continue;
		}
		if (item.type === "text") {
			const next = { ...item };
			if (previousWasQuote) {
				next.text = next.text.replace(/^\s+/, "");
				if (next.text === "") continue;
			}
			expanded.push(next);
		} else expanded.push(item);
		previousWasQuote = false;
	}
	const normalized = normalizeDraft({
		...draft,
		items: expanded,
	});
	const sendable = normalized.items.filter(
		(i) => i.type === "text" || (i.type === "chip" && chipToPart(i.chip) !== null),
	);
	const items = [...sendable];
	if (items.length > 0 && items[0]?.type === "text") {
		const first = items[0] as { type: "text"; text: string };
		const t = first.text.replace(/^\s+/, "");
		if (t === "") items.shift();
		else items[0] = { type: "text", text: t };
	}
	if (items.length > 0 && items[items.length - 1]?.type === "text") {
		const last = items[items.length - 1] as { type: "text"; text: string };
		const t = last.text.replace(/\s+$/, "");
		if (t === "") items.pop();
		else items[items.length - 1] = { type: "text", text: t };
	}
	const parts: UIMessage["parts"] = [];
	for (const item of items) {
		if (item.type === "text") {
			parts.push({ type: "text", text: item.text } as UIMessage["parts"][number]);
			continue;
		}
		const part = chipToPart(item.chip);
		if (part !== null) parts.push(part);
	}
	const mentioned = new Set(
		items
			.filter(
				(i): i is { type: "chip"; chip: FileChip & { state: "ready" } } =>
					i.type === "chip" && i.chip.kind === "file" && i.chip.state === "ready",
			)
			.map((i) => i.chip.ref.path),
	);
	for (const chip of normalized.shelf) {
		if (chip.state !== "ready" || mentioned.has(chip.ref.path)) continue;
		parts.push({ type: "data-attachment", data: chip.ref } as UIMessage["parts"][number]);
	}
	return parts;
}

export function uploadState(draft: Draft): "ready" | "uploading" {
	for (const item of draft.items) {
		if (item.type === "chip" && item.chip.kind === "file" && item.chip.state !== "ready")
			return item.chip.state;
	}
	for (const chip of draft.shelf) {
		if (chip.kind === "file" && chip.state !== "ready") return chip.state;
	}
	return "ready";
}

function partData(part: UIMessage["parts"][number]): Record<string, unknown> | null {
	const data = (part as { data?: unknown }).data;
	if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
	return data as Record<string, unknown>;
}

function withoutFlag(data: Record<string, unknown>): Record<string, unknown> {
	const rest = { ...data };
	delete rest.inline;
	return rest;
}

function attachmentChip(data: Record<string, unknown>): FileChip | null {
	const res = fileChipSchema.safeParse({ kind: "file", state: "ready", ref: withoutFlag(data) });
	return res.success ? res.data : null;
}

export function draftFromMessages(messages: UIMessage["parts"][]): Draft {
	const items: DraftItem[] = [];
	const shelf: FileChip[] = [];
	const shelfKeys = new Set<string>();
	const appendText = (text: string, sep: string) => {
		const last = items[items.length - 1];
		if (last !== undefined && last.type === "text") {
			const prev = last as { type: "text"; text: string };
			items[items.length - 1] = { type: "text", text: `${prev.text}${sep}${text}` };
			return;
		}
		items.push({ type: "text", text });
	};
	const appendBlankLine = () => {
		if (items.length === 0) return;
		const last = items[items.length - 1];
		if (last !== undefined && last.type === "text") {
			const prev = last as { type: "text"; text: string };
			items[items.length - 1] = { type: "text", text: `${prev.text}\n\n` };
			return;
		}
		items.push({ type: "text", text: "\n\n" });
	};
	for (const parts of messages) {
		appendBlankLine();
		let textSeen = false;
		const trailing: DraftItem[] = [];
		for (const part of parts) {
			if (part.type === "text") {
				const t = (part as { text?: unknown }).text;
				appendText(typeof t === "string" ? t : "", textSeen ? "\n\n" : "");
				textSeen = true;
				continue;
			}
			const data = partData(part);
			if (data === null) continue;
			const inline = data.inline === true;
			if (part.type === "data-attachment") {
				const chip = attachmentChip(data);
				if (chip === null) continue;
				if (!inline && isImageChip(chip)) {
					const key = chipKey(chip);
					if (!shelfKeys.has(key)) {
						shelfKeys.add(key);
						shelf.push(chip);
					}
					continue;
				}
				(inline ? items : trailing).push({ type: "chip", chip });
				continue;
			}
			if (part.type === "data-note") {
				if (typeof data.id !== "string" || typeof data.title !== "string") continue;
				const chip: Chip = { kind: "note", id: data.id, title: data.title };
				(inline ? items : trailing).push({ type: "chip", chip });
				continue;
			}
			if (part.type === "data-skill") {
				const ref =
					typeof data.name === "string" && data.name !== ""
						? { name: data.name }
						: typeof data.url === "string" && typeof data.path === "string"
							? { url: data.url, path: data.path }
							: null;
				if (ref === null) continue;
				const chip: Chip = { kind: "skill", ref };
				(inline ? items : trailing).push({ type: "chip", chip });
				continue;
			}
		}
		for (const item of trailing) {
			const last = items[items.length - 1];
			if (last !== undefined && last.type === "text") {
				const text = last as { type: "text"; text: string };
				if (!/\s$/.test(text.text)) {
					items[items.length - 1] = { type: "text", text: `${text.text} ` };
				}
			}
			items.push(item);
		}
	}
	return normalizeDraft({ items, shelf });
}

export function joinDrafts(a: Draft, b: Draft): Draft {
	const x = normalizeDraft(a);
	const y = normalizeDraft(b);
	if (isEmptyDraft(x)) return y;
	if (isEmptyDraft(y)) return x;
	return { items: [...x.items, { type: "text", text: "\n\n" }, ...y.items], shelf: [...x.shelf, ...y.shelf] };
}

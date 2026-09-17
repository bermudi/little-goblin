// Attachment parts. Telegram media is saved to workspace/attachments/ and
// stored in history as a small data-attachment part — path + metadata, no
// payload. At turn time, materializeAttachments swaps each one for either
// a file part (the current model's capability data says it can consume the
// media type, and the payload fits the inline cap) or a text reference to
// the saved path.
//
// The capability decision is per-turn, per-current-model: a /model switch
// or a wrong catalog guess degrades to the path reference instead of
// poisoning the conversation's history with a part the provider rejects
// on every turn.

import { readFile, stat } from "node:fs/promises";
import type { UIMessage } from "ai";
import { z } from "zod";
import { log } from "../log.ts";

// Inline payloads get a ceiling — data URLs bloat both the request and,
// once materialized, the context window. One budget covers the whole
// turn: attachments materialize oldest-first until it's spent.
export const INLINE_MAX_BYTES = 8 * 1024 * 1024;

export const ATTACHMENT_PART = "data-attachment";

const attachmentRefSchema = z.object({
	path: z.string(),
	mediaType: z.string(),
	filename: z.string(),
	size: z.number(),
});

export type AttachmentRef = z.infer<typeof attachmentRefSchema>;

// What intake stores: a data part, not a file part — it's a durable
// reference, not model content.
export function attachmentPart(ref: AttachmentRef): UIMessage["parts"][number] {
	return { type: ATTACHMENT_PART, data: ref };
}

// Does capability data say this media type goes in natively? Same mapping
// intake and replay share: image/audio/video need their own modality;
// anything else needs the generic "file" modality, or "pdf" for PDFs.
export function acceptsMedia(modalities: Set<string>, mediaType: string): boolean {
	const top = mediaType.split("/", 1)[0];
	if (top === "image") return modalities.has("image");
	if (top === "audio") return modalities.has("audio");
	if (top === "video") return modalities.has("video");
	return (
		modalities.has("file") ||
		(mediaType === "application/pdf" && modalities.has("pdf"))
	);
}

// Rewrite a history snapshot for the model about to run: data-attachment
// parts become file parts when the model can consume them, text references
// otherwise. Everything else passes through. An unreadable attachment file
// degrades to the text reference too — the path still tells the model what
// was sent; a failed read_file on it fails loud there.
export async function materializeAttachments(
	messages: UIMessage[],
	modalities: Set<string> = new Set(),
	inlineBudget: number = INLINE_MAX_BYTES,
): Promise<UIMessage[]> {
	// Sequential: the budget is consumed in history order, so later
	// attachments see what earlier ones spent.
	let spent = 0;
	const out: UIMessage[] = [];
	for (const m of messages) {
		const parts: UIMessage["parts"] = [];
		for (const p of m.parts) {
			if (p.type !== ATTACHMENT_PART) {
				parts.push(p);
				continue;
			}
			// The part crossed the disk boundary — validate, don't trust.
			const ref = attachmentRefSchema.parse(p.data);
			const pathRef: UIMessage["parts"][number] = {
				type: "text",
				text: `[attachment: ${ref.path} — ${ref.mediaType}, ${ref.size} bytes. Read it with read_file or bash tools.]`,
			};
			if (!acceptsMedia(modalities, ref.mediaType)) {
				parts.push(pathRef);
				continue;
			}
			try {
				// The file on disk is authoritative — ref.size was recorded at
				// intake and the file may have changed since.
				if ((await stat(ref.path)).size > inlineBudget - spent) {
					parts.push(pathRef);
					continue;
				}
				const bytes = await readFile(ref.path);
				// Grew (or shrank — be honest) between stat and read.
				if (bytes.byteLength > inlineBudget - spent) {
					parts.push(pathRef);
					continue;
				}
				spent += bytes.byteLength;
				parts.push({
					type: "file",
					mediaType: ref.mediaType,
					filename: ref.filename,
					url: `data:${ref.mediaType};base64,${bytes.toString("base64")}`,
				});
			} catch (err) {
				// Any read/stat failure degrades the same way — a dead
				// attachment must not take the turn down with it.
				log.warn("attachment unreadable — degrading to path reference", {
					path: ref.path,
					error: String(err),
				});
				parts.push(pathRef);
			}
		}
		out.push({ ...m, parts });
	}
	return out;
}

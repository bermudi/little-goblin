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

import { readFile } from "node:fs/promises";
import type { UIMessage } from "ai";

// Inline payloads get a ceiling — data URLs bloat both the request and,
// once materialized, the context window.
export const INLINE_MAX_BYTES = 8 * 1024 * 1024;

export const ATTACHMENT_PART = "data-attachment";

export interface AttachmentRef {
	path: string;
	mediaType: string;
	filename: string;
	size: number;
}

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
// otherwise. Everything else passes through. A missing attachment file
// degrades to the text reference too — the path still tells the model what
// was sent; a failed read_file on it fails loud there.
export async function materializeAttachments(
	messages: UIMessage[],
	modalities: Set<string> = new Set(),
): Promise<UIMessage[]> {
	return Promise.all(
		messages.map(async (m) => ({
			...m,
			parts: await Promise.all(
				m.parts.map(async (p) => {
					if (p.type !== ATTACHMENT_PART) return p;
					const ref = p.data as AttachmentRef;
					if (acceptsMedia(modalities, ref.mediaType) && ref.size <= INLINE_MAX_BYTES) {
						try {
							const bytes = await readFile(ref.path);
							return {
								type: "file",
								mediaType: ref.mediaType,
								filename: ref.filename,
								url: `data:${ref.mediaType};base64,${bytes.toString("base64")}`,
							};
						} catch (err) {
							if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
						}
					}
					return {
						type: "text",
						text: `[attachment: ${ref.path} — ${ref.mediaType}, ${ref.size} bytes. Read it with read_file or bash tools.]`,
					};
				}),
			),
		})),
	);
}

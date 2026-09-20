// Attachment parts. Telegram media is saved to workspace/attachments/ and
// stored in history as a small data-attachment part — path + metadata, no
// payload. At turn time, materializeAttachments swaps each one for either
// a file part or a text reference to the saved path.
//
// Cache stability owns this module's shape: the decision for each part is
// a pure function of the stored ref and the model's input modalities —
// never of what else is in history, never of turn order. The same history
// under the same model materializes to identical request bytes every turn,
// so a provider's prefix cache survives from turn to turn. A /model switch
// recomputes representations once, which is free — the switch already
// lands on a cold cache.

import { readFile } from "node:fs/promises";
import type { UIMessage } from "ai";
import { z } from "zod";
import { log } from "../log.ts";

// Inline payloads get a per-item ceiling — a data URL inflates ~1.33× and
// providers cap request bodies. It is a request-size guard, not a context
// policy: there is deliberately no whole-turn budget, because a shared
// budget means new attachments can re-decide old ones — rewriting bytes
// already sent and busting the prefix cache (see DESIGN.md, Cache
// stability). Over-cap items degrade to the path reference with a warn.
export const INLINE_ITEM_MAX_BYTES = 8 * 1024 * 1024;

export const ATTACHMENT_PART = "data-attachment";

const attachmentRefSchema = z.object({
	path: z.string(),
	mediaType: z.string(),
	filename: z.string(),
	size: z.number(),
	// Speech attachments carry an intake-produced transcript — a model
	// that can't consume audio reads the words instead of a bare path.
	transcript: z.string().optional(),
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

// The fallback when the file can't go inline: a stored transcript
// (speech the model can't hear) beats the bare path reference.
function fallbackFor(ref: AttachmentRef): UIMessage["parts"][number] {
	return ref.transcript !== undefined
		? {
				type: "text",
				text: `[attachment: ${ref.path} — ${ref.mediaType}, ${ref.size} bytes. transcript: ${JSON.stringify(ref.transcript)}]`,
			}
		: {
				type: "text",
				text: `[attachment: ${ref.path} — ${ref.mediaType}, ${ref.size} bytes. Read it with read_file or bash tools.]`,
			};
}

function malformedFallback(): UIMessage["parts"][number] {
	return {
		type: "text",
		text: "[attachment: unreadable reference — stored attachment data failed validation. The file, if saved, may still be readable with read_file or bash tools.]",
	};
}

// One part's decision, independent of every other part. The plan is
// derivable from the ref alone (no disk access) — reading only happens
// for items that will inline.
function planPart(
	ref: AttachmentRef,
	modalities: Set<string>,
	maxItemBytes: number,
): { decision: "inline" } | { decision: "fallback"; reason: "modality" | "size" } {
	if (!acceptsMedia(modalities, ref.mediaType)) {
		return { decision: "fallback", reason: "modality" };
	}
	if (ref.size > maxItemBytes) {
		return { decision: "fallback", reason: "size" };
	}
	return { decision: "inline" };
}

// Rewrite a history snapshot for the model about to run: data-attachment
// parts become file parts when the model can consume them, text references
// otherwise. Everything else passes through untouched.
//
// Each part is decided on its own merits, in isolation — the output for a
// given message never depends on the rest of the snapshot, so adding a new
// photo to history cannot change how an old one materializes. That
// independence is what keeps a provider prefix cache valid across turns.
//
// Disk failure is the one degrade path for a planned-inline item: a file
// gone or grown past the cap becomes its path reference, with a warn — the
// model still sees what was sent, and the anomaly is visible in the log.
// A file whose bytes differ from intake but still fits inlines the current
// bytes with a warn — intake names files by Telegram fileUniqueId, so an
// overwrite means someone touched the workspace by hand.
export async function materializeAttachments(
	messages: UIMessage[],
	modalities: Set<string> = new Set(),
	maxItemBytes: number = INLINE_ITEM_MAX_BYTES,
): Promise<UIMessage[]> {
	const out: UIMessage[] = [];
	for (const m of messages) {
		let parts: UIMessage["parts"] | null = null;
		for (const [pi, p] of m.parts.entries()) {
			if (p.type !== ATTACHMENT_PART) continue;
			// The part crossed the disk boundary — validate, don't trust. A
			// malformed part degrades like everything else, never throws.
			const parsed = attachmentRefSchema.safeParse((p as { data?: unknown }).data);
			if (!parsed.success) {
				log.warn("malformed attachment — degrading to fallback reference", {
					message: m.id,
				});
				parts ??= [...m.parts];
				parts[pi] = malformedFallback();
				continue;
			}
			const ref = parsed.data;
			const plan = planPart(ref, modalities, maxItemBytes);
			if (plan.decision === "fallback") {
				if (plan.reason === "size") {
					log.warn("attachment over inline cap — degrading to reference", {
						path: ref.path,
						size: ref.size,
						cap: maxItemBytes,
					});
				}
				parts ??= [...m.parts];
				parts[pi] = fallbackFor(ref);
				continue;
			}
			try {
				const bytes = await readFile(ref.path);
				if (bytes.byteLength > maxItemBytes) {
					log.warn("attachment grew past cap since intake — degrading to reference", {
						path: ref.path,
						intakeSize: ref.size,
						actual: bytes.byteLength,
					});
					parts ??= [...m.parts];
					parts[pi] = fallbackFor(ref);
					continue;
				}
				if (bytes.byteLength !== ref.size) {
					log.warn("attachment bytes differ from intake — inlining current bytes", {
						path: ref.path,
						intakeSize: ref.size,
						actual: bytes.byteLength,
					});
				}
				parts ??= [...m.parts];
				parts[pi] = {
					type: "file",
					mediaType: ref.mediaType,
					filename: ref.filename,
					url: `data:${ref.mediaType};base64,${bytes.toString("base64")}`,
				};
			} catch (err) {
				log.warn("attachment unreadable — degrading to fallback reference", {
					path: ref.path,
					error: String(err),
				});
				parts ??= [...m.parts];
				parts[pi] = fallbackFor(ref);
			}
		}
		out.push(parts ? { ...m, parts } : m);
	}
	return out;
}

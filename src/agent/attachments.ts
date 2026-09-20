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
// turn: attachments reserve newest-first, so a fresh photo never goes
// invisible behind megabytes of older images. Degradations past the budget
// warn — a silent path reference the model can't read is a trap.
export const INLINE_MAX_BYTES = 8 * 1024 * 1024;

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

type PlanEntry =
	| { decision: "inline"; ref: AttachmentRef; size: number }
	| { decision: "fallback"; ref: AttachmentRef | null; reason: "malformed" | "modality" | "budget" | "unreadable" };

// Rewrite a history snapshot for the model about to run: data-attachment
// parts become file parts when the model can consume them, text references
// otherwise. Everything else passes through. An unreadable attachment file
// — or a malformed stored part — degrades to the text reference too: the
// path still tells the model what was sent, and a corrupt row must never
// take the turn (or the conversation) down with it.
export async function materializeAttachments(
	messages: UIMessage[],
	modalities: Set<string> = new Set(),
	inlineBudget: number = INLINE_MAX_BYTES,
): Promise<UIMessage[]> {
	// Collect attachment slots in history order.
	const slots: Array<{ mi: number; pi: number }> = [];
	messages.forEach((m, mi) => {
		m.parts.forEach((p, pi) => {
			if (p.type === ATTACHMENT_PART) slots.push({ mi, pi });
		});
	});

	// Reserve the budget newest-first: walk slots in reverse, statting each
	// candidate and spending the budget on the newest attachments first.
	// Older images degrade to path references instead of starving the new.
	const plan = new Map<string, PlanEntry>();
	let remaining = inlineBudget;
	let budgetDegraded = 0;
	const budgetPaths: string[] = [];
	for (let i = slots.length - 1; i >= 0; i--) {
		const { mi, pi } = slots[i]!;
		const key = `${mi}:${pi}`;
		const p = messages[mi]!.parts[pi] as { data?: unknown };
		// The part crossed the disk boundary — validate, don't trust. A
		// malformed part degrades like everything else, never throws.
		const parsed = attachmentRefSchema.safeParse(p.data);
		if (!parsed.success) {
			plan.set(key, { decision: "fallback", ref: null, reason: "malformed" });
			continue;
		}
		const ref = parsed.data;
		if (!acceptsMedia(modalities, ref.mediaType)) {
			plan.set(key, { decision: "fallback", ref, reason: "modality" });
			continue;
		}
		// The file on disk is authoritative — ref.size was recorded at
		// intake and the file may have changed since.
		let size: number;
		try {
			size = (await stat(ref.path)).size;
		} catch {
			plan.set(key, { decision: "fallback", ref, reason: "unreadable" });
			continue;
		}
		if (size > remaining) {
			plan.set(key, { decision: "fallback", ref, reason: "budget" });
			budgetDegraded++;
			if (budgetPaths.length < 5) budgetPaths.push(ref.path);
			continue;
		}
		remaining -= size;
		plan.set(key, { decision: "inline", ref, size });
	}
	if (budgetDegraded > 0) {
		log.warn("attachment budget spent — oldest attachments degraded to references", {
			budget: inlineBudget,
			degraded: budgetDegraded,
			inlined: slots.length - budgetDegraded,
			paths: budgetPaths,
		});
	}

	// Emit in history order. Reservations above guarantee the inline set
	// fits the budget as long as files only shrink; a file that grew past
	// its reservation degrades instead of pushing the total over.
	let spent = 0;
	const out: UIMessage[] = [];
	for (const [mi, m] of messages.entries()) {
		const parts: UIMessage["parts"] = [];
		for (const [pi, p] of m.parts.entries()) {
			if (p.type !== ATTACHMENT_PART) {
				parts.push(p);
				continue;
			}
			const entry = plan.get(`${mi}:${pi}`);
			if (!entry || entry.decision === "fallback") {
				if (!entry || entry.ref === null) {
					log.warn("malformed attachment — degrading to fallback reference", {
						message: m.id,
					});
					parts.push(malformedFallback());
				} else if (entry.reason === "budget") {
					parts.push(fallbackFor(entry.ref));
				} else if (entry.reason === "modality") {
					parts.push(fallbackFor(entry.ref));
				} else {
					log.warn("attachment unreadable — degrading to fallback reference", {
						path: entry.ref.path,
						error: "stat failed",
					});
					parts.push(fallbackFor(entry.ref));
				}
				continue;
			}
			const { ref, size: reserved } = entry;
			try {
				const bytes = await readFile(ref.path);
				if (bytes.byteLength > reserved) {
					// Grew between stat and read — be honest, degrade.
					log.warn("attachment grew since stat — degrading to fallback reference", {
						path: ref.path,
						reserved,
						actual: bytes.byteLength,
					});
					parts.push(fallbackFor(ref));
					continue;
				}
				if (spent + bytes.byteLength > inlineBudget) {
					log.warn("attachment budget exceeded at read — degrading to fallback reference", {
						path: ref.path,
					});
					parts.push(fallbackFor(ref));
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
				// Any read failure degrades the same way — a dead
				// attachment must not take the turn down with it.
				log.warn("attachment unreadable — degrading to fallback reference", {
					path: ref.path,
					error: String(err),
				});
				parts.push(fallbackFor(ref));
			}
		}
		out.push({ ...m, parts });
	}
	return out;
}

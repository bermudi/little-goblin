// Decide per ref so adding another attachment cannot rematerialize older parts;
// bytes are read from disk at turn time.

import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import { z } from "zod";
import { paths } from "../config.ts";
import { log } from "../log.ts";

// Cap each inline item because data URLs inflate payloads. A shared turn budget
// could rewrite old parts and invalidate the prefix cache; over-cap refs use
// transcript text when available, otherwise a saved-path reference.
export const INLINE_ITEM_MAX_BYTES = 8 * 1024 * 1024;

export const ATTACHMENT_PART = "data-attachment";

// App-supplied refs must also pass isStoredAttachmentPath before readFile sees
// them; parsing alone cannot make a client-chosen path safe.
export const attachmentRefSchema = z.object({
	path: z.string(),
	mediaType: z.string(),
	filename: z.string(),
	size: z.number(),
	// A stored transcript lets a non-audio model read speech instead of a path.
	transcript: z.string().optional(),
	// Intake marks recorded voice/video notes so speech can inline; arbitrary
	// audio stays a path instead of base64-ing music into every request.
	speech: z.boolean().optional(),
});

export type AttachmentRef = z.infer<typeof attachmentRefSchema>;

export function attachmentPart(ref: AttachmentRef): UIMessage["parts"][number] {
	return { type: ATTACHMENT_PART, data: ref };
}

export interface SavedAttachment {
	path: string;
	size: number;
}

// Sync before exposing the path to history. Wrapped sync failures redact the
// supplied credential; other I/O and writer errors propagate unchanged.
export async function persistAttachment(
	stem: string,
	fileName: string,
	label: string,
	writeTemp: (temp: string) => Promise<void>,
	redact?: string,
): Promise<SavedAttachment> {
	const safeStem = z
		.string()
		.regex(/^[A-Za-z0-9_-]+$/)
		.parse(stem);
	const scrub = (detail: string) => (redact ? detail.replaceAll(redact, "***") : detail);
	await mkdir(paths.attachments(), { recursive: true });
	// Make a recreated attachments directory durable before history points into it.
	try {
		const parent = await open(dirname(paths.attachments()), "r");
		try {
			await parent.sync();
		} finally {
			await parent.close();
		}
	} catch (err) {
		throw new Error(`${label} attachment parent directory sync failed: ${scrub(String(err))}`);
	}
	const safe = basename(fileName).replace(/[^\w.\-]+/g, "_");
	const dest = join(paths.attachments(), `${safeStem}-${safe}`);
	const temp = join(paths.attachments(), `.${safeStem}-${randomUUID()}.tmp`);
	try {
		await writeTemp(temp);
		const { size } = await stat(temp);
		// Sync bytes before exposing the destination.
		try {
			const handle = await open(temp, "r");
			try {
				await handle.sync();
			} finally {
				await handle.close();
			}
		} catch (err) {
			throw new Error(`${label} attachment file sync failed for ${dest}: ${scrub(String(err))}`);
		}
		await rename(temp, dest);
		// Sync the directory so the rename is durable before history commits.
		try {
			const handle = await open(paths.attachments(), "r");
			try {
				await handle.sync();
			} finally {
				await handle.close();
			}
		} catch (err) {
			throw new Error(
				`${label} attachment directory sync failed for ${dest}: ${scrub(String(err))}`,
			);
		}
		return { path: dest, size };
	} catch (err) {
		// Do not delete the destination: history may already reference it.
		try {
			await unlink(temp);
		} catch (cleanupErr) {
			if ((cleanupErr as NodeJS.ErrnoException).code !== "ENOENT") {
				log.warn(`${label} attachment temp cleanup failed`, {
					dest,
					temp,
					error: scrub(String(cleanupErr)),
				});
			}
		}
		throw err;
	}
}

// Resolve before the prefix check so absolute paths and `..` cannot escape
// the attachments directory this process owns.
export function isStoredAttachmentPath(path: string): boolean {
	const dir = resolve(paths.attachments());
	return resolve(path).startsWith(dir + sep);
}

// Provider converters differ by position: some stringify or drop tool-result
// files, while Responses and OpenRouter preserve them.
export type MediaPosition = "user" | "tool-result";

// Built once per turn from model modalities and provider transport support.
// Reusing it for attachments and fetched PDFs keeps materialization deterministic.
export interface AcceptsMedia {
	modalities: ReadonlySet<string>;
	carries: (mediaType: string, position: MediaPosition) => boolean;
}

// Media needs its own modality; other files use `file`, with PDFs also
// accepted through the `pdf` capability.
export function acceptsMedia(modalities: ReadonlySet<string>, mediaType: string): boolean {
	const top = mediaType.split("/", 1)[0];
	if (top === "image") return modalities.has("image");
	if (top === "audio") return modalities.has("audio");
	if (top === "video") return modalities.has("video");
	return modalities.has("file") || (mediaType === "application/pdf" && modalities.has("pdf"));
}

// Preserve an intake speech transcript when the model cannot consume the file.
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

// Plan without disk access; only planned-inline items are read.
function planPart(
	ref: AttachmentRef,
	modalities: Set<string>,
	maxItemBytes: number,
	carries: (mediaType: string, position: MediaPosition) => boolean,
): { decision: "inline" } | { decision: "fallback"; reason: "modality" | "size" } {
	// Never inline non-speech audio: use its transcript as text when present,
	// otherwise keep a path reference.
	if (ref.mediaType.startsWith("audio/") && ref.speech !== true) {
		return { decision: "fallback", reason: "modality" };
	}
	// Both model capability and provider transport must pass; otherwise retain a
	// path instead of failing mid-request.
	if (!acceptsMedia(modalities, ref.mediaType) || !carries(ref.mediaType, "user")) {
		return { decision: "fallback", reason: "modality" };
	}
	if (ref.size > maxItemBytes) {
		return { decision: "fallback", reason: "size" };
	}
	return { decision: "inline" };
}

// Convert validated data parts to file parts when both gates pass, otherwise
// use text references. Decide each part independently so adding history cannot
// change older materialization or bust the prefix cache.
//
// Missing or over-cap files degrade to a reference. A changed file warns but
// inlines its current bytes when still within the cap.
export async function materializeAttachments(
	messages: UIMessage[],
	modalities: Set<string> = new Set(),
	maxItemBytes: number = INLINE_ITEM_MAX_BYTES,
	// Conservative default: user-message parts only.
	carries: (mediaType: string, position: MediaPosition) => boolean = (_mt, position) =>
		position === "user",
): Promise<UIMessage[]> {
	const out: UIMessage[] = [];
	for (const m of messages) {
		let parts: UIMessage["parts"] | null = null;
		for (const [pi, p] of m.parts.entries()) {
			if (p.type !== ATTACHMENT_PART) continue;
			// Validate at this disk boundary; malformed data degrades instead of throwing.
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
			const plan = planPart(ref, modalities, maxItemBytes, carries);
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
				log.warn("attachment unreadable — degrading to fallback reference", err, {
					path: ref.path,
				});
				parts ??= [...m.parts];
				parts[pi] = fallbackFor(ref);
			}
		}
		out.push(parts ? { ...m, parts } : m);
	}
	return out;
}

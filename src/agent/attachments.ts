// Attachment parts. Telegram media is saved to workspace/attachments/ and
// stored in history as a small data-attachment part — path + metadata, no
// payload. At turn time, materializeAttachments swaps each one for either
// a file part or a text reference to the saved path.
//
// Cache stability owns this module's shape: the decision for each part is
// a pure function of the stored ref and the model's input modalities —
// never of what else is in history, never of turn order. The same history
// under the same model materializes to identical request bytes every turn,
// so a provider's prefix cache survives from turn to turn. A model switch
// recomputes representations once, which is free — the switch already
// lands on a cold cache.

import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import { z } from "zod";
import { paths } from "../config.ts";
import { log } from "../log.ts";

// Inline payloads get a per-item ceiling — a data URL inflates ~1.33× and
// providers cap request bodies. It is a request-size guard, not a context
// policy: there is deliberately no whole-turn budget, because a shared
// budget means new attachments can re-decide old ones — rewriting bytes
// already sent and busting the prefix cache (see DESIGN.md, Cache
// stability). Over-cap items degrade to the path reference with a warn.
export const INLINE_ITEM_MAX_BYTES = 8 * 1024 * 1024;

export const ATTACHMENT_PART = "data-attachment";

// Exported for the app channel's intake boundary: a client-supplied
// data-attachment part must parse against this AND pass
// isStoredAttachmentPath — otherwise ref.path is a client-chosen string
// that materializeAttachments would hand to readFile below.
export const attachmentRefSchema = z.object({
	path: z.string(),
	mediaType: z.string(),
	filename: z.string(),
	size: z.number(),
	// Speech attachments carry an intake-produced transcript — a model
	// that can't consume audio reads the words instead of a bare path.
	transcript: z.string().optional(),
	// Set at intake for voice and video notes — the kinds Telegram only
	// produces by recording someone. Audio inlines for a hearing model
	// only when the file is speech: an attached mp3 is data, and
	// base64-ing a song into every request is the most expensive way
	// to not listen to it.
	speech: z.boolean().optional(),
});

export type AttachmentRef = z.infer<typeof attachmentRefSchema>;

// What intake stores: a data part, not a file part — it's a durable
// reference, not model content.
export function attachmentPart(ref: AttachmentRef): UIMessage["parts"][number] {
	return { type: ATTACHMENT_PART, data: ref };
}

// ---------- durable save ----------

export interface SavedAttachment {
	path: string;
	size: number;
}

// The save every channel shares (tg/media.ts for telegram downloads,
// http/app-channel.ts for app uploads): workspace/attachments/, a
// same-directory temp, file sync → atomic rename → directory sync, so a
// path that reaches history is provably on disk. `stem` is the caller's
// unique name-stem — untrusted input, validated as a path-safe token
// before the directory exists. `label` prefixes error/log lines
// ("telegram", "app") so the channel survives in the message;
// `redact` scrubs a credential out of propagated details.
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
	// ensureHomeLayout syncs first-boot directory creation. Also cover
	// attachments/ being recreated later: its name must be durable in
	// workspace/ before history can commit a path inside it.
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
		// The bytes must reach disk before the path can enter history.
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
		// Persist the rename too. A failure here leaves the new
		// destination in place, but must not commit an unproven path to
		// history.
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
		// Never delete the destination: history may already reference it.
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

// Intake-side confinement for client-supplied refs: persistAttachment
// writes only inside workspace/attachments/, so a ref.path that resolves
// anywhere else is not a file this process saved — it's a request to
// readFile an arbitrary path at materialize time. resolve() collapses
// `..` and absolutizes before the prefix check, so neither escapes.
export function isStoredAttachmentPath(path: string): boolean {
	const dir = resolve(paths.attachments());
	return resolve(path).startsWith(dir + sep);
}

// Where a media part rides in a request. The pipe's answer differs by
// position: chat-completions converters express file parts in user
// messages but stringify tool-result content (openai-compatible — a
// file part there becomes base64 JSON text riding every later request)
// or filter it to text (codex). Real tool-result file parts exist on
// the Responses protocol and OpenRouter's normalizer.
export type MediaPosition = "user" | "tool-result";

// This turn's effective media acceptance, built once per turn by
// buildStep: catalog modalities (what the model consumes, models.dev)
// intersected with the provider pipe's carries predicate (what the SDK
// converter can actually deliver — carriesMedia in providers.ts).
// Attachment materialization and the fetch tool's PDF rendering both
// read it at request time, so a given history under a given model
// renders to identical request bytes every turn.
export interface AcceptsMedia {
	modalities: ReadonlySet<string>;
	carries: (mediaType: string, position: MediaPosition) => boolean;
}

// Does capability data say this media type goes in natively? Same mapping
// intake and replay share: image/audio/video need their own modality;
// anything else needs the generic "file" modality, or "pdf" for PDFs.
export function acceptsMedia(modalities: ReadonlySet<string>, mediaType: string): boolean {
	const top = mediaType.split("/", 1)[0];
	if (top === "image") return modalities.has("image");
	if (top === "audio") return modalities.has("audio");
	if (top === "video") return modalities.has("video");
	return modalities.has("file") || (mediaType === "application/pdf" && modalities.has("pdf"));
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
	carries: (mediaType: string, position: MediaPosition) => boolean,
): { decision: "inline" } | { decision: "fallback"; reason: "modality" | "size" } {
	// Attached audio is data, not speech — even an audio-capable model
	// gets the path, and listens via the transcribe tool or ffmpeg. Only
	// intake-marked recordings (voice/video notes) inline as audio.
	if (ref.mediaType.startsWith("audio/") && ref.speech !== true) {
		return { decision: "fallback", reason: "modality" };
	}
	// Two gates, both must pass: the model consumes the media type
	// (catalog modalities), and the provider pipe can deliver it at the
	// position it rides (carriesMedia — user-message content here; tool
	// results are a different converter path). A model
	// that takes PDFs behind a pipe that can't carry them gets the path
	// reference, not a thrown turn mid-request.
	if (!acceptsMedia(modalities, ref.mediaType) || !carries(ref.mediaType, "user")) {
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
	// Default preserves the pre-gate behavior for user-message parts and
	// carries nothing in tool results — the conservative reading for a
	// caller that didn't say.
	carries: (mediaType: string, position: MediaPosition) => boolean = (_mt, position) =>
		position === "user",
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

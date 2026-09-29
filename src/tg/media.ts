// Telegram media → UIMessage parts. Media is always saved to
// workspace/attachments/ and stored as a data-attachment part (path +
// metadata, no payload) — the inline-vs-path decision is made per turn by
// the runtime against the current model's capability data, so intake
// doesn't need to know the model at all.

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import type { File as TgFile } from "grammy/types";
import type { UIMessage } from "ai";
import { z } from "zod";
import { paths } from "../config.ts";
import { attachmentPart } from "../agent/attachments.ts";
import { log } from "../log.ts";

export interface IncomingMedia {
	fileId: string;
	fileUniqueId: string;
	fileName: string; // best-effort original name
	mimeType: string;
	// Carries speech worth transcribing at intake: voice notes and video
	// notes — the two kinds Telegram only produces by recording someone.
	// Attached audio (audio, audio-mime documents) is data, not speech —
	// a song is a wasted whisper call. The transcribe tool covers it on
	// demand.
	transcribable?: boolean;
}

export function mediaFromMessage(msg: {
	photo?: { file_id: string; file_unique_id: string; width: number }[];
	document?: { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string };
	voice?: { file_id: string; file_unique_id: string; mime_type?: string };
	audio?: { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string };
	video?: { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string };
	animation?: { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string };
	video_note?: { file_id: string; file_unique_id: string };
	sticker?: {
		file_id: string;
		file_unique_id: string;
		is_animated?: boolean;
		is_video?: boolean;
	};
}): IncomingMedia | null {
	if (msg.photo && msg.photo.length > 0) {
		const largest = z.object({
			file_id: z.string().min(1),
			file_unique_id: z.string().min(1),
		}).parse(msg.photo[msg.photo.length - 1]);
		return {
			fileId: largest.file_id,
			fileUniqueId: largest.file_unique_id,
			fileName: `photo-${largest.file_unique_id}.jpg`,
			mimeType: "image/jpeg",
		};
	}
	if (msg.document) {
		const d = msg.document;
		return {
			fileId: d.file_id,
			fileUniqueId: d.file_unique_id,
			fileName: d.file_name ?? `doc-${d.file_unique_id}`,
			mimeType: d.mime_type ?? "application/octet-stream",
		};
	}
	if (msg.voice) {
		return {
			fileId: msg.voice.file_id,
			fileUniqueId: msg.voice.file_unique_id,
			fileName: `voice-${msg.voice.file_unique_id}.ogg`,
			mimeType: msg.voice.mime_type ?? "audio/ogg",
			transcribable: true,
		};
	}
	if (msg.audio) {
		return {
			fileId: msg.audio.file_id,
			fileUniqueId: msg.audio.file_unique_id,
			fileName: msg.audio.file_name ?? `audio-${msg.audio.file_unique_id}`,
			mimeType: msg.audio.mime_type ?? "audio/mpeg",
		};
	}
	if (msg.video) {
		return {
			fileId: msg.video.file_id,
			fileUniqueId: msg.video.file_unique_id,
			fileName: msg.video.file_name ?? `video-${msg.video.file_unique_id}.mp4`,
			mimeType: msg.video.mime_type ?? "video/mp4",
		};
	}
	if (msg.animation) {
		// GIFs from the picker arrive as `animation`, not video/document —
		// always mp4 by convention.
		const a = msg.animation;
		return {
			fileId: a.file_id,
			fileUniqueId: a.file_unique_id,
			fileName: a.file_name ?? `animation-${a.file_unique_id}.mp4`,
			mimeType: a.mime_type ?? "video/mp4",
		};
	}
	if (msg.video_note) {
		// Video notes (circles) are always mp4 and carry no mime_type.
		return {
			fileId: msg.video_note.file_id,
			fileUniqueId: msg.video_note.file_unique_id,
			fileName: `video-note-${msg.video_note.file_unique_id}.mp4`,
			mimeType: "video/mp4",
			transcribable: true,
		};
	}
	if (msg.sticker) {
		const s = msg.sticker;
		// Static stickers are .webp images; animated (.tgs) and video
		// (.webm) stickers go the attachment-path route.
		const staticImage = s.is_animated !== true && s.is_video !== true;
		return {
			fileId: s.file_id,
			fileUniqueId: s.file_unique_id,
			fileName: `sticker-${s.file_unique_id}.webp`,
			mimeType: staticImage ? "image/webp" : "application/octet-stream",
		};
	}
	return null;
}

export interface SavedAttachment {
	path: string;
	size: number;
}

// Persist to workspace/attachments/ (Telegram still owns the file; this is
// the agent-reachable copy) without ever buffering the whole file —
// uploads run to 2GB on a self-hosted bot-api. Local-mode files are
// copied on disk; cloud downloads stream to a same-directory temp file.
export async function saveAttachment(
	media: IncomingMedia,
	file: TgFile,
	apiRoot: string | undefined,
	token: string,
): Promise<SavedAttachment> {
	const filePath = file.file_path;
	if (!filePath) throw new Error("telegram returned no file_path");
	// Telegram's unique id is untrusted input, not a path component.
	const uniqueId = z.string().regex(/^[A-Za-z0-9_-]+$/).parse(media.fileUniqueId);
	await mkdir(paths.attachments(), { recursive: true });
	const safe = basename(media.fileName).replace(/[^\w.\-]+/g, "_");
	const dest = join(paths.attachments(), `${uniqueId}-${safe}`);
	const temp = join(paths.attachments(), `.${uniqueId}-${randomUUID()}.tmp`);
	try {
		if (filePath.startsWith("/")) {
			// Self-hosted bot-api in --local mode: copy on disk, no HTTP fetch.
			await copyFile(filePath, temp, constants.COPYFILE_EXCL);
		} else {
			const root = apiRoot ?? "https://api.telegram.org";
			// The URL carries the bot token. Never propagate its raw errors.
			const url = `${root}/file/bot${token}/${filePath}`;
			try {
				const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				await Bun.write(temp, res);
			} catch (err) {
				const msg = String(err instanceof Error ? err.message : err);
				throw new Error(`telegram file download failed: ${token ? msg.replaceAll(token, "***") : msg}`);
			}
		}
		const { size } = await stat(temp);
		// The copy/download must reach disk before its name can enter history.
		try {
			const handle = await open(temp, "r");
			try {
				await handle.sync();
			} finally {
				await handle.close();
			}
		} catch (err) {
			const detail = String(err);
			throw new Error(`telegram attachment file sync failed for ${dest}: ${token ? detail.replaceAll(token, "***") : detail}`);
		}
		await rename(temp, dest);
		// Persist the rename too. A failure here leaves the new destination in
		// place, but must not commit an unproven path to history.
		try {
			const handle = await open(paths.attachments(), "r");
			try {
				await handle.sync();
			} finally {
				await handle.close();
			}
		} catch (err) {
			const detail = String(err);
			throw new Error(`telegram attachment directory sync failed for ${dest}: ${token ? detail.replaceAll(token, "***") : detail}`);
		}
		return { path: dest, size };
	} catch (err) {
		// Never delete the destination: history may already reference it.
		try {
			await unlink(temp);
		} catch (cleanupErr) {
			if ((cleanupErr as NodeJS.ErrnoException).code !== "ENOENT") {
				const msg = String(cleanupErr);
				log.warn("telegram attachment temp cleanup failed", {
					dest, temp, error: token ? msg.replaceAll(token, "***") : msg,
				});
			}
		}
		throw err;
	}
}

// Media → parts: one data-attachment part carrying the saved path (plus
// the transcript when intake produced one). The runtime materializes it
// against the current model at turn time.
export function mediaParts(
	media: IncomingMedia,
	saved: SavedAttachment,
	transcript?: string,
): UIMessage["parts"] {
	return [
		attachmentPart({
			path: saved.path,
			mediaType: media.mimeType,
			filename: media.fileName,
			size: saved.size,
			...(transcript !== undefined ? { transcript } : {}),
			// The speech marker is what lets a voice note inline for a
			// hearing model while an attached mp3 stays a path.
			...(media.transcribable ? { speech: true } : {}),
		}),
	];
}

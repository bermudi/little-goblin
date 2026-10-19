import { constants } from "node:fs";
import { copyFile } from "node:fs/promises";
import type { File as TgFile } from "grammy/types";
import type { UIMessage } from "ai";
import { z } from "zod";
import { attachmentPart, persistAttachment, type SavedAttachment } from "../agent/attachments.ts";

export interface IncomingMedia {
	fileId: string;
	fileUniqueId: string;
	fileName: string;
	mimeType: string;
	transcribable?: boolean;
}

export function mediaFromMessage(msg: {
	photo?: { file_id: string; file_unique_id: string; width: number }[];
	live_photo?: {
		file_id: string;
		file_unique_id: string;
		photo?: { file_id: string; file_unique_id: string; width: number }[];
		mime_type?: string;
	};
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
	if (msg.live_photo) {
		const lp = msg.live_photo;
		const still =
			lp.photo !== undefined && lp.photo.length > 0
				? lp.photo
				: msg.photo !== undefined && msg.photo.length > 0
					? msg.photo
					: null;
		if (still !== null) {
			const largest = z
				.object({
					file_id: z.string().min(1),
					file_unique_id: z.string().min(1),
				})
				.parse(still[still.length - 1]);
			return {
				fileId: largest.file_id,
				fileUniqueId: largest.file_unique_id,
				fileName: `photo-${largest.file_unique_id}.jpg`,
				mimeType: "image/jpeg",
			};
		}
		return {
			fileId: lp.file_id,
			fileUniqueId: lp.file_unique_id,
			fileName: `live-photo-${lp.file_unique_id}.mp4`,
			mimeType: lp.mime_type ?? "video/mp4",
		};
	}
	if (msg.photo && msg.photo.length > 0) {
		const largest = z
			.object({
				file_id: z.string().min(1),
				file_unique_id: z.string().min(1),
			})
			.parse(msg.photo[msg.photo.length - 1]);
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
		const a = msg.animation;
		return {
			fileId: a.file_id,
			fileUniqueId: a.file_unique_id,
			fileName: a.file_name ?? `animation-${a.file_unique_id}.mp4`,
			mimeType: a.mime_type ?? "video/mp4",
		};
	}
	if (msg.video_note) {
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

export type { SavedAttachment };

export function unhandledMediaKind(msg: {
	location?: unknown;
	venue?: unknown;
	contact?: unknown;
	poll?: unknown;
	story?: unknown;
	dice?: unknown;
	paid_media?: unknown;
}): string | null {
	if (msg.location !== undefined) return "a location";
	if (msg.venue !== undefined) return "a venue";
	if (msg.contact !== undefined) return "a contact card";
	if (msg.poll !== undefined) return "a poll";
	if (msg.story !== undefined) return "a story";
	if (msg.dice !== undefined) return "a dice roll";
	if (msg.paid_media !== undefined) return "paid media";
	return null;
}

export async function saveAttachment(
	media: IncomingMedia,
	file: TgFile,
	apiRoot: string | undefined,
	token: string,
): Promise<SavedAttachment> {
	const filePath = file.file_path;
	if (!filePath) throw new Error("telegram returned no file_path");
	const uniqueId = z
		.string()
		.regex(/^[A-Za-z0-9_-]+$/)
		.parse(media.fileUniqueId);
	return persistAttachment(
		uniqueId,
		media.fileName,
		"telegram",
		async (temp) => {
			if (filePath.startsWith("/")) {
				await copyFile(filePath, temp, constants.COPYFILE_EXCL);
			} else {
				const root = apiRoot ?? "https://api.telegram.org";
				const url = `${root}/file/bot${token}/${filePath}`;
				try {
					const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					await Bun.write(temp, res);
				} catch (err) {
					const msg = String(err instanceof Error ? err.message : err);
					throw new Error(
						`telegram file download failed: ${token ? msg.replaceAll(token, "***") : msg}`,
					);
				}
			}
		},
		token,
	);
}

export function mediaParts(
	media: IncomingMedia,
	saved: SavedAttachment,
	transcript?: string,
	transcriptionError?: string,
): UIMessage["parts"] {
	return [
		attachmentPart({
			path: saved.path,
			mediaType: media.mimeType,
			filename: media.fileName,
			size: saved.size,
			...(transcript !== undefined ? { transcript } : {}),
			...(transcriptionError !== undefined ? { transcriptionError } : {}),
			...(media.transcribable ? { speech: true } : {}),
		}),
	];
}

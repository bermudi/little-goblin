// Telegram media → UIMessage parts. Telegram media goes to the model
// natively when the model's capability data says it can; otherwise it's
// saved to workspace/attachments/ and referenced by path.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { File as TgFile } from "grammy/types";
import type { UIMessage } from "ai";
import { paths, splitModelRef } from "../config.ts";
import { inputModalities } from "../agent/models-dev.ts";

// Inline payloads get a ceiling — data URLs bloat the event history.
const INLINE_MAX_BYTES = 8 * 1024 * 1024;

export interface IncomingMedia {
	fileId: string;
	fileUniqueId: string;
	fileName: string; // best-effort original name
	mimeType: string;
	// What the file is, for the text reference and modality check.
	kind: "image" | "audio" | "video" | "document";
}

export function mediaFromMessage(msg: {
	photo?: { file_id: string; file_unique_id: string; width: number }[];
	document?: { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string };
	voice?: { file_id: string; file_unique_id: string; mime_type?: string };
	audio?: { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string };
	video?: { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string };
	sticker?: { file_id: string; file_unique_id: string };
}): IncomingMedia | null {
	if (msg.photo && msg.photo.length > 0) {
		const largest = msg.photo[msg.photo.length - 1]!;
		return {
			fileId: largest.file_id,
			fileUniqueId: largest.file_unique_id,
			fileName: `photo-${largest.file_unique_id}.jpg`,
			mimeType: "image/jpeg",
			kind: "image",
		};
	}
	if (msg.document) {
		const d = msg.document;
		return {
			fileId: d.file_id,
			fileUniqueId: d.file_unique_id,
			fileName: d.file_name ?? `doc-${d.file_unique_id}`,
			mimeType: d.mime_type ?? "application/octet-stream",
			kind: d.mime_type?.startsWith("image/") ? "image" : "document",
		};
	}
	if (msg.voice) {
		return {
			fileId: msg.voice.file_id,
			fileUniqueId: msg.voice.file_unique_id,
			fileName: `voice-${msg.voice.file_unique_id}.ogg`,
			mimeType: msg.voice.mime_type ?? "audio/ogg",
			kind: "audio",
		};
	}
	if (msg.audio) {
		return {
			fileId: msg.audio.file_id,
			fileUniqueId: msg.audio.file_unique_id,
			fileName: msg.audio.file_name ?? `audio-${msg.audio.file_unique_id}`,
			mimeType: msg.audio.mime_type ?? "audio/mpeg",
			kind: "audio",
		};
	}
	if (msg.video) {
		return {
			fileId: msg.video.file_id,
			fileUniqueId: msg.video.file_unique_id,
			fileName: msg.video.file_name ?? `video-${msg.video.file_unique_id}.mp4`,
			mimeType: msg.video.mime_type ?? "video/mp4",
			kind: "video",
		};
	}
	return null;
}

// Fetch file bytes. With a self-hosted telegram-bot-api in --local mode,
// getFile returns an absolute local path — read straight off disk, no HTTP.
// With the cloud API, download over HTTPS.
export async function fetchFileBytes(
	file: TgFile,
	apiRoot: string | undefined,
	token: string,
): Promise<Buffer> {
	const filePath = file.file_path;
	if (!filePath) throw new Error("telegram returned no file_path");
	if (filePath.startsWith("/")) {
		return readFileSync(filePath);
	}
	const root = apiRoot ?? "https://api.telegram.org";
	const url = `${root}/file/bot${token}/${filePath}`;
	const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
	if (!res.ok) throw new Error(`telegram file download HTTP ${res.status}`);
	return Buffer.from(await res.arrayBuffer());
}

// Persist to workspace/attachments/ (Telegram still owns the file; this is
// the agent-reachable copy). Returns the absolute path.
export function saveAttachment(media: IncomingMedia, bytes: Buffer): string {
	mkdirSync(paths.attachments(), { recursive: true });
	const safe = basename(media.fileName).replace(/[^\w.\-]+/g, "_");
	const dest = join(paths.attachments(), `${media.fileUniqueId}-${safe}`);
	writeFileSync(dest, bytes);
	return dest;
}

// Media → parts. Natively-capable models get a file part (data URL);
// everyone else gets a text reference to the saved path.
export async function mediaParts(
	media: IncomingMedia,
	bytes: Buffer,
	savedPath: string,
	modelRef: string,
): Promise<UIMessage["parts"]> {
	const { provider, modelId } = splitModelRef(modelRef);
	const modalities = await inputModalities(provider, modelId);
	const accepts =
		(media.kind === "image" && modalities.has("image")) ||
		(media.kind === "audio" && modalities.has("audio")) ||
		(media.kind === "document" &&
			(modalities.has(media.mimeType === "application/pdf" ? "pdf" : "file") ||
				modalities.has("pdf"))) ||
		(media.kind === "video" && modalities.has("video"));

	if (accepts && bytes.byteLength <= INLINE_MAX_BYTES) {
		const dataUrl = `data:${media.mimeType};base64,${bytes.toString("base64")}`;
		return [
			{
				type: "file",
				mediaType: media.mimeType,
				filename: media.fileName,
				url: dataUrl,
			},
		];
	}
	return [
		{
			type: "text",
			text: `[attachment: ${savedPath} — ${media.mimeType}, ${bytes.byteLength} bytes. Read it with read_file or bash tools.]`,
		},
	];
}

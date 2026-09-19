import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { File as TgFile } from "grammy/types";
import { paths } from "../config.ts";
import { mediaFromMessage, mediaParts, saveAttachment, type IncomingMedia } from "./media.ts";

let dirs: string[] = [];
let prevHome: string | undefined;

function useHome(): string {
	prevHome = process.env.GOBLIN_HOME;
	const dir = mkdtempSync(join(tmpdir(), "goblin-media-"));
	dirs.push(dir);
	process.env.GOBLIN_HOME = dir;
	return dir;
}

afterEach(() => {
	if (prevHome === undefined) delete process.env.GOBLIN_HOME;
	else process.env.GOBLIN_HOME = prevHome;
	prevHome = undefined;
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

const media: IncomingMedia = {
	fileId: "f1",
	fileUniqueId: "u1",
	fileName: "clip.mp4",
	mimeType: "video/mp4",
};

describe("mediaFromMessage", () => {
	test("animation (GIF) is picked up as video media", () => {
		const m = mediaFromMessage({
			animation: { file_id: "a1", file_unique_id: "u9", mime_type: "video/mp4" },
		});
		expect(m).not.toBeNull();
		expect(m!.mimeType).toBe("video/mp4");
		expect(m!.fileId).toBe("a1");
		expect(m!.fileName).toBe("animation-u9.mp4");
	});

	test("a photo picks the largest size", () => {
		const m = mediaFromMessage({
			photo: [
				{ file_id: "small", file_unique_id: "u1", width: 90 },
				{ file_id: "big", file_unique_id: "u2", width: 1280 },
			],
		});
		expect(m!.fileId).toBe("big");
		expect(m!.mimeType).toBe("image/jpeg");
	});

	test("speech media is marked transcribable; silent media is not", () => {
		expect(
			mediaFromMessage({ voice: { file_id: "v", file_unique_id: "u" } })!.transcribable,
		).toBe(true);
		expect(
			mediaFromMessage({ audio: { file_id: "a", file_unique_id: "u" } })!.transcribable,
		).toBe(true);
		expect(
			mediaFromMessage({ video_note: { file_id: "n", file_unique_id: "u" } })!
				.transcribable,
		).toBe(true);
		expect(
			mediaFromMessage({
				document: { file_id: "d", file_unique_id: "u", mime_type: "audio/flac" },
			})!.transcribable,
		).toBe(true);
		expect(
			mediaFromMessage({
				document: { file_id: "d", file_unique_id: "u", mime_type: "application/pdf" },
			})!.transcribable,
		).toBe(false);
		// Plain video and GIFs might have no audio track — never offered.
		expect(
			mediaFromMessage({ video: { file_id: "vv", file_unique_id: "u" } })!.transcribable,
		).toBeUndefined();
		expect(
			mediaFromMessage({ animation: { file_id: "g", file_unique_id: "u" } })!
				.transcribable,
		).toBeUndefined();
	});
});

describe("mediaParts", () => {
	test("stores a data-attachment part — path + metadata, no payload", () => {
		const parts = mediaParts(media, { path: "/a/u1-clip.mp4", size: 7 });
		expect(parts).toHaveLength(1);
		const p = parts[0]!;
		if (p.type !== "data-attachment") throw new Error(`expected data-attachment, got ${p.type}`);
		expect(p.data).toEqual({
			path: "/a/u1-clip.mp4",
			mediaType: "video/mp4",
			filename: "clip.mp4",
			size: 7,
		});
	});

	test("a transcript rides inside the part when intake produced one", () => {
		const parts = mediaParts(media, { path: "/a/u1-clip.mp4", size: 7 }, "call me back");
		const p = parts[0]!;
		if (p.type !== "data-attachment") throw new Error(`expected data-attachment, got ${p.type}`);
		expect(p.data).toEqual({
			path: "/a/u1-clip.mp4",
			mediaType: "video/mp4",
			filename: "clip.mp4",
			size: 7,
			transcript: "call me back",
		});
	});
});

describe("saveAttachment", () => {
	test("local-mode file is copied into attachments, never fetched", async () => {
		const dir = useHome();
		const src = join(dir, "upload.bin");
		writeFileSync(src, "payload");
		const saved = await saveAttachment(
			media,
			{ file_path: src } as TgFile,
			undefined,
			"token",
		);
		expect(saved.size).toBe(7);
		expect(saved.path).toBe(join(paths.attachments(), "u1-clip.mp4"));
		expect(readFileSync(saved.path, "utf8")).toBe("payload");
	});

	test("a missing file_path fails loud", async () => {
		useHome();
		await expect(
			saveAttachment(media, {} as TgFile, undefined, "token"),
		).rejects.toThrow("no file_path");
	});
});

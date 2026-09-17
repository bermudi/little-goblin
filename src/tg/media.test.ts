import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { File as TgFile } from "grammy/types";
import { paths } from "../config.ts";
import { saveAttachment, type IncomingMedia } from "./media.ts";

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
	kind: "video",
};

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

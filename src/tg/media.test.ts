import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as fsPromises from "node:fs/promises";
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

	test("only recordings are marked transcribable; attached audio is data", () => {
		expect(mediaFromMessage({ voice: { file_id: "v", file_unique_id: "u" } })!.transcribable).toBe(
			true,
		);
		expect(
			mediaFromMessage({ video_note: { file_id: "n", file_unique_id: "u" } })!.transcribable,
		).toBe(true);
		// Attached audio — a song, a podcast — is a file, not speech.
		// Transcribing it eagerly burns provider calls on content nobody
		// asked for; the transcribe tool covers it on demand.
		expect(
			mediaFromMessage({ audio: { file_id: "a", file_unique_id: "u" } })!.transcribable,
		).toBeUndefined();
		expect(
			mediaFromMessage({
				document: { file_id: "d", file_unique_id: "u", mime_type: "audio/flac" },
			})!.transcribable,
		).toBeUndefined();
		expect(
			mediaFromMessage({
				document: { file_id: "d", file_unique_id: "u", mime_type: "application/pdf" },
			})!.transcribable,
		).toBeUndefined();
		// Plain video and GIFs might have no audio track — never offered.
		expect(
			mediaFromMessage({ video: { file_id: "vv", file_unique_id: "u" } })!.transcribable,
		).toBeUndefined();
		expect(
			mediaFromMessage({ animation: { file_id: "g", file_unique_id: "u" } })!.transcribable,
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

	test("a transcribable medium marks the part as speech", () => {
		const parts = mediaParts(
			{ ...media, transcribable: true },
			{ path: "/a/u1-clip.mp4", size: 7 },
		);
		const p = parts[0]!;
		if (p.type !== "data-attachment") throw new Error(`expected data-attachment, got ${p.type}`);
		expect((p.data as { speech?: boolean }).speech).toBe(true);
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
		const saved = await saveAttachment(media, { file_path: src } as TgFile, undefined, "token");
		expect(saved.size).toBe(7);
		expect(saved.path).toBe(join(paths.attachments(), "u1-clip.mp4"));
		expect(readFileSync(saved.path, "utf8")).toBe("payload");
	});

	test("downloaded bytes also pass through the sync boundary without contacting Telegram", async () => {
		useHome();
		const fetched = spyOn(globalThis, "fetch").mockResolvedValue(new Response("downloaded"));
		const realOpen = fsPromises.open;
		const synced: string[] = [];
		const opened = spyOn(fsPromises, "open").mockImplementation(async (path, flags, mode) => {
			const handle = await realOpen(path, flags, mode);
			const realSync = handle.sync.bind(handle);
			handle.sync = async () => {
				synced.push(
					String(path) === paths.attachments()
						? "directory"
						: String(path) === paths.workspace()
							? "workspace"
							: "temp",
				);
				await realSync();
			};
			return handle;
		});
		try {
			const saved = await saveAttachment(
				media,
				{ file_path: "cloud/file" } as TgFile,
				undefined,
				"token",
			);
			expect(readFileSync(saved.path, "utf8")).toBe("downloaded");
			expect(synced).toEqual(["workspace", "temp", "directory"]);
			expect(fetched).toHaveBeenCalledTimes(1);
		} finally {
			opened.mockRestore();
			fetched.mockRestore();
		}
	});

	test("syncs the complete temp file before rename and the directory before returning", async () => {
		const dir = useHome();
		const src = join(dir, "upload.bin");
		writeFileSync(src, "payload");
		const events: string[] = [];
		const realOpen = fsPromises.open;
		const realRename = fsPromises.rename;
		const opened = spyOn(fsPromises, "open").mockImplementation(async (path, flags, mode) => {
			const handle = await realOpen(path, flags, mode);
			const kind =
				String(path) === paths.attachments()
					? "directory"
					: String(path) === paths.workspace()
						? "workspace"
						: "temp";
			const realSync = handle.sync.bind(handle);
			handle.sync = async () => {
				events.push(`sync:${kind}`);
				await realSync();
			};
			return handle;
		});
		const renamed = spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
			events.push("rename");
			await realRename(from, to);
		});
		try {
			const saved = await saveAttachment(media, { file_path: src } as TgFile, undefined, "token");
			expect(readFileSync(saved.path, "utf8")).toBe("payload");
			expect(events).toEqual(["sync:workspace", "sync:temp", "rename", "sync:directory"]);
		} finally {
			opened.mockRestore();
			renamed.mockRestore();
		}
	});

	test("a new attachments directory needs its parent synced before any file is published", async () => {
		const dir = useHome();
		const src = join(dir, "upload.bin");
		writeFileSync(src, "payload");
		const realOpen = fsPromises.open;
		const opened = spyOn(fsPromises, "open").mockImplementation(async (path, flags, mode) => {
			const handle = await realOpen(path, flags, mode);
			if (String(path) === paths.workspace()) {
				handle.sync = async () => {
					throw new Error("parent I/O failure");
				};
			}
			return handle;
		});
		try {
			await expect(
				saveAttachment(media, { file_path: src } as TgFile, undefined, "token"),
			).rejects.toThrow("attachment parent directory sync failed");
		} finally {
			opened.mockRestore();
		}
		expect(readdirSync(paths.attachments())).toEqual([]);
	});

	test("temp sync failure rejects without replacing the previous attachment", async () => {
		const dir = useHome();
		const src = join(dir, "upload.bin");
		writeFileSync(src, "replacement");
		mkdirSync(paths.attachments(), { recursive: true });
		const dest = join(paths.attachments(), "u1-clip.mp4");
		writeFileSync(dest, "previous");
		const realOpen = fsPromises.open;
		const opened = spyOn(fsPromises, "open").mockImplementation(async (path, flags, mode) => {
			const handle = await realOpen(path, flags, mode);
			if (String(path) !== paths.workspace()) {
				handle.sync = async () => {
					throw new Error("disk I/O failure token");
				};
			}
			return handle;
		});
		try {
			const failure: unknown = await saveAttachment(
				media,
				{ file_path: src } as TgFile,
				undefined,
				"token",
			).catch((err: unknown) => err);
			expect(failure).toBeInstanceOf(Error);
			if (!(failure instanceof Error)) throw new Error("expected sync failure");
			expect(failure.message).toContain("telegram attachment file sync failed");
			expect(failure.message).toContain("disk I/O failure");
			expect(failure.message).not.toContain("token");
		} finally {
			opened.mockRestore();
		}
		expect(readFileSync(dest, "utf8")).toBe("previous");
		expect(readdirSync(paths.attachments())).toEqual(["u1-clip.mp4"]);
	});

	test("directory sync failure rejects after rename without removing the destination", async () => {
		const dir = useHome();
		const src = join(dir, "upload.bin");
		writeFileSync(src, "replacement");
		mkdirSync(paths.attachments(), { recursive: true });
		const dest = join(paths.attachments(), "u1-clip.mp4");
		writeFileSync(dest, "previous");
		const realOpen = fsPromises.open;
		const opened = spyOn(fsPromises, "open").mockImplementation(async (path, flags, mode) => {
			const handle = await realOpen(path, flags, mode);
			if (String(path) === paths.attachments()) {
				handle.sync = async () => {
					throw new Error("directory I/O failure");
				};
			}
			return handle;
		});
		try {
			await expect(
				saveAttachment(media, { file_path: src } as TgFile, undefined, "token"),
			).rejects.toThrow("telegram attachment directory sync failed");
		} finally {
			opened.mockRestore();
		}
		expect(readFileSync(dest, "utf8")).toBe("replacement");
		expect(readdirSync(paths.attachments())).toEqual(["u1-clip.mp4"]);
	});

	test("failed partial local copy preserves the previous attachment and removes temp", async () => {
		const dir = useHome();
		const src = join(dir, "upload.bin");
		writeFileSync(src, "replacement");
		mkdirSync(paths.attachments(), { recursive: true });
		const dest = join(paths.attachments(), "u1-clip.mp4");
		const previous = Buffer.from([0, 1, 2, 255]);
		writeFileSync(dest, previous);
		const copy = spyOn(fsPromises, "copyFile").mockImplementation(async (_src, temp) => {
			writeFileSync(temp, "partial");
			throw new Error("copy interrupted");
		});
		try {
			await expect(
				saveAttachment(media, { file_path: src } as TgFile, undefined, "token"),
			).rejects.toThrow("copy interrupted");
		} finally {
			copy.mockRestore();
		}
		expect(readFileSync(dest)).toEqual(previous);
		expect(readdirSync(paths.attachments())).toEqual(["u1-clip.mp4"]);
	});

	test("successful replay atomically replaces the previous local attachment", async () => {
		const dir = useHome();
		const src = join(dir, "upload.bin");
		writeFileSync(src, "replacement");
		mkdirSync(paths.attachments(), { recursive: true });
		const dest = join(paths.attachments(), "u1-clip.mp4");
		writeFileSync(dest, "previous");
		const saved = await saveAttachment(media, { file_path: src } as TgFile, undefined, "token");
		expect(saved).toEqual({ path: dest, size: 11 });
		expect(readFileSync(dest, "utf8")).toBe("replacement");
		expect(readdirSync(paths.attachments())).toEqual(["u1-clip.mp4"]);
	});

	test("rejects a unique id that could escape the attachments directory", async () => {
		useHome();
		await expect(
			saveAttachment(
				{ ...media, fileUniqueId: "../escape" },
				{ file_path: "/not-read" } as TgFile,
				undefined,
				"token",
			),
		).rejects.toThrow();
		expect(existsSync(paths.attachments())).toBe(false);
	});

	test("a missing file_path fails loud", async () => {
		useHome();
		await expect(saveAttachment(media, {} as TgFile, undefined, "token")).rejects.toThrow(
			"no file_path",
		);
	});
});

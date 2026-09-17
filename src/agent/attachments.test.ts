import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UIMessage } from "ai";
import {
	acceptsMedia,
	attachmentPart,
	ATTACHMENT_PART,
	materializeAttachments,
} from "./attachments.ts";

let dirs: string[] = [];
function tmpdir_(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-att-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

describe("acceptsMedia", () => {
	test("media types map to their own modality; documents need file or pdf", () => {
		expect(acceptsMedia(new Set(["text", "image"]), "image/webp")).toBe(true);
		expect(acceptsMedia(new Set(["text"]), "image/jpeg")).toBe(false);
		expect(acceptsMedia(new Set(["audio"]), "audio/ogg")).toBe(true);
		expect(acceptsMedia(new Set(["video"]), "video/mp4")).toBe(true);
		// a generic "file" modality covers documents, not images
		expect(acceptsMedia(new Set(["file"]), "application/pdf")).toBe(true);
		expect(acceptsMedia(new Set(["file"]), "image/png")).toBe(false);
		expect(acceptsMedia(new Set(["pdf"]), "application/pdf")).toBe(true);
		expect(acceptsMedia(new Set(["pdf"]), "application/zip")).toBe(false);
	});
});

const msg = (path: string, size = 4): UIMessage => ({
	id: "u1",
	role: "user",
	parts: [attachmentPart({ path, mediaType: "image/png", filename: "x.png", size })],
});

describe("materializeAttachments", () => {
	test("a capable model gets the file part with the payload inline", async () => {
		const dir = tmpdir_();
		const f = join(dir, "x.png");
		writeFileSync(f, "pngdata");
		const out = await materializeAttachments([msg(f)], new Set(["text", "image"]));
		const p = out[0]!.parts[0]!;
		expect(p.type).toBe("file");
		expect((p as { mediaType: string }).mediaType).toBe("image/png");
		expect((p as { url: string }).url).toBe(
			`data:image/png;base64,${Buffer.from("pngdata").toString("base64")}`,
		);
	});

	test("an incapable model gets the path reference instead", async () => {
		const dir = tmpdir_();
		const f = join(dir, "x.png");
		writeFileSync(f, "pngdata");
		const out = await materializeAttachments([msg(f)], new Set(["text"]));
		const p = out[0]!.parts[0]!;
		expect(p.type).toBe("text");
		expect((p as { text: string }).text).toContain(f);
	});

	test("a missing attachment file degrades to the path reference", async () => {
		const out = await materializeAttachments(
			[msg(join(tmpdir_(), "gone.png"))],
			new Set(["text", "image"]),
		);
		expect(out[0]!.parts[0]!.type).toBe("text");
	});

	test("non-attachment parts pass through untouched", async () => {
		const m: UIMessage = { id: "u2", role: "user", parts: [{ type: "text", text: "hi" }] };
		const out = await materializeAttachments([m], new Set(["image"]));
		expect(out[0]!.parts[0]).toEqual({ type: "text", text: "hi" });
	});

	test(`${ATTACHMENT_PART} round-trips through stored JSON shape`, async () => {
		// The stored part is plain JSON — what comes back from SQLite must
		// materialize the same way as the in-memory object.
		const dir = tmpdir_();
		const f = join(dir, "x.png");
		writeFileSync(f, "pngdata");
		const stored = JSON.parse(JSON.stringify(msg(f))) as UIMessage;
		const out = await materializeAttachments([stored], new Set(["image"]));
		expect(out[0]!.parts[0]!.type).toBe("file");
	});
});

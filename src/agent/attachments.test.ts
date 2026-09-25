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

	test("a non-ENOENT read failure degrades to the path reference too", async () => {
		// A directory stats fine but readFile throws EISDIR — the error
		// must degrade, not crash the turn.
		const out = await materializeAttachments([msg(tmpdir_())], new Set(["text", "image"]));
		expect(out[0]!.parts[0]!.type).toBe("text");
	});

	test("a file that grew past the cap since intake degrades to the path reference", async () => {
		const dir = tmpdir_();
		const f = join(dir, "x.png");
		writeFileSync(f, "x".repeat(64));
		// ref.size says 4 — the recorded size is not authoritative.
		const out = await materializeAttachments([msg(f)], new Set(["image"]), 16);
		expect(out[0]!.parts[0]!.type).toBe("text");
	});

	test("each item is judged alone — no shared budget between attachments", async () => {
		const dir = tmpdir_();
		const a = join(dir, "a.png");
		const b = join(dir, "b.png");
		writeFileSync(a, "12345678");
		writeFileSync(b, "12345678");
		const m: UIMessage = {
			id: "u4",
			role: "user",
			parts: [
				attachmentPart({ path: a, mediaType: "image/png", filename: "a.png", size: 8 }),
				attachmentPart({ path: b, mediaType: "image/png", filename: "b.png", size: 8 }),
			],
		};
		// Two items over the old whole-turn budget (16 with cap 10) — both
		// fit the per-item cap, so both inline. Cross-item budgets would
		// re-decide old parts when new ones arrive; that's the bug this
		// replaced.
		const out = await materializeAttachments([m], new Set(["image"]), 10);
		expect(out[0]!.parts[0]!.type).toBe("file");
		expect(out[0]!.parts[1]!.type).toBe("file");
	});

	test("an over-cap item degrades while a small one inlines — decisions are independent", async () => {
		const dir = tmpdir_();
		const old = join(dir, "old.png");
		const fresh = join(dir, "fresh.png");
		writeFileSync(old, "x".repeat(64));
		writeFileSync(fresh, "12345678");
		const history: UIMessage[] = [
			{
				id: "u-old",
				role: "user",
				parts: [attachmentPart({ path: old, mediaType: "image/png", filename: "old.png", size: 64 })],
			},
			{
				id: "u-new",
				role: "user",
				parts: [attachmentPart({ path: fresh, mediaType: "image/png", filename: "fresh.png", size: 8 })],
			},
		];
		const out = await materializeAttachments(history, new Set(["image"]), 16);
		expect(out[1]!.parts[0]!.type).toBe("file");
		expect(out[0]!.parts[0]!.type).toBe("text");
	});

	test("cache stability — adding attachments never changes how old ones materialize", async () => {
		const dir = tmpdir_();
		const a = join(dir, "a.png");
		const b = join(dir, "b.png");
		writeFileSync(a, "pngdata");
		writeFileSync(b, "pngdata");
		const turn1: UIMessage[] = [msg(a)];
		const turn2: UIMessage[] = [
			...turn1,
			{ id: "u2", role: "user", parts: [attachmentPart({ path: b, mediaType: "image/png", filename: "b.png", size: 7 })] },
		];
		const run1 = await materializeAttachments(turn1, new Set(["image"]));
		const run2 = await materializeAttachments(turn2, new Set(["image"]));
		// The old message renders byte-identically whether or not a new
		// attachment exists — the provider prefix stays cacheable.
		expect(JSON.stringify(run2[0])).toBe(JSON.stringify(run1[0]));
		// And repeated materialization of the same snapshot is identical —
		// the same history must produce the same request bytes every turn.
		const rerun = await materializeAttachments(turn2, new Set(["image"]));
		expect(JSON.stringify(rerun)).toBe(JSON.stringify(run2));
	});

	test("non-attachment parts pass through untouched", async () => {
		const m: UIMessage = { id: "u2", role: "user", parts: [{ type: "text", text: "hi" }] };
		const out = await materializeAttachments([m], new Set(["image"]));
		expect(out[0]!.parts[0]).toEqual({ type: "text", text: "hi" });
	});

	test("a malformed attachment part degrades to the fallback reference", async () => {
		const bad: UIMessage = {
			id: "u3",
			role: "user",
			parts: [{ type: ATTACHMENT_PART, data: { path: 123 } }],
		};
		const out = await materializeAttachments([bad], new Set(["image"]));
		expect(out[0]!.parts[0]!.type).toBe("text");
	});

	test("a model that can't consume audio gets the transcript, not the bare path", async () => {
		const dir = tmpdir_();
		const f = join(dir, "v.ogg");
		writeFileSync(f, "oggdata");
		const m: UIMessage = {
			id: "u9",
			role: "user",
			parts: [
				attachmentPart({
					path: f,
					mediaType: "audio/ogg",
					filename: "v.ogg",
					size: 7,
					transcript: "call me back",
				}),
			],
		};
		const out = await materializeAttachments([m], new Set(["text"]));
		const p = out[0]!.parts[0]!;
		expect(p.type).toBe("text");
		expect((p as { text: string }).text).toContain("call me back");
	});

	test("an audio-capable model still gets the file part for a recording", async () => {
		const dir = tmpdir_();
		const f = join(dir, "v.ogg");
		writeFileSync(f, "oggdata");
		const m: UIMessage = {
			id: "u10",
			role: "user",
			parts: [
				attachmentPart({
					path: f,
					mediaType: "audio/ogg",
					filename: "v.ogg",
					size: 7,
					transcript: "call me back",
					speech: true,
				}),
			],
		};
		const out = await materializeAttachments([m], new Set(["text", "audio"]));
		expect(out[0]!.parts[0]!.type).toBe("file");
	});

	test("attached audio never inlines — a hearing model gets the path, not a song's bytes", async () => {
		const dir = tmpdir_();
		const f = join(dir, "song.mp3");
		writeFileSync(f, "mp3data");
		const m: UIMessage = {
			id: "u12",
			role: "user",
			parts: [
				attachmentPart({
					path: f,
					mediaType: "audio/mpeg",
					filename: "song.mp3",
					size: 7,
				}),
			],
		};
		const out = await materializeAttachments([m], new Set(["text", "audio"]));
		const p = out[0]!.parts[0]!;
		expect(p.type).toBe("text");
		expect((p as { text: string }).text).toContain(f);
	});

	test("the transcript also beats the path when the payload doesn't fit", async () => {
		const dir = tmpdir_();
		const f = join(dir, "v.ogg");
		writeFileSync(f, "x".repeat(64));
		const m: UIMessage = {
			id: "u11",
			role: "user",
			parts: [
				attachmentPart({
					path: f,
					mediaType: "audio/ogg",
					filename: "v.ogg",
					size: 64,
					transcript: "call me back",
				}),
			],
		};
		// Capable model, but the file can't fit the per-item cap — the
		// transcript is still the better answer than a bare path.
		const out = await materializeAttachments([m], new Set(["audio"]), 16);
		const p = out[0]!.parts[0]!;
		expect(p.type).toBe("text");
		expect((p as { text: string }).text).toContain("call me back");
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

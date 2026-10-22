import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UIMessage, UIMessageChunk } from "ai";
import { ATTACHMENT_PART, type AttachmentRef } from "./agent/attachments.ts";
import { appMediaSink } from "./app-media.ts";
import { paths } from "./config.ts";
import { FencedError } from "./runtime.ts";
import { useHome } from "./testkit.ts";

function fixture() {
	const home = useHome("goblin-media-");
	const appended: { messages: UIMessage[]; anchorSeq: number | null | undefined }[] = [];
	const emitted: UIMessageChunk[] = [];
	const sink = appMediaSink(
		"app/media",
		{
			append: (messages, opts) => {
				appended.push({ messages, anchorSeq: opts.anchorSeq });
			},
		},
		(chunk) => emitted.push(chunk),
	);
	return { home, sink, appended, emitted };
}

function attachmentOf(message: UIMessage | undefined): AttachmentRef {
	const part = message?.parts[0] as { type: string; data: AttachmentRef } | undefined;
	expect(part?.type).toBe(ATTACHMENT_PART);
	return part!.data;
}

describe("app media sink", () => {
	test("send_file persists bytes, anchors the record, and emits the same ref live", async () => {
		const { home, sink, appended, emitted } = fixture();
		const source = join(home, "out", "note.txt");
		mkdirSync(join(home, "out"), { recursive: true });
		writeFileSync(source, "file-bytes");
		sink.setAuthorityCheck?.(() => true, 7);

		await sink.onFile!({ path: source, filename: "note.txt", caption: "keepsake" });

		expect(appended).toHaveLength(1);
		expect(appended[0]!.anchorSeq).toBe(7);
		const message = appended[0]!.messages[0]!;
		expect(message.role).toBe("assistant");
		const ref = attachmentOf(message);
		expect(ref.filename).toBe("note.txt");
		expect(ref.mediaType).toMatch(/^text\/plain/);
		expect(readFileSync(ref.path, "utf8")).toBe("file-bytes");
		expect((message.parts[1] as { type: string; text: string }).text).toBe("keepsake");
		expect(emitted).toEqual([{ type: ATTACHMENT_PART, data: ref } as UIMessageChunk]);
	});

	test("a voice note persists as playable audio", async () => {
		const { sink, appended, emitted } = fixture();
		sink.setAuthorityCheck?.(() => true, 3);

		await sink.onVoiceNote!(new Uint8Array([1, 2, 3]));

		const ref = attachmentOf(appended[0]!.messages[0]);
		expect(ref.filename).toBe("voice-note.ogg");
		expect(ref.mediaType).toBe("audio/ogg");
		expect(ref.size).toBe(3);
		expect([...readFileSync(ref.path)]).toEqual([1, 2, 3]);
		expect(emitted).toEqual([{ type: ATTACHMENT_PART, data: ref } as UIMessageChunk]);
	});

	test("a file already in the managed store is referenced, not copied", async () => {
		const { sink, appended } = fixture();
		mkdirSync(paths.attachments(), { recursive: true });
		const managed = join(paths.attachments(), "managed.txt");
		writeFileSync(managed, "already stored");
		sink.setAuthorityCheck?.(() => true, 9);

		await sink.onFile!({ path: managed, filename: "managed.txt" });

		expect(attachmentOf(appended[0]!.messages[0]).path).toBe(managed);
		expect(readdirSync(paths.attachments())).toEqual(["managed.txt"]);
	});

	test("a fence after copying removes the new copy and records nothing", async () => {
		const { home, sink, appended, emitted } = fixture();
		const source = join(home, "out.txt");
		writeFileSync(source, "copied");
		let checks = 0;
		sink.setAuthorityCheck?.(() => checks++ === 0, 7);

		await expect(sink.onFile!({ path: source, filename: "out.txt" })).rejects.toThrow(FencedError);

		expect(appended).toEqual([]);
		expect(emitted).toEqual([]);
		expect(readdirSync(paths.attachments())).toEqual([]);
	});

	test("a fence after voice persistence removes the new audio file", async () => {
		const { sink, appended, emitted } = fixture();
		let checks = 0;
		sink.setAuthorityCheck?.(() => checks++ === 0, 7);

		await expect(sink.onVoiceNote!(new Uint8Array([4]))).rejects.toThrow(FencedError);

		expect(appended).toEqual([]);
		expect(emitted).toEqual([]);
		expect(readdirSync(paths.attachments())).toEqual([]);
	});

	test("a failed history append cleans only the newly-created copy", async () => {
		const home = useHome("goblin-media-");
		const source = join(home, "out.txt");
		writeFileSync(source, "copied");
		mkdirSync(paths.attachments(), { recursive: true });
		const managed = join(paths.attachments(), "managed.txt");
		writeFileSync(managed, "stored");
		const sink = appMediaSink("app/media", {
			append: () => {
				throw new Error("history wedged");
			},
		});
		sink.setAuthorityCheck?.(() => true, 7);

		await expect(sink.onFile!({ path: source, filename: "out.txt" })).rejects.toThrow(
			"history wedged",
		);
		await expect(sink.onFile!({ path: managed, filename: "managed.txt" })).rejects.toThrow(
			"history wedged",
		);

		expect(readdirSync(paths.attachments())).toEqual(["managed.txt"]);
		expect(readFileSync(managed, "utf8")).toBe("stored");
	});
});

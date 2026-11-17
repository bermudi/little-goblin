import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message, MessageChunk } from "./message.ts";
import { ATTACHMENT_PART, type AttachmentRef } from "./agent/attachments.ts";
import { appMediaSink, composeTurnSinks } from "./app-media.ts";
import { paths } from "./home-layout.ts";
import { FencedError } from "./runtime.ts";

import { useHome } from "./testkit.ts";

function fixture() {
	const home = useHome("goblin-media-");
	const appended: { messages: Message[]; anchorSeq: number | null | undefined }[] = [];
	const emitted: MessageChunk[] = [];
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

function attachmentOf(message: Message | undefined): AttachmentRef {
	const part = message?.parts[0] as { type: string; data: AttachmentRef } | undefined;
	expect(part?.type).toBe(ATTACHMENT_PART);
	return part!.data;
}

describe("app media sink", () => {
	test("fan-out declares streaming when any child streams and forwards only there", () => {
		const chunks: MessageChunk[] = [];
		const streaming = {
			delivery: "stream" as const,
			onTextDelta() {},
			onReasoningDelta() {},
			onToolCall() {},
			onStreamChunk: (chunk: MessageChunk) => chunks.push(chunk),
			onDone() {},
		};
		const headless = {
			delivery: "headless" as const,
			onTextDelta() {},
			onReasoningDelta() {},
			onToolCall() {},
			onDone() {},
		};
		const fanout = composeTurnSinks(streaming, headless);
		const chunk = { type: "start", messageId: "m1" } as MessageChunk;
		expect(fanout.delivery).toBe("stream");
		if (fanout.delivery === "stream") fanout.onStreamChunk(chunk);
		expect(chunks).toEqual([chunk]);
	});

	test("headless fan-out has no chunk callback", () => {
		const headless = () => ({
			delivery: "headless" as const,
			onTextDelta() {},
			onReasoningDelta() {},
			onToolCall() {},
			onDone() {},
		});
		const fanout = composeTurnSinks(headless(), headless());
		expect(fanout.delivery).toBe("headless");
		expect("onStreamChunk" in fanout).toBe(false);
	});

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
		expect(emitted).toEqual([{ type: ATTACHMENT_PART, data: ref } as MessageChunk]);
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
		expect(emitted).toEqual([{ type: ATTACHMENT_PART, data: ref } as MessageChunk]);
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

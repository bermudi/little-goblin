import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api } from "grammy";
import type { Conversation } from "../conversation.ts";
import {
	isNotModifiedError,
	makeDeliverySink,
	recentReplyText,
	SPEAK_CALLBACK,
} from "./delivery.ts";

const CHUNK = 3800;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const conv: Conversation = {
	id: "dm:1",
	chatId: 1,
	threadId: null,
	title: null,
	titleImplicit: false,
	model: null,
	thinking: null,
	voice: false,
	epoch: 0,
	createdAt: "",
};

// Fake the Telegram API at the edge. `gate` holds sends while set.
function fakeApi(opts: { gate?: { current: Promise<void> | null }; failSends?: boolean }) {
	const msgs: string[] = [];
	const voices: number[] = [];
	const reactions: Array<{ chat: number; id: number; emoji: string }> = [];
	const markups: unknown[] = [];
	const api = {
		sendChatAction: () => Promise.resolve(true),
		sendMessage: async (_chat: number, text: string) => {
			if (opts.gate?.current) await opts.gate.current;
			if (opts.failSends) throw new Error("sendMessage failed");
			msgs.push(text);
			return { message_id: msgs.length };
		},
		editMessageText: async (_chat: number, id: number, text: string) => {
			msgs[id - 1] = text;
			return true;
		},
		sendVoice: async () => {
			voices.push(voices.length + 1);
			return { message_id: 100 + voices.length };
		},
		editMessageReplyMarkup: async (_chat: number, _id: number, markup: unknown) => {
			markups.push(markup);
			return true;
		},
		setMessageReaction: async (
			chat: number,
			id: number,
			reaction: Array<{ type: string; emoji: string }>,
		) => {
			reactions.push({ chat, id, emoji: reaction[0]!.emoji });
			return true;
		},
	} as unknown as Api;
	return { api, msgs, voices, reactions, markups };
}

describe("delivery", () => {
	test("short reply → one message, edited in place", async () => {
		const { api, msgs } = fakeApi({});
		const sink = makeDeliverySink(api, conv, undefined, 0);
		sink.onTextDelta("hello");
		await sleep(0);
		sink.onTextDelta(" world");
		await sink.onDone({ kind: "completed" });
		expect(msgs).toEqual(["hello world"]);
	});

	test("a chunk sent early is patched when its window fills — nothing dropped", async () => {
		const gate: { current: Promise<void> | null } = { current: null };
		const { api, msgs } = fakeApi({ gate });
		const sink = makeDeliverySink(api, conv, undefined, 0);

		sink.onTextDelta("a".repeat(CHUNK)); // → send msg1
		await sleep(0);
		expect(msgs).toEqual(["a".repeat(CHUNK)]);

		// msg2 sends with a partial window; hold it in flight.
		let release: () => void = () => {};
		gate.current = new Promise<void>((r) => {
			release = r;
		});
		sink.onTextDelta("b".repeat(100));
		await sleep(0);
		expect(msgs.length).toBe(1); // msg2 send still in flight

		// Output grows past the boundary while msg2 is in flight.
		sink.onTextDelta("b".repeat(CHUNK));
		gate.current = null;
		release();
		await sink.onDone({ kind: "completed" });

		// msg2 must be patched to its full window, not left short —
		// otherwise the slice between what it showed and the boundary is
		// dropped silently.
		expect(msgs).toEqual([
			"a".repeat(CHUNK),
			"b".repeat(CHUNK),
			"b".repeat(100),
		]);
	});

	test("failed send at final flush is retried, not dropped", async () => {
		let calls = 0;
		const msgs: string[] = [];
		const api = {
			sendChatAction: () => Promise.resolve(true),
			sendMessage: async (_chat: number, text: string) => {
				calls++;
				if (calls === 1) throw new Error("transient failure");
				msgs.push(text);
				return { message_id: msgs.length };
			},
			editMessageText: () => Promise.resolve(true),
		} as unknown as Api;
		const sink = makeDeliverySink(api, conv, undefined, 0);
		sink.onTextDelta("tail");
		// First send fails inside onDone's flush; the drain retries it.
		await sink.onDone({ kind: "completed" });
		expect(msgs).toEqual(["tail"]);
	});

	test("a surrogate pair is never split across the chunk boundary", async () => {
		const { api, msgs } = fakeApi({});
		const sink = makeDeliverySink(api, conv, undefined, 0);
		// 😀 is one code point but two UTF-16 units — placed so the naive
		// 3800-unit cut lands inside the pair.
		const emoji = "\u{1f600}";
		sink.onTextDelta("a".repeat(CHUNK - 1) + emoji + "b".repeat(50));
		await sink.onDone({ kind: "completed" });
		expect(msgs[0]).toBe("a".repeat(CHUNK - 1));
		expect(msgs[1]).toBe(emoji + "b".repeat(50));
	});

	test("a seam computed against the status tail re-seats when status changes", async () => {
		const { api, msgs } = fakeApi({});
		const sink = makeDeliverySink(api, conv, undefined, 0);
		// First send goes out before the status tail exists; the tool call
		// then pushes body past CHUNK, so the seam is computed against
		// status chars, which are still provisional.
		sink.onTextDelta("a".repeat(3791));
		sink.onToolCall("t", { path: "pppppp" });
		await sleep(0);
		expect(msgs).toEqual(["a".repeat(3791)]);

		// Five more tool calls push that entry out of the last-5 status
		// window; the new first entry puts a surrogate pair exactly on the
		// seam. The sent chunk must be re-edited and the pair must land
		// intact in the next message — not split, dropped, or duplicated.
		sink.onToolCall("t", { path: "\u{1f600}" });
		for (let i = 0; i < 4; i++) sink.onToolCall("t", { path: "p" });
		await sink.onDone({ kind: "completed" });
		expect(msgs[1]!.startsWith("\u{1f600}")).toBe(true);
		expect(msgs.join("")).toBe(
			"a".repeat(3791) + "\n\n—\n⚙ t \u{1f600}" + "\n⚙ t p".repeat(4),
		);
	});

	test("a failed final edit is retried by the drain, not declared done", async () => {
		let edits = 0;
		const msgs: string[] = [];
		const api = {
			sendChatAction: () => Promise.resolve(true),
			sendMessage: async (_chat: number, text: string) => {
				msgs.push(text);
				return { message_id: msgs.length };
			},
			editMessageText: async (_chat: number, id: number, text: string) => {
				edits++;
				// Two transient failures — the drain must keep retrying a
				// stale shown window, not exit on zero unsent sends.
				if (edits <= 2) throw new Error("transient edit failure");
				msgs[id - 1] = text;
				return true;
			},
		} as unknown as Api;
		const sink = makeDeliverySink(api, conv, undefined, 0);
		sink.onTextDelta("a".repeat(3791));
		await sleep(0);
		expect(msgs).toEqual(["a".repeat(3791)]);
		// The error status entry lands at done time, so the seam under
		// msg1 moves only in the final flush — its edit fails twice and
		// the drain has to come back for it.
		await sink.onDone({ kind: "error", message: "boom" });
		expect(msgs.join("")).toBe("a".repeat(3791) + "\n\n—\n⚠ boom");
	});

	test("a chunk edited to the empty-window ellipsis is not re-edited", async () => {
		let ellipsisEdits = 0;
		const msgs: string[] = [];
		const api = {
			sendChatAction: () => Promise.resolve(true),
			sendMessage: async (_chat: number, text: string) => {
				msgs.push(text);
				return { message_id: msgs.length };
			},
			editMessageText: async (_chat: number, id: number, text: string) => {
				if (text === "…") ellipsisEdits++;
				msgs[id - 1] = text;
				return true;
			},
		} as unknown as Api;
		const sink = makeDeliverySink(api, conv, undefined, 0);
		// Two long status entries (the hint caps at 60 chars) push the body
		// past the chunk limit, so a second message goes out showing the
		// tail.
		sink.onTextDelta("a".repeat(3700));
		sink.onToolCall("t", { path: "p".repeat(200) });
		sink.onToolCall("t", { path: "p".repeat(200) });
		await sleep(0);
		// Tiny entries roll the long ones out of the last-5 window — the
		// tail shrinks back under the limit and msg2's window empties.
		for (let i = 0; i < 6; i++) sink.onToolCall("t", { path: "p" });
		await sink.onDone({ kind: "completed" });
		expect(msgs[1]).toBe("…");
		// shown already holds "…" — comparing against the rendered value
		// means later flushes see no diff. Each would re-edit otherwise.
		expect(ellipsisEdits).toBe(1);
	});

	test("permanently failing sends don't make onDone throw", async () => {
		const { api } = fakeApi({ failSends: true });
		const sink = makeDeliverySink(api, conv, undefined, 0);
		sink.onTextDelta("lost");
		await expect(sink.onDone({ kind: "completed" })).resolves.toBeUndefined();
	});

	test("completed turn reacts 🫡 on the last bubble", async () => {
		const { api, msgs, reactions } = fakeApi({});
		const sink = makeDeliverySink(api, conv, undefined, 0);
		sink.onTextDelta("a".repeat(CHUNK)); // msg1
		sink.onTextDelta("tail"); // msg2
		await sink.onDone({ kind: "completed" });
		expect(msgs.length).toBe(2);
		expect(reactions).toEqual([{ chat: 1, id: 2, emoji: "🫡" }]);
	});

	test("error turn gets no reaction", async () => {
		const { api, reactions } = fakeApi({});
		const sink = makeDeliverySink(api, conv, undefined, 0);
		sink.onTextDelta("partial");
		await sink.onDone({ kind: "error", message: "boom" });
		expect(reactions).toEqual([]);
	});

	test("configured text delivery stamps a speak button and remembers the whole reply", async () => {
		const { api, markups } = fakeApi({});
		const sink = makeDeliverySink(api, conv, undefined, 0, {
			voiceMode: false,
			synthesize: async () => [],
		});
		sink.onTextDelta("whole reply");
		await sink.onDone({ kind: "completed" });
		expect(markups).toEqual([
			{ reply_markup: { inline_keyboard: [[{ text: "🔊", callback_data: SPEAK_CALLBACK }]] } },
		]);
		expect(recentReplyText(1, 1)).toBe("whole reply");
	});

	test("voice mode skips streamed text and sends synthesized ogg chunks", async () => {
		const { api, msgs, voices } = fakeApi({});
		const spoken: string[] = [];
		const sink = makeDeliverySink(api, conv, undefined, 0, {
			voiceMode: true,
			synthesize: async (text) => {
				spoken.push(text);
				return [new Uint8Array([1]), new Uint8Array([2])];
			},
		});
		sink.onTextDelta("**hello**");
		await sink.onDone({ kind: "completed" });
		expect(msgs).toEqual([]);
		expect(spoken).toEqual(["hello"]);
		expect(voices).toHaveLength(2);
	});

	test("an epoch change during synthesis fences the voice reply", async () => {
		const { api, msgs, voices } = fakeApi({});
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let authoritative = true;
		const sink = makeDeliverySink(api, conv, undefined, 0, {
			voiceMode: true,
			synthesize: async () => {
				await gate;
				return [new Uint8Array([1])];
			},
		});
		sink.setAuthorityCheck?.(() => authoritative);
		sink.onTextDelta("hello");
		const done = sink.onDone({ kind: "completed" });
		authoritative = false;
		release();
		await done;
		expect(msgs).toEqual([]);
		expect(voices).toEqual([]);
	});

	test("a benign 'message is not modified' edit counts as success — 🫡 still lands", async () => {
		const msgs: string[] = [];
		const reactions: Array<{ id: number; emoji: string }> = [];
		const api = {
			sendChatAction: () => Promise.resolve(true),
			sendMessage: async (_chat: number, text: string) => {
				msgs.push(text);
				return { message_id: msgs.length };
			},
			editMessageText: async () => {
				// Telegram 400 when the edit changes nothing — must not
				// wedge the drain or skip the end-marker reaction.
				throw new Error(
					"Call to 'editMessageText' failed! (400: Bad Request: message is not modified)",
				);
			},
			setMessageReaction: async (_chat: number, id: number, reaction: Array<{ emoji: string }>) => {
				reactions.push({ id, emoji: reaction[0]!.emoji });
				return true;
			},
		} as unknown as Api;
		const sink = makeDeliverySink(api, conv, undefined, 0);
		sink.onTextDelta("a".repeat(3791));
		await sleep(0);
		expect(msgs).toEqual(["a".repeat(3791)]);
		// The tool status tail moves msg1's window at done time — its edit
		// hits the benign 400, which must clear as success instead of
		// stagnating the drain and skipping the 🫡.
		sink.onToolCall("t", { path: "p" });
		await sink.onDone({ kind: "completed" });
		expect(reactions).toEqual([{ id: 1, emoji: "🫡" }]);
	});

	test("overlapping speak syntheses keep independent recording indicators", async () => {
		// Parallel speak tool calls open overlapping synthesis windows on
		// one sink. A shared recording handle would orphan all but the
		// newest interval (it keeps pinging record_voice after the sink is
		// done), let a stopper clear another window's interval, and resume
		// typing while a synthesis is still live.
		const actions: string[] = [];
		const api = {
			sendChatAction: async (_chat: number, action: string) => {
				actions.push(action);
				return true;
			},
		} as unknown as Api;
		const sink = makeDeliverySink(api, conv, undefined, 0, undefined, 2);
		await sleep(3);
		expect(actions[0]).toBe("typing"); // construction's immediate ping
		expect(actions.every((a) => a === "typing")).toBe(true);

		const stopA = sink.onVoiceSynthesisStart!();
		const stopB = sink.onVoiceSynthesisStart!();
		stopB(); // B ends while A is still synthesizing
		actions.length = 0;
		await sleep(12);
		// Only A's window is live: record_voice, never typing.
		expect(actions.length).toBeGreaterThan(0);
		expect(actions.every((a) => a === "record_voice")).toBe(true);

		stopA();
		actions.length = 0;
		await sleep(12);
		// Last window closed → typing resumes.
		expect(actions).toContain("typing");

		await sink.onDone({ kind: "completed" });
		actions.length = 0;
		await sleep(12);
		// Terminal sink: no orphaned record_voice, no ghost typing.
		expect(actions).toEqual([]);
	});

	test("isNotModifiedError matches grammy 400 shapes", () => {
		expect(isNotModifiedError(new Error("400: Bad Request: message is not modified"))).toBe(true);
		expect(
			isNotModifiedError({ description: "Bad Request: message is not modified", error_code: 400 }),
		).toBe(true);
		expect(isNotModifiedError(new Error("transient edit failure"))).toBe(false);
	});
});

describe("delivery files", () => {
	function fileApi() {
		const photos: Array<{ caption?: string }> = [];
		const documents: Array<{ caption?: string }> = [];
		const api = {
			sendChatAction: () => Promise.resolve(true),
			sendMessage: async () => ({ message_id: 1 }),
			editMessageText: async () => true,
			sendPhoto: async (_chat: number, _photo: unknown, other?: { caption?: string }) => {
				photos.push({ ...(other?.caption !== undefined ? { caption: other.caption } : {}) });
				return { message_id: 10 + photos.length };
			},
			sendDocument: async (_chat: number, _doc: unknown, other?: { caption?: string }) => {
				documents.push({ ...(other?.caption !== undefined ? { caption: other.caption } : {}) });
				return { message_id: 20 + documents.length };
			},
			setMessageReaction: async () => true,
		} as unknown as Api;
		return { api, photos, documents };
	}

	function pngFile(dir: string): string {
		// Minimal PNG head: signature + IHDR dims — enough for magic sniffing.
		const head = Buffer.alloc(24);
		head.set([0x89, 0x50, 0x4e, 0x47], 0);
		head.writeUInt32BE(2, 16);
		head.writeUInt32BE(3, 20);
		const f = join(dir, "chart.png");
		writeFileSync(f, head);
		return f;
	}

	test("an image goes as a photo preview", async () => {
		const dir = mkdtempSync(join(tmpdir(), "goblin-delivery-file-"));
		try {
			const { api, photos, documents } = fileApi();
			const sink = makeDeliverySink(api, conv, undefined, 0);
			await sink.onFile!({ path: pngFile(dir), filename: "chart.png" });
			expect(photos).toHaveLength(1);
			expect(documents).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a non-image goes as a document, caption carried", async () => {
		const dir = mkdtempSync(join(tmpdir(), "goblin-delivery-file-"));
		try {
			const f = join(dir, "report.pdf");
			writeFileSync(f, "pdf-bytes");
			const { api, photos, documents } = fileApi();
			const sink = makeDeliverySink(api, conv, undefined, 0);
			await sink.onFile!({ path: f, filename: "report.pdf", caption: "here you go" });
			expect(documents).toEqual([{ caption: "here you go" }]);
			expect(photos).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("as_file forces a document even for an image", async () => {
		const dir = mkdtempSync(join(tmpdir(), "goblin-delivery-file-"));
		try {
			const { api, photos, documents } = fileApi();
			const sink = makeDeliverySink(api, conv, undefined, 0);
			await sink.onFile!({ path: pngFile(dir), filename: "chart.png", asFile: true });
			expect(documents).toHaveLength(1);
			expect(photos).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a GIF goes as a document — sendPhoto strips animation", async () => {
		const dir = mkdtempSync(join(tmpdir(), "goblin-delivery-file-"));
		try {
			const f = join(dir, "loop.gif");
			// Minimal GIF head: the "GIF8" magic is all the sniffer needs.
			writeFileSync(f, Buffer.from("GIF89a"));
			const { api, photos, documents } = fileApi();
			const sink = makeDeliverySink(api, conv, undefined, 0);
			await sink.onFile!({ path: f, filename: "loop.gif" });
			expect(documents).toHaveLength(1);
			expect(photos).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a fenced turn sends nothing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "goblin-delivery-file-"));
		try {
			const f = join(dir, "a.txt");
			writeFileSync(f, "data");
			const { api, photos, documents } = fileApi();
			const sink = makeDeliverySink(api, conv, undefined, 0);
			sink.setAuthorityCheck?.(() => false);
			await sink.onFile!({ path: f, filename: "a.txt" });
			expect(photos).toHaveLength(0);
			expect(documents).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

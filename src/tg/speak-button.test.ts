// The 🔊 button's own boundaries: the tap is answered exactly once and
// before any slow work (a late answer reads as a false failure), a
// double-tap synthesizes once, and a synthesis failure surfaces in the
// chat — not as a toast that can no longer be sent.

import { afterEach, describe, expect, test } from "bun:test";
import type { Api } from "grammy";
import { rememberReply } from "./delivery.ts";
import { handleSpeakButton, type SpeakQuery } from "./speak-button.ts";

const TTS = { kind: "edge", voice: "en-US-AriaNeural" } as const;

function query(chatId: number, messageId: number, text = "tapped bubble text"): SpeakQuery {
	return {
		id: `q-${chatId}-${messageId}`,
		message: {
			message_id: messageId,
			chat: { id: chatId },
			text,
		},
	};
}

interface ApiCall {
	method: string;
	args: unknown[];
}

function fakeApi(calls: ApiCall[]): Api {
	const rec = (method: string) =>
		((...args: unknown[]) => {
			calls.push({ method, args });
			return Promise.resolve(true);
		}) as unknown as Api[keyof Api];
	return {
		answerCallbackQuery: rec("answerCallbackQuery"),
		sendChatAction: rec("sendChatAction"),
		sendVoice: rec("sendVoice"),
		sendMessage: rec("sendMessage"),
	} as unknown as Api;
}

function answers(calls: ApiCall[]): (string | undefined)[] {
	return calls
		.filter((c) => c.method === "answerCallbackQuery")
		.map((c) => (c.args[1] as { text?: string } | undefined)?.text);
}

describe("speak button", () => {
	// Module-level in-flight/reply-cache state: distinct chat ids per test
	// keep them independent.
	let chatId = 900;
	afterEach(() => {
		chatId++;
	});

	test("answers the tap before synthesis finishes, delivers, answers once", async () => {
		const calls: ApiCall[] = [];
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let synthesized = 0;
		const p = handleSpeakButton(query(chatId, 1), {
			api: fakeApi(calls),
			tts: TTS,
			synthesize: async () => {
				synthesized++;
				await gate;
				return [new Uint8Array([1])];
			},
		});
		// While synthesis is still gated, the tap must already be answered
		// — Telegram expires queries in seconds.
		await Bun.sleep(20);
		expect(answers(calls)).toEqual([undefined]);
		release();
		await p;
		expect(synthesized).toBe(1);
		expect(calls.filter((c) => c.method === "sendVoice")).toHaveLength(1);
		// Exactly one answer for the whole interaction.
		expect(answers(calls)).toEqual([undefined]);
	});

	test("a double-tap synthesizes and delivers once", async () => {
		const calls: ApiCall[] = [];
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let synthesized = 0;
		const deps = {
			api: fakeApi(calls),
			tts: TTS,
			synthesize: async () => {
				synthesized++;
				await gate;
				return [new Uint8Array([1])];
			},
		};
		const q = query(chatId, 7);
		const first = handleSpeakButton(q, deps);
		await Bun.sleep(20); // first tap past its answer, into synthesis
		await handleSpeakButton(query(chatId, 7), deps);
		release();
		await first;
		expect(synthesized).toBe(1);
		expect(calls.filter((c) => c.method === "sendVoice")).toHaveLength(1);
		// Second tap got a toast, not a second rendering.
		expect(answers(calls)).toEqual([undefined, "already reading this reply"]);
	});

	test("synthesis failure surfaces in the chat, not as a false toast", async () => {
		const calls: ApiCall[] = [];
		await handleSpeakButton(query(chatId, 2), {
			api: fakeApi(calls),
			tts: TTS,
			synthesize: async () => {
				throw new Error("edge is down");
			},
		});
		expect(answers(calls)).toEqual([undefined]);
		const notice = calls.find((c) => c.method === "sendMessage");
		expect(notice?.args[1]).toBe("⚠ speech synthesis failed");
	});

	test("reads the cached whole reply over the tapped bubble", async () => {
		const calls: ApiCall[] = [];
		let spoken = "";
		rememberReply(chatId, 3, "the whole reply, cached");
		await handleSpeakButton(query(chatId, 3, "just the bubble"), {
			api: fakeApi(calls),
			tts: TTS,
			synthesize: async (text) => {
				spoken = text;
				return [];
			},
		});
		expect(spoken).toBe("the whole reply, cached");
	});

	test("cache miss falls back to the tapped bubble", async () => {
		const calls: ApiCall[] = [];
		let spoken = "";
		await handleSpeakButton(query(chatId, 4, "just the bubble"), {
			api: fakeApi(calls),
			tts: TTS,
			synthesize: async (text) => {
				spoken = text;
				return [];
			},
		});
		expect(spoken).toBe("just the bubble");
	});

	test("unconfigured tts is answered, nothing runs", async () => {
		const calls: ApiCall[] = [];
		let synthesized = 0;
		await handleSpeakButton(query(chatId, 5), {
			api: fakeApi(calls),
			tts: undefined,
			synthesize: async () => {
				synthesized++;
				return [];
			},
		});
		expect(answers(calls)).toEqual(["speech is not configured"]);
		expect(synthesized).toBe(0);
	});
});

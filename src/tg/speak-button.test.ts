// The 🔊 button's own boundaries: the tap is answered exactly once and
// before any slow work (a late answer reads as a false failure), a
// double-tap synthesizes once, and a synthesis failure surfaces in the
// chat — not as a toast that can no longer be sent.

import { afterEach, describe, expect, test } from "bun:test";
import { fakeApi, type RecordedCall } from "../testkit/fake-api.ts";
import { handleSpeakButton, type SpeakQuery, type SpeakButtonDeps } from "./speak-button.ts";

const TTS = { kind: "edge", voice: "en-US-AriaNeural" } as const;

// The durable lookup the real store provides; tests pre-populate the
// map to stand in for recorded deliveries.
function storeFor(replies: Record<string, string> = {}): SpeakButtonDeps["store"] {
	return {
		deliveredReplyText: (chatId, messageId) => replies[`${chatId}:${messageId}`] ?? null,
	};
}

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

function answers(calls: RecordedCall[]): (string | undefined)[] {
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
		const fake = fakeApi();
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let synthesized = 0;
		const p = handleSpeakButton(query(chatId, 1), {
			api: fake.api,
			tts: TTS,
			store: storeFor(),
			synthesize: async () => {
				synthesized++;
				await gate;
				return [new Uint8Array([1])];
			},
		});
		// While synthesis is still gated, the tap must already be answered
		// — Telegram expires queries in seconds.
		await Bun.sleep(20);
		expect(answers(fake.calls)).toEqual([undefined]);
		release();
		await p;
		expect(synthesized).toBe(1);
		expect(fake.calls.filter((c) => c.method === "sendVoice")).toHaveLength(1);
		expect(answers(fake.calls)).toEqual([undefined]);
	});

	test("a double-tap synthesizes and delivers once", async () => {
		const fake = fakeApi();
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let synthesized = 0;
		const deps = {
			api: fake.api,
			tts: TTS,
			store: storeFor(),
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
		expect(fake.calls.filter((c) => c.method === "sendVoice")).toHaveLength(1);
		// The second tap got a toast — not a second rendering.
		expect(answers(fake.calls)).toEqual([undefined, "already reading this reply"]);
	});

	test("synthesis failure surfaces in the chat, not as a false toast", async () => {
		const fake = fakeApi();
		await handleSpeakButton(query(chatId, 2), {
			api: fake.api,
			tts: TTS,
			store: storeFor(),
			synthesize: async () => {
				throw new Error("edge is down");
			},
		});
		expect(answers(fake.calls)).toEqual([undefined]);
		const notice = fake.calls.find((c) => c.method === "sendMessage");
		expect(notice?.args[1]).toBe("⚠ speech failed — check the log");
	});

	test("reads the durably recorded whole reply over the tapped bubble", async () => {
		const fake = fakeApi();
		let spoken = "";
		await handleSpeakButton(query(chatId, 3, "just the bubble"), {
			api: fake.api,
			tts: TTS,
			store: storeFor({ [`${chatId}:3`]: "the whole reply, recorded" }),
			synthesize: async (text) => {
				spoken = text;
				return [];
			},
		});
		expect(spoken).toBe("the whole reply, recorded");
	});

	test("a lookup miss speaks the tapped bubble and says the rest is gone", async () => {
		const fake = fakeApi();
		let spoken = "";
		await handleSpeakButton(query(chatId, 4, "just the bubble"), {
			api: fake.api,
			tts: TTS,
			store: storeFor(),
			synthesize: async (text) => {
				spoken = text;
				return [];
			},
		});
		expect(spoken).toBe("just the bubble");
		const notice = fake.calls.find((c) => c.method === "sendMessage");
		expect(notice?.args[1]).toBe(
			"Only this part could be read — the full reply is no longer available.",
		);
	});

	test("a resolved reply sends no partial-read notice", async () => {
		const fake = fakeApi();
		await handleSpeakButton(query(chatId, 8, "bubble"), {
			api: fake.api,
			tts: TTS,
			store: storeFor({ [`${chatId}:8`]: "the whole reply" }),
			synthesize: async () => [],
		});
		expect(fake.calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
	});

	test("a completed rendering clears the in-flight guard — a later tap runs again", async () => {
		const fake = fakeApi();
		let synthesized = 0;
		const deps = {
			api: fake.api,
			tts: TTS,
			store: storeFor(),
			synthesize: async () => {
				synthesized++;
				return [];
			},
		};
		// The finally cleanup is what keeps the button alive after its
		// first success.
		await handleSpeakButton(query(chatId, 6), deps);
		await handleSpeakButton(query(chatId, 6), deps);
		expect(synthesized).toBe(2);
		expect(answers(fake.calls)).toEqual([undefined, undefined]);
	});

	test("unconfigured tts is answered, nothing runs", async () => {
		const fake = fakeApi();
		let synthesized = 0;
		await handleSpeakButton(query(chatId, 5), {
			api: fake.api,
			tts: undefined,
			store: storeFor(),
			synthesize: async () => {
				synthesized++;
				return [];
			},
		});
		expect(answers(fake.calls)).toEqual(["speech is not configured"]);
		expect(synthesized).toBe(0);
	});
});

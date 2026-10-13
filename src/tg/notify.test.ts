import { describe, expect, test } from "bun:test";
import { fakeApi } from "../testkit/fake-api.ts";
import { formatAddress, type ConversationAddress } from "../conversation.ts";
import {
	parseConversationAddress,
	sendMemoryBlockedNotice,
	sendMemoryOutageNotice,
	sendSkillProposedNotice,
} from "./notify.ts";

// formatAddress ∘ parseConversationAddress must be the identity on every
// address goblin stores — the outage notice depends on the round trip.
// Colocated here because the invariant spans both modules (review
// finding: held by convention only, untested).
describe("conversation address round trip", () => {
	const addresses: ConversationAddress[] = [
		{ kind: "dm", chatId: 1 },
		{ kind: "dm", chatId: -100200300 },
		{ kind: "topic", chatId: -100200300, threadId: 546216 },
	];
	for (const addr of addresses) {
		test(`${formatAddress(addr)} parses back`, () => {
			expect(parseConversationAddress(formatAddress(addr))).toEqual(
				addr.kind === "dm"
					? { chatId: addr.chatId, threadId: null }
					: { chatId: addr.chatId, threadId: (addr as { threadId: number }).threadId },
			);
		});
	}

	test("a rolling conversation id decodes to its bare chat", () => {
		// dm:<chat>:<n> — the rolling DM's door is the private chat,
		// never a thread (Rolling DM).
		expect(parseConversationAddress("dm:1:2")).toEqual({ chatId: 1, threadId: null });
		expect(parseConversationAddress("dm:-100:3")).toEqual({ chatId: -100, threadId: null });
	});

	test("malformed ids are rejected, not guessed", () => {
		expect(parseConversationAddress("topic:1")).toBeNull(); // missing thread
		expect(parseConversationAddress("group:1")).toBeNull(); // unknown kind
		expect(parseConversationAddress("app/chat-01")).toBeNull(); // not a telegram door
		expect(parseConversationAddress("")).toBeNull();
	});
});

describe("outage notice send", () => {
	test("topic ids send into their thread; dm ids without one", async () => {
		type Send = { chatId: number; text: string; threadId?: number };
		const sends: Send[] = [];
		const api = fakeApi({
			handlers: {
				sendMessage: async (
					chatId: number,
					text: string,
					other?: { message_thread_id?: number },
				) => {
					sends.push({
						chatId,
						text,
						...(other?.message_thread_id !== undefined
							? { threadId: other.message_thread_id }
							: {}),
					});
				},
			},
		}).api;
		await sendMemoryOutageNotice(api, "topic:-100200300:546216", 3_600_000, 2);
		await sendMemoryOutageNotice(api, "dm:42", 7_200_000, 1);
		expect(sends).toHaveLength(2);
		const [topic, dm] = sends;
		expect(topic).toMatchObject({ chatId: -100200300, threadId: 546216 });
		expect(topic?.text).toContain("unreachable");
		expect(topic?.text).toContain("2 exchanges queued");
		expect(dm).toMatchObject({ chatId: 42 });
		expect(dm?.text).toContain("1 exchange queued"); // singular
		expect(dm?.threadId).toBeUndefined();
	});

	test("an unparseable id throws — the caller's retry/logging depends on it", async () => {
		const api = fakeApi({
			handlers: {
				sendMessage: async () => {
					throw new Error("must not be called");
				},
			},
		}).api;
		await expect(sendMemoryOutageNotice(api, "garbage", 3_600_000, 1)).rejects.toThrow(
			/unparseable conversation id/,
		);
	});
});

describe("blocked notice send", () => {
	test("one line into the stuck exchange's thread; error capped at 120 chars", async () => {
		type Send = { chatId: number; text: string; threadId?: number };
		const sends: Send[] = [];
		const api = fakeApi({
			handlers: {
				sendMessage: async (
					chatId: number,
					text: string,
					other?: { message_thread_id?: number },
				) => {
					sends.push({
						chatId,
						text,
						...(other?.message_thread_id !== undefined
							? { threadId: other.message_thread_id }
							: {}),
					});
				},
			},
		}).api;
		await sendMemoryBlockedNotice(api, "topic:-100200300:546216", "x".repeat(300), 3);
		await sendMemoryBlockedNotice(api, "dm:42", null, 1);
		expect(sends).toHaveLength(2);
		const [topic, dm] = sends;
		expect(topic).toMatchObject({ chatId: -100200300, threadId: 546216 });
		expect(topic?.text).toContain("memory retention blocked for one exchange: ");
		expect(topic?.text).toContain("— /memory retry to resend, /memory dismiss to drop");
		expect(topic?.text.split("\n")).toHaveLength(1); // one line, plain
		// 43-char prefix + 120-char error + 51-char suffix is the ceiling.
		expect(topic?.text.length).toBeLessThanOrEqual(43 + 120 + 51);
		expect(dm).toMatchObject({ chatId: 42 });
		expect(dm?.threadId).toBeUndefined();
		expect(dm?.text).toContain("unknown error"); // null error never renders as "null"
	});

	test("an unparseable id throws — the caller logs it", async () => {
		const api = fakeApi({
			handlers: {
				sendMessage: async () => {
					throw new Error("must not be called");
				},
			},
		}).api;
		await expect(sendMemoryBlockedNotice(api, "garbage", "err", 1)).rejects.toThrow(
			/unparseable conversation id/,
		);
	});
});

describe("skill proposal notice send", () => {
	type Send = {
		chatId: number;
		text: string;
		threadId?: number;
		keyboard?: Array<Array<{ text: string; callback_data: string }>>;
	};
	function noticeApi() {
		const sends: Send[] = [];
		const api = fakeApi({
			handlers: {
				sendMessage: async (
					chatId: number,
					text: string,
					other?: {
						message_thread_id?: number;
						reply_markup?: {
							inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
						};
					},
				) => {
					sends.push({
						chatId,
						text,
						...(other?.message_thread_id !== undefined
							? { threadId: other.message_thread_id }
							: {}),
						...(other?.reply_markup !== undefined
							? { keyboard: other.reply_markup.inline_keyboard }
							: {}),
					});
				},
			},
		}).api;
		return { api, sends };
	}

	test("one message per skill, each with the install/discard row", async () => {
		const { api, sends } = noticeApi();
		await sendSkillProposedNotice(api, "topic:-100200300:546216", ["pdf-tables"]);
		await sendSkillProposedNotice(api, "dm:42", ["a", "b"]);
		expect(sends).toHaveLength(3);
		expect(sends[0]).toMatchObject({ chatId: -100200300, threadId: 546216 });
		expect(sends[0]?.text).toBe("proposed skill: pdf-tables — approve to install");
		expect(sends[0]?.keyboard).toEqual([
			[
				{ text: "✅ Install", callback_data: "skill:install:topic:-100200300:546216:pdf-tables" },
				{ text: "🚫 Discard", callback_data: "skill:discard:topic:-100200300:546216:pdf-tables" },
			],
		]);
		expect(sends[1]?.text).toBe("proposed skill: a — approve to install");
		expect(sends[2]?.text).toBe("proposed skill: b — approve to install");
	});

	test("callback data over 64 bytes degrades to the conversational notice", async () => {
		const { api, sends } = noticeApi();
		const long = "a".repeat(64); // spec-legal name, worst case
		await sendSkillProposedNotice(api, "dm:42", [long]);
		expect(sends).toHaveLength(1);
		expect(sends[0]?.text).toBe(`proposed skill: ${long} — approve to install`);
		expect(sends[0]?.keyboard).toBeUndefined();
	});
});

describe("app conversation notices", () => {
	// App conversations ring nothing (DESIGN.md, App channel — no push):
	// every notice is a deliberate skip, not a parse failure — the api is
	// never touched and nothing throws for the caller's retry loop.
	test("all three notices skip app ids without sending", async () => {
		const { api, calls } = fakeApi();
		await sendMemoryOutageNotice(api, "app/chat-01", 3_600_000, 2);
		await sendMemoryBlockedNotice(api, "app/chat-01", "err", 1);
		await sendSkillProposedNotice(api, "app/chat-01", ["x"]);
		expect(calls).toEqual([]);
	});
});

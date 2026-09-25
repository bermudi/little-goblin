import { describe, expect, test } from "bun:test";
import type { Api } from "grammy";
import { addressId, type ConversationAddress } from "../conversation.ts";
import { parseConversationAddress, sendMemoryOutageNotice } from "./notify.ts";

// addressId ∘ parseConversationAddress must be the identity on every
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
		test(`${addressId(addr)} parses back`, () => {
			expect(parseConversationAddress(addressId(addr))).toEqual(
				addr.kind === "dm"
					? { chatId: addr.chatId, threadId: null }
					: { chatId: addr.chatId, threadId: (addr as { threadId: number }).threadId },
			);
		});
	}

	test("malformed ids are rejected, not guessed", () => {
		expect(parseConversationAddress("topic:1")).toBeNull(); // missing thread
		expect(parseConversationAddress("dm:1:2")).toBeNull(); // dm with thread
		expect(parseConversationAddress("group:1")).toBeNull(); // unknown kind
		expect(parseConversationAddress("")).toBeNull();
	});
});

describe("outage notice send", () => {
	test("topic ids send into their thread; dm ids without one", async () => {
		type Send = { chatId: number; text: string; threadId?: number };
		const sends: Send[] = [];
		const api = {
			sendMessage: async (chatId: number, text: string, other?: { message_thread_id?: number }) => {
				sends.push({
					chatId, text,
					...(other?.message_thread_id !== undefined ? { threadId: other.message_thread_id } : {}),
				});
			},
		} as unknown as Api;
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
		const api = { sendMessage: async () => { throw new Error("must not be called"); } } as unknown as Api;
		await expect(sendMemoryOutageNotice(api, "garbage", 3_600_000, 1)).rejects.toThrow(
			/unparseable conversation id/,
		);
	});
});

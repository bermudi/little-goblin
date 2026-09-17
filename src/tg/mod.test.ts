import { describe, expect, test } from "bun:test";
import type { Api } from "grammy";
import { applyMenuButton, conversationAddress } from "./mod.ts";

describe("conversationAddress", () => {
	// Regression: bot DMs with topics enabled carry message_thread_id on
	// private-chat messages — dropping it collapses every topic into the
	// DM lane and replies land outside the topic.
	test("private chat with thread id is a topic", () => {
		expect(
			conversationAddress({ chat: { id: 42, type: "private" }, message_thread_id: 7 }),
		).toEqual({ kind: "topic", chatId: 42, threadId: 7 });
	});

	test("forum supergroup topic", () => {
		expect(
			conversationAddress({
				chat: { id: -100, type: "supergroup" },
				message_thread_id: 7,
				is_topic_message: true,
			}),
		).toEqual({ kind: "topic", chatId: -100, threadId: 7 });
	});

	test("comment thread in a plain group stays bare-chat", () => {
		expect(
			conversationAddress({
				chat: { id: -100, type: "supergroup" },
				message_thread_id: 7,
			}),
		).toEqual({ kind: "dm", chatId: -100 });
	});

	test("plain private message is the dm lane", () => {
		expect(conversationAddress({ chat: { id: 42, type: "private" } })).toEqual({
			kind: "dm",
			chatId: 42,
		});
	});
});

describe("applyMenuButton", () => {
	test("publicUrl maps to a web_app button; unset resets to default", async () => {
		const calls: unknown[] = [];
		const api = {
			setChatMenuButton: (opts: unknown) => {
				calls.push(opts);
				return Promise.resolve(true);
			},
		} as unknown as Api;

		applyMenuButton(api, "https://goblin.example.ts.net");
		applyMenuButton(api, undefined);
		await Promise.resolve();

		expect(calls).toEqual([
			{
				menu_button: {
					type: "web_app",
					text: "Settings",
					web_app: { url: "https://goblin.example.ts.net" },
				},
			},
			{ menu_button: { type: "default" } },
		]);
	});
});

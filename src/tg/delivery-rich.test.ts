// Rich replies (design/telegram.md, ruling 2026-10-12): the sink fakes
// Telegram at the edge and pins the four behaviors that matter — draft
// streaming + one rich send, fallback to plain on any rich failure, DM
// gating, and the reasoning bubble/collapsed block. Config defaults ride
// the same file: the kill switch must survive a parse round-trip.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api } from "grammy";
import { parseConfig } from "../config.ts";
import type { Conversation } from "../conversation.ts";
import { setLogFile, setLogWriter } from "../log.ts";
import { makeDeliverySink } from "./delivery.ts";

const conv: Conversation = {
	id: "dm:1",
	chatId: 1,
	threadId: null,
	title: null,
	titleImplicit: false,
	model: null,
	thinking: null,
	voice: false,
	memoryExcluded: false,
	projectId: null,
	persona: "personal",
	archivedAt: null,
	pinnedAt: null,
	epoch: 0,
	createdAt: "",
};

const groupConv: Conversation = { ...conv, id: "tg:-100", chatId: -100 };

interface DraftCall {
	kind: "plain" | "rich";
	id: number;
	text?: string;
	markdown?: string;
}

function fakeApi(opts: { failRichDrafts?: boolean; failRichSend?: boolean } = {}) {
	const drafts: DraftCall[] = [];
	const richSends: Array<{ markdown: string; other: Record<string, unknown> }> = [];
	const msgs: string[] = [];
	const edits: string[] = [];
	const reactions: Array<{ chat: number; id: number; emoji: string }> = [];
	const markups: unknown[] = [];
	const api = {
		sendChatAction: () => Promise.resolve(true),
		sendMessage: async (_chat: number, text: string) => {
			msgs.push(text);
			return { message_id: msgs.length };
		},
		editMessageText: async (_chat: number, _id: number, text: string) => {
			edits.push(text);
			return true;
		},
		sendMessageDraft: async (_chat: number, id: number, text: string) => {
			drafts.push({ kind: "plain", id, text });
			return true;
		},
		sendRichMessageDraft: async (_chat: number, id: number, rm: { markdown: string }) => {
			if (opts.failRichDrafts) throw new Error("sendRichMessageDraft failed");
			drafts.push({ kind: "rich", id, markdown: rm.markdown });
			return true;
		},
		sendRichMessage: async (
			_chat: number,
			rm: { markdown: string },
			other: Record<string, unknown>,
		) => {
			if (opts.failRichSend) throw new Error("sendRichMessage failed");
			richSends.push({ markdown: rm.markdown, other });
			return { message_id: 900 + richSends.length };
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
	return { api, drafts, richSends, msgs, edits, reactions, markups };
}

const silenceLogs = () => {
	const dir = mkdtempSync(join(tmpdir(), "delivery-rich-"));
	setLogFile(join(dir, "test.log"));
	setLogWriter(() => {});
	return () => {
		setLogFile(null);
		setLogWriter(null);
		rmSync(dir, { recursive: true, force: true });
	};
};

describe("rich delivery", () => {
	test("DM turn streams rich drafts and finalizes with one rich send", async () => {
		const done = silenceLogs();
		try {
			const { api, drafts, richSends, msgs, edits, reactions, markups } = fakeApi();
			const sink = makeDeliverySink(api, conv, 77, 0, undefined, undefined, undefined, {
				lastReplyAnchor: () => 42,
			}, {
				enabled: true,
			});
			sink.onTextDelta("hello ");
			sink.onTextDelta("world");
			await sink.onDone({ kind: "completed" });
			// Thinking placeholder first, then the accumulated markdown.
			expect(drafts[0]).toEqual({ kind: "plain", id: drafts[0]!.id, text: "" });
			expect(drafts.some((d) => d.kind === "rich" && d.markdown === "hello world")).toBe(true);
			// One rich send carries the reply anchor; no plain text went out.
			expect(richSends).toHaveLength(1);
			expect(richSends[0]!.markdown).toBe("hello world");
			expect(richSends[0]!.other.reply_parameters).toEqual({ message_id: 77 });
			expect(msgs).toEqual([]);
			expect(edits).toEqual([]);
			// 🫡 + rating keyboard land on the rich message.
			expect(reactions).toEqual([{ chat: 1, id: 901, emoji: "🫡" }]);
			expect(markups).toHaveLength(1);
			const keyboard = (
				markups[0] as { reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } }
			).reply_markup.inline_keyboard;
			expect(keyboard[0]!.map((b) => b.callback_data)).toEqual(["rate:up|dm:1|42", "rate:down|dm:1|42"]);
		} finally {
			done();
		}
	});

	test("a rich draft failure degrades the turn to the plain path", async () => {
		const done = silenceLogs();
		try {
			const { api, richSends, msgs } = fakeApi({ failRichDrafts: true });
			const sink = makeDeliverySink(api, conv, undefined, 0, undefined, undefined, undefined, undefined, {
				enabled: true,
			});
			sink.onTextDelta("plain again");
			await sink.onDone({ kind: "completed" });
			expect(richSends).toHaveLength(0);
			expect(msgs).toContain("plain again");
		} finally {
			done();
		}
	});

	test("a rich finalize failure falls through to the plain drain", async () => {
		const done = silenceLogs();
		try {
			const { api, drafts, richSends, msgs } = fakeApi({ failRichSend: true });
			const sink = makeDeliverySink(api, conv, undefined, 0, undefined, undefined, undefined, undefined, {
				enabled: true,
			});
			sink.onTextDelta("still delivered");
			await sink.onDone({ kind: "completed" });
			expect(drafts.length).toBeGreaterThan(0);
			expect(richSends).toHaveLength(0);
			expect(msgs).toContain("still delivered");
		} finally {
			done();
		}
	});

	test("showReasoning streams a reasoning draft and lands a collapsed block", async () => {
		const done = silenceLogs();
		try {
			const { api, drafts, richSends } = fakeApi();
			const sink = makeDeliverySink(api, conv, undefined, 0, undefined, undefined, undefined, undefined, {
				enabled: true,
				reasoning: true,
			});
			sink.onReasoningDelta("hidden thought");
			sink.onTextDelta("answer");
			await sink.onDone({ kind: "completed" });
			expect(
				drafts.some((d) => d.kind === "plain" && d.text === "hidden thought"),
			).toBe(true);
			expect(richSends[0]!.markdown.startsWith("<details><summary>Thinking</summary>")).toBe(
				true,
			);
			expect(richSends[0]!.markdown).toContain("hidden thought");
			expect(richSends[0]!.markdown.endsWith("answer")).toBe(true);
		} finally {
			done();
		}
	});

	test("reasoning deltas stay invisible when showReasoning is off", async () => {
		const done = silenceLogs();
		try {
			const { api, drafts, richSends } = fakeApi();
			const sink = makeDeliverySink(api, conv, undefined, 0, undefined, undefined, undefined, undefined, {
				enabled: true,
			});
			sink.onReasoningDelta("secret");
			sink.onTextDelta("answer");
			await sink.onDone({ kind: "completed" });
			expect(drafts.some((d) => d.text === "secret")).toBe(false);
			expect(richSends[0]!.markdown).toBe("answer");
			expect(richSends[0]!.markdown).not.toContain("<details>");
		} finally {
			done();
		}
	});

	test("the kill switch and non-DM conversations keep the plain sink", async () => {
		const done = silenceLogs();
		try {
			for (const [c, enabled] of [
				[conv, false],
				[groupConv, true],
			] as const) {
				const { api, drafts, richSends, msgs } = fakeApi();
				const sink = makeDeliverySink(
					api,
					c,
					undefined,
					0,
					undefined,
					undefined,
					undefined,
					undefined,
					{ enabled },
				);
				sink.onTextDelta("plain");
				await sink.onDone({ kind: "completed" });
				expect(drafts).toEqual([]);
				expect(richSends).toEqual([]);
				expect(msgs).toContain("plain");
			}
		} finally {
			done();
		}
	});

	test("a fenced rich turn sends nothing", async () => {
		const done = silenceLogs();
		try {
			const { api, drafts, richSends, msgs } = fakeApi();
			const sink = makeDeliverySink(api, conv, undefined, 0, undefined, undefined, undefined, undefined, {
				enabled: true,
			});
			sink.setAuthorityCheck!(() => false);
			sink.onTextDelta("never delivered");
			await sink.onDone({ kind: "fenced" });
			expect(drafts).toEqual([]);
			expect(richSends).toEqual([]);
			expect(msgs).toEqual([]);
		} finally {
			done();
		}
	});

	test("a body over the rich cap falls back to plain chunking", async () => {
		const done = silenceLogs();
		try {
			const { api, richSends, msgs } = fakeApi();
			const sink = makeDeliverySink(api, conv, undefined, 0, undefined, undefined, undefined, undefined, {
				enabled: true,
			});
			sink.onTextDelta("x".repeat(33_000));
			await sink.onDone({ kind: "completed" });
			expect(richSends).toHaveLength(0);
			expect(msgs.length).toBeGreaterThan(1);
		} finally {
			done();
		}
	});

	test("config defaults: rich on, reasoning off, kill switch survives", () => {
		const base = {
			providers: {
				test: { kind: "openai-compatible", baseUrl: "https://api.example.org", auth: "ref" },
			},
			model: "test/m",
			operators: [42],
			allowedUsers: [42],
		};
		const defaults = parseConfig(base);
		expect(defaults.telegram.richReplies).toBe(true);
		expect(defaults.telegram.showReasoning).toBe(false);
		const off = parseConfig({ ...base, telegram: { richReplies: false, showReasoning: true } });
		expect(off.telegram.richReplies).toBe(false);
		expect(off.telegram.showReasoning).toBe(true);
		expect(off.telegram.dmGapMinutes).toBe(45);
	});
});

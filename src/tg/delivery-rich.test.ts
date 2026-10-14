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
import { TelegramTimeoutError } from "./deadline.ts";
import { makeDeliverySink, resetMessageEffectsGateForTests } from "./delivery.ts";

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
	text?: string | undefined;
	markdown?: string | undefined;
	blocks?: Array<{ type: string; text?: unknown }> | undefined;
}

function fakeApi(
	opts: {
		failRichDrafts?: boolean;
		failRichSend?: boolean;
		timeoutNextRichDraft?: boolean;
		rejectEffect?: boolean;
	} = {},
) {
	const drafts: DraftCall[] = [];
	const richSends: Array<{ markdown: string; other: Record<string, unknown> }> = [];
	const msgs: string[] = [];
	const edits: string[] = [];
	const actions: string[] = [];
	const reactions: Array<{ chat: number; id: number; emoji: string }> = [];
	const markups: unknown[] = [];
	let sendAttempts = 0;
	const api = {
		sendChatAction: async (_chat: number, action: string) => {
			actions.push(action);
			return true;
		},
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
		sendRichMessageDraft: async (
			_chat: number,
			id: number,
			rm: { markdown?: string; blocks?: Array<{ type: string; text?: unknown }> },
		) => {
			if (opts.timeoutNextRichDraft) {
				opts.timeoutNextRichDraft = false;
				throw new TelegramTimeoutError("sendRichMessageDraft", 30_000);
			}
			if (opts.failRichDrafts) throw new Error("sendRichMessageDraft failed");
			drafts.push({ kind: "rich", id, markdown: rm.markdown, blocks: rm.blocks });
			return true;
		},
		sendRichMessage: async (
			_chat: number,
			rm: { markdown: string },
			other: Record<string, unknown>,
		) => {
			sendAttempts++;
			if (opts.rejectEffect && other.message_effect_id !== undefined) {
				throw new Error("Bad Request: PREMIUM_ACCOUNT_REQUIRED");
			}
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
	return {
		api,
		drafts,
		richSends,
		msgs,
		edits,
		actions,
		reactions,
		markups,
		sendAttempts: () => sendAttempts,
	};
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
	// Drafts carry content, the chat action carries liveness: the typing
	// indicator must stay live in rich mode too, not be replaced by the
	// draft bubble (operator ruling 2026-10-14).
	test("rich mode keeps the typing chat action live alongside drafts", async () => {
		const done = silenceLogs();
		try {
			const { api, drafts, actions } = fakeApi();
			const sink = makeDeliverySink(
				api,
				conv,
				undefined,
				0,
				undefined,
				2, // typingIntervalMs — the tick drives both ping and refresh
				undefined,
				undefined,
				{ enabled: true },
			);
			await sleep(12);
			// The placeholder draft went out AND typing pings keep coming.
			expect(drafts.length).toBeGreaterThan(0);
			const typings = actions.filter((a) => a === "typing").length;
			expect(typings).toBeGreaterThanOrEqual(2);
			await sink.onDone({ kind: "completed" });
			actions.length = 0;
			await sleep(12);
			// Terminal sink: no ghost typing after the rich send landed.
			expect(actions).toEqual([]);
		} finally {
			done();
		}
	});

	// Synthesis pauses the typing interval, which otherwise carries the
	// draft keep-alive: with a tiny draft TTL the recording tick must
	// keep re-pushing the unchanged draft, and nothing may ping typing
	// while record_voice owns the status bar.
	test("a synthesis window keeps refreshing the rich draft — no mid-turn evaporation", async () => {
		const done = silenceLogs();
		try {
			const { api, drafts, actions } = fakeApi();
			const sink = makeDeliverySink(
				api,
				conv,
				undefined,
				0,
				undefined,
				2, // typingIntervalMs — powers the recording tick while synthesis runs
				undefined,
				undefined,
				{ enabled: true },
				400,
				10, // draftTtlMs — the unchanged draft goes stale almost immediately
			);
			// One sync block: text lands, the typing interval is cleared, and
			// the recording tick is armed before any timer can fire.
			sink.onTextDelta("hold");
			const stop = sink.onVoiceSynthesisStart!();
			const pushed = drafts.length;
			actions.length = 0;
			await sleep(25);
			expect(drafts.length).toBeGreaterThan(pushed); // keep-alive re-pushed
			expect(actions.every((a) => a === "record_voice")).toBe(true);
			stop();
			await sink.onDone({ kind: "completed" });
		} finally {
			done();
		}
	});

	test("DM turn streams rich drafts and finalizes with one rich send", async () => {
		const done = silenceLogs();
		try {
			const { api, drafts, richSends, msgs, edits, reactions, markups } = fakeApi();
			const sink = makeDeliverySink(
				api,
				conv,
				77,
				0,
				undefined,
				undefined,
				undefined,
				{
					lastReplyAnchor: () => 42,
				},
				{
					enabled: true,
				},
			);
			sink.onTextDelta("hello ");
			sink.onTextDelta("world");
			await sink.onDone({ kind: "completed" });
			// Thinking placeholder first, then the accumulated markdown.
			expect(drafts[0]).toEqual({ kind: "plain", id: expect.any(Number), text: "" });
			expect(drafts.some((d) => d.kind === "rich" && d.markdown === "hello world")).toBe(true);
			// One rich send carries the reply anchor; no plain text went out.
			expect(richSends).toHaveLength(1);
			expect(richSends[0]!.markdown).toBe("hello world");
			expect(richSends[0]!.other.reply_parameters).toEqual({ message_id: 77 });
			expect(msgs).toEqual([]);
			expect(edits).toEqual([]);
			// 🫡 reacts on the landed message; the rating keyboard rode the
			// send itself — no second editMessageReplyMarkup call.
			expect(reactions).toEqual([{ chat: 1, id: 901, emoji: "🫡" }]);
			expect(markups).toEqual([]);
			const keyboard = (
				richSends[0]!.other.reply_markup as {
					inline_keyboard: Array<Array<{ callback_data: string }>>;
				}
			).inline_keyboard;
			expect(keyboard[0]!.map((b) => b.callback_data)).toEqual([
				"rate:up|dm:1|42",
				"rate:down|dm:1|42",
			]);
		} finally {
			done();
		}
	});

	test("a rich draft failure degrades the turn to the plain path", async () => {
		const done = silenceLogs();
		try {
			const { api, richSends, msgs } = fakeApi({ failRichDrafts: true });
			const sink = makeDeliverySink(
				api,
				conv,
				undefined,
				0,
				undefined,
				undefined,
				undefined,
				undefined,
				{
					enabled: true,
				},
			);
			sink.onTextDelta("plain again");
			await sink.onDone({ kind: "completed" });
			expect(richSends).toHaveLength(0);
			expect(msgs).toContain("plain again");
		} finally {
			done();
		}
	});

	// A draft is a disposable preview — its timeout can't have delivered
	// anything, so it degrades like any other draft failure instead of
	// marking the turn uncertain (which would drop the reply).
	test("a draft timeout degrades like any draft failure — the reply lands plain", async () => {
		const done = silenceLogs();
		try {
			const { api, drafts, richSends, msgs } = fakeApi({ timeoutNextRichDraft: true });
			const sink = makeDeliverySink(
				api,
				conv,
				undefined,
				0,
				undefined,
				undefined,
				undefined,
				undefined,
				{
					enabled: true,
				},
			);
			sink.onTextDelta("first");
			sink.onTextDelta("second");
			await sink.onDone({ kind: "completed" });
			expect(richSends).toHaveLength(0);
			expect(msgs).toContain("firstsecond");
			expect(msgs.some((m) => m.includes("uncertain"))).toBe(false);
			// Drafts queued behind the timed-out one never fire — the
			// enqueued fn re-checks richMode after the degrade.
			expect(drafts.some((d) => d.kind === "rich")).toBe(false);
		} finally {
			done();
		}
	});

	test("a rich finalize failure falls through to the plain drain", async () => {
		const done = silenceLogs();
		try {
			const { api, drafts, richSends, msgs } = fakeApi({ failRichSend: true });
			const sink = makeDeliverySink(
				api,
				conv,
				undefined,
				0,
				undefined,
				undefined,
				undefined,
				undefined,
				{
					enabled: true,
				},
			);
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
			const sink = makeDeliverySink(
				api,
				conv,
				undefined,
				0,
				undefined,
				undefined,
				undefined,
				undefined,
				{
					enabled: true,
					reasoning: true,
				},
			);
			sink.onReasoningDelta("hidden thought");
			sink.onTextDelta("answer");
			await sink.onDone({ kind: "completed" });
			// Reasoning streams inside the native thinking block (Bot API
			// 10.2) — a rich draft, not plain text.
			const think = drafts.find((d) => d.kind === "rich" && d.blocks !== undefined);
			expect(think?.blocks).toEqual([{ type: "thinking", text: "hidden thought" }]);
			expect(richSends[0]!.markdown.startsWith("<details><summary>Thinking</summary>")).toBe(true);
			// Raw reasoning rides a <pre> so its text stays literal.
			expect(richSends[0]!.markdown).toContain("<pre>hidden thought</pre>");
			expect(richSends[0]!.markdown.endsWith("answer")).toBe(true);
		} finally {
			done();
		}
	});

	test("no reasoning delta, no reasoning bubble — just the answer's placeholder", async () => {
		const done = silenceLogs();
		try {
			const { api, drafts, richSends } = fakeApi();
			const sink = makeDeliverySink(
				api,
				conv,
				undefined,
				0,
				undefined,
				undefined,
				undefined,
				undefined,
				{
					enabled: true,
					reasoning: true,
				},
			);
			sink.onTextDelta("answer");
			await sink.onDone({ kind: "completed" });
			// Exactly one plain draft — the answer's "Thinking…" — not two.
			expect(drafts.filter((d) => d.kind === "plain")).toHaveLength(1);
			expect(richSends[0]!.markdown).toBe("answer");
			expect(richSends[0]!.markdown).not.toContain("<details>");
		} finally {
			done();
		}
	});

	test("reasoning deltas stay invisible when showReasoning is off", async () => {
		const done = silenceLogs();
		try {
			const { api, drafts, richSends } = fakeApi();
			const sink = makeDeliverySink(
				api,
				conv,
				undefined,
				0,
				undefined,
				undefined,
				undefined,
				undefined,
				{
					enabled: true,
				},
			);
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
			const sink = makeDeliverySink(
				api,
				conv,
				undefined,
				0,
				undefined,
				undefined,
				undefined,
				undefined,
				{
					enabled: true,
				},
			);
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
			const sink = makeDeliverySink(
				api,
				conv,
				undefined,
				0,
				undefined,
				undefined,
				undefined,
				undefined,
				{
					enabled: true,
				},
			);
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

	// The completed-turn salute rides the rich send. The memo is
	// process-lifetime module state: these tests reset it in finally.
	test("a completed DM send carries the salute effect; error turns don't", async () => {
		const done = silenceLogs();
		try {
			resetMessageEffectsGateForTests();
			const { api, richSends } = fakeApi();
			const sink = makeDeliverySink(
				api,
				conv,
				undefined,
				0,
				undefined,
				undefined,
				undefined,
				undefined,
				{
					enabled: true,
				},
			);
			sink.onTextDelta("done");
			await sink.onDone({ kind: "completed" });
			expect(richSends[0]!.other.message_effect_id).toBe("4913930782671635058");

			const errSink = makeDeliverySink(
				api,
				conv,
				undefined,
				0,
				undefined,
				undefined,
				undefined,
				undefined,
				{ enabled: true },
			);
			errSink.onTextDelta("failed");
			await errSink.onDone({ kind: "error", message: "boom" });
			expect(richSends[1]!.other.message_effect_id).toBeUndefined();
		} finally {
			resetMessageEffectsGateForTests();
			done();
		}
	});

	test("a premium-gated effect retries once without it, then memoizes", async () => {
		const done = silenceLogs();
		try {
			resetMessageEffectsGateForTests();
			const { api, richSends, sendAttempts } = fakeApi({ rejectEffect: true });
			const sink = makeDeliverySink(
				api,
				conv,
				undefined,
				0,
				undefined,
				undefined,
				undefined,
				{ lastReplyAnchor: () => 7 },
				{
					enabled: true,
				},
			);
			sink.onTextDelta("first");
			await sink.onDone({ kind: "completed" });
			// First turn: attempt with effect, definite 400, safe retry without.
			expect(sendAttempts()).toBe(2);
			expect(richSends).toHaveLength(1);
			expect(richSends[0]!.markdown).toBe("first");
			expect(richSends[0]!.other.message_effect_id).toBeUndefined();
			// The keyboard rode the retry too — it isn't part of the drop.
			expect(richSends[0]!.other.reply_markup).toEqual({
				inline_keyboard: [
					[
						{ text: "👍", callback_data: "rate:up|dm:1|7" },
						{ text: "👎", callback_data: "rate:down|dm:1|7" },
					],
				],
			});

			// Later turns in the same process skip the param entirely.
			const sink2 = makeDeliverySink(
				api,
				conv,
				undefined,
				0,
				undefined,
				undefined,
				undefined,
				undefined,
				{ enabled: true },
			);
			sink2.onTextDelta("second");
			await sink2.onDone({ kind: "completed" });
			expect(sendAttempts()).toBe(3);
			expect(richSends).toHaveLength(2);
			expect(richSends[1]!.other.message_effect_id).toBeUndefined();
		} finally {
			resetMessageEffectsGateForTests();
			done();
		}
	});
});

// Guest mode tests (design/telegram.md → Guest mode). Boundaries and
// invariants only: classification ordering, the sandbox's hard tool
// exclusion, open/close lifecycle + fencing, dedup, budget, and the
// placeholder-then-edit delivery shape — Telegram faked at the api
// edge like every other tg test.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	guestAddress,
	openStore,
	type Conversation,
	type ConversationStore,
} from "../conversation.ts";
import type { Config, ConfigRef } from "../config.ts";
import type { Runtime, TurnSink } from "../runtime.ts";
import type { UIMessage } from "ai";
import type { Message, User } from "grammy/types";
import {
	type GuestEnv,
	classifySummon,
	filterGuestTools,
	GuestSink,
	guestCommand,
	handleGuestUpdate,
	mentionsBot,
	openGuestStore,
	routeMemberGuestMessage,
} from "./guest.ts";
import { sharedChatPart } from "./mod.ts";

const dirs: string[] = [];
function tmpdb(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-guest-"));
	dirs.push(dir);
	return join(dir, "goblin.sqlite");
}
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const baseConfig = (over: Partial<Config> = {}): Config =>
	({
		providers: {},
		model: "t/m",
		thinking: "medium",
		favorites: [],
		allowedUsers: [7],
		telegram: { dmGapMinutes: 45, apiRoot: undefined },
		http: { port: 8787 },
		guest: { perUserDailyTurns: 2, outputChars: 3500 },
		...over,
	}) as Config;

// ---------- pure pieces ----------

describe("classifySummon", () => {
	test("the operator is personal anywhere, open or not", () => {
		expect(classifySummon(7, -100, [7], false)).toEqual({ kind: "personal" });
		expect(classifySummon(7, -100, [7], true)).toEqual({ kind: "personal" });
	});
	test("third parties are sandbox in an open chat, denied elsewhere", () => {
		expect(classifySummon(9, -100, [7], true)).toEqual({ kind: "sandbox" });
		expect(classifySummon(9, -100, [7], false)).toEqual({ kind: "deny", reason: "chat-closed" });
	});
});

describe("mentionsBot", () => {
	const bot = { username: "goblin_bot", id: 42 };
	const user = (id: number, first_name: string): User => ({ id, is_bot: false, first_name });
	const msg = (over: Partial<Message>): Message =>
		({ chat: { id: -100, type: "group" }, date: 0, message_id: 1, ...over }) as unknown as Message;

	test("a @username mention entity addresses the bot", () => {
		expect(
			mentionsBot(
				msg({ text: "@goblin_bot hello", entities: [{ type: "mention", offset: 0, length: 11 }] }),
				bot.username,
				bot.id,
			),
		).toBe(true);
	});
	test("a text_mention of the bot id addresses the bot", () => {
		expect(
			mentionsBot(
				msg({
					text: "hey there",
					entities: [{ type: "text_mention", offset: 4, length: 5, user: user(42, "g") }],
				}),
				bot.username,
				bot.id,
			),
		).toBe(true);
	});
	test("a reply to one of the bot's messages addresses the bot", () => {
		expect(
			mentionsBot(
				msg({
					text: "go on",
					reply_to_message: msg({ text: "earlier", from: user(42, "goblin") }) as never,
				}),
				bot.username,
				bot.id,
			),
		).toBe(true);
	});
	test("another bot's mention does not", () => {
		expect(
			mentionsBot(
				msg({ text: "@other_bot hi", entities: [{ type: "mention", offset: 0, length: 10 }] }),
				bot.username,
				bot.id,
			),
		).toBe(false);
		expect(mentionsBot(msg({ text: "plain text" }), bot.username, bot.id)).toBe(false);
	});
});

describe("guestCommand", () => {
	test("open/off with mention, suffix, or case variants", () => {
		expect(guestCommand("@goblin_bot /open")).toBe("open");
		expect(guestCommand("/off")).toBe("off");
		expect(guestCommand("/OPEN@Goblin_Bot")).toBe("open");
	});
	test("anything else is not a command", () => {
		expect(guestCommand("/opening statement")).toBeNull();
		expect(guestCommand("@goblin_bot what is 2+2")).toBeNull();
		expect(guestCommand("")).toBeNull();
	});
});

describe("filterGuestTools — the sandbox invariant", () => {
	const tools = {
		read_file: 1,
		write_file: 1,
		edit_file: 1,
		bash: 1,
		speak: 1,
		transcribe: 1,
		vision: 1,
		program: 1,
		delegate: 1,
		mail: 1,
		send_file: 1,
		memory_search: 1,
		search: 1,
		fetch: 1,
		history_search: 1,
	};
	const conv = (persona: "personal" | "guest"): Conversation =>
		({
			id: `guest:-100:9`,
			chatId: -100,
			threadId: null,
			title: null,
			titleImplicit: false,
			model: null,
			thinking: null,
			voice: false,
			memoryExcluded: true,
			persona,
			epoch: 0,
			createdAt: "",
		}) as unknown as Conversation;

	test("sandbox personas keep search and fetch only", () => {
		expect(Object.keys(filterGuestTools(conv("guest"), tools)).sort()).toEqual(["fetch", "search"]);
	});
	test("personal guest turns lose tools that pin or reach beyond the chat", () => {
		const kept = Object.keys(filterGuestTools(conv("personal"), tools)).sort();
		for (const gone of [
			"program",
			"mail",
			"delegate",
			"memory_search",
			"history_search",
			"speak",
			"send_file",
		]) {
			expect(kept).not.toContain(gone);
		}
		expect(kept).toContain("bash");
		expect(kept).toContain("search");
	});
	test("non-guest conversations are untouched", () => {
		const dm = { ...conv("guest"), id: "dm:5" } as unknown as Conversation;
		expect(filterGuestTools(dm, tools)).toEqual(tools);
	});
});

// ---------- store ----------

describe("openGuestStore", () => {
	test("open/isOpen/close lifecycle", () => {
		const store = openGuestStore(openStore(tmpdb()).db);
		expect(store.isOpen(-100)).toBe(false);
		store.open(-100, 7);
		expect(store.isOpen(-100)).toBe(true);
		store.close(-100);
		expect(store.isOpen(-100)).toBe(false);
	});
	test("seen is true once per update id", () => {
		const store = openGuestStore(openStore(tmpdb()).db);
		expect(store.seen(500)).toBe(true);
		expect(store.seen(500)).toBe(false);
		expect(store.seen(501)).toBe(true);
	});
	test("budget charges to the limit, then refuses; days are separate", () => {
		const store = openGuestStore(openStore(tmpdb()).db);
		expect(store.tryChargeBudget(9, "2026-10-06", 2)).toBe(true);
		expect(store.tryChargeBudget(9, "2026-10-06", 2)).toBe(true);
		expect(store.tryChargeBudget(9, "2026-10-06", 2)).toBe(false);
		expect(store.tryChargeBudget(9, "2026-10-07", 2)).toBe(true);
	});
});

// ---------- GuestSink ----------

function fakeApi() {
	const edits: string[] = [];
	return {
		edits,
		answerGuestQuery: (async () => ({ inline_message_id: "im-1" })) as never,
		editMessageTextInline: (async (_id: string, text: string) => {
			edits.push(text);
			return true;
		}) as never,
		sendMessage: (async () => ({})) as never,
		sendChatAction: (async () => true) as never,
	};
}

describe("GuestSink", () => {
	test("deltas stream as edits, onDone flushes the final body", async () => {
		const api = fakeApi();
		const sink = new GuestSink(api as never, "im-1", 3500, 1);
		sink.onTextDelta("hello ");
		sink.onTextDelta("world");
		await new Promise((r) => setTimeout(r, 10));
		await sink.onDone({ kind: "completed" });
		expect(api.edits.length).toBeGreaterThanOrEqual(1);
		expect(api.edits[api.edits.length - 1]).toBe("hello world");
	});
	test("output past the cap truncates with a pointer", async () => {
		const api = fakeApi();
		const sink = new GuestSink(api as never, "im-1", 10, 1);
		sink.onTextDelta("0123456789ABCDEFGHIJ");
		await sink.onDone({ kind: "completed" });
		expect(api.edits[api.edits.length - 1]).toContain("0123456789");
		expect(api.edits[api.edits.length - 1]).toContain("capped");
	});
	test("a fenced turn stamps superseded on the displayed text", async () => {
		const api = fakeApi();
		const sink = new GuestSink(api as never, "im-1", 3500, 1);
		sink.onTextDelta("partial");
		await sink.onDone({ kind: "fenced" });
		expect(api.edits[api.edits.length - 1]).toContain("⏹ superseded");
		expect(api.edits[api.edits.length - 1]).toContain("partial");
	});
	test("a failed authority check stops mid-stream edits", async () => {
		const api = fakeApi();
		let ok = true;
		const sink = new GuestSink(api as never, "im-1", 3500, 1);
		sink.setAuthorityCheck(() => ok);
		sink.onTextDelta("first");
		await new Promise((r) => setTimeout(r, 10));
		ok = false;
		sink.onTextDelta(" second");
		await new Promise((r) => setTimeout(r, 10));
		const seen = [...api.edits];
		await sink.onDone({ kind: "fenced" });
		expect(seen.every((e) => !e.includes("second"))).toBe(true);
	});
});

// ---------- handlers ----------

interface Submitted {
	conv: Conversation;
	message: UIMessage;
	sink: TurnSink;
}

function makeEnv(over: { busy?: boolean; guest?: boolean } = {}) {
	const db = openStore(tmpdb());
	const store: ConversationStore = db;
	const guestStore = openGuestStore(db.db);
	const submitted: Submitted[] = [];
	const runtime = {
		hasActiveTurn: (_id: string) => over.busy === true,
		submit: (conv: Conversation, message: UIMessage, sink: TurnSink) => {
			submitted.push({ conv, message, sink });
			return true;
		},
	} as unknown as Runtime;
	const configRef: ConfigRef = {
		current: baseConfig({ ...(over.guest === false ? { guest: undefined } : {}) }),
		ttsDown: false,
	};
	const api = fakeApi();
	const env = {
		api,
		store,
		runtime,
		configRef,
		guestStore,
		botUsername: "goblin_bot",
		botUserId: 42,
	} as unknown as GuestEnv;
	return { env, api, guestStore, store, submitted, configRef };
}

const guestMsg = (
	over: Partial<Message> & { guest_query_id?: string },
): Message & { guest_query_id?: string } =>
	({
		message_id: 10,
		date: 0,
		chat: { id: -100, type: "group" },
		from: { id: 9, is_bot: false, first_name: "Friend" },
		text: "@goblin_bot what is 2+2",
		entities: [{ type: "mention", offset: 0, length: 11 }],
		...over,
	}) as Message & { guest_query_id?: string };

describe("handleGuestUpdate", () => {
	test("operator summons anywhere: personal turn, memory off, placeholder first", async () => {
		const { env, api, submitted } = makeEnv();
		await handleGuestUpdate(
			env,
			guestMsg({ from: { id: 7, is_bot: false, first_name: "Op" }, guest_query_id: "q1" }),
			1,
		);
		expect(submitted.length).toBe(1);
		const turn = submitted[0];
		expect(turn !== undefined).toBe(true);
		expect(turn?.conv.id).toBe("guest:-100:7");
		expect(turn?.conv.memoryExcluded).toBe(true);
		expect(turn?.conv.persona).toBe("personal");
		// The placeholder was answered before the submit (edits[0] is the
		// placeholder text the fake answerGuestQuery ignores; the sink's
		// edits ride the same api record).
		expect(api.edits.length).toBe(0);
	});
	test("third party in a closed chat: silence, no spend", async () => {
		const { env, submitted } = makeEnv();
		await handleGuestUpdate(env, guestMsg({ guest_query_id: "q2" }), 2);
		expect(submitted.length).toBe(0);
	});
	test("third party in an open chat: sandbox turn, budget charged", async () => {
		const { env, guestStore, submitted } = makeEnv();
		guestStore.open(-100, 7);
		await handleGuestUpdate(env, guestMsg({ guest_query_id: "q3" }), 3);
		expect(submitted.length).toBe(1);
		const turn = submitted[0];
		expect(turn !== undefined).toBe(true);
		expect(turn?.conv.id).toBe("guest:-100:9");
		expect(turn?.conv.persona).toBe("guest");
		expect(guestStore.tryChargeBudget(9, new Date().toLocaleDateString("sv-SE"), 0)).toBe(false);
	});
	test("budget exhaustion answers a refusal, never submits", async () => {
		const { env, guestStore, submitted } = makeEnv();
		guestStore.open(-100, 7);
		const day = new Date().toLocaleDateString("sv-SE");
		expect(guestStore.tryChargeBudget(9, day, 2)).toBe(true);
		expect(guestStore.tryChargeBudget(9, day, 2)).toBe(true);
		await handleGuestUpdate(env, guestMsg({ guest_query_id: "q4" }), 4);
		expect(submitted.length).toBe(0);
	});
	test("a busy conversation refuses instead of steering", async () => {
		const { env, guestStore, submitted } = makeEnv({ busy: true });
		guestStore.open(-100, 7);
		await handleGuestUpdate(env, guestMsg({ guest_query_id: "q5" }), 5);
		expect(submitted.length).toBe(0);
	});
	test("duplicate update ids are swallowed", async () => {
		const { env, submitted } = makeEnv();
		await handleGuestUpdate(
			env,
			guestMsg({ from: { id: 7, is_bot: false, first_name: "Op" }, guest_query_id: "q6" }),
			6,
		);
		await handleGuestUpdate(
			env,
			guestMsg({ from: { id: 7, is_bot: false, first_name: "Op" }, guest_query_id: "q6" }),
			6,
		);
		expect(submitted.length).toBe(1);
	});
	test("operator /open opens the chat and confirms; /off closes and fences", async () => {
		const { env, guestStore, store } = makeEnv();
		guestStore.open(-100, 7);
		store.resolve(guestAddress(-100, 9), "/w");
		await handleGuestUpdate(env, guestMsg({ guest_query_id: "q7" }), 7); // sandbox conversation exists
		await handleGuestUpdate(
			env,
			guestMsg({
				from: { id: 7, is_bot: false, first_name: "Op" },
				text: "@goblin_bot /off",
				guest_query_id: "q8",
			}),
			8,
		);
		expect(guestStore.isOpen(-100)).toBe(false);
		const conv = store.get("guest:-100:9");
		expect(conv !== null && conv.epoch > 0).toBe(true);
	});
	test("third-party /off attempts change nothing", async () => {
		const { env, guestStore } = makeEnv();
		guestStore.open(-100, 7);
		await handleGuestUpdate(env, guestMsg({ text: "@goblin_bot /off", guest_query_id: "q9" }), 9);
		expect(guestStore.isOpen(-100)).toBe(true);
	});
	test("feature off (no guest block): summons are silent", async () => {
		const { env, submitted } = makeEnv({ guest: false });
		await handleGuestUpdate(
			env,
			guestMsg({ from: { id: 7, is_bot: false, first_name: "Op" }, guest_query_id: "q10" }),
			10,
		);
		expect(submitted.length).toBe(0);
	});
	test("a failed answerGuestQuery never runs the turn blind", async () => {
		const { env, submitted } = makeEnv();
		(env.api as { answerGuestQuery: unknown }).answerGuestQuery = (async () => ({})) as never;
		await handleGuestUpdate(
			env,
			guestMsg({ from: { id: 7, is_bot: false, first_name: "Op" }, guest_query_id: "q11" }),
			11,
		);
		expect(submitted.length).toBe(0);
	});
	test("the operator is exempt from the budget", async () => {
		const { env, guestStore, submitted } = makeEnv();
		const day = new Date().toLocaleDateString("sv-SE");
		// Exhaust the limit for user 7 — the operator's summons still runs.
		expect(guestStore.tryChargeBudget(7, day, 2)).toBe(true);
		expect(guestStore.tryChargeBudget(7, day, 2)).toBe(true);
		await handleGuestUpdate(
			env,
			guestMsg({ from: { id: 7, is_bot: false, first_name: "Op" }, guest_query_id: "q12" }),
			12,
		);
		expect(submitted.length).toBe(1);
	});
	test("a persona flip busts the frozen prompt snapshot", async () => {
		const { env, guestStore, store } = makeEnv();
		guestStore.open(-100, 7);
		await handleGuestUpdate(env, guestMsg({ guest_query_id: "q13" }), 13); // sandbox conv
		// Flip: user 9 joins allowedUsers → same conversation, personal turn.
		env.configRef.current = {
			...env.configRef.current,
			allowedUsers: [7, 9],
		} as typeof env.configRef.current;
		await handleGuestUpdate(env, guestMsg({ guest_query_id: "q14" }), 14);
		const conv = store.get("guest:-100:9");
		expect(conv?.persona).toBe("personal");
		expect(store.promptSnapshot("guest:-100:9")).toBeNull();
	});
});

describe("routeMemberGuestMessage", () => {
	const memberMsg = (over: Partial<Message>): Message => guestMsg(over) as Message;

	test("operator messages fall through to normal intake", async () => {
		const { env } = makeEnv();
		expect(
			await routeMemberGuestMessage(
				env,
				memberMsg({ from: { id: 7, is_bot: false, first_name: "Op" }, text: "@goblin_bot hi" }),
				20,
			),
		).toBe(false);
	});
	test("non-mention chatter falls through (the gate drops it as today)", async () => {
		const { env } = makeEnv();
		guestStore_open(env);
		expect(
			await routeMemberGuestMessage(env, memberMsg({ text: "just talking", entities: [] }), 21),
		).toBe(false);
	});
	test("third-party mention in an open chat submits a sandbox turn with normal delivery", async () => {
		const { env, submitted } = makeEnv();
		guestStore_open(env);
		expect(await routeMemberGuestMessage(env, memberMsg({}), 22)).toBe(true);
		expect(submitted.length).toBe(1);
		const turn = submitted[0];
		expect(turn !== undefined).toBe(true);
		expect(turn?.conv.persona).toBe("guest");
	});
	test("third-party mention in a closed chat is swallowed with a deny log", async () => {
		const { env, submitted } = makeEnv();
		expect(await routeMemberGuestMessage(env, memberMsg({}), 23)).toBe(true);
		expect(submitted.length).toBe(0);
	});
	test("addressed /open from the operator opens; bare /open falls through", async () => {
		const { env, guestStore } = makeEnv();
		expect(
			await routeMemberGuestMessage(
				env,
				memberMsg({
					from: { id: 7, is_bot: false, first_name: "Op" },
					text: "/open@goblin_bot",
					entities: [{ type: "bot_command", offset: 0, length: 17 }],
				}),
				24,
			),
		).toBe(true);
		expect(guestStore.isOpen(-100)).toBe(true);
		expect(
			await routeMemberGuestMessage(
				env,
				memberMsg({
					from: { id: 7, is_bot: false, first_name: "Op" },
					text: "/open",
					entities: [{ type: "bot_command", offset: 0, length: 5 }],
				}),
				25,
			),
		).toBe(false);
	});
	test("a command suffix naming someone else does not open the chat", async () => {
		const { env, guestStore } = makeEnv();
		expect(
			await routeMemberGuestMessage(
				env,
				memberMsg({
					from: { id: 7, is_bot: false, first_name: "Op" },
					text: "/open @somehuman",
					entities: [{ type: "bot_command", offset: 0, length: 5 }],
				}),
				26,
			),
		).toBe(false);
		expect(guestStore.isOpen(-100)).toBe(false);
	});
	test("private chats fall through — the DM is not a guest chat", async () => {
		const { env, guestStore } = makeEnv();
		expect(
			await routeMemberGuestMessage(
				env,
				memberMsg({
					from: { id: 7, is_bot: false, first_name: "Op" },
					chat: { id: 7, type: "private" } as never,
					text: "/off@goblin_bot",
					entities: [{ type: "bot_command", offset: 0, length: 16 }],
				}),
				27,
			),
		).toBe(false);
		expect(guestStore.isOpen(-100)).toBe(false);
	});
	test("non-operator member /off is swallowed", async () => {
		const { env, guestStore } = makeEnv();
		guestStore.open(-100, 7);
		expect(await routeMemberGuestMessage(env, memberMsg({ text: "@goblin_bot /off" }), 28)).toBe(
			true,
		);
		expect(guestStore.isOpen(-100)).toBe(true);
	});
	test("a busy member conversation refuses instead of steering", async () => {
		const { env, guestStore, submitted } = makeEnv({ busy: true });
		guestStore.open(-100, 7);
		expect(await routeMemberGuestMessage(env, memberMsg({}), 29)).toBe(true);
		expect(submitted.length).toBe(0);
	});
	test("redelivered member commands never re-run", async () => {
		const { env, guestStore } = makeEnv();
		guestStore.open(-100, 7);
		const off = memberMsg({
			from: { id: 7, is_bot: false, first_name: "Op" },
			text: "@goblin_bot /off",
		});
		expect(await routeMemberGuestMessage(env, off, 30)).toBe(true);
		expect(guestStore.isOpen(-100)).toBe(false);
		// Re-open, then the SAME update id arrives again: nothing re-closes.
		guestStore.open(-100, 7);
		expect(await routeMemberGuestMessage(env, off, 30)).toBe(true);
		expect(guestStore.isOpen(-100)).toBe(true);
	});
});

function guestStore_open(env: { guestStore: { open(id: number, by: number): void } }): void {
	env.guestStore.open(-100, 7);
}

describe("sharedChatPart — the audience note", () => {
	test("an open group chat's bursts carry the note; closed and private chats don't", () => {
		const open = (_id: number): boolean => true;
		const closed = (_id: number): boolean => false;
		expect(sharedChatPart("topic:-100:5", -100, open)?.text).toContain("shared chat");
		expect(sharedChatPart("topic:-100:5", -100, closed)).toBeNull();
		// Private chats: a bot member chat IS the DM — never a shared room.
		expect(sharedChatPart("dm:7", 7, open)).toBeNull();
		// Guest conversations know their audience from the persona.
		expect(sharedChatPart("guest:-100:9", -100, open)).toBeNull();
	});
});

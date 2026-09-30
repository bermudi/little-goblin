import { afterEach, describe, expect, test } from "bun:test";
import type { Api } from "grammy";
import type { Config } from "../config.ts";
import { allowedUserGate, applyCommands, applyMenuButton, conversationAddress } from "./mod.ts";
import { COMMANDS } from "./commands.ts";

const baseConfig: Config = {
	providers: {
		zai: { kind: "openai-compatible", baseUrl: "https://api.example.com", auth: "zai" },
	},
	model: "zai/m",
	tts: false,
	favorites: [],
	thinking: "medium",
	allowedUsers: [1],
	telegram: {},
	http: { port: 8787 },
	logLevel: "info",
};

describe("allowedUserGate", () => {
	// The access-control boundary — everything else hangs off it.
	test("allowed ids pass; anyone else is dropped before the bot sees it", async () => {
		const configRef = { current: baseConfig };
		const gate = allowedUserGate(configRef);
		let reached = 0;
		const next = async (): Promise<void> => {
			reached++;
		};
		await gate({ from: { id: 1 } }, next);
		expect(reached).toBe(1);
		await gate({ from: { id: 2 } }, next); // not on the list
		expect(reached).toBe(1);
		await gate({}, next); // service update, no sender
		expect(reached).toBe(1);
		// Read per message: a mini-app save applies without a restart.
		configRef.current = { ...baseConfig, allowedUsers: [1, 2] };
		await gate({ from: { id: 2 } }, next);
		expect(reached).toBe(2);
	});
});

describe("applyCommands", () => {
	test("registers exactly the handled command set", async () => {
		const calls: unknown[] = [];
		const api = {
			setMyCommands: (cmds: unknown) => {
				calls.push(cmds);
				return Promise.resolve(true);
			},
		} as unknown as Api;

		applyCommands(api);
		await Promise.resolve();

		expect(calls).toEqual([[...COMMANDS]]);
	});
});

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


// ---------- handleMessage / flushConversation ----------
//
// The intake router and the coalescing flush, driven through explicit
// fakes: real store (SQLite in a tmpdir — the house pattern), fake Api,
// fake buffer. These tests pin the rulings that used to live only
// inside createBot's closures: command-vs-media precedence, the failed
// attachment sentinel, one-attempt titling, and the sink release.

import type { Message } from "grammy/types";
import type { UIMessage } from "ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type ConversationStore } from "../conversation.ts";
import type { Runtime, TurnSink } from "../runtime.ts";
import type { AuthStore } from "../auth.ts";
import { CoalescingBuffer } from "./buffer.ts";
import { flushConversation, handleMessage, handleMessageDurably, replayInbox, InboxRecordError, type IntakeEnv } from "./mod.ts";
import { openTelegramInbox } from "./inbox.ts";

let intakeDirs: string[] = [];
function tmpdb(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-intake-"));
	intakeDirs.push(dir);
	return join(dir, "goblin.sqlite");
}

afterEach(() => {
	for (const d of intakeDirs) rmSync(d, { recursive: true, force: true });
	intakeDirs = [];
});

function tgMsg(p: Record<string, unknown>): Message {
	return { date: 0, ...p } as unknown as Message;
}

interface RouterHarness {
	env: IntakeEnv;
	pushed: Array<{ conv: string; parts: UIMessage["parts"]; replyTo: number | undefined; updateId: number }>;
	apiCalls: Array<{ method: string; text?: string }>;
	stopped: string[];
	store: ConversationStore;
}

function routerHarness(config: Config = baseConfig): RouterHarness {
	const store = openStore(tmpdb());
	const pushed: RouterHarness["pushed"] = [];
	const apiCalls: RouterHarness["apiCalls"] = [];
	const stopped: string[] = [];
	const api = {
		getFile: (_id: string) => Promise.reject(new Error("file api down")),
		sendMessage: (_chat: unknown, text: string) => {
			apiCalls.push({ method: "sendMessage", text });
			return Promise.resolve({ message_id: apiCalls.length });
		},
		editMessageText: (_c: unknown, _m: unknown, text: string) => {
			apiCalls.push({ method: "editMessageText", text });
			return Promise.resolve(true);
		},
		editForumTopic: () => Promise.resolve(true),
		sendChatAction: () => Promise.resolve(true),
		sendVoice: () => Promise.resolve({ message_id: 1 }),
	} as unknown as IntakeEnv["api"];
	const buffer = {
		push: (conv: string, item: { parts: UIMessage["parts"]; replyTo: number | undefined; updateId: number }) => {
			pushed.push({ conv, parts: item.parts, replyTo: item.replyTo, updateId: item.updateId });
		},
	} as unknown as IntakeEnv["buffer"];
	const env: IntakeEnv = {
		deps: {
			configRef: { current: config, ttsDown: false },
			auth: {} as unknown as AuthStore,
			store,
			runtime: {
				submitPersisted: () => {},
				stop: (id: string) => {
					stopped.push(id);
					return { stopped: true, settled: Promise.resolve() };
				},
			} as unknown as Runtime,
			titleFor: () => Promise.resolve(null),
			transcribe: () => Promise.resolve(null),
			synthesize: () => Promise.resolve([]),
		},
		api,
		apiRoot: undefined,
		token: "t",
		botUsername: "goblin",
		titleAttempts: new Set<string>(),
		buffer,
		intake: new Map<string, Promise<void>>(),
		inbox: openTelegramInbox(store.db),
	};
	return { env, pushed, apiCalls, stopped, store };
}

function handleTestMessage(env: IntakeEnv, msg: Message): void {
	handleMessage(env, msg, msg.message_id);
}

let nextFlushUpdate = 100;
function flushTest(env: IntakeEnv, convId: string, items: Array<{parts: UIMessage["parts"]; replyTo?: number}>): void {
	const buffered = items.map((item) => {
		const updateId = nextFlushUpdate++;
		env.inbox.record(updateId, {
			conversationId: convId, chatId: -100, messageId: updateId,
			text: "", media: null, mediaError: null,
		});
		return { parts: item.parts, replyTo: item.replyTo, updateId };
	});
	flushConversation(env, convId, buffered);
}

describe("handleMessage", () => {
	test("a settings command without media is consumed — nothing reaches the buffer", () => {
		// tts on (the default) so /voice actually toggles — the observable
		// proof the command ran against meta, not just a reply.
		const h = routerHarness({
			...baseConfig,
			tts: { kind: "edge", voice: "en-US-AriaNeural" },
		});
		handleTestMessage(
			h.env,
			tgMsg({ message_id: 1, chat: { id: 1, type: "private" }, text: "/voice" }),
		);
		expect(h.pushed).toEqual([]);
		expect(h.env.intake.size).toBe(0);
		// The command really ran: the voice toggle and epoch bump landed.
		const conv = h.store.get("dm:1")!;
		expect(conv.voice).toBe(true);
		expect(conv.epoch).toBe(1);
	});

	test("a caption that looks like a command must not eat its media", async () => {
		const h = routerHarness();
		handleTestMessage(
			h.env,
			tgMsg({
				message_id: 2,
				chat: { id: 1, type: "private" },
				photo: [{ file_id: "f1", file_unique_id: "u1", width: 8, height: 8 }],
				caption: "/stop",
			}),
		);
		await h.env.intake.get("dm:1");
		// The command never ran (media wins), and intake kept going:
		// caption text + the failed-download sentinel, reply-anchored.
		expect(h.stopped).toEqual([]);
		expect(h.pushed).toHaveLength(1);
		expect(h.pushed[0]!.replyTo).toBe(2);
		expect(h.pushed[0]!.parts[0]).toEqual({ type: "text", text: "/stop" });
		expect(JSON.stringify(h.pushed[0]!.parts[1])).toContain(
			"[attachment failed to download:",
		);
	});

	test("malformed photo metadata becomes a failed attachment, not a dropped update", async () => {
		const h = routerHarness();
		handleTestMessage(h.env, tgMsg({
			message_id: 3,
			chat: { id: 1, type: "private" },
			photo: [null],
		}));
		await h.env.intake.get("dm:1");
		expect(h.pushed).toHaveLength(1);
		expect(h.pushed[0]!.parts[0]?.type).toBe("text");
		expect((h.pushed[0]!.parts[0] as { text: string }).text).toContain("[attachment failed to download:");
		h.store.close();
	});

	test("malformed document metadata is journaled as a failed attachment, not a boot loop", async () => {
		const h = routerHarness();
		handleMessage(h.env, tgMsg({
			message_id: 33,
			chat: { id: 1, type: "private" },
			document: { file_id: "f", file_unique_id: null },
		}), 330);
		expect(h.env.inbox.pending()[0]!.payload.media).toBeNull();
		expect(h.env.inbox.pending()[0]!.payload.mediaError).not.toBeNull();
		await h.env.intake.get("dm:1");
		expect(h.pushed[0]!.parts).toEqual([
			{ type: "text", text: expect.stringContaining("[attachment failed to download:") },
		]);
		h.store.close();
	});

	test("a message with neither text nor media is dropped", () => {
		const h = routerHarness();
		handleTestMessage(
			h.env,
			tgMsg({ message_id: 3, chat: { id: 1, type: "private" }, new_chat_title: "x" }),
		);
		expect(h.pushed).toEqual([]);
		expect(h.env.intake.size).toBe(0);
	});

	test("an unmatched /word falls through to a normal message", async () => {
		const h = routerHarness();
		handleTestMessage(
			h.env,
			tgMsg({ message_id: 4, chat: { id: 1, type: "private" }, text: "/notacommand" }),
		);
		await h.env.intake.get("dm:1");
		expect(h.pushed).toHaveLength(1);
		expect(h.pushed[0]!.parts).toEqual([{ type: "text", text: "/notacommand" }]);
	});
});

describe("flushConversation", () => {
	function topicHarness(config: Config) {
		const h = routerHarness(config);
		const conv = h.store.resolve({ kind: "topic", chatId: -100, threadId: 7 }, "/w");
		h.store.setMeta(conv.id, { title: "New Chat", titleImplicit: true });
		const titleCalls: string[] = [];
		const submitted: Array<{ conv: string; parts: UIMessage["parts"]; sink: TurnSink }> = [];
		h.env.deps = {
			...h.env.deps,
			titleFor: (text: string) => {
				titleCalls.push(text);
				return Promise.resolve(title === "" ? null : title);
			},
			runtime: {
				submitPersisted: (c: { id: string }, _m: unknown, s: TurnSink) => {
					submitted.push({ conv: c.id, parts: h.store.history(c.id).at(-1)!.parts, sink: s });
				},
			} as unknown as Runtime,
		};
		const setTitle = (t: string | null): void => {
			title = t ?? "";
		};
		return { h, conv, submitted, titleCalls, setTitle };
	}
	let title = "Titled";

	test("buffered text becomes one turn submit; the sentinel stays out of the title", async () => {
		const { h, conv, submitted, titleCalls } = topicHarness({
			...baseConfig,
			titleModel: "zai/t",
		});
		flushTest(h.env, conv.id, [
			{
				parts: [{ type: "text", text: "[attachment failed to download: boom]" }],
				replyTo: 5,
			},
			{ parts: [{ type: "text", text: "what did the photo say?" }], replyTo: 5 },
		]);
		await Bun.sleep(10);
		// The sentinel never became the topic's name.
		expect(titleCalls).toEqual(["what did the photo say?"]);
		expect(submitted).toHaveLength(1);
		expect(submitted[0]!.parts).toEqual([
			{ type: "text", text: "[attachment failed to download: boom]" },
			{ type: "text", text: "what did the photo say?" },
		]);
		// Sinks are constructed "typing" — close them.
		await submitted[0]!.sink.onDone({ kind: "completed" });
	});

	test("one titling attempt per topic per process — a failed attempt is not retried", async () => {
		const { h, conv, titleCalls, setTitle } = topicHarness({
			...baseConfig,
			titleModel: "zai/t",
		});
		setTitle(null); // first attempt: provider unusable
		flushTest(h.env, conv.id, [
			{ parts: [{ type: "text", text: "hello" }], replyTo: 1 },
		]);
		expect(titleCalls).toEqual(["hello"]);
		await Bun.sleep(10);
		setTitle("Titled");
		flushTest(h.env, conv.id, [
			{ parts: [{ type: "text", text: "again" }], replyTo: 2 },
		]);
		await Bun.sleep(10);
		// Attempt burned on the first flush — never retried this process.
		expect(titleCalls).toEqual(["hello"]);
		expect([...h.env.titleAttempts]).toContain(conv.id);
	});

	test("no titleModel configured — titling never fires, the turn still submits", async () => {
		const { h, conv, submitted, titleCalls } = topicHarness(baseConfig);
		flushTest(h.env, conv.id, [
			{ parts: [{ type: "text", text: "hello" }], replyTo: 1 },
		]);
		expect(titleCalls).toEqual([]);
		expect(submitted).toHaveLength(1);
		await submitted[0]!.sink.onDone({ kind: "completed" });
	});

	test("a submit failure rethrows and releases the sink with the error", async () => {
		const h = routerHarness(baseConfig);
		const conv = h.store.resolve({ kind: "dm", chatId: 9 }, "/w");
		let seen: TurnSink | null = null;
		h.env.deps = {
			...h.env.deps,
			runtime: {
				submitPersisted: (_c: unknown, _m: unknown, s: TurnSink) => {
					seen = s;
					throw new Error("queue closed");
				},
			} as unknown as Runtime,
		};
		expect(() =>
			flushTest(h.env, conv.id, [
				{ parts: [{ type: "text", text: "hi" }], replyTo: 1 },
			]),
		).toThrow("queue closed");
		expect(seen).not.toBeNull();
		// The sink was released (not left ghosting "typing…"): its error
		// path delivers the failure to Telegram.
		await Bun.sleep(10);
		expect(
			h.apiCalls.some((c) => c.method === "sendMessage" && c.text?.includes("queue closed")),
		).toBe(true);
		expect(h.env.inbox.pending()).toEqual([]); // commit precedes admission
	});

	test("a flush for a missing conversation fails without consuming its row", () => {
		const h = routerHarness(baseConfig);
		expect(() =>
			flushTest(h.env, "dm:404", [
				{ parts: [{ type: "text", text: "hi" }], replyTo: 1 },
			]),
		).toThrow("flush for missing conversation");
		expect(h.env.inbox.pending()).toHaveLength(1);
	});
});

describe("durable intake", () => {
	test("duplicate update is not enqueued twice; commands and service messages are not journaled", async () => {
		const h = routerHarness();
		const msg = tgMsg({ message_id: 50, chat: { id: 1, type: "private" }, text: "hello" });
		handleMessage(h.env, msg, 500);
		handleMessage(h.env, msg, 500);
		handleMessage(h.env, tgMsg({ message_id: 51, chat: msg.chat, text: "/stop" }), 501);
		handleMessage(h.env, tgMsg({ message_id: 52, chat: msg.chat, new_chat_title: "hi" }), 502);
		await h.env.intake.get("dm:1");
		expect(h.pushed).toHaveLength(1);
		expect(h.env.inbox.pending().map((e) => e.updateId)).toEqual([500]);
		h.store.close();
	});

	test("replay resolves persisted media and commits once before admitting a turn", async () => {
		const h = routerHarness();
		const msg = tgMsg({ message_id: 61, chat: { id: 1, type: "private" },
			caption: "look", photo: [{ file_id: "f", file_unique_id: "u", width: 8, height: 8 }] });
		handleMessage(h.env, msg, 601);
		expect(h.env.inbox.pending()).toEqual([{
			updateId: 601,
			payload: { conversationId: "dm:1", chatId: 1, messageId: 61, text: "look",
				media: { fileId: "f", fileUniqueId: "u", fileName: "photo-u.jpg", mimeType: "image/jpeg" },
				mediaError: null },
		}]);
		handleMessage(h.env, tgMsg({ message_id: 62, chat: { id: 1, type: "private" }, text: "after" }), 602);
		await h.env.intake.get("dm:1");
		// Simulate a restart after journaling but before flush: old buffered
		// parts are lost; replay uses only the normalized SQLite payload.
		const submitted: UIMessage[][] = [];
		h.env.deps.runtime = {
			submitPersisted: (conv: { id: string }, _m: unknown, sink: TurnSink) => {
				submitted.push(h.store.history(conv.id));
				void sink.onDone({ kind: "completed" });
			},
		} as unknown as Runtime;
		h.env.intake = new Map();
		h.env.buffer = new CoalescingBuffer(60_000,
			(id, items) => flushConversation(h.env, id, items), 120_000);
		await replayInbox(h.env);
		// Scheduling recovery is non-blocking: new polling can start while
		// a media download waits, but each conversation keeps its order.
		await Promise.all([...h.env.intake.values()]);
		h.env.buffer.drain();
		expect(submitted).toHaveLength(1);
		expect(submitted[0]).toHaveLength(1);
		expect(JSON.stringify(submitted[0])).toContain("[attachment failed to download:");
		expect(JSON.stringify(submitted[0])).toContain("after");
		expect(h.env.inbox.pending()).toEqual([]);
		await replayInbox(h.env);
		handleMessage(h.env, msg, 601); // Telegram redelivery after commit
		expect(submitted).toHaveLength(1);
		expect(h.store.history("dm:1")).toHaveLength(1);
		h.store.close();
	});

	test("failed history append rolls back inbox acknowledgement; retry commits exactly once", () => {
		const h = routerHarness();
		const conv = h.store.resolve({ kind: "dm", chatId: 1 }, "/w");
		h.env.inbox.record(700, { conversationId: conv.id, chatId: 1, messageId: 70,
			text: "retry", media: null, mediaError: null });
		const item = { updateId: 700, parts: [{ type: "text" as const, text: "retry" }], replyTo: 70 };
		const originalStore = h.store;
		h.env.deps.store = { ...originalStore, append: () => { throw new Error("disk failed"); } };
		expect(() => flushConversation(h.env, conv.id, [item])).toThrow("disk failed");
		expect(originalStore.history(conv.id)).toHaveLength(0);
		expect(h.env.inbox.pending()).toHaveLength(1);
		h.env.deps.store = originalStore;
		flushConversation(h.env, conv.id, [item]);
		expect(originalStore.history(conv.id)).toHaveLength(1);
		expect(h.env.inbox.pending()).toEqual([]);
		originalStore.close();
	});

	test("journal insert failure is a fatal-class synchronous error", () => {
		const h = routerHarness();
		h.store.db.run("DROP TABLE tg_inbox");
		expect(() => handleMessage(h.env, tgMsg({ message_id: 80,
			chat: { id: 1, type: "private" }, text: "hello" }), 800)).toThrow(InboxRecordError);
		expect(h.pushed).toHaveLength(0);
		h.store.close();
	});

	test("a conversation write failure before journaling also stops acknowledgement", () => {
		const h = routerHarness();
		h.env.deps.store = {
			...h.store,
			resolve: () => { throw new Error("database unavailable"); },
		};
		expect(() => handleMessageDurably(h.env, tgMsg({
			message_id: 81, chat: { id: 1, type: "private" }, text: "hello",
		}), 801)).toThrow(InboxRecordError);
		expect(h.env.inbox.pending()).toEqual([]);
		h.store.close();
	});

	test("recovery queues a stalled attachment without blocking a different chat", async () => {
		const h = routerHarness();
		const first = h.store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const other = h.store.resolve({ kind: "dm", chatId: 2 }, "/w");
		h.env.inbox.record(901, { conversationId: first.id, chatId: 1, messageId: 91,
			text: "", media: { fileId: "f", fileUniqueId: "u", fileName: "a.jpg", mimeType: "image/jpeg" },
			mediaError: null });
		h.env.inbox.record(902, { conversationId: first.id, chatId: 1, messageId: 92,
			text: "second", media: null, mediaError: null });
		h.env.inbox.record(903, { conversationId: other.id, chatId: 2, messageId: 93,
			text: "other", media: null, mediaError: null });
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });
		h.env.api.getFile = async () => {
			await gate;
			throw new Error("download unavailable");
		};
		await replayInbox(h.env); // only schedules; does not wait for getFile
		await Promise.resolve();
		await Promise.resolve();
		expect(h.pushed.map((item) => item.parts)).toEqual([[{ type: "text", text: "other" }]]);
		release();
		await Promise.all([...h.env.intake.values()]);
		expect(h.pushed.map((item) => item.conv)).toEqual(["dm:2", "dm:1", "dm:1"]);
		expect(h.pushed[2]!.parts).toEqual([{ type: "text", text: "second" }]);
		h.store.close();
	});
});

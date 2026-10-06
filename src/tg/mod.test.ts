import { afterEach, describe, expect, test } from "bun:test";
import type { Api } from "grammy";
import type { Config } from "../config.ts";
import { allowedUserGate, applyCommands, applyMenuButton, conversationAddress } from "./mod.ts";
import { COMMANDS, DM_COMMANDS } from "./commands.ts";

const baseConfig: Config = {
	providers: {
		zai: { kind: "openai-compatible", baseUrl: "https://api.example.com", auth: "zai" },
	},
	model: "zai/m",
	tts: false,
	favorites: [],
	thinking: "medium",
	allowedUsers: [1],
	telegram: { dmGapMinutes: 45 },
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
			setMyCommands: (cmds: unknown, options?: unknown) => {
				calls.push({ cmds, options });
				return Promise.resolve(true);
			},
		} as unknown as Api;

		applyCommands(api);
		await Promise.resolve();

		expect(calls).toEqual([
			{ cmds: [...COMMANDS], options: undefined },
			{ cmds: [...DM_COMMANDS], options: { scope: { type: "all_private_chats" } } },
		]);
	});
});

describe("conversationAddress", () => {
	// Rolling DM: private chats always address the dm lane — DM topics
	// are retired, so a thread id on a private message is ignored.
	test("private chat with thread id is the rolling dm lane", () => {
		expect(
			conversationAddress({ chat: { id: 42, type: "private" }, message_thread_id: 7 }),
		).toEqual({ kind: "dm", chatId: 42 });
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
import { openPings, type PingStore } from "./pings.ts";

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

const nullSink: TurnSink = {
	onTextDelta: () => {},
	onReasoningDelta: () => {},
	onToolCall: () => {},
	onDone: () => {},
};

interface RouterHarness {
	env: IntakeEnv;
	pushed: Array<{ conv: string; parts: UIMessage["parts"]; replyTo: number | undefined; updateId: number }>;
	apiCalls: Array<{ method: string; text?: string; chat?: unknown }>;
	stopped: string[];
	store: ConversationStore;
	pings: PingStore;
	bellConvs: string[];
}

function routerHarness(config: Config = baseConfig): RouterHarness {
	const store = openStore(tmpdb());
	const pushed: RouterHarness["pushed"] = [];
	const apiCalls: RouterHarness["apiCalls"] = [];
	const stopped: string[] = [];
	const pings = openPings(store.db);
	const bellConvs: string[] = [];
	const api = {
		getFile: (_id: string) => Promise.reject(new Error("file api down")),
		sendMessage: (chat: unknown, text: string) => {
			apiCalls.push({ method: "sendMessage", text, chat });
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
				busy: () => false,
				stop: (id: string) => {
					stopped.push(id);
					return { stopped: true, settled: Promise.resolve(), reviewsCancelled: 0 };
				},
				cancelFenced: (id: string) => {
					stopped.push(id);
					return { stopped: true, settled: Promise.resolve(), reviewsCancelled: 0 };
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
		pings,
		bell: (conv) => {
			bellConvs.push(conv.id);
			return nullSink;
		},
	};
	return { env, pushed, apiCalls, stopped, store, pings, bellConvs };
}

function handleTestMessage(env: IntakeEnv, msg: Message): void {
	handleMessage(env, msg, msg.message_id);
}

let nextFlushUpdate = 100;
function flushTest(
	env: IntakeEnv,
	convId: string,
	items: Array<{parts: UIMessage["parts"]; replyTo?: number; chatId?: number; quoted?: { messageId: number; text: string }}>,
): void | Promise<void> {
	const buffered = items.map((item) => {
		const updateId = nextFlushUpdate++;
		env.inbox.record(updateId, {
			conversationId: convId, chatId: item.chatId ?? -100, messageId: updateId,
			text: "", media: null, mediaError: null,
		});
		return {
			parts: item.parts, replyTo: item.replyTo, updateId,
			chatId: item.chatId ?? -100,
			...(item.quoted !== undefined ? { quoted: item.quoted } : {}),
		};
	});
	return flushConversation(env, convId, buffered);
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
		// The command really ran: the voice toggle and epoch bump landed —
		// on the rolling conversation /voice rolled into, not a legacy id.
		const conv = h.store.get(h.store.currentDm(1)!.id)!;
		expect(conv.id).toBe("dm:1:1");
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

	test("a command failure is answered, not promoted to InboxRecordError", async () => {
		const h = routerHarness();
		h.env.deps.runtime = {
			stop: () => {
				throw new Error("runtime wedged");
			},
		} as unknown as Runtime;
		// Commands are never inbox-recorded, so a throw inside one is an
		// operator-facing failure — logged and replied — not the fatal
		// intake class.
		expect(() =>
			handleMessageDurably(
				h.env,
				tgMsg({ message_id: 9, chat: { id: 1, type: "private" }, text: "/stop" }),
				900,
			),
		).not.toThrow();
		await Promise.resolve();
		expect(h.pushed).toEqual([]);
		expect(h.env.inbox.pending()).toEqual([]);
		expect(
			h.apiCalls.some(
				(c) => c.method === "sendMessage" && c.text?.includes("command failed: runtime wedged"),
			),
		).toBe(true);
		h.store.close();
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

describe("ping replies (Spin-off)", () => {
	// A swipe-reply to a delegation ping routes into the app
	// conversation that rang — the lane IS that id, the quoted ping
	// text never becomes a part.
	test("a reply to a recorded ping routes into the app conversation", async () => {
		const h = routerHarness();
		const src = h.store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const app = h.store.forkToApp(src.id, "spun-1", "/w", "the work");
		h.pings.record(1, 99, app.id);
		handleTestMessage(
			h.env,
			tgMsg({
				message_id: 7,
				chat: { id: 1, type: "private" },
				text: "looks good",
				reply_to_message: { message_id: 99, text: "the work: deployed" },
			}),
		);
		await h.env.intake.get(app.id);
		expect(h.env.inbox.pending()[0]!.payload.conversationId).toBe(app.id);
		expect(h.pushed.map((p) => p.conv)).toEqual([app.id]);
		expect(h.pushed[0]!.parts).toEqual([{ type: "text", text: "looks good" }]);
		h.store.close();
	});

	// The app lane's flush: commit, a delivery-only "sent to" ack on
	// the DM, and a headless submit — the bell rings back when the
	// turn lands. No topic titling exists on this lane to attempt.
	test("the app flush acks the DM and submits with the bell sink", async () => {
		const h = routerHarness({ ...baseConfig, titleModel: "zai/t" });
		const app = h.store.forkToApp(
			h.store.resolve({ kind: "dm", chatId: 1 }, "/w").id,
			"spun-1",
			"/w",
			"the work",
		);
		const submitted: Array<{ conv: string; sink: TurnSink }> = [];
		h.env.deps = {
			...h.env.deps,
			runtime: {
				submitPersisted: (c: { id: string }, _m: unknown, s: TurnSink) => {
					submitted.push({ conv: c.id, sink: s });
				},
				busy: () => false,
			} as unknown as Runtime,
		};
		flushTest(h.env, app.id, [
			{ parts: [{ type: "text", text: "looks good" }], replyTo: 7, chatId: 1 },
		]);
		await Bun.sleep(10);
		expect(
			h.apiCalls.some(
				(c) => c.method === "sendMessage" && c.chat === 1 && c.text === "sent to the work",
			),
		).toBe(true);
		expect(submitted).toHaveLength(1);
		expect(submitted[0]!.sink).toBe(nullSink); // the bell, never a delivery sink
		expect(h.bellConvs).toEqual([app.id]);
		expect(h.env.titleAttempts.size).toBe(0);
		// The reply is real history on the app side — no quoted part.
		expect(h.store.history(app.id).at(-1)!.parts).toEqual([
			{ type: "text", text: "looks good" },
		]);
		h.store.close();
	});

	// A ping whose app conversation was deleted degrades to the
	// ordinary reply path: DM lane, quote leading the parts.
	test("a deleted ping target falls back to ordinary reply routing", async () => {
		const h = routerHarness();
		h.pings.record(1, 99, "app/gone-forever");
		handleTestMessage(
			h.env,
			tgMsg({
				message_id: 8,
				chat: { id: 1, type: "private" },
				text: "and?",
				reply_to_message: { message_id: 99, text: "old ping" },
			}),
		);
		await h.env.intake.get("dm:1");
		expect(h.pushed.map((p) => p.conv)).toEqual(["dm:1"]);
		expect((h.pushed[0]!.parts[0] as { text: string }).text).toBe('[replying to: "old ping"]');
		h.store.close();
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

	test("a submit failure after commit releases the sink with the error — never rethrown", async () => {
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
		// The batch committed before admission failed, so a rethrow would
		// make the buffer retry forever against already-consumed rows.
		// dm:9 is a rolling lane — the flush is async.
		await flushTest(h.env, conv.id, [
			{ parts: [{ type: "text", text: "hi" }], replyTo: 1 },
		]);
		expect(seen).not.toBeNull();
		// The sink was released (not left ghosting "typing…"): its error
		// path delivers the failure to Telegram.
		await Bun.sleep(10);
		expect(
			h.apiCalls.some((c) => c.method === "sendMessage" && c.text?.includes("queue closed")),
		).toBe(true);
		expect(h.env.inbox.pending()).toEqual([]); // commit precedes admission
	});

	test("a failed commit builds no sink — no typing ping, no error bubble", async () => {
		const h = routerHarness(baseConfig);
		const conv = h.store.resolve({ kind: "dm", chatId: 1 }, "/w");
		let pings = 0;
		h.env.api = {
			...h.env.api,
			sendChatAction: () => {
				pings++;
				return Promise.resolve(true);
			},
		} as unknown as Api;
		h.env.inbox.record(710, { conversationId: conv.id, chatId: 1, messageId: 71,
			text: "hi", media: null, mediaError: null });
		h.env.deps.store = { ...h.store, append: () => { throw new Error("disk failed"); } };
		// dm:1 is a rolling lane — the flush is async and the failure is a rejection.
		await expect(
			flushConversation(h.env, conv.id, [
				{ updateId: 710, parts: [{ type: "text", text: "hi" }], replyTo: 71, chatId: 1 },
			]) as Promise<void>,
		).rejects.toThrow("disk failed");
		await Bun.sleep(10);
		expect(pings).toBe(0);
		// The roll marker is the only send — the roll happened even though
		// the batch's history append did not.
		expect(h.apiCalls.filter((c) => c.method === "sendMessage").map((c) => c.text)).toEqual([
			"— new conversation —",
		]);
		expect(h.env.inbox.pending()).toHaveLength(1); // retained for retry
		h.store.close();
	});

	test("a flush for a missing conversation fails without consuming its row", () => {
		const h = routerHarness(baseConfig);
		expect(() =>
			flushTest(h.env, "dm:-404", [
				{ parts: [{ type: "text", text: "hi" }], replyTo: 1 },
			]),
		).toThrow("flush for missing conversation");
		expect(h.env.inbox.pending()).toHaveLength(1);
	});

	test("a ping reply to a deleted app conversation is tombstoned and acked, not retried", () => {
		const h = routerHarness(baseConfig);
		expect(() =>
			flushTest(h.env, "app/gone", [
				{ parts: [{ type: "text", text: "hi" }], replyTo: 1, chatId: 7 },
			]),
		).not.toThrow();
		// The rows are consumed — no 5-minute retry ladder, no boot replay.
		expect(h.env.inbox.pending()).toHaveLength(0);
		// The DM learns the reply never landed instead of waiting for an
		// ack that would never come.
		expect(h.apiCalls.filter((c) => c.method === "sendMessage").map((c) => c.text)).toEqual([
			"not sent — that app conversation was deleted",
		]);
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
			busy: () => false,
		} as unknown as Runtime;
		h.env.intake = new Map();
		h.env.buffer = new CoalescingBuffer(60_000,
			(id, items) => flushConversation(h.env, id, items), 120_000);
		await replayInbox(h.env);
		// Scheduling recovery is non-blocking: new polling can start while
		// a media download waits, but each conversation keeps its order.
		await Promise.all([...h.env.intake.values()]);
		await h.env.buffer.drain();
		expect(submitted).toHaveLength(1);
		expect(submitted[0]).toHaveLength(1);
		expect(JSON.stringify(submitted[0])).toContain("[attachment failed to download:");
		expect(JSON.stringify(submitted[0])).toContain("after");
		expect(h.env.inbox.pending()).toEqual([]);
		await replayInbox(h.env);
		handleMessage(h.env, msg, 601); // Telegram redelivery after commit
		expect(submitted).toHaveLength(1);
		// dm:1 is a rolling lane — the replayed batch rolled into dm:1:1.
		expect(h.store.history("dm:1:1")).toHaveLength(1);
		h.store.close();
	});

	test("failed history append rolls back inbox acknowledgement; retry commits exactly once", async () => {
		const h = routerHarness();
		// dm:1 is a rolling lane — the flush routes to dm:1:1.
		h.env.inbox.record(700, { conversationId: "dm:1", chatId: 1, messageId: 70,
			text: "retry", media: null, mediaError: null });
		const item = { updateId: 700, parts: [{ type: "text" as const, text: "retry" }], replyTo: 70, chatId: 1 };
		const originalStore = h.store;
		h.env.deps.store = { ...originalStore, append: () => { throw new Error("disk failed"); } };
		await expect(
			flushConversation(h.env, "dm:1", [item]) as Promise<void>,
		).rejects.toThrow("disk failed");
		expect(originalStore.history("dm:1:1")).toHaveLength(0);
		expect(h.env.inbox.pending()).toHaveLength(1);
		h.env.deps.store = originalStore;
		await flushConversation(h.env, "dm:1", [item]);
		expect(originalStore.history("dm:1:1")).toHaveLength(1);
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
		// Topic lanes still resolve eagerly at intake; private chats do
		// not (the rolling lane defers routing to the flush).
		expect(() => handleMessageDurably(h.env, tgMsg({
			message_id: 81,
			chat: { id: -100, type: "supergroup" },
			message_thread_id: 7, is_topic_message: true, text: "hello",
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

describe("rolling dm", () => {
	test("a private message carrying a thread id still lands in the rolling lane", async () => {
		const h = routerHarness();
		handleTestMessage(h.env, tgMsg({
			message_id: 40, chat: { id: 7, type: "private" },
			message_thread_id: 5, text: "hello",
		}));
		await h.env.intake.get("dm:7");
		// The lane key is the rolling address; the dm:<chat>:<n>
		// conversation is chosen at flush.
		expect(h.pushed.map((p) => p.conv)).toEqual(["dm:7"]);
		await flushTest(h.env, "dm:7", [
			{ parts: [{ type: "text", text: "hello" }], replyTo: 40 },
		]);
		const current = h.store.currentDm(7)!;
		expect(current.id).toBe("dm:7:1");
		expect(h.store.history(current.id).at(-1)?.parts).toEqual([
			{ type: "text", text: "hello" },
		]);
		h.store.close();
	});

	test("a rolled flush sends the boundary marker before the turn's delivery", async () => {
		const h = routerHarness();
		// submitPersisted stands in for the turn's first Telegram write —
		// the marker must already be on the wire when it runs.
		h.env.deps.runtime = {
			submitPersisted: (_c: unknown, _m: unknown, _s: TurnSink) => {
				void h.env.api.sendMessage(7, "turn output");
			},
			busy: () => false,
		} as unknown as Runtime;
		await flushTest(h.env, "dm:7", [
			{ parts: [{ type: "text", text: "hello" }], replyTo: 1 },
		]);
		const sends = h.apiCalls.filter((c) => c.method === "sendMessage").map((c) => c.text);
		expect(sends[0]).toBe("— new conversation —");
		expect(sends[1]).toBe("turn output");
		h.store.close();
	});

	test("a quoted reply's context leads the parts", async () => {
		const h = routerHarness();
		handleTestMessage(h.env, tgMsg({
			message_id: 40, chat: { id: 7, type: "private" }, text: "yep",
			reply_to_message: { message_id: 39, text: "come back?" },
		}));
		await h.env.intake.get("dm:7");
		expect(h.pushed[0]!.parts[0]).toEqual({ type: "text", text: '[replying to: "come back?"]' });
		expect(h.pushed[0]!.parts[1]).toEqual({ type: "text", text: "yep" });
		h.store.close();
	});

	test("a reply target that is the topic root is thread plumbing, not a reply", async () => {
		// dmGapMinutes 0 makes every flush past the gap — the check is
		// the only path a plain burst can take.
		const h = routerHarness({ ...baseConfig, telegram: { dmGapMinutes: 0 } });
		const calls: unknown[] = [];
		h.env.deps.followUpGate = () => ({
			decide: (state: string) => {
				calls.push(state);
				return Promise.resolve({ answers: { follow_up: 0.9 }, inputTokens: null, cost: null });
			},
		});
		h.store.append(h.store.rollDm(7, "/w").id, [
			{ id: "u", role: "user", parts: [{ type: "text", text: "q" }] },
			{ id: "a", role: "assistant", parts: [{ type: "text", text: "a" }] },
		]); // dm:7:1 — current, answered once, past the gap
		handleTestMessage(h.env, tgMsg({
			message_id: 40, chat: { id: 7, type: "private" },
			message_thread_id: 5,
			// The thread's root service message — Telegram reports it as
			// reply_to_message on ordinary messages in a threaded chat.
			reply_to_message: { message_id: 5, text: "" },
			text: "a fresh thought",
		}));
		await h.env.intake.get("dm:7");
		// No quoted context was journaled or projected.
		expect(h.env.inbox.pending()[0]?.payload.quoted).toBeUndefined();
		expect(h.pushed[0]!.parts).toEqual([{ type: "text", text: "a fresh thought" }]);
		await flushTest(h.env, "dm:7", [
			{ parts: [{ type: "text", text: "a fresh thought" }], replyTo: 40 },
		]);
		// Past the gap and NOT a reply — the follow-up check ran.
		expect(calls).toHaveLength(1);
		expect(h.store.currentDm(7)?.id).toBe("dm:7:1");
		h.store.close();
	});

	test("a reply past the gap joins without asking the gate", async () => {
		// dmGapMinutes 0 makes every flush past the gap.
		const h = routerHarness({ ...baseConfig, telegram: { dmGapMinutes: 0 } });
		const calls: unknown[] = [];
		h.env.deps.followUpGate = () => ({
			decide: (state: string) => {
				calls.push(state);
				return Promise.resolve({ answers: { follow_up: 0.1 }, inputTokens: null, cost: null });
			},
		});
		h.store.rollDm(7, "/w"); // dm:7:1 is current, now past the gap
		await flushTest(h.env, "dm:7", [
			{ parts: [{ type: "text", text: "and this too" }], replyTo: 9,
				quoted: { messageId: 8, text: "earlier" } },
		]);
		expect(calls).toHaveLength(0);
		expect(h.store.currentDm(7)?.id).toBe("dm:7:1"); // joined, not rolled
		expect(h.store.history("dm:7:1").at(-1)?.parts).toEqual([
			{ type: "text", text: "and this too" },
		]);
		h.store.close();
	});
});

describe("manual DM navigation", () => {
	const chat = { id: 7, type: "private" } as const;
	function batch(h: RouterHarness) {
		return h.pushed.map((item) => ({ ...item, chatId: chat.id }));
	}

	test("/new is immediate while busy, stops the outgoing turn, and preserves its history", () => {
		const h = routerHarness();
		const old = h.store.rollDm(chat.id, "/w");
		h.store.append(old.id, [{ id: "old", role: "user", parts: [{ type: "text", text: "politics" }] }]);
		h.env.deps.runtime.busy = () => true;
		handleMessage(h.env, tgMsg({ message_id: 10, chat, text: "/new" }), 10);
		expect(h.stopped).toEqual([old.id]);
		expect(h.store.currentDm(chat.id)?.id).toBe("dm:7:2");
		expect(h.store.history(old.id)).toHaveLength(1);
		expect(h.store.history("dm:7:2")).toEqual([]);
		expect(h.pushed).toEqual([]);
		expect(h.apiCalls.at(-1)?.text).toBe("— new conversation —");
		// Redelivery is not another manual /new.
		handleMessage(h.env, tgMsg({ message_id: 10, chat, text: "/new" }), 10);
		expect(h.store.currentDm(chat.id)?.id).toBe("dm:7:2");
		expect(h.stopped).toEqual([old.id]);
		h.store.close();
	});

	test("/back steps back without replay, and /new keeps ids unique after returning", () => {
		const h = routerHarness();
		const first = h.store.rollDm(chat.id, "/w");
		h.store.rollDm(chat.id, "/w");
		h.store.rollDm(chat.id, "/w");
		handleMessage(h.env, tgMsg({ message_id: 10, chat, text: "/back" }), 10);
		handleMessage(h.env, tgMsg({ message_id: 11, chat, text: "/back@goblin" }), 11);
		expect(h.store.currentDm(chat.id)?.id).toBe(first.id);
		expect(h.stopped).toEqual(["dm:7:3", "dm:7:2"]);
		expect(h.pushed).toEqual([]);
		handleMessage(h.env, tgMsg({ message_id: 12, chat, text: "/new" }), 12);
		expect(h.store.currentDm(chat.id)?.id).toBe("dm:7:4");
		handleMessage(h.env, tgMsg({ message_id: 13, chat, text: "/back" }), 13);
		expect(h.store.currentDm(chat.id)?.id).toBe(first.id);
		expect(h.store.get("dm:7:2")).not.toBeNull();
		expect(h.store.get("dm:7:3")).not.toBeNull();
		h.store.close();
	});

	test("/back before any conversation changes nothing", () => {
		const h = routerHarness();
		handleMessage(h.env, tgMsg({ message_id: 10, chat, text: "/back" }), 10);
		expect(h.store.currentDm(chat.id)).toBeNull();
		expect(h.stopped).toEqual([]);
		expect(h.pushed).toEqual([]);
		expect(h.apiCalls.at(-1)?.text).toBe("no earlier conversation");
		h.store.close();
	});

	test("group/topic navigation is rejected before creating or stopping a conversation", () => {
		const h = routerHarness();
		for (const text of ["/new", "/back"]) {
			handleMessage(h.env, tgMsg({
				message_id: text === "/new" ? 10 : 11,
				chat: { id: -100, type: "supergroup" },
				message_thread_id: 5, is_topic_message: true, text,
			}), text === "/new" ? 10 : 11);
		}
		expect(h.store.get("topic:-100:5")).toBeNull();
		expect(h.stopped).toEqual([]);
		expect(h.pushed).toEqual([]);
		expect(h.apiCalls.map((call) => call.text)).toEqual([
			"/new and /back work only in our private chat — group topics keep their own conversations.",
			"/new and /back work only in our private chat — group topics keep their own conversations.",
		]);
		h.store.close();
	});

	test("other-bot commands make no routing changes, including unknown commands", async () => {
		const h = routerHarness({ ...baseConfig, telegram: { dmGapMinutes: 0 } });
		for (const [i, text] of ["/new@otherbot", "/back@otherbot", "/voice@otherbot", "/unknown@otherbot"].entries()) {
			handleMessage(h.env, tgMsg({ message_id: 10 + i, chat, text }), 10 + i);
		}
		await Promise.all([...h.env.intake.values()]);
		expect(h.store.currentDm(chat.id)).toBeNull();
		expect(h.stopped).toEqual([]);
		expect(h.pushed).toEqual([]);
		expect(h.apiCalls).toEqual([]);
		h.store.close();
	});

	test("buffered pre-command input stays in old history, never the fresh prompt", async () => {
		const h = routerHarness();
		const old = h.store.rollDm(chat.id, "/w");
		let submits = 0;
		h.env.deps.runtime.submitPersisted = () => { submits++; return true; };
		handleMessage(h.env, tgMsg({ message_id: 9, chat, text: "old question" }), 9);
		await h.env.intake.get("dm:7");
		handleMessage(h.env, tgMsg({ message_id: 10, chat, text: "/new" }), 10);
		await flushConversation(h.env, "dm:7", batch(h));
		expect(h.store.history(old.id)[0]?.parts).toEqual([{ type: "text", text: "old question" }]);
		expect(h.store.history("dm:7:2")).toEqual([]);
		expect(h.env.inbox.pending()).toEqual([]);
		expect(submits).toBe(0);
		h.store.close();
	});

	test("navigation during a follow-up check cannot reroll the pin or execute archived input", async () => {
		const h = routerHarness({ ...baseConfig, telegram: { dmGapMinutes: 0 } });
		const old = h.store.rollDm(chat.id, "/w");
		// An answered exchange — without one the burst never reaches the check.
		h.store.append(old.id, [
			{ id: "u", role: "user", parts: [{ type: "text", text: "q" }] },
			{ id: "a", role: "assistant", parts: [{ type: "text", text: "a" }] },
		]);
		let entered: () => void = () => {};
		let release: () => void = () => {};
		const checking = new Promise<void>((resolve) => { entered = resolve; });
		const held = new Promise<void>((resolve) => { release = resolve; });
		h.env.deps.followUpGate = () => ({
			async decide() {
				entered();
				await held;
				return { answers: { follow_up: 0.01 }, inputTokens: 1, cost: 0 };
			},
		});
		let submits = 0;
		h.env.deps.runtime.submitPersisted = () => { submits++; return true; };
		handleMessage(h.env, tgMsg({ message_id: 9, chat, text: "old question" }), 9);
		await h.env.intake.get("dm:7");
		const flushing = flushConversation(h.env, "dm:7", batch(h));
		await checking;
		handleMessage(h.env, tgMsg({ message_id: 10, chat, text: "/new" }), 10);
		// Away and back makes id comparison alone insufficient.
		handleMessage(h.env, tgMsg({ message_id: 11, chat, text: "/back" }), 11);
		release();
		await flushing;
		expect(h.store.currentDm(chat.id)?.id).toBe(old.id);
		expect(h.store.get("dm:7:3")).toBeNull();
		expect(h.store.history(old.id)).toHaveLength(3);
		expect(submits).toBe(0);
		h.store.close();
	});

	test("navigation while the automatic boundary marker is pending prevents late admission", async () => {
		const h = routerHarness();
		let entered: () => void = () => {};
		let release: () => void = () => {};
		const sending = new Promise<void>((resolve) => { entered = resolve; });
		const held = new Promise<void>((resolve) => { release = resolve; });
		h.env.api.sendMessage = (async (_chat: unknown, text: string) => {
			if (text === "— new conversation —") { entered(); await held; }
			return { message_id: 1 };
		}) as unknown as IntakeEnv["api"]["sendMessage"];
		let submits = 0;
		h.env.deps.runtime.submitPersisted = () => { submits++; return true; };
		handleMessage(h.env, tgMsg({ message_id: 9, chat, text: "old question" }), 9);
		await h.env.intake.get("dm:7");
		const flushing = flushConversation(h.env, "dm:7", batch(h));
		await sending;
		handleMessage(h.env, tgMsg({ message_id: 10, chat, text: "/new" }), 10);
		release();
		await flushing;
		expect(h.store.currentDm(chat.id)?.id).toBe("dm:7:2");
		expect(h.store.history("dm:7:1")).toHaveLength(1);
		expect(h.store.history("dm:7:2")).toEqual([]);
		expect(submits).toBe(0);
		h.store.close();
	});

	test("held pre-command media is archived while post-command text enters only the new conversation", async () => {
		const h = routerHarness();
		const old = h.store.rollDm(chat.id, "/w");
		let entered: () => void = () => {};
		let release: () => void = () => {};
		const downloading = new Promise<void>((resolve) => { entered = resolve; });
		const held = new Promise<void>((resolve) => { release = resolve; });
		h.env.api.getFile = async () => {
			entered();
			await held;
			throw new Error("synthetic download failure");
		};
		const targets: string[] = [];
		h.env.deps.runtime.submitPersisted = (conv, _message, sink) => {
			targets.push(conv.id);
			void sink.onDone({ kind: "completed" });
			return true;
		};
		handleMessage(h.env, tgMsg({
			message_id: 9, chat, caption: "old photo",
			photo: [{ file_id: "f", file_unique_id: "u", width: 8, height: 8 }],
		}), 9);
		await downloading;
		handleMessage(h.env, tgMsg({ message_id: 10, chat, text: "/new" }), 10);
		handleMessage(h.env, tgMsg({ message_id: 11, chat, text: "new question" }), 11);
		release();
		await h.env.intake.get("dm:7");
		await flushConversation(h.env, "dm:7", batch(h));
		expect(JSON.stringify(h.store.history(old.id))).toContain("old photo");
		expect(h.store.history("dm:7:2")[0]?.parts).toEqual([{ type: "text", text: "new question" }]);
		expect(targets).toEqual(["dm:7:2"]);
		expect(h.env.inbox.pending()).toEqual([]);
		h.store.close();
	});

	test("boot replay honours the durable history-only assignment without starting a turn", async () => {
		const h = routerHarness();
		const old = h.store.rollDm(chat.id, "/w");
		handleMessage(h.env, tgMsg({ message_id: 9, chat, text: "old question" }), 9);
		await h.env.intake.get("dm:7");
		handleMessage(h.env, tgMsg({ message_id: 10, chat, text: "/new" }), 10);
		const filename = h.store.db.filename;
		h.store.close();
		const reopened = openStore(filename);
		h.env.deps.store = reopened;
		h.env.inbox = openTelegramInbox(reopened.db);
		h.env.pings = openPings(reopened.db);
		h.env.intake = new Map();
		h.env.buffer = new CoalescingBuffer(60_000,
			(id, items) => flushConversation(h.env, id, items), 120_000);
		let submits = 0;
		h.env.deps.runtime.submitPersisted = () => { submits++; return true; };
		await replayInbox(h.env);
		await Promise.all([...h.env.intake.values()]);
		await h.env.buffer.drain();
		expect(reopened.history(old.id)[0]?.parts).toEqual([{ type: "text", text: "old question" }]);
		expect(reopened.history("dm:7:2")).toEqual([]);
		expect(submits).toBe(0);
		expect(h.env.inbox.pending()).toEqual([]);
		reopened.close();
	});

	test("navigation persistence failure rolls back the selection and prevents update acknowledgement", async () => {
		const h = routerHarness();
		handleMessage(h.env, tgMsg({ message_id: 10, chat, text: "/new" }), 10);
		const old = h.store.currentDm(chat.id)!;
		handleMessage(h.env, tgMsg({ message_id: 11, chat, text: "pending" }), 11);
		await h.env.intake.get("dm:7");
		h.store.db.run(`CREATE TRIGGER reject_navigation BEFORE INSERT ON tg_dm_navigation
			BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END`);
		expect(() => handleMessageDurably(h.env, tgMsg({ message_id: 12, chat, text: "/new" }), 12))
			.toThrow(InboxRecordError);
		expect(h.store.currentDm(chat.id)?.id).toBe(old.id);
		expect(h.store.get("dm:7:2")).toBeNull();
		expect(h.env.inbox.archivedTarget(11, "dm:7")).toBeNull();
		expect(h.env.inbox.pending().map((row) => row.updateId)).toEqual([11]);
		expect(h.stopped).toEqual([]);
		h.store.close();
	});

	for (const multipleArchives of [false, true]) {
		test(`partial flush failure retries only pending rows${multipleArchives ? " across multiple archive targets" : ""}`, async () => {
			const h = routerHarness();
			h.store.rollDm(chat.id, "/w");
			const targets: string[] = [];
			h.env.deps.runtime.submitPersisted = (conv, _message, sink) => {
				targets.push(conv.id);
				void sink.onDone({ kind: "completed" });
				return true;
			};
			h.env.buffer = new CoalescingBuffer(60_000,
				(id, items) => flushConversation(h.env, id, items), 120_000);
			handleMessage(h.env, tgMsg({ message_id: 1, chat, text: "first archived" }), 1);
			await h.env.intake.get("dm:7");
			handleMessage(h.env, tgMsg({ message_id: 2, chat, text: "/new" }), 2);
			handleMessage(h.env, tgMsg({ message_id: 3, chat, text: "second input" }), 3);
			await h.env.intake.get("dm:7");
			if (multipleArchives) {
				handleMessage(h.env, tgMsg({ message_id: 4, chat, text: "/new" }), 4);
				handleMessage(h.env, tgMsg({ message_id: 5, chat, text: "normal input" }), 5);
				await h.env.intake.get("dm:7");
			}
			h.store.db.run(`CREATE TRIGGER reject_later_append BEFORE INSERT ON events
				WHEN NEW.conversation_id = 'dm:7:2'
				BEGIN SELECT RAISE(ABORT, 'synthetic later append failure'); END`);
			await expect(h.env.buffer.drain()).rejects.toThrow("buffer drain failed");
			expect(h.store.history("dm:7:1")).toHaveLength(1);
			expect(targets).toEqual([]);
			h.store.db.run("DROP TRIGGER reject_later_append");
			await h.env.buffer.drain();
			expect(h.store.history("dm:7:1")).toHaveLength(1);
			expect(h.store.history("dm:7:2")).toHaveLength(1);
			if (multipleArchives) expect(h.store.history("dm:7:3")).toHaveLength(1);
			expect(targets).toEqual([multipleArchives ? "dm:7:3" : "dm:7:2"]);
			expect(h.env.inbox.pending()).toEqual([]);
			h.store.close();
		});
	}
});

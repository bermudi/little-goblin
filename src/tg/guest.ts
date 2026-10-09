// Guest mode (design/telegram.md → Guest mode, ruling 2026-10-06).
// goblin answers in third-party chats, summoned by mention, on two
// surfaces: `guest_message` updates (chats the bot is NOT a member of
// — one reply per summons via answerGuestQuery, then edits on the
// returned inline_message_id) and member-chat mentions (normal
// delivery sink, multi-bubble). The unit of trust is the chat: an
// `guest_open_chats` row admits third-party summons; the operator
// opens/closes with `/open` and `/off`. Two caller classes: the
// operator gets personal-persona turns (minus tools that pin or reach
// beyond the chat), everyone else gets a sandbox — a guest persona
// and a constructed toolset of search (enforced in index.ts's
// makeTools on conv.persona, never a prompt-level promise).
//
// Guest handlers register BEFORE allowedUserGate (mod.ts): the gate
// stays pure, and guest traffic — which includes strangers once the
// BotFather usage restriction is off — never reaches it. At-most-once
// rides guest_dedup(update_id), NOT tg_inbox: guest message ids share
// no namespace with the bot's own chats, and a UNIQUE(chat_id,
// message_id) hit there would exit the process.

import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { Message } from "grammy/types";
import type { Api } from "grammy";
import { paths, type ConfigRef } from "../config.ts";
import {
	channelOf,
	guestAddress,
	type Conversation,
	type ConversationStore,
} from "../conversation.ts";
import type { Runtime, TurnDone, TurnSink } from "../runtime.ts";
import type { UIMessage } from "ai";
import { log } from "../log.ts";
import { withTimeout } from "./deadline.ts";
import { makeDeliverySink } from "./delivery.ts";

// ---------- state: open chats, dedup, budget (rows, not config) ----------

export interface GuestStore {
	isOpen(chatId: number): boolean;
	open(chatId: number, byUserId: number): void;
	close(chatId: number): void;
	// True = first sighting of this update id (insert-or-ignore won).
	// Duplicates are redelivered updates, not new summons.
	seen(updateId: number): boolean;
	// Atomically count a turn against a user's daily budget; false =
	// limit already reached (not charged).
	tryChargeBudget(userId: number, day: string, limit: number): boolean;
}

export function openGuestStore(db: Database): GuestStore {
	db.run(`CREATE TABLE IF NOT EXISTS guest_open_chats (
		chat_id INTEGER PRIMARY KEY,
		opened_by INTEGER NOT NULL,
		opened_at TEXT NOT NULL
	)`);
	db.run(`CREATE TABLE IF NOT EXISTS guest_dedup (
		update_id INTEGER PRIMARY KEY,
		seen_at TEXT NOT NULL
	)`);
	db.run(`CREATE TABLE IF NOT EXISTS guest_turns (
		user_id INTEGER NOT NULL,
		day TEXT NOT NULL,
		turns INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (user_id, day)
	)`);
	const q = {
		qIsOpen: db.query<{ n: number }, [number]>(
			"SELECT COUNT(*) AS n FROM guest_open_chats WHERE chat_id = ?",
		),
		qOpen: db.query(
			"INSERT INTO guest_open_chats (chat_id, opened_by, opened_at) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO NOTHING",
		),
		qClose: db.query("DELETE FROM guest_open_chats WHERE chat_id = ?"),
		qSeen: db.query(
			"INSERT INTO guest_dedup (update_id, seen_at) VALUES (?, ?) ON CONFLICT(update_id) DO NOTHING",
		),
		qPurge: db.query("DELETE FROM guest_dedup WHERE update_id < ?"),
		qBudget: db.query<{ turns: number }, [number, string]>(
			"SELECT turns FROM guest_turns WHERE user_id = ? AND day = ?",
		),
		qCharge: db.query(
			`INSERT INTO guest_turns (user_id, day, turns) VALUES (?, ?, 1)
			 ON CONFLICT(user_id, day) DO UPDATE SET turns = turns + 1`,
		),
	};
	return {
		isOpen: (chatId) => (q.qIsOpen.get(chatId)?.n ?? 0) > 0,
		open: (chatId, byUserId) => void q.qOpen.run(chatId, byUserId, new Date().toISOString()),
		close: (chatId) => void q.qClose.run(chatId),
		seen(updateId) {
			const res = q.qSeen.run(updateId, new Date().toISOString());
			if (res.changes === 0) return false;
			// Periodic trim: dedup only guards redelivery windows, not history.
			if (updateId % 500 === 0) q.qPurge.run(updateId - 1_000);
			return true;
		},
		tryChargeBudget(userId, day, limit) {
			return db.transaction(() => {
				const n = q.qBudget.get(userId, day)?.turns ?? 0;
				if (n >= limit) return false;
				q.qCharge.run(userId, day);
				return true;
			})();
		},
	};
}

// ---------- pure classification / parsing ----------

// Operator anywhere → personal. Third party → sandbox in an open chat,
// deny (silence) everywhere else.
export type SummonVerdict =
	| { kind: "personal" }
	| { kind: "sandbox" }
	| { kind: "deny"; reason: "chat-closed" };

export function classifySummon(
	fromId: number,
	chatId: number,
	allowedUsers: readonly number[],
	isOpen: boolean,
): SummonVerdict {
	if (allowedUsers.includes(fromId)) return { kind: "personal" };
	return isOpen ? { kind: "sandbox" } : { kind: "deny", reason: "chat-closed" };
}

// Does this message address the bot? A @username (or text) mention
// entity, or a reply to one of the bot's own messages. Entity offsets
// are UTF-16 code units — plain slice matches.
export function mentionsBot(msg: Message, botUsername: string, botUserId: number): boolean {
	const body = msg.text ?? msg.caption ?? "";
	const entities = msg.entities ?? msg.caption_entities ?? [];
	for (const e of entities) {
		if (e.type === "mention") {
			const mentioned = body.slice(e.offset, e.offset + e.length).toLowerCase();
			if (mentioned === `@${botUsername.toLowerCase()}`) return true;
		} else if (e.type === "text_mention" && e.user.id === botUserId) {
			return true;
		}
	}
	return msg.reply_to_message?.from?.id === botUserId;
}

// "/open" or "/off", optionally suffixed @botname, nothing else. On
// the guest surface the leading @username mention is stripped first
// (the summons is inherently addressed to the bot).
export function guestCommand(text: string): "open" | "off" | null {
	const stripped = text
		.replace(/^@\S+\s*/, "")
		.trim()
		.toLowerCase();
	const m = /^\/(open|off)(@\S+)?$/.exec(stripped);
	return m ? (m[1] as "open" | "off") : null;
}

function localDay(): string {
	// Server-local date (the programs precedent for cron timezones).
	return new Date().toLocaleDateString("sv-SE");
}

// ---------- summons → UIMessage ----------

// Text-only v1: media in third-party summons rides as a dropped-media
// note (ruling — photo intake for the member surface is a follow-up).
function summonParts(msg: Message): { type: "text"; text: string }[] {
	const text = (msg.text ?? msg.caption ?? "").replace(/^@\S+\s*/, "").trim();
	const quoted = msg.reply_to_message;
	const quotedText = quoted === undefined ? "" : (quoted.text ?? quoted.caption ?? "");
	const parts: { type: "text"; text: string }[] = [];
	if (quotedText !== "") {
		parts.push({ type: "text", text: `[replying to: "${quotedText.slice(0, 2_000)}"]` });
	}
	if (text !== "") parts.push({ type: "text", text });
	const media =
		msg.photo !== undefined ||
		msg.video !== undefined ||
		msg.document !== undefined ||
		msg.voice !== undefined ||
		msg.video_note !== undefined ||
		msg.audio !== undefined;
	if (media) parts.push({ type: "text", text: "[media omitted — guest intake is text-only]" });
	if (parts.length === 0) parts.push({ type: "text", text: "[summoned with no text]" });
	return parts;
}

export function summonMessage(msg: Message): UIMessage {
	return { id: randomUUID(), role: "user", parts: summonParts(msg) };
}

// ---------- sink: the guest_message surface (one message, edited) ----------

const GUEST_EDIT_INTERVAL_MS = 1_000;

// Streams a guest reply into the single message answerGuestQuery sent.
// One message is the physics of the surface: no chunking, no files, no
// voice — output truncates past the cap with a pointer to the bot DM.
// A "message is not modified" edit is routine (throttle re-edit of an
// identical body), never an error.
export class GuestSink implements TurnSink {
	private text = "";
	private lastEdit = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private edits = 0;
	private authority: (() => boolean) | null = null;
	private done = false;
	// A deleted/undeliverable inline message: one error log, then the
	// sink goes quiet instead of warning once per second for the whole
	// turn.
	private dead = false;
	private chain: Promise<void> = Promise.resolve();

	constructor(
		private api: Api,
		private inlineMessageId: string,
		private outputChars: number,
		private editIntervalMs = GUEST_EDIT_INTERVAL_MS,
	) {}

	onTextDelta(delta: string): void {
		if (this.done) return;
		this.text += delta;
		if (this.timer === null) {
			const wait = Math.max(0, this.editIntervalMs - (Date.now() - this.lastEdit));
			this.timer = setTimeout(() => {
				this.timer = null;
				void this.flush();
			}, wait);
		}
	}

	onReasoningDelta(): void {}

	onToolCall(toolName: string): void {
		log.debug("guest tool call", { tool: toolName });
	}

	setAuthorityCheck(check: () => boolean): void {
		this.authority = check;
	}

	private render(final: boolean): string {
		if (this.text === "") return final ? "…" : "";
		if (this.text.length <= this.outputChars) return this.text;
		return `${this.text.slice(0, this.outputChars)}\n\n… (reply capped — continue in goblin's own chat)`;
	}

	private async edit(body: string): Promise<void> {
		if (this.dead) return;
		try {
			await withTimeout(
				this.api.editMessageTextInline(this.inlineMessageId, body),
				"editMessageText",
			);
			this.edits++;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("message is not modified")) return;
			if (msg.includes("message to edit not found") || msg.includes("message not found")) {
				this.dead = true;
				log.error("guest message vanished — edits stopped", undefined, {
					inline: this.inlineMessageId,
					edits: this.edits,
				});
				return;
			}
			// Fail loud but never kill the turn over one edit.
			log.warn("guest edit failed", err, { edits: this.edits });
		}
	}

	private async flush(): Promise<void> {
		if (this.done) return;
		if (this.authority !== null && !this.authority()) return; // fenced: onDone stamps
		const body = this.render(false);
		if (body === "") return;
		this.lastEdit = Date.now();
		this.chain = this.chain.then(() => this.edit(body));
		await this.chain;
	}

	async onDone(doneResult: TurnDone): Promise<void> {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.done = true;
		await this.chain;
		let body = this.render(true);
		if (doneResult.kind === "fenced") {
			// The one sanctioned post-fence stamp: displayed text + marker.
			body = body === "…" ? "⏹ superseded" : `${body}\n\n⏹ superseded`;
		} else if (doneResult.kind === "error") {
			body = this.text === "" ? `⚠ ${doneResult.message}` : `${body}\n\n⚠ ${doneResult.message}`;
		}
		try {
			await this.edit(body);
		} finally {
			log.info("guest answered", {
				inline: this.inlineMessageId,
				edits: this.edits + 1,
				chars: this.text.length,
				outcome: doneResult.kind,
			});
		}
	}
}

// ---------- answering on the guest surface ----------

const ANSWER_TIMEOUT_MS = 8_000;

// The immediate placeholder — fires before any model work so the
// summons window can't expire under us. Returns the inline message id
// that is the reply's delivery surface, or null (logged) when the
// query could not be answered — then the summons is dropped, never
// run blind: a turn whose output cannot land must not spend money.
async function answerGuestArticle(
	api: Api,
	guestQueryId: string,
	title: string,
	text: string,
): Promise<string | null> {
	try {
		const sent: unknown = await withTimeout(
			api.answerGuestQuery(guestQueryId, {
				type: "article",
				id: "goblin",
				title,
				input_message_content: { message_text: text },
			}),
			"answerGuestQuery",
			ANSWER_TIMEOUT_MS,
		);
		// Narrow by hand: grammy types the method's return loosely, and
		// the id is the whole point of the call.
		if (
			typeof sent === "object" &&
			sent !== null &&
			"inline_message_id" in sent &&
			typeof (sent as { inline_message_id: unknown }).inline_message_id === "string"
		) {
			return (sent as { inline_message_id: string }).inline_message_id;
		}
		log.warn("guest answerGuestQuery returned no inline id — summons dropped", {});
		return null;
	} catch (err) {
		// A timeout here is ambiguous (the answer may have landed) but
		// without the returned id there is nothing to edit — drop, loud.
		log.warn("guest answerGuestQuery failed — summons dropped", err);
		return null;
	}
}

// Settle a placeholder whose summons was dropped after it: the
// inline message is the only reply this summons will ever get, and it
// must not hang on "on it…" forever. Best-effort — the drop is
// already decided; a vanished inline message is GuestSink's routine
// case.
async function editGuestPlaceholder(
	api: Api,
	inlineMessageId: string,
	text: string,
): Promise<void> {
	try {
		await withTimeout(api.editMessageTextInline(inlineMessageId, text), "editMessageText");
	} catch (err) {
		log.warn("guest placeholder edit failed", err, { inline: inlineMessageId });
	}
}

// ---------- env + handlers ----------

export interface GuestEnv {
	api: Api;
	store: ConversationStore;
	runtime: Runtime;
	configRef: ConfigRef;
	guestStore: GuestStore;
	botUsername: string;
	botUserId: number;
}

// Closing a chat also fences every running guest turn in it.
function closeGuestChat(env: GuestEnv, chatId: number): number {
	env.guestStore.close(chatId);
	const ids = env.store.listGuestConversationIds(chatId);
	for (const id of ids) env.store.bumpEpoch(id);
	log.info("guest chat closed", { chat: chatId, fenced: ids.length });
	return ids.length;
}

function resolveGuestConversation(
	env: GuestEnv,
	chatId: number,
	userId: number,
	sandbox: boolean,
): Conversation {
	const conv = env.store.resolve(guestAddress(chatId, userId), paths.workspace());
	// All guest conversations are off the record (no recall, no
	// distillation, no review, no FTS); persona freezes the prompt
	// class and the tool filter. Idempotent — set only on a mismatch.
	const wantPersona = sandbox ? "guest" : "personal";
	if (conv.memoryExcluded !== true || conv.persona !== wantPersona) {
		env.store.setMeta(conv.id, { memoryExcluded: true, persona: wantPersona });
		// A persona flip rewrites the system prompt — the frozen snapshot
		// must bust with it, or a demoted caller keeps the personal
		// persona's bytes (SOUL, USER) while the tool filter already
		// sandboxed them. Compaction's precedent: history/prefix busts,
		// so the refresh is free.
		env.store.clearPromptSnapshot(conv.id);
	}
	return env.store.get(conv.id) ?? conv;
}

// Per-conversation serialization for the guest surface's critical
// section (busy-check → placeholder → submit): two rapid summons by
// the same user would otherwise both pass the busy check across the
// placeholder's await and the second would steer the first's turn —
// delivering its reply into the other summons' message. The member
// surface needs none: its check and submit have no await between them.
const guestTurnLanes = new Map<string, Promise<void>>();
function serializeGuestTurn<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
	const prev = guestTurnLanes.get(conversationId) ?? Promise.resolve();
	const run = prev.then(fn, fn);
	const tail = run
		.then(
			() => undefined,
			() => undefined,
		)
		.finally(() => {
			if (guestTurnLanes.get(conversationId) === tail) guestTurnLanes.delete(conversationId);
		});
	guestTurnLanes.set(conversationId, tail);
	return run;
}

// The guest_message update handler — non-member chats. Registered
// before allowedUserGate in mod.ts.
export async function handleGuestUpdate(
	env: GuestEnv,
	msg: Message & { guest_query_id?: string },
	updateId: number,
): Promise<void> {
	const from = msg.from;
	const guestQueryId = msg.guest_query_id;
	if (from === undefined || guestQueryId === undefined) return;
	const cfg = env.configRef.current.guest;
	if (cfg === undefined) return; // feature off: total silence, commands included
	if (!env.guestStore.seen(updateId)) return;
	const chatId = msg.chat.id;
	const allowed = env.configRef.current.allowedUsers;
	const isOperator = allowed.includes(from.id);

	// Operator-only chat controls, answered as the summons' one reply.
	const cmd = guestCommand(msg.text ?? msg.caption ?? "");
	if (cmd !== null) {
		if (!isOperator) {
			log.info("guest command denied — not the operator", { chat: chatId, from: from.id, cmd });
			return;
		}
		if (cmd === "open") {
			env.guestStore.open(chatId, from.id);
			log.info("guest chat opened", { chat: chatId, by: from.id });
			await answerGuestArticle(
				env.api,
				guestQueryId,
				"goblin",
				"🟢 guest access open — anyone in this chat can summon me",
			);
		} else {
			closeGuestChat(env, chatId);
			await answerGuestArticle(env.api, guestQueryId, "goblin", "🔴 guest access closed");
		}
		return;
	}

	const verdict = classifySummon(from.id, chatId, allowed, env.guestStore.isOpen(chatId));
	if (verdict.kind === "deny") {
		log.info("guest summons denied — chat not open", {
			chat: chatId,
			from: from.id,
			update: updateId,
		});
		return;
	}
	const sandbox = verdict.kind === "sandbox";

	const conv = resolveGuestConversation(env, chatId, from.id, sandbox);
	// Serialized per conversation: the busy check must still hold when
	// submit runs, across the placeholder's await.
	await serializeGuestTurn(conv.id, async () => {
		const busyLine = "⏳ still answering an earlier summons here — try again in a moment";
		if (env.runtime.hasActiveTurn(conv.id)) {
			// Never steer a guest turn: the reply would land in another
			// summons' message.
			await answerGuestArticle(env.api, guestQueryId, "goblin", busyLine);
			return;
		}

		const inlineMessageId = await answerGuestArticle(
			env.api,
			guestQueryId,
			"goblin",
			"⏳ goblin is on it…",
		);
		if (inlineMessageId === null) return;

		// The placeholder await is a suspension point: /off, a guest-config
		// removal, an allowedUsers edit, or a same-conversation member
		// summons (which bypasses this lane) can all land in it. /off's
		// epoch bump fences only turns that already started — a submit
		// here would read the bumped epoch as its own and be authorized —
		// so eligibility is revalidated before anything is charged or
		// submitted.
		const freshCfg = env.configRef.current.guest;
		const freshVerdict =
			freshCfg === undefined
				? null
				: classifySummon(
						from.id,
						chatId,
						env.configRef.current.allowedUsers,
						env.guestStore.isOpen(chatId),
					);
		const busyAgain = env.runtime.hasActiveTurn(conv.id);
		if (
			freshCfg === undefined ||
			freshVerdict === null ||
			freshVerdict.kind !== verdict.kind ||
			busyAgain
		) {
			log.info("guest summons dropped — eligibility changed during placeholder", {
				chat: chatId,
				from: from.id,
				update: updateId,
				verdict: verdict.kind,
				fresh: freshVerdict === null ? "config-off" : freshVerdict.kind,
				busy: busyAgain,
			});
			await editGuestPlaceholder(
				env.api,
				inlineMessageId,
				busyAgain ? busyLine : "⏹ cancelled — guest access here changed",
			);
			return;
		}

		// Charged only once the summons is committed: past the busy check,
		// the placeholder, and revalidation — nothing below awaits, so a
		// dropped or refused summons never burns budget.
		if (sandbox) {
			const limit = freshCfg.perUserDailyTurns;
			if (!env.guestStore.tryChargeBudget(from.id, localDay(), limit)) {
				log.warn("guest budget exhausted", { chat: chatId, from: from.id, limit });
				await editGuestPlaceholder(
					env.api,
					inlineMessageId,
					`⏳ daily guest limit reached (${limit} answers) — try again tomorrow`,
				);
				return;
			}
		}

		const admitted = env.runtime.submit(
			conv,
			summonMessage(msg),
			new GuestSink(env.api, inlineMessageId, freshCfg.outputChars),
		);
		log.info("guest summons", {
			chat: chatId,
			from: from.id,
			update: updateId,
			verdict: verdict.kind,
			admitted,
		});
	});
}

// The member-surface pre-gate router: returns true when the guest path
// consumed this message (chain stops), false to fall through to the
// normal gate + intake. Registered before allowedUserGate in mod.ts.
export async function routeMemberGuestMessage(
	env: GuestEnv,
	msg: Message,
	updateId: number,
): Promise<boolean> {
	const from = msg.from;
	if (from === undefined) return false;
	// Groups only: the bot's own DM is not a guest chat — a stray "/off"
	// there must fall through to normal intake, not flip a phantom
	// guest chat keyed by the operator's own user id.
	if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") return false;
	const chatId = msg.chat.id;
	const cfg = env.configRef.current.guest;
	if (cfg === undefined) return false; // feature off: no member routing, no commands
	const allowed = env.configRef.current.allowedUsers;
	const isOperator = allowed.includes(from.id);
	const text = msg.text ?? msg.caption ?? "";

	// Chat controls must address THE BOT — a /cmd@botname suffix or a
	// mention entity — never a bare "/open" (the operator's own topic
	// group falls through untouched) and never "/open @somehuman".
	const cmd = guestCommand(text);
	const addressed =
		text.trim().toLowerCase().endsWith(`@${env.botUsername.toLowerCase()}`) ||
		mentionsBot(msg, env.botUsername, env.botUserId);
	if (cmd !== null && addressed) {
		// Redelivered updates must not re-run a close (a second epoch bump
		// could fence a turn admitted after the first /off) or re-answer.
		if (!env.guestStore.seen(updateId)) return true;
		if (!isOperator) {
			log.info("guest command denied — not the operator", { chat: chatId, from: from.id, cmd });
			return true;
		}
		if (cmd === "open") {
			env.guestStore.open(chatId, from.id);
			log.info("guest chat opened", { chat: chatId, by: from.id });
			void sendMemberLine(env, chatId, "🟢 guest access open — anyone in this chat can summon me");
		} else {
			closeGuestChat(env, chatId);
			void sendMemberLine(env, chatId, "🔴 guest access closed");
		}
		return true;
	}

	if (isOperator || cfg === undefined) return false;
	if (!mentionsBot(msg, env.botUsername, env.botUserId)) return false;
	if (!env.guestStore.seen(updateId)) return true; // duplicate redelivery
	if (!env.guestStore.isOpen(chatId)) {
		log.info("guest summons denied — chat not open", {
			chat: chatId,
			from: from.id,
			update: updateId,
		});
		return true;
	}

	const conv = resolveGuestConversation(env, chatId, from.id, true);
	if (env.runtime.hasActiveTurn(conv.id)) {
		void sendMemberLine(
			env,
			chatId,
			"⏳ still answering an earlier summons — try again in a moment",
		);
		return true;
	}

	// Charged only past the busy check — a refusal must never burn budget.
	const limit = cfg.perUserDailyTurns;
	if (!env.guestStore.tryChargeBudget(from.id, localDay(), limit)) {
		log.warn("guest budget exhausted", { chat: chatId, from: from.id, limit });
		void sendMemberLine(
			env,
			chatId,
			`⏳ daily guest limit reached (${limit} answers) — try again tomorrow`,
		);
		return true;
	}

	const sink = makeDeliverySink(env.api, conv, msg.message_id);
	const admitted = env.runtime.submit(conv, summonMessage(msg), sink);
	log.info("guest summons", {
		chat: chatId,
		from: from.id,
		update: updateId,
		verdict: "sandbox",
		surface: "member",
		admitted,
	});
	return true;
}

function sendMemberLine(env: GuestEnv, chatId: number, text: string): Promise<void> {
	return withTimeout(env.api.sendMessage(chatId, text), "sendMessage")
		.then(() => undefined)
		.catch((err: unknown) => {
			log.warn("guest member line failed", err);
		});
}

// The sandbox toolset — the hard exclusion list guest personas run
// with. Applied in index.ts's makeTools on conv.persona === "guest";
// kept here so the ruling and its enforcement live together. search
// only: read-only, no workspace, no operator data. No fetch — the
// personal fetch's no-SSRF stance (design/web.md) rests on the caller
// already having bash, which a sandbox caller does not, and a
// restricted fetch that cannot pin the connection to the checked
// address is DNS-rebindable onto the loopback. The ruling and its
// history live in design/telegram.md → Guest mode.
export const SANDBOX_TOOLS: ReadonlySet<string> = new Set(["search"]);

// The guest channel's personal-turn exclusions (the operator's own
// guest summons keep the personal persona but never get tools that
// pin work to, or reach beyond, the chat).
export const GUEST_CHANNEL_EXCLUDED: ReadonlySet<string> = new Set([
	"program",
	"mail",
	"delegate",
	"memory_search",
	"history_search",
	"speak",
	"send_file",
]);

// Hard toolset exclusion, applied at assembly (index.ts makeTools):
// sandbox personas keep SANDBOX_TOOLS only; personal guest turns keep
// everything except GUEST_CHANNEL_EXCLUDED. Constructed toolsets, never
// prompt-level promises — a sandboxed caller's model never sees a tool
// it must merely be asked not to use.
export function filterGuestTools<T extends Record<string, unknown>>(
	conv: Conversation,
	tools: T,
): T {
	if (channelOf(conv.id) !== "guest") return tools;
	const out: Record<string, unknown> = {};
	for (const [name, tool] of Object.entries(tools)) {
		if (conv.persona === "guest") {
			if (SANDBOX_TOOLS.has(name)) out[name] = tool;
		} else if (!GUEST_CHANNEL_EXCLUDED.has(name)) {
			out[name] = tool;
		}
	}
	return out as T;
}

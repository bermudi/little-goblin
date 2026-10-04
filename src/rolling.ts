// Rolling DM (design/telegram.md → Rolling DM): the bot DM is a rolling
// address — dm:<chat>:<n> conversations, one current per chat, and the
// boundary is a quiet gap the follow-up check arbitrates. Everything a
// caller needs to route a DM lives here; sending the "— new
// conversation —" marker stays in src/tg/ (only tg knows grammy).
//
// Synchronous triggers (quoted replies, commands, program fires) never
// pay the check's latency — they roll or join by rule. Only the
// plain-message path past the gap asks the check, and then raced
// against a deadline a human can feel.

import type { UIMessage } from "ai";
import { paths } from "./config.ts";
import type { Conversation, ConversationStore } from "./conversation.ts";
import { JevError, type JevClient, type JevDecision, type JevQuestion } from "./jev.ts";
import { log } from "./log.ts";
import type { Runtime } from "./runtime.ts";

// Telegram invariant: private chat ids are positive, group ids
// negative — chatId > 0 is the whole "is this a private chat" test for
// call sites that hold a bare chat id (pinned program addresses, inbox
// lane keys) instead of a message envelope.
export function isRollingChat(chatId: number): boolean {
	return chatId > 0;
}

// The intake lane key for a private chat is the rolling address
// "dm:<chat>" — deliberately the same string the legacy conversation id
// uses, so inbox rows recorded before the ruling stay valid. Returns
// the chat id for a rolling lane, null for topics and group bare-chats.
export function rollingChatId(laneKey: string): number | null {
	const m = /^dm:(-?\d+)$/.exec(laneKey);
	if (!m) return null;
	const chatId = Number(m[1]);
	return isRollingChat(chatId) ? chatId : null;
}

export type RollDecidedBy =
	| "gap" // inside the quiet window, or a forced join of current
	| "busy" // a live turn absorbs the input as steering
	| "reply" // a quoted reply continues what it quotes — no check
	| "command" // /voice, /memory — settings commands own their roll
	| "fire" // a scheduled program landing in the DM
	| "first" // no current conversation exists yet
	| "check" // the follow-up check judged the burst
	| "fallback"; // the check couldn't run — join current, answer the message

export interface RollResult {
	conv: Conversation;
	rolled: boolean;
	decidedBy: RollDecidedBy;
	probability?: number;
}

export interface RollDeps {
	store: ConversationStore;
	runtime: Pick<Runtime, "busy">;
	// Live config read — a mini-app save applies on the next message.
	gapMinutes: () => number;
	// The shared reviewer JevClient, resolved per call (it is built
	// after the bot in the composition root). undefined = no check
	// available — the burst joins current.
	gate?: () => Pick<JevClient, "decide"> | undefined;
	// Injectable clock — tests steer the gap without sleeping.
	now?: () => Date;
	// Interactive ceiling for the check: the shared JevClient's own 30s
	// timeout is too long to hold an operator's message; the losing
	// request is abandoned, not aborted.
	checkDeadlineMs?: number;
}

// Fresh-below: the check answers p(follow-up) — under it the burst
// starts a new subject and the conversation rolls.
export const FRESH_BELOW = 0.3;
const CHECK_DEADLINE_MS = 3_000;
const HEAD_CHARS = 2_000;

const FOLLOW_UP_QUESTIONS: Record<string, JevQuestion> = {
	follow_up: {
		type: "noul",
		instructions:
			"The operator messaged their personal assistant after a quiet gap. Decide whether the new message continues the previous exchange or starts a new subject.",
		criteria: {
			true: "The new message continues the previous exchange: it refers back to it (a pronoun, ellipsis, or 'and also' that only makes sense with it), answers a question the assistant asked, or asks more about the same subject.",
			false: "The new message starts a new subject: it is understandable on its own and is not about the previous exchange.",
		},
	},
};

// The deadline losing the race is a fallback trigger, not a bug —
// typed so the catch can tell it from a real failure (fail loud covers
// everything that isn't a JevError or this).
class RollDeadlineError extends Error {
	constructor() {
		super("follow-up check deadline");
	}
}

function roll(
	deps: RollDeps,
	chatId: number,
	from: Conversation | null,
	decidedBy: RollDecidedBy,
	gapMinutes: number | null,
	probability?: number,
): RollResult {
	const conv = deps.store.rollDm(chatId, paths.workspace());
	log.info("dm rolled", {
		address: `dm:${chatId}`,
		from: from?.id ?? null,
		to: conv.id,
		gapMinutes,
		decidedBy,
		...(probability !== undefined ? { probability } : {}),
	});
	return { conv, rolled: true, decidedBy, ...(probability !== undefined ? { probability } : {}) };
}

function continued(
	conv: Conversation,
	decidedBy: RollDecidedBy,
	gapMinutes: number,
	probability?: number,
): RollResult {
	log.info("dm continued past gap", {
		conversation: conv.id,
		gapMinutes,
		decidedBy,
		...(probability !== undefined ? { probability } : {}),
	});
	return { conv, rolled: false, decidedBy, ...(probability !== undefined ? { probability } : {}) };
}

function elapsedMs(deps: RollDeps, conv: Conversation): number {
	const now = deps.now ? deps.now() : new Date();
	return now.getTime() - new Date(deps.store.lastActivityAt(conv.id)).getTime();
}

// Text-only projection for the check's state: text parts joined, an
// attachment renders as [voice: <transcript>] when it carries one,
// [photo] for an image, else [file: <name>]. Head-cut — the state
// carries the shape of the exchange, not a transcript.
export function projectRollText(parts: readonly UIMessage["parts"][number][]): string {
	const out: string[] = [];
	for (const part of parts) {
		if (part.type === "text") {
			out.push(part.text);
			continue;
		}
		if (part.type !== "data-attachment") continue;
		const data = (part as { data?: unknown }).data;
		const ref = typeof data === "object" && data !== null
			? data as { transcript?: unknown; mediaType?: unknown; filename?: unknown }
			: null;
		if (typeof ref?.transcript === "string" && ref.transcript !== "") {
			out.push(`[voice: ${ref.transcript}]`);
		} else if (typeof ref?.mediaType === "string" && ref.mediaType.startsWith("image/")) {
			out.push("[photo]");
		} else {
			out.push(`[file: ${typeof ref?.filename === "string" ? ref.filename : "unnamed"}]`);
		}
	}
	return out.join("\n").slice(0, HEAD_CHARS);
}

// The check's evidence: how long the quiet lasted, the last exchange
// of the current conversation, and the new burst. Missing sides read
// as "" — a conversation with no assistant answer yet is still a fair
// question.
function checkState(deps: RollDeps, current: Conversation, gapMinutes: number, burstText: string): string {
	let user = "";
	let assistant = "";
	const history = deps.store.history(current.id);
	for (let i = history.length - 1; i >= 0 && (user === "" || assistant === ""); i--) {
		const m = history[i]!;
		if (m.role === "user" && user === "") user = projectRollText(m.parts);
		if (m.role === "assistant" && assistant === "") assistant = projectRollText(m.parts);
	}
	return JSON.stringify({
		gapMinutes,
		previous: { user, assistant },
		next: burstText.slice(0, HEAD_CHARS),
	});
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new RollDeadlineError()), ms);
	});
	return Promise.race([p, deadline]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

// Synchronous routing: no check ever runs on these triggers. Quoted
// replies join, settings commands and fires roll, and every other
// command just acts on the current conversation.
export function routeDm(
	deps: RollDeps,
	chatId: number,
	trigger: "reply" | "command" | "fire" | "current",
): RollResult {
	const current = deps.store.currentDm(chatId);
	if (current === null) return roll(deps, chatId, null, "first", null);
	if (deps.runtime.busy(current.id)) return { conv: current, rolled: false, decidedBy: "busy" };
	const elapsed = elapsedMs(deps, current);
	const gapMinutes = Math.floor(elapsed / 60_000);
	if (elapsed < deps.gapMinutes() * 60_000) {
		return { conv: current, rolled: false, decidedBy: "gap" };
	}
	switch (trigger) {
		case "reply":
			return continued(current, "reply", gapMinutes);
		case "command":
			return roll(deps, chatId, current, "command", gapMinutes);
		case "fire":
			return roll(deps, chatId, current, "fire", gapMinutes);
		case "current":
			return continued(current, "gap", gapMinutes);
	}
}

// The intake path: past the gap, the follow-up check decides continue
// vs roll. Every failure of the check itself fails open into the
// current conversation (the message still needs an answer); anything
// that isn't a JevError or the deadline propagates.
export async function routeDmMessage(
	deps: RollDeps,
	chatId: number,
	burstText: string,
): Promise<RollResult> {
	const current = deps.store.currentDm(chatId);
	if (current === null) return roll(deps, chatId, null, "first", null);
	if (deps.runtime.busy(current.id)) return { conv: current, rolled: false, decidedBy: "busy" };
	const elapsed = elapsedMs(deps, current);
	const gapMinutes = Math.floor(elapsed / 60_000);
	if (elapsed < deps.gapMinutes() * 60_000) {
		return { conv: current, rolled: false, decidedBy: "gap" };
	}
	const gate = deps.gate?.();
	if (gate === undefined) {
		log.warn("follow-up check", {
			chat: chatId, conversation: current.id, ms: 0, kind: "no gate",
		});
		return continued(current, "fallback", gapMinutes);
	}
	const started = Date.now();
	let decision: JevDecision;
	try {
		decision = await withDeadline(
			gate.decide(checkState(deps, current, gapMinutes, burstText), FOLLOW_UP_QUESTIONS),
			deps.checkDeadlineMs ?? CHECK_DEADLINE_MS,
		);
	} catch (err) {
		if (!(err instanceof JevError) && !(err instanceof RollDeadlineError)) throw err;
		log.warn("follow-up check", {
			chat: chatId,
			conversation: current.id,
			ms: Date.now() - started,
			kind: err instanceof JevError ? err.kind : "deadline",
		});
		// The address can still have rolled while the failed check ran
		// — same re-read as the resolved path: join the new current
		// rather than answering the superseded one.
		const pinned = deps.store.currentDm(chatId);
		if (pinned !== null && pinned.id !== current.id) {
			return continued(pinned, "gap", gapMinutes);
		}
		return continued(current, "fallback", gapMinutes);
	}
	const probability = decision.answers["follow_up"] ?? 1;
	const fresh = probability < FRESH_BELOW;
	log.info("follow-up check", {
		chat: chatId,
		conversation: current.id,
		probability,
		ms: Date.now() - started,
		inputTokens: decision.inputTokens,
		cost: decision.cost,
		outcome: fresh ? "fresh" : "continue",
	});
	// A fire (or a command, or another burst) can roll the address while
	// the check ran — join wherever the pin points now, never roll twice.
	const pinned = deps.store.currentDm(chatId);
	if (pinned !== null && pinned.id !== current.id) {
		return continued(pinned, "gap", gapMinutes, probability);
	}
	// The pin didn't move, but the conversation may have gone busy or
	// absorbed fresh activity while the check ran — a roll now would
	// strand that exchange on a stale fork.
	if (deps.runtime.busy(current.id)) {
		return {
			conv: current,
			rolled: false,
			decidedBy: "busy",
			...(probability !== undefined ? { probability } : {}),
		};
	}
	if (elapsedMs(deps, current) < deps.gapMinutes() * 60_000) {
		return continued(current, "gap", gapMinutes, probability);
	}
	if (fresh) return roll(deps, chatId, current, "check", gapMinutes, probability);
	return continued(current, "check", gapMinutes, probability);
}

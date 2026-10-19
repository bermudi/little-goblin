import type { UIMessage } from "ai";
import { paths } from "./config.ts";
import {
	formatAddress,
	parseAddress,
	type Conversation,
	type ConversationStore,
} from "./conversation.ts";
import {
	System1Error,
	type System1Client,
	type System1Decision,
	type System1Question,
} from "./system1.ts";
import { log } from "./log.ts";
import type { Runtime } from "./runtime.ts";

// Telegram: private chat ids are positive, group ids negative.
export function isRollingChat(chatId: number): boolean {
	return chatId > 0;
}

// "dm:<chat>" is deliberately the same string the legacy conversation id
// uses — inbox rows recorded before the rolling ruling stay valid.
export function rollingChatId(laneKey: string): number | null {
	const parsed = parseAddress(laneKey);
	return parsed !== null && parsed.kind === "dm" && isRollingChat(parsed.chatId)
		? parsed.chatId
		: null;
}

export type RollDecidedBy =
	| "gap" // inside the quiet window, or a forced join of current
	| "unanswered" // no assistant reply yet — no exchange to judge against
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
	// Live read — a config save applies on the next message.
	gapMinutes: () => number;
	// Resolved per call (the client is built after the bot in the
	// composition root). undefined = no check available — join current.
	gate?: () => Pick<System1Client, "decide"> | undefined;
	now?: () => Date;
	// Interactive ceiling: the client's own 30s timeout is too long to
	// hold an operator's message. Passed into the client so primary +
	// backup abort within it; the outer deadline bounds a gate that
	// ignores the option.
	checkDeadlineMs?: number;
}

// Below p(follow-up) the burst starts a new subject and rolls.
export const FRESH_BELOW = 0.3;
const CHECK_DEADLINE_MS = 3_000;
const HEAD_CHARS = 2_000;

const FOLLOW_UP_QUESTIONS: Record<string, System1Question> = {
	follow_up: {
		type: "noul",
		instructions:
			"The operator messaged their personal assistant after a quiet gap. Decide whether the new message continues the previous exchange or starts a new subject.",
		criteria: {
			true: "The new message continues the previous exchange: it refers back to it (a pronoun, ellipsis, or 'and also' that only makes sense with it), answers a question the assistant asked, or asks more about the same subject.",
			false:
				"The new message starts a new subject: it is understandable on its own and is not about the previous exchange.",
		},
	},
};

// A fallback trigger, not a bug — typed so the catch can tell it from
// a real failure.
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
		address: formatAddress({ kind: "dm", chatId }),
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

// Head-cut — the state carries the shape of the exchange, not a transcript.
export function projectRollText(parts: readonly UIMessage["parts"][number][]): string {
	const out: string[] = [];
	for (const part of parts) {
		if (part.type === "text") {
			out.push(part.text);
			continue;
		}
		if (part.type !== "data-attachment") continue;
		const data = (part as { data?: unknown }).data;
		const ref =
			typeof data === "object" && data !== null
				? (data as { transcript?: unknown; mediaType?: unknown; filename?: unknown })
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

// A missing side is the rare all-assistant or unrenderable edge — it
// still reads "".
function checkState(history: UIMessage[], gapMinutes: number, burstText: string): string {
	let user = "";
	let assistant = "";
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

// Synchronous triggers never run the check — they roll or join by rule.
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

// Check failures fail open into current (the message still needs an
// answer); anything that isn't a System1Error or the deadline propagates.
export async function routeDmMessage(
	deps: RollDeps,
	chatId: number,
	burstText: string,
	stillRouteable: () => boolean = () => true,
): Promise<RollResult> {
	const current = deps.store.currentDm(chatId);
	if (current === null) return roll(deps, chatId, null, "first", null);
	if (deps.runtime.busy(current.id)) return { conv: current, rolled: false, decidedBy: "busy" };
	const elapsed = elapsedMs(deps, current);
	const gapMinutes = Math.floor(elapsed / 60_000);
	if (elapsed < deps.gapMinutes() * 60_000) {
		return { conv: current, rolled: false, decidedBy: "gap" };
	}
	const history = deps.store.history(current.id);
	// No assistant reply yet — nothing to judge against, so join
	// without asking. Rolling here would orphan a fragment behind a
	// second "— new conversation —" marker.
	if (!history.some((m) => m.role === "assistant")) {
		return continued(current, "unanswered", gapMinutes);
	}
	const gate = deps.gate?.();
	if (gate === undefined) {
		log.warn("follow-up check", {
			chat: chatId,
			conversation: current.id,
			ms: 0,
			kind: "no gate",
		});
		return continued(current, "fallback", gapMinutes);
	}
	const started = Date.now();
	let decision: System1Decision;
	try {
		decision = await withDeadline(
			gate.decide(checkState(history, gapMinutes, burstText), FOLLOW_UP_QUESTIONS, {
				timeoutMs: deps.checkDeadlineMs ?? CHECK_DEADLINE_MS,
			}),
			deps.checkDeadlineMs ?? CHECK_DEADLINE_MS,
		);
	} catch (err) {
		if (!(err instanceof System1Error) && !(err instanceof RollDeadlineError)) throw err;
		log.warn("follow-up check", {
			chat: chatId,
			conversation: current.id,
			ms: Date.now() - started,
			kind: err instanceof System1Error ? err.kind : "deadline",
		});
		if (!stillRouteable()) {
			// Navigation may have moved the pin while the check ran.
			const pinned = deps.store.currentDm(chatId);
			return { conv: pinned ?? current, rolled: false, decidedBy: "command" };
		}
		// The address can still have rolled while the failed check ran
		// — join the new current rather than answering the superseded one.
		const pinned = deps.store.currentDm(chatId);
		if (pinned !== null && pinned.id !== current.id) {
			return continued(pinned, "gap", gapMinutes);
		}
		return continued(current, "fallback", gapMinutes);
	}
	const probability = decision.answers["follow_up"] ?? 1;
	if (!stillRouteable()) {
		log.info("follow-up check superseded by navigation", {
			chat: chatId,
			conversation: current.id,
			probability,
			ms: Date.now() - started,
			inputTokens: decision.inputTokens,
			cost: decision.cost,
		});
		const pinned2 = deps.store.currentDm(chatId);
		return { conv: pinned2 ?? current, rolled: false, decidedBy: "command", probability };
	}
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
	// A fire/command/burst can roll the address while the check ran —
	// join wherever the pin points now, never roll twice.
	const pinned = deps.store.currentDm(chatId);
	if (pinned !== null && pinned.id !== current.id) {
		return continued(pinned, "gap", gapMinutes, probability);
	}
	// The pin didn't move, but the conversation may have gone busy or
	// absorbed fresh activity mid-check — a roll now would strand that
	// exchange on a stale fork.
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

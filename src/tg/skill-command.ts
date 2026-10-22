// /skill — the Telegram door onto explicit skill invocation (ruling
// 2026-10-21, design/telegram.md → /skill; mechanism ruling:
// design/skills.md → Skill invocation).
//
//   /skill                 catalog listing (manual-only marked)
//   /skill <name> [text]   submit a turn with a data-skill part
//   /skill <url> [text]    fetch + System One score, then a preview
//                          message with a ✅/🚫 row; yes submits the
//                          held turn
//
// The pending temp confirm lives in process memory keyed by a short
// token — the URL cannot ride Telegram's 64-byte callback cap, and a
// restart losing a pending confirm is fine: the command re-runs
// instantly off the skillcache. Like every command, /skill bypasses
// the intake inbox; a crash-redelivery re-runs it.
//
// Fences: the conversation's epoch is captured when the preview is
// requested and re-checked at every async boundary — a /stop or /new
// landing mid-fetch or mid-score cancels the preview, and a stale tap
// can never invoke into a conversation that moved on.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Api } from "grammy";
import type { UIMessage } from "ai";
import { loadCatalog } from "../agent/skills.ts";
import { checkInjection } from "../injection.ts";
import type { System1Client } from "../system1.ts";
import { log } from "../log.ts";
import { paths } from "../config.ts";
import { SKILL_PART, type SkillRef } from "../skill-part.ts";
import { fetchSkill, stampVerdict, SkillFetchError } from "../agent/skill-fetch.ts";
import type { Conversation, ConversationStore } from "../conversation.ts";
import { userMessage, type Runtime, type TurnSink } from "../runtime.ts";
import { sharedChatPart } from "./turn-input.ts";
import { withTimeout } from "./deadline.ts";

const LISTING_CAP = 40;
const REPLY_CHUNK_LIMIT = 4000;
// The echoed name in an unknown-name reply is bounded — the input is
// operator-supplied and unbounded, and the whole reply must stay under
// the chunk cap.
const NAME_ECHO_CAP = 200;
const PENDING_TTL_MS = 15 * 60 * 1000;
const PENDING_CAP = 8;

export interface SkillCommandDeps {
	api: Api;
	store: ConversationStore;
	runtime: Runtime;
	/** The shared System One client — absent, temp skills answer unavailable. */
	gate?: Pick<System1Client, "decide">;
	/**
	 * The conversation-configured delivery sink a submitted turn gets —
	 * the same construction ordinary intake uses (voice, rating, rich).
	 */
	delivery(target: Conversation): TurnSink;
	// Test seams.
	fetchImpl?: typeof fetch;
	cacheRoot?: string;
	now?: () => Date;
}

interface PendingTemp {
	conversationId: string;
	chatId: number;
	threadId: number | null;
	messageId: number;
	ref: SkillRef;
	name: string;
	text: string;
	/** The conversation epoch the preview was fetched under. */
	epoch: number;
	expiresAt: number;
}

// Keyed per process — crash-safety is the command re-run, by ruling.
const pending = new Map<string, PendingTemp>();

function sweepPending(now: number): void {
	for (const [token, p] of pending) {
		if (p.expiresAt <= now) pending.delete(token);
	}
	while (pending.size > PENDING_CAP) {
		const oldest = pending.keys().next().value;
		if (oldest === undefined) break;
		pending.delete(oldest);
	}
}

// Pack lines into ≤REPLY_CHUNK_LIMIT chunks at newline boundaries; a
// pathological single line splits hard rather than truncating.
function chunkLines(lines: string[]): string[] {
	const pieces: string[] = [];
	for (const raw of lines) {
		if (raw.length <= REPLY_CHUNK_LIMIT) {
			pieces.push(raw);
			continue;
		}
		for (let i = 0; i < raw.length; i += REPLY_CHUNK_LIMIT) {
			pieces.push(raw.slice(i, i + REPLY_CHUNK_LIMIT));
		}
	}
	const chunks: string[] = [];
	let cur = "";
	for (const piece of pieces) {
		if (cur !== "" && cur.length + 1 + piece.length > REPLY_CHUNK_LIMIT) {
			chunks.push(cur);
			cur = "";
		}
		cur = cur === "" ? piece : `${cur}\n${piece}`;
	}
	if (cur !== "") chunks.push(cur);
	return chunks;
}

export async function handleSkillCommand(
	deps: SkillCommandDeps,
	target: Conversation,
	text: string,
): Promise<boolean> {
	const arg = text.replace(/^\/skill(?:@\S+)?/i, "").trim();
	// Awaited, not fire-and-forget: a failed send rejects the command
	// into the caller's existing "command failed" path.
	const reply = (t: string, keyboard?: unknown) =>
		withTimeout(
			deps.api.sendMessage(target.chatId, t, {
				...(target.threadId !== null ? { message_thread_id: target.threadId } : {}),
				...(keyboard !== undefined ? { reply_markup: keyboard } : {}),
			} as Parameters<Api["sendMessage"]>[2]),
			"sendMessage (/skill)",
		).then(() => undefined);
	const replyLines = async (lines: string[], keyboard?: unknown) => {
		const chunks = chunkLines(lines);
		for (const [i, chunk] of chunks.entries()) {
			await reply(chunk, i === chunks.length - 1 ? keyboard : undefined);
		}
	};

	if (arg === "") {
		await replyLines(catalogLines());
		return true;
	}

	// URL vs name: the scheme decides — a name never contains ":".
	if (/^https:\/\//i.test(arg)) {
		const splitAt = arg.search(/\s/);
		const url = (splitAt === -1 ? arg : arg.slice(0, splitAt)).trim();
		const heldText = splitAt === -1 ? "" : arg.slice(splitAt).trim();
		return previewTempSkill(deps, target, url, heldText, reply).then(() => true);
	}

	const name = arg.split(/\s/, 1)[0] ?? "";
	const rest = arg.slice(name.length).trim();
	const catalog = loadCatalog(paths.skills());
	const entry = catalog.entries.find((e) => e.name === name);
	if (entry === undefined) {
		const shown = name.length > NAME_ECHO_CAP ? `${name.slice(0, NAME_ECHO_CAP)}…` : name;
		await replyLines([`no skill named "${shown}" —`, ...catalogLines()]);
		return true;
	}
	submitSkillTurn(deps, target, { name }, rest);
	return true;
}

function catalogLines(): string[] {
	const catalog = loadCatalog(paths.skills());
	const lines = catalog.entries
		.slice(0, LISTING_CAP)
		.map((e) => `- ${e.name}${e.manualOnly === true ? " (manual-only)" : ""} — ${e.description}`);
	if (catalog.entries.length > LISTING_CAP) {
		lines.push(`…and ${catalog.entries.length - LISTING_CAP} more`);
	}
	if (lines.length === 0) return ["no skills installed yet."];
	return [
		"skills:",
		...lines,
		"",
		"invoke with /skill <name> — or a GitHub skill URL to try one without installing.",
	];
}

function submitSkillTurn(
	deps: SkillCommandDeps,
	target: Conversation,
	ref: SkillRef,
	text: string,
): void {
	const audience = sharedChatPart(target.id, target.chatId);
	const parts: UIMessage["parts"] = [
		...(audience === null ? [] : [audience]),
		{ type: SKILL_PART, data: ref } as UIMessage["parts"][number],
	];
	if (text !== "") parts.push({ type: "text", text });
	const message = userMessage(parts);
	deps.store.append(target.id, [message]);
	const sink = deps.delivery(target);
	try {
		deps.runtime.submitPersisted(target, message, sink);
		log.info("skill invoked via /skill", {
			conversation: target.id,
			temp: "url" in ref,
		});
	} catch (err) {
		log.error("skill turn submit failed", err, { conversation: target.id });
		void sink.onDone({
			kind: "error",
			message: err instanceof Error ? err.message : String(err),
		});
	}
}

// The epoch probe every async boundary funnels through — synchronous
// by contract: a successful check must not add an await between the
// probe and the publish that follows, or a /stop lands in the gap.
// A fenced preview is logged and answered plainly — never an
// actionable card, never a pending entry.
function previewFenced(
	deps: SkillCommandDeps,
	target: Conversation,
	stage: string,
	epoch: number,
): boolean {
	const current = deps.store.get(target.id)?.epoch ?? null;
	if (current === epoch) return false;
	log.info("temp skill preview fenced — conversation moved on", {
		conversation: target.id,
		stage,
		epoch,
		current,
	});
	return true;
}

async function previewTempSkill(
	deps: SkillCommandDeps,
	target: Conversation,
	url: string,
	heldText: string,
	reply: (text: string, keyboard?: unknown) => Promise<void>,
): Promise<void> {
	if (deps.gate === undefined) {
		await reply("temp skills are unavailable — the System One gate is not wired.");
		return;
	}
	// Captured synchronously — the turn input was admitted under this
	// epoch; anything later works on a stale snapshot.
	const epoch = target.epoch;
	let fetched;
	try {
		fetched = await fetchSkill(url, {
			...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
			...(deps.cacheRoot !== undefined ? { cacheRoot: deps.cacheRoot } : {}),
			...(deps.now !== undefined ? { now: deps.now } : {}),
		});
	} catch (err) {
		if (err instanceof SkillFetchError) {
			await reply(`could not fetch that skill: ${err.message}`);
			return;
		}
		throw err;
	}
	if (previewFenced(deps, target, "fetched", epoch)) {
		await reply("cancelled — the conversation moved on.");
		return;
	}
	const body = readFileSync(fetched.path, "utf8");
	const verdict = await checkInjection(deps.gate, body);
	// Probe, stamp, pending, reply — one synchronous run past the last
	// real await; nothing may interpose between them.
	if (previewFenced(deps, target, "scored", epoch)) {
		await reply("cancelled — the conversation moved on.");
		return;
	}
	stampVerdict(deps.cacheRoot ?? paths.skillcache(), fetched.digest, verdict);

	const token = randomUUID().slice(0, 8);
	const now = deps.now ?? (() => new Date());
	sweepPending(now().getTime());
	pending.set(token, {
		conversationId: target.id,
		chatId: target.chatId,
		threadId: target.threadId,
		messageId: 0, // stamped by the send below
		ref: { url: fetched.descriptor.sourceUrl, path: fetched.path },
		name: fetched.descriptor.name,
		text: heldText,
		epoch,
		expiresAt: now().getTime() + PENDING_TTL_MS,
	});

	const kb = {
		inline_keyboard: [
			[
				{ text: "✅ Invoke", callback_data: `skilltmp:y:${token}` },
				{ text: "🚫 Drop", callback_data: `skilltmp:n:${token}` },
			],
		],
	};
	const flag =
		verdict.status === "malicious" || verdict.status === "suspicious"
			? "⚠️ "
			: verdict.status === "unavailable"
				? ""
				: "";
	const sizes = `SKILL.md ${fmtBytes(fetched.bodyBytes)} · ${fetched.fileCount} files · ${fmtBytes(fetched.dirBytes)}`;
	const held = heldText === "" ? "" : `\nheld text: ${heldText.slice(0, 500)}`;
	await reply(
		[
			`temp skill: ${fetched.descriptor.name}`,
			`from ${fetched.descriptor.sourceUrl}`,
			`${sizes}`,
			`${flag}injection check: ${verdict.status}${held}`,
			"",
			"not installed — invoking stages a one-turn copy.",
		].join("\n"),
		kb,
	);
}

export const TEMP_SKILL_CALLBACK_RE = /^skilltmp:(y|n):([a-z0-9]+)$/;

export function parseTempSkillCallback(
	data: string,
): { op: "invoke" | "drop"; token: string } | null {
	const m = TEMP_SKILL_CALLBACK_RE.exec(data);
	if (m === null) return null;
	return { op: m[1] === "y" ? "invoke" : "drop", token: m[2]! };
}

export interface TempSkillQuery {
	id: string;
	data?: string;
	message?: { message_id: number; chat: { id: number } };
}

export async function handleTempSkillCallback(
	deps: SkillCommandDeps,
	query: TempSkillQuery,
): Promise<void> {
	const answer = (text?: string) =>
		withTimeout(
			text === undefined
				? deps.api.answerCallbackQuery(query.id)
				: deps.api.answerCallbackQuery(query.id, { text }),
			"answerCallbackQuery",
		).catch((err: unknown) => {
			log.debug("answerCallbackQuery failed", { error: String(err) });
		});
	const parsed = parseTempSkillCallback(query.data ?? "");
	if (parsed === null) {
		await answer("unknown button");
		return;
	}
	const p = pending.get(parsed.token);
	if (p === undefined) {
		await stamp(deps, query, "⚠ pending temp skill is gone — run /skill again.");
		await answer("expired");
		return;
	}
	const now = (deps.now ?? (() => new Date()))().getTime();
	if (p.expiresAt <= now) {
		pending.delete(parsed.token);
		log.info("temp skill pending expired", { token: parsed.token, name: p.name });
		await stamp(deps, query, "⚠ pending temp skill expired — run /skill again.");
		await answer("expired");
		return;
	}
	// Consumed either way — a tap is single-use, including a refusal.
	pending.delete(parsed.token);
	if (parsed.op === "drop") {
		log.info("temp skill dropped", { token: parsed.token, name: p.name });
		await stamp(deps, query, `🚫 temp skill ${p.name} dropped — nothing invoked.`);
		await answer();
		return;
	}
	const conv = deps.store.get(p.conversationId);
	if (conv === null || conv.epoch !== p.epoch) {
		log.info("temp skill invoke fenced — conversation moved on", {
			conversation: p.conversationId,
			epoch: p.epoch,
			current: conv?.epoch ?? null,
		});
		await stamp(
			deps,
			query,
			conv === null
				? "⚠ that conversation no longer exists — nothing invoked."
				: "⚠ the conversation moved on — run /skill again.",
		);
		await answer("stale");
		return;
	}
	submitSkillTurn(deps, conv, p.ref, p.text);
	await stamp(deps, query, `✅ temp skill ${p.name} invoked into the conversation.`);
	await answer();
}

async function stamp(
	deps: SkillCommandDeps,
	query: TempSkillQuery,
	text: string,
): Promise<void> {
	if (query.message === undefined) return;
	await withTimeout(
		deps.api.editMessageText(query.message.chat.id, query.message.message_id, text, {
			reply_markup: { inline_keyboard: [] },
		}),
		"editMessageText",
	).catch((err: unknown) => {
		log.debug("temp skill stamp failed", { error: String(err) });
	});
}

function fmtBytes(n: number): string {
	if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
	if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
	return `${n}B`;
}

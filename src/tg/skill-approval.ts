// Skill proposal taps — the in-chat ✅/🚫 that mail approval proved
// (design/skills.md, "It proposes, then tells"). The notice posts one
// message per proposed skill with an Install/Discard row; taps decide
// here through the shared decision machinery (src/skill-decisions.ts —
// the same disk semantics and resolution-event the operator doors'
// POST skills/decide runs). This file keeps the Telegram-only parts:
// callback parse, the message stamp, and the toast answer. A tap on a
// gone proposal answers "already handled".

import type { Api } from "grammy";
import type { UIMessage } from "ai";
import { log } from "../log.ts";
import {
	appendSkillResolution,
	decideSkillProposal,
	skillResolutionText,
} from "../skill-decisions.ts";
import { withTimeout } from "./deadline.ts";

export const SKILL_CALLBACK_RE = /^skill:(install|discard):(.+):([^:]+)$/;

export function skillInstallData(conversationId: string, skill: string): string {
	return `skill:install:${conversationId}:${skill}`;
}

export function skillDiscardData(conversationId: string, skill: string): string {
	return `skill:discard:${conversationId}:${skill}`;
}

// Spec name rule (agent/skills.ts): a-z0-9 with single hyphens, 1–64.
// The handler never trusts callback bytes for a path component — the
// parse rejects anything the catalog would reject.
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseSkillCallback(
	data: string,
): { op: "install" | "discard"; conversationId: string; skill: string } | null {
	const m = SKILL_CALLBACK_RE.exec(data);
	if (m === null) return null;
	const op = m[1] as "install" | "discard";
	const conversationId = m[2]!;
	const skill = m[3]!;
	if (!NAME_RE.test(skill)) return null;
	return { op, conversationId, skill };
}

// Structural subset of Telegram's CallbackQuery — the fields this flow
// reads (the mail-approval pattern: grammy's full type is assignable).
export interface SkillApprovalQuery {
	id: string;
	data: string;
	message?: {
		message_id: number;
		chat: { id: number };
	};
}

export interface SkillApprovalDeps {
	api: Api;
	// History appends land in the conversation that learned the skill —
	// the same one whose door carried the notice. Narrowed to the one
	// method the flow needs.
	store: { append(id: string, messages: UIMessage[]): void };
	workspaceDir: string;
	skillsDir: string;
	proposedDir: string;
	/** Test door for the swap-trash timestamp. */
	now?(): Date;
}

export interface SkillApproval {
	handleTap(query: SkillApprovalQuery): Promise<void>;
}

export function startSkillApproval(deps: SkillApprovalDeps): SkillApproval {
	const handleTap = async (query: SkillApprovalQuery): Promise<void> => {
		try {
			await decide(query);
		} catch (err) {
			// Outside the guarded paths — a programming error, not an edge
			// failure. The fire-and-forget registration can't surface it,
			// so it lands here instead of unhandledRejection.
			log.error("skill approval handler failed", err, { query: query.id });
		}
	};

	const decide = async (query: SkillApprovalQuery): Promise<void> => {
		const answer = (text?: string) =>
			withTimeout(
				text === undefined
					? deps.api.answerCallbackQuery(query.id)
					: deps.api.answerCallbackQuery(query.id, { text }),
				"answerCallbackQuery",
			).catch((err: unknown) => {
				log.debug("answerCallbackQuery failed", { error: String(err) });
			});
		const parsed = parseSkillCallback(query.data ?? "");
		if (parsed === null) {
			await answer("unknown button");
			return;
		}
		try {
			// A missing notice only loses the stamp — the action still
			// decides on disk with a null query.
			const answerText = await runDecision(parsed, query.message === undefined ? null : query);
			await answer(answerText);
		} catch (err) {
			// A filesystem error that isn't absence — the decision did not
			// happen, the buttons stay, and the tap gets the failure line
			// rather than a silently dead press.
			log.error("skill proposal decision failed", err, {
				skill: parsed.skill,
				conversation: parsed.conversationId,
			});
			await answer("internal error — nothing applied; check goblin logs");
			throw err;
		}
	};

	const runDecision = async (
		parsed: { op: "install" | "discard"; conversationId: string; skill: string },
		query: SkillApprovalQuery | null,
	): Promise<string | undefined> => {
		const { op, conversationId, skill } = parsed;
		const stamp = async (text: string) => {
			if (query === null) return;
			await withTimeout(
				deps.api.editMessageText(query.message!.chat.id, query.message!.message_id, text, {
					reply_markup: { inline_keyboard: [] },
				}),
				"editMessageText",
			).catch((err: unknown) => {
				// Cosmetic — the log line already carries the decision.
				log.debug("skill proposal stamp failed", { skill, error: String(err) });
			});
		};

		const outcome = decideSkillProposal(deps, skill, op, { conversation: conversationId });
		if (!outcome.ok && outcome.reason === "gone") {
			await stamp(
				`⚠ skill ${skill} not ${op === "install" ? "installed" : "discarded"} — proposal no longer exists (handled elsewhere)`,
			);
			return "already handled — the proposal is gone, nothing applied";
		}
		if (!outcome.ok) {
			await stamp(
				`⚠ skill ${skill} not ${op === "install" ? "installed" : "discarded"} — ${outcome.reason}; ${op === "install" ? "approve" : "discard"} conversationally`,
			);
			return;
		}
		await stamp(
			outcome.action === "install"
				? outcome.replaced
					? `✅ skill ${skill} installed — replaced the live copy.`
					: `✅ skill ${skill} installed.`
				: `🚫 skill ${skill} discarded — proposal deleted.`,
		);
		appendSkillResolution(deps.store, conversationId, skillResolutionText(outcome, skill));
	};

	return { handleTap };
}

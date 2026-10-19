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
	store: { append(id: string, messages: UIMessage[]): void };
	workspaceDir: string;
	skillsDir: string;
	proposedDir: string;
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
			const answerText = await runDecision(parsed, query.message === undefined ? null : query);
			await answer(answerText);
		} catch (err) {
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

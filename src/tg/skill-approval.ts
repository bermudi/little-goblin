import type { Api } from "grammy";
import type { UIMessage } from "ai";
import { log } from "../log.ts";
import {
	appendSkillResolution,
	decideSkillProposal,
	proposalFingerprint,
	skillResolutionText,
} from "../skill-decisions.ts";
import { withTimeout } from "./deadline.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Long enough to span the reviewer's two-rename same-name swap (reviewer.ts
// proposeSkill moves the incumbent out before the restage lands), short
// enough to never delay a tap noticeably.
const RESTAGE_PROBE_MS = 250;

// The fingerprint rides after '#': skill names and conversation ids can
// contain ':' and hex, never '#', so the split stays unambiguous.
export const SKILL_CALLBACK_RE = /^skill:(install|discard):(.+):([^:#]+)(?:#([0-9a-f]{12}))?$/;

export function skillInstallData(
	conversationId: string,
	skill: string,
	fingerprint?: string,
): string {
	return fingerprint === undefined
		? `skill:install:${conversationId}:${skill}`
		: `skill:install:${conversationId}:${skill}#${fingerprint}`;
}

export function skillDiscardData(
	conversationId: string,
	skill: string,
	fingerprint?: string,
): string {
	return fingerprint === undefined
		? `skill:discard:${conversationId}:${skill}`
		: `skill:discard:${conversationId}:${skill}#${fingerprint}`;
}

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseSkillCallback(data: string): {
	op: "install" | "discard";
	conversationId: string;
	skill: string;
	fingerprint: string | null;
} | null {
	const m = SKILL_CALLBACK_RE.exec(data);
	if (m === null) return null;
	const op = m[1] as "install" | "discard";
	const conversationId = m[2]!;
	const skill = m[3]!;
	if (!NAME_RE.test(skill)) return null;
	return { op, conversationId, skill, fingerprint: m[4] ?? null };
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
	/** Test door for the restage re-probe delay. */
	restageProbeMs?: number;
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
		parsed: {
			op: "install" | "discard";
			conversationId: string;
			skill: string;
			fingerprint: string | null;
		},
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

		// The tap decides the proposal the operator saw: a fingerprint
		// mismatch (or a legacy button with none) means the reviewer has
		// parked new content since the notice — never install or discard
		// it unseen. A same-name restage swaps the dir in two renames, so
		// a fingerprinted tap can catch the gap as a null fingerprint:
		// re-probe once, and still-null refuses — deciding then could act
		// on re-appeared bytes the notice never covered. Only legacy
		// fingerprint-less buttons keep the "gone" path in
		// decideSkillProposal.
		let current = proposalFingerprint(deps.proposedDir, skill);
		if (current === null && parsed.fingerprint !== null) {
			await sleep(deps.restageProbeMs ?? RESTAGE_PROBE_MS);
			current = proposalFingerprint(deps.proposedDir, skill);
			if (current === null) {
				log.warn("skill proposal decision refused — proposal missing at tap time", {
					skill,
					conversation: conversationId,
				});
				await stamp(
					`⚠ skill ${skill} not ${op === "install" ? "installed" : "discarded"} — proposal missing, review again`,
				);
				return "proposal missing, review again";
			}
		}
		if (current !== null && parsed.fingerprint !== current) {
			log.warn("skill proposal decision refused — proposal changed since notice", {
				skill,
				conversation: conversationId,
			});
			await stamp(
				`⚠ skill ${skill} not ${op === "install" ? "installed" : "discarded"} — proposal changed, review again`,
			);
			return "proposal changed, review again";
		}

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

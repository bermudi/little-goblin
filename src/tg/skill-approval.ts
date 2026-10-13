// Skill proposal taps — the in-chat ✅/🚫 that mail approval proved
// (design/skills.md, "It proposes, then tells"). The notice posts one
// message per proposed skill with an Install/Discard row; taps decide
// here, mechanically: install is the atomic proposal→skills/ swap
// (replacing any live copy — the same semantics the conversational
// approve hands to goblin), discard deletes the staged dir. Disk is the
// state — no rows, nothing pending a restart; a tap on a gone proposal
// answers "already handled". Each decision appends a system history
// event to the learning conversation: the original "proposed skill"
// event claims it's parked, and the resolution is the durable
// correction.

import { lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Api } from "grammy";
import type { UIMessage } from "ai";
import { log } from "../log.ts";
import { stagingRoot } from "../reviewer.ts";
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

type InstallOutcome = { ok: true; replaced: boolean } | { ok: false; reason: string };

// lstat, never stat: a symlink parked on either path is operator state —
// never clobbered, never followed (same rule as the reviewer's swaps).
function installProposal(deps: SkillApprovalDeps, skill: string): InstallOutcome {
	const proposed = join(deps.proposedDir, skill);
	const target = join(deps.skillsDir, skill);
	let proposedStats;
	try {
		proposedStats = lstatSync(proposed);
	} catch {
		return { ok: false, reason: "gone" };
	}
	if (proposedStats.isSymbolicLink()) return { ok: false, reason: "proposal dir is a symlink" };
	let targetStats;
	try {
		targetStats = lstatSync(target);
	} catch {
		// Live copy not there at all — plain move.
	}
	if (targetStats?.isSymbolicLink()) return { ok: false, reason: "live skill is a symlink" };
	mkdirSync(deps.skillsDir, { recursive: true });
	if (targetStats === undefined) {
		renameSync(proposed, target);
		return { ok: true, replaced: false };
	}
	const staging = stagingRoot(deps.workspaceDir);
	mkdirSync(staging, { recursive: true });
	const trash = join(
		staging,
		`.replaced-approve-${(deps.now?.() ?? new Date()).getTime()}-${skill}`,
	);
	rmSync(trash, { recursive: true, force: true });
	renameSync(target, trash);
	try {
		renameSync(proposed, target);
	} catch (err) {
		renameSync(trash, target); // rollback — the live copy and proposal stand
		throw err;
	}
	try {
		rmSync(trash, { recursive: true, force: true });
	} catch (err) {
		// The swap succeeded: cleanup is not a decision failure.
		log.warn("skill approve replaced-copy cleanup failed", err, { skill, trash });
	}
	return { ok: true, replaced: true };
}

function discardProposal(deps: SkillApprovalDeps, skill: string): { ok: boolean; reason?: string } {
	const proposed = join(deps.proposedDir, skill);
	let stats;
	try {
		stats = lstatSync(proposed);
	} catch {
		return { ok: false, reason: "gone" };
	}
	if (stats.isSymbolicLink()) return { ok: false, reason: "proposal dir is a symlink" };
	// The ruling defines discard as deletion; a proposal is a
	// regenerable reviewer artifact, never operator-authored work.
	rmSync(proposed, { recursive: true, force: true });
	return { ok: true };
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
		if (query.message === undefined) {
			// The notice died — the action is still decided on disk.
			await runDecision(parsed, null);
			await answer();
			return;
		}
		await runDecision(parsed, query);
		await answer();
	};

	const runDecision = async (
		parsed: { op: "install" | "discard"; conversationId: string; skill: string },
		query: SkillApprovalQuery | null,
	): Promise<void> => {
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
		const strip = async () => {
			if (query === null) return;
			await withTimeout(
				deps.api.editMessageReplyMarkup(query.message!.chat.id, query.message!.message_id, {
					reply_markup: { inline_keyboard: [] },
				}),
				"editMessageReplyMarkup",
			).catch((err: unknown) => {
				log.debug("skill button strip failed", { skill, error: String(err) });
			});
		};
		const appendHistory = (text: string) => {
			try {
				deps.store.append(conversationId, [
					{ id: randomUUID(), role: "system", parts: [{ type: "text", text }] },
				]);
			} catch (err) {
				// The decision already happened — the stamp and the log carry
				// it; a history append failure never un-decides a tap.
				log.warn("skill approval history append failed", err, {
					conversation: conversationId,
					skill,
				});
			}
		};

		if (op === "install") {
			const outcome = installProposal(deps, skill);
			if (!outcome.ok && outcome.reason === "gone") {
				log.info("skill proposal tap on gone proposal", { skill, conversation: conversationId });
				await strip();
				return;
			}
			if (!outcome.ok) {
				log.warn("skill proposal install conflict", {
					skill,
					conversation: conversationId,
					reason: outcome.reason,
				});
				await stamp(`⚠ skill ${skill} not installed — ${outcome.reason}; approve conversationally`);
				return;
			}
			log.info("skill proposal installed", {
				skill,
				conversation: conversationId,
				replaced: outcome.replaced,
			});
			await stamp(
				outcome.replaced
					? `✅ skill ${skill} installed — replaced the live copy.`
					: `✅ skill ${skill} installed.`,
			);
			appendHistory(
				`skill proposal resolved: ${skill} — installed${outcome.replaced ? " (replaced live copy)" : ""}`,
			);
			return;
		}
		const outcome = discardProposal(deps, skill);
		if (!outcome.ok && outcome.reason === "gone") {
			log.info("skill proposal tap on gone proposal", { skill, conversation: conversationId });
			await strip();
			return;
		}
		if (!outcome.ok) {
			log.warn("skill proposal discard conflict", {
				skill,
				conversation: conversationId,
				reason: outcome.reason,
			});
			await stamp(`⚠ skill ${skill} not discarded — ${outcome.reason}; discard conversationally`);
			return;
		}
		log.info("skill proposal discarded", { skill, conversation: conversationId });
		await stamp(`🚫 skill ${skill} discarded — proposal deleted.`);
		appendHistory(`skill proposal resolved: ${skill} — discarded (deleted)`);
	};

	return { handleTap };
}

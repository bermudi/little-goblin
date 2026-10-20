// The Telegram side of the program grant boundary: requestApproval
// posts the complete immutable candidate — charter in full plus the
// resulting trigger set — chunked but never truncated, buttons on the
// last chunk only. handleTap turns the operator's tap into the store's
// one-transaction decision: no tap, no activation. A hook requested by
// a proposal is minted here at grant time — the token never enters
// model context, tool results, stamps or logs; it goes only to the
// operators' private chats.

import type { Api } from "grammy";
import { formatAddress } from "../conversation.ts";
import { log } from "../log.ts";
import { hookTokenHash, hookUrl, newHookToken } from "../program-hook.ts";
import type { ProgramProposal, ProposalRefusal } from "../program-proposals.ts";
import type { ProgramsStore } from "../programs.ts";
import { withTimeout } from "./deadline.ts";

export const PROGRAM_APPROVE_PREFIX = "program:approve:";
export const PROGRAM_REJECT_PREFIX = "program:reject:";
export const PROGRAM_CALLBACK_RE = /^program:(approve|reject):(\d+)$/;

const PROPOSAL_CHUNK = 3800;

export interface ProgramApprovalQuery {
	id: string;
	data: string;
	from: { id: number };
	message?: {
		message_id: number;
		chat: { id: number };
	};
}

export interface ProgramApprovalDeps {
	api: Api;
	programs: Pick<ProgramsStore, "get" | "proposals">;
	publicUrl(): string | undefined;
	/** The same operator-DM lane the hook tool uses — secret delivery
	 *  stays behind this one seam. */
	sendPrivate(text: string): Promise<void>;
	now?(): Date;
}

export interface ProgramApproval {
	requestApproval(proposal: ProgramProposal): Promise<void>;
	handleTap(query: ProgramApprovalQuery): Promise<void>;
}

export function startProgramApproval(deps: ProgramApprovalDeps): ProgramApproval {
	const requestApproval = async (proposal: ProgramProposal): Promise<void> => {
		const chunks = chunkProposalText(proposalText(deps.programs, proposal));
		for (let i = 0; i < chunks.length; i++) {
			const last = i === chunks.length - 1;
			await withTimeout(
				deps.api.sendMessage(proposal.chatId, chunks[i]!, {
					...(proposal.threadId !== null ? { message_thread_id: proposal.threadId } : {}),
					...(last
						? {
								reply_markup: {
									inline_keyboard: [
										[
											{
												text: "✅ Approve",
												callback_data: `${PROGRAM_APPROVE_PREFIX}${proposal.id}`,
											},
											{
												text: "🚫 Reject",
												callback_data: `${PROGRAM_REJECT_PREFIX}${proposal.id}`,
											},
										],
									],
								},
							}
						: {}),
				}),
				"sendMessage",
			);
		}
		log.info("program approval posted", {
			proposal: proposal.id,
			kind: proposal.kind,
			conversation: formatAddress(
				proposal.threadId === null
					? { kind: "dm", chatId: proposal.chatId }
					: { kind: "topic", chatId: proposal.chatId, threadId: proposal.threadId },
			),
			chunks: chunks.length,
		});
	};

	const handleTap = async (query: ProgramApprovalQuery): Promise<void> => {
		try {
			await decide(query);
		} catch (err) {
			log.error("program approval handler failed", err, { query: query.id });
			await withTimeout(
				deps.api.answerCallbackQuery(query.id, { text: "internal error" }),
				"answerCallbackQuery",
			).catch((e: unknown) => log.debug("answerCallbackQuery failed", { error: String(e) }));
		}
	};

	const decide = async (query: ProgramApprovalQuery): Promise<void> => {
		const answer = (text?: string) =>
			withTimeout(
				text === undefined
					? deps.api.answerCallbackQuery(query.id)
					: deps.api.answerCallbackQuery(query.id, { text }),
				"answerCallbackQuery",
			).catch((err: unknown) => {
				log.debug("answerCallbackQuery failed", { error: String(err) });
			});

		const match = PROGRAM_CALLBACK_RE.exec(query.data);
		if (!match) {
			await answer("unknown button");
			return;
		}
		const op = match[1]!;
		const proposalId = Number(match[2]);
		const proposal = deps.programs.proposals.get(proposalId);
		if (proposal === null) {
			await answer("proposal gone");
			return;
		}
		if (proposal.state !== "pending") {
			await stripButtons(deps.api, proposal, query);
			await answer(`already ${proposal.state}`);
			return;
		}

		if (op === "reject") {
			const outcome = deps.programs.proposals.reject(proposalId, query.from.id, deps.now?.());
			if (outcome.kind !== "rejected") {
				await answer(refusalText(outcome.refusal));
				return;
			}
			await stamp(
				deps.api,
				proposal,
				query,
				`🚫 Proposal #${proposalId} rejected — nothing was granted.`,
			);
			await answer("rejected");
			return;
		}

		// Approve. A requested hook mints here: publicUrl must exist
		// before the grant, or the proposal stays pending for a later
		// tap — approving with no reachable URL would activate a hook
		// the operator can never receive.
		const wantsHook =
			proposal.kind === "create" ? proposal.draft?.hook === true : proposal.patch?.hook === true;
		const base = wantsHook ? deps.publicUrl() : undefined;
		if (wantsHook && base === undefined) {
			await answer(
				"publicUrl isn't set — set it in the mini app, then approve again; the proposal stays pending",
			);
			return;
		}
		const token = wantsHook ? newHookToken() : undefined;
		const outcome = deps.programs.proposals.approve(proposalId, query.from.id, {
			...(token !== undefined ? { hookHash: hookTokenHash(token) } : {}),
			...(deps.now !== undefined ? { now: deps.now() } : {}),
		});
		if (outcome.kind !== "activated") {
			await answer(refusalText(outcome.refusal));
			return;
		}
		const program = outcome.program;
		if (token !== undefined) {
			// The grant already landed — a delivery failure reports
			// granted-but-undelivered with rotation guidance, never a
			// pretended rollback.
			try {
				await deps.sendPrivate(
					`Webhook for program ${program.name}: ${hookUrl(base!, token)}\nKeep it secret; rotate via goblin if it leaks.`,
				);
			} catch (err) {
				log.warn("program hook URL delivery failed — the grant is active", err, {
					proposal: proposalId,
					program: program.id,
				});
				await stamp(
					deps.api,
					proposal,
					query,
					`✅ Proposal #${proposalId} approved — "${program.name}" is active, but the webhook URL could not be delivered (${err instanceof Error ? err.message : String(err)}). Ask goblin to rotate the hook to resend it.`,
				);
				await answer("approved — webhook URL delivery failed; rotate to resend");
				return;
			}
		}
		await stamp(
			deps.api,
			proposal,
			query,
			`✅ Proposal #${proposalId} approved — "${program.name}" is active${token !== undefined ? "; the webhook URL was sent privately" : ""}.`,
		);
		await answer("approved");
	};

	return { requestApproval, handleTap };
}

function refusalText(refusal: ProposalRefusal): string {
	switch (refusal) {
		case "gone":
			return "proposal gone";
		case "decided":
			return "already decided";
		case "superseded":
			return "a newer proposal superseded this one";
		case "target-gone":
			return "the program is gone — nothing applied; reject the proposal to clear it";
		case "stale":
			return "the program changed since this proposal — it no longer matches what was shown; reject it and ask again";
		case "hook-unsatisfied":
			return "the hook credential wasn't generated — nothing applied";
	}
}

// The complete candidate: for a create, the whole draft; for an
// update, the resulting configuration (current row merged with the
// requested patch — the shown grant is what lands, not just the
// diff). Nothing abbreviated: the operator approves exactly this.
function proposalText(programs: Pick<ProgramsStore, "get">, proposal: ProgramProposal): string {
	const header =
		proposal.kind === "create"
			? `📋 Program proposal #${proposal.id} — new program "${proposal.draft!.name}".`
			: `📋 Program proposal #${proposal.id} — changes to program ${proposal.targetId}.`;
	const lead =
		proposal.kind === "create"
			? "Approving grants it standing authority exactly as shown:"
			: "Approving applies exactly this configuration:";
	if (proposal.kind === "create") {
		const d = proposal.draft!;
		return [
			header,
			lead,
			"",
			`name: ${d.name}`,
			"charter:",
			d.charter,
			"",
			`triggers: ${triggerLine({ cron: d.cron, maxLatenessMinutes: d.maxLatenessMinutes, hook: d.hook, mailFilter: d.mailFilter })}`,
		].join("\n");
	}
	const patch = proposal.patch!;
	const target = proposal.targetId !== null ? programs.get(proposal.targetId) : null;
	if (target === null) {
		return [
			header,
			lead,
			"",
			"(the program is already gone — the approval will refuse; reject to clear it)",
			"",
			`requested: ${JSON.stringify(patch)}`,
		].join("\n");
	}
	const merged = {
		name: patch.name ?? target.name,
		charter: patch.charter ?? target.charter,
		cron: patch.cron !== undefined ? patch.cron : target.cron,
		maxLatenessMinutes:
			patch.maxLatenessMinutes !== undefined ? patch.maxLatenessMinutes : target.maxLatenessMinutes,
		hook: patch.hook === true ? true : target.hookHash !== null,
		mailFilter: patch.mailFilter !== undefined ? patch.mailFilter : target.mailFilter,
	};
	return [
		header,
		lead,
		"",
		`name: ${merged.name}`,
		"charter:",
		merged.charter,
		"",
		`triggers: ${triggerLine(merged)}`,
	].join("\n");
}

function triggerLine(t: {
	cron: string | null;
	maxLatenessMinutes: number | null;
	hook: boolean;
	mailFilter: string | null;
}): string {
	const parts: string[] = [];
	if (t.cron !== null) {
		parts.push(
			`cron "${t.cron}"${t.maxLatenessMinutes !== null ? ` (fires at most ${t.maxLatenessMinutes}m late)` : " (no lateness limit)"}`,
		);
	}
	if (t.hook) parts.push("webhook");
	if (t.mailFilter !== null) parts.push(`mail filter "${t.mailFilter}"`);
	return parts.length === 0 ? "none" : parts.join(", ");
}

// Bounded input (the charter cap lives in the proposal schema) means
// no truncation marker — every chunk lands verbatim, buttons on the
// last. Same split policy as the mail draft's: prefer a newline
// boundary, never split a surrogate pair.
export function chunkProposalText(text: string): string[] {
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > PROPOSAL_CHUNK) {
		let cut = rest.lastIndexOf("\n", PROPOSAL_CHUNK);
		if (cut < PROPOSAL_CHUNK / 2) cut = PROPOSAL_CHUNK;
		const before = rest.charCodeAt(cut - 1);
		const after = rest.charCodeAt(cut);
		if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) cut--;
		chunks.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^\n/, "");
	}
	if (rest.length > 0) chunks.push(rest);
	return chunks;
}

async function stamp(
	api: Api,
	proposal: ProgramProposal,
	query: ProgramApprovalQuery,
	text: string,
): Promise<void> {
	if (query.message === undefined) return;
	await withTimeout(
		api.editMessageText(query.message.chat.id, query.message.message_id, text, {
			...(proposal.threadId !== null ? { message_thread_id: proposal.threadId } : {}),
			reply_markup: { inline_keyboard: [] },
		}),
		"editMessageText",
	).catch((err: unknown) => {
		log.warn("program approval stamp failed", err, { proposal: proposal.id });
	});
}

async function stripButtons(
	api: Api,
	proposal: ProgramProposal,
	query: ProgramApprovalQuery,
): Promise<void> {
	if (query.message === undefined) return;
	await withTimeout(
		api.editMessageReplyMarkup(query.message.chat.id, query.message.message_id, {
			...(proposal.threadId !== null ? { message_thread_id: proposal.threadId } : {}),
			reply_markup: { inline_keyboard: [] },
		}),
		"editMessageReplyMarkup",
	).catch((err: unknown) => {
		log.debug("program button strip failed", { proposal: proposal.id, error: String(err) });
	});
}

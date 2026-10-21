// Telegram presentation for program grants: post the complete
// immutable candidate in chunks, translate callback taps into the
// shared decision owner, answer callbacks, and stamp the result. Durable
// approval/rejection and hook minting live in ../program-approval.ts.

import type { Api } from "grammy";
import { formatAddress } from "../conversation.ts";
import { log } from "../log.ts";
import {
	proposalText,
	refusalText,
	type ProgramApproval,
	type ProgramDecisionOutcome,
} from "../program-approval.ts";
import type { ProgramProposal } from "../program-proposals.ts";
import type { ProgramsStore } from "../programs.ts";
import { telegramActor, telegramAddressOf } from "../targets.ts";
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

export interface TelegramProgramApprovalDeps {
	api: Api;
	approval: ProgramApproval;
	programs: Pick<ProgramsStore, "get">;
	/** The same operator-DM lane the hook tool uses — secret delivery
	 *  stays behind this one seam. */
	sendPrivate(text: string): Promise<void>;
}

export interface TelegramProgramApproval {
	handleTap(query: ProgramApprovalQuery): Promise<void>;
}

export function startTelegramProgramApproval(
	deps: TelegramProgramApprovalDeps,
): TelegramProgramApproval {
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
		const action = match[1] === "approve" ? "approve" : "reject";
		const proposalId = Number(match[2]);
		const proposal = deps.approval.pending().find((p) => p.id === proposalId);
		const outcome = await deps.approval.decide(proposalId, action, telegramActor(query.from.id));
		if (outcome.kind === "refused") {
			if (outcome.proposal !== null && outcome.proposal.state !== "pending") {
				await stripButtons(deps.api, outcome.proposal, query);
			}
			await answer(telegramRefusalText(outcome));
			return;
		}
		if (outcome.kind === "needs-public-url") {
			await answer(
				"publicUrl isn't set — set it in the mini app, then approve again; the proposal stays pending",
			);
			return;
		}
		if (outcome.kind === "rejected") {
			await stamp(
				deps.api,
				proposal,
				query,
				`🚫 Proposal #${proposalId} rejected — nothing was granted.`,
			);
			await answer("rejected");
			return;
		}

		if (outcome.hookUrl !== undefined) {
			try {
				await deps.sendPrivate(
					`Webhook for program ${outcome.program.name}: ${outcome.hookUrl}\nKeep it secret; rotate via goblin if it leaks.`,
				);
			} catch (err) {
				log.warn("program hook URL delivery failed — the grant is active", err, {
					proposal: proposalId,
					program: outcome.program.id,
				});
				await stamp(
					deps.api,
					proposal,
					query,
					`✅ Proposal #${proposalId} approved — "${outcome.program.name}" is active, but the webhook URL could not be delivered (${err instanceof Error ? err.message : String(err)}). Ask goblin to rotate the hook to resend it.`,
				);
				await answer("approved — webhook URL delivery failed; rotate to resend");
				return;
			}
		}
		await stampApproval(deps.api, proposal, query, outcome);
		await answer("approved");
	};

	return { handleTap };
}

function telegramRefusalText(
	outcome: Extract<ProgramDecisionOutcome, { kind: "refused" }>,
): string {
	if (outcome.refusal === "decided" && outcome.proposal !== null) {
		return `already ${outcome.proposal.state}`;
	}
	if (outcome.refusal === "superseded") return "already superseded";
	return refusalText(outcome.refusal);
}

async function stampApproval(
	api: Api,
	proposal: ProgramProposal | undefined,
	query: ProgramApprovalQuery,
	outcome: Extract<ProgramDecisionOutcome, { kind: "activated" }>,
): Promise<void> {
	await stamp(
		api,
		proposal,
		query,
		`✅ Proposal #${outcome.proposal.id} approved — "${outcome.program.name}" is active${outcome.hookUrl !== undefined ? "; the webhook URL was sent privately" : ""}.`,
	);
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

export async function postProgramApproval(
	api: Api,
	programs: Pick<ProgramsStore, "get">,
	proposal: ProgramProposal,
): Promise<void> {
	const address = telegramAddressOf(proposal.target);
	if (address === null) throw new Error(`proposal ${proposal.id} is not addressed to Telegram`);
	const chunks = chunkProposalText(proposalText(programs, proposal));
	for (let i = 0; i < chunks.length; i++) {
		const last = i === chunks.length - 1;
		await withTimeout(
			api.sendMessage(address.chatId, chunks[i]!, {
				...(address.threadId !== null ? { message_thread_id: address.threadId } : {}),
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
			address.threadId === null
				? { kind: "dm", chatId: address.chatId }
				: { kind: "topic", chatId: address.chatId, threadId: address.threadId },
		),
		chunks: chunks.length,
	});
}

async function stamp(
	api: Api,
	proposal: ProgramProposal | undefined,
	query: ProgramApprovalQuery,
	text: string,
): Promise<void> {
	if (query.message === undefined) return;
	const threadId = proposal?.threadId ?? null;
	await withTimeout(
		api.editMessageText(query.message.chat.id, query.message.message_id, text, {
			...(threadId !== null ? { message_thread_id: threadId } : {}),
			reply_markup: { inline_keyboard: [] },
		}),
		"editMessageText",
	).catch((err: unknown) => {
		log.warn("program approval stamp failed", err, { proposal: proposal?.id });
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

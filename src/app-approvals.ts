// App presentation for shared approvals. The durable transcript carries
// a typed marker only; the authenticated approvals API supplies the
// complete proposal/draft when the card renders. Decisions still route
// through the shared owners — this module never decides.

import { randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import type { ConversationStore } from "./conversation.ts";
import type { MailApprovalLane } from "./mail-approval.ts";
import type { OutboxEntry } from "./mail-outbox.ts";
import type { ProgramProposal } from "./program-proposals.ts";
import { appConversationOf } from "./targets.ts";

export const APPROVAL_PART = "data-approval";
export type ApprovalPartKind = "program" | "mail";

export interface ApprovalPartData {
	kind: ApprovalPartKind;
	id: number;
}

function approvalMessage(kind: ApprovalPartKind, id: number): UIMessage {
	return {
		id: randomUUID(),
		role: "system",
		parts: [{ type: APPROVAL_PART, data: { kind, id } }],
	} as UIMessage;
}

function noticeMessage(text: string): UIMessage {
	return {
		id: randomUUID(),
		role: "system",
		parts: [{ type: "text", text }],
	};
}

export function presentProgramApproval(
	store: Pick<ConversationStore, "append" | "get">,
	proposal: ProgramProposal,
): void {
	const conversationId = appConversationOf(proposal.target);
	if (conversationId === null || store.get(conversationId) === null) {
		throw new Error(`proposal ${proposal.id} is not addressed to an app conversation`);
	}
	store.append(conversationId, [approvalMessage("program", proposal.id)]);
}

export function makeAppMailLane(
	store: Pick<ConversationStore, "append" | "get">,
): MailApprovalLane {
	const append = (row: OutboxEntry, message: UIMessage): void => {
		const conversationId = appConversationOf(row.target);
		if (conversationId === null || store.get(conversationId) === null) {
			throw new Error(`mail draft ${row.id} is not addressed to an app conversation`);
		}
		store.append(conversationId, [message]);
	};
	return {
		async present(row) {
			append(row, approvalMessage("mail", row.id));
			return { kind: "posted", messageId: null, surface: "the app" };
		},
		async notice(row, text) {
			append(row, noticeMessage(text));
		},
		async settle(row, text) {
			append(row, noticeMessage(text));
		},
		async strip() {},
	};
}

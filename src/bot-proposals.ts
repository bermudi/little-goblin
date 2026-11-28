import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Bot, BotStore } from "./bots.ts";
import type { ConversationStore } from "./conversation.ts";
import { appIdOf } from "./conversation-address.ts";
import { presentBotApproval } from "./app-approvals.ts";
import { log } from "./log.ts";
import type { ModelSettings } from "./conversation-settings.ts";
import type { Config } from "./config-schema.ts";
import type { ThinkingLevel } from "./config-schema.ts";

export interface BotProposal {
	id: number;
	conversationId: string;
	name: string;
	instructions: string;
	model: string | null;
	thinking: ThinkingLevel | null;
	state: "pending" | "approved" | "declined";
	createdAt: string;
	decidedAt: string | null;
	botId: string | null;
}

export type BotProposalInput = Pick<BotProposal, "conversationId" | "name" | "instructions" | "model" | "thinking">;

const proposalSelect = `
	SELECT id, conversation_id AS conversationId, name, instructions, model, thinking,
		state, created_at AS createdAt, decided_at AS decidedAt, bot_id AS botId
	FROM bot_proposals
`;

export function makeBotProposals(
	db: Database,
	bots: BotStore,
	store: Pick<ConversationStore, "append" | "get">,
	workspace: () => string,
	defaults: () => ModelSettings & { providers?: Config["providers"] },
	now: () => Date,
) {
	const getQuery = db.query<BotProposal, [number]>(`${proposalSelect} WHERE id = ?`);
	const pendingQuery = db.query<BotProposal, []>(`${proposalSelect} WHERE state = 'pending' ORDER BY id`);
	const insert = db.query(
		"INSERT INTO bot_proposals (conversation_id, name, instructions, model, thinking, state, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
	);
	const update = db.query(
		"UPDATE bot_proposals SET state = ?, decided_at = ?, bot_id = ? WHERE id = ? AND state = 'pending'",
	);
	const row = (id: number): BotProposal | null => getQuery.get(id) ?? null;
	const notice = (conversationId: string, text: string): void => {
		if (store.get(conversationId) === null) throw new Error(`bot proposal target ${conversationId} is missing`);
		store.append(conversationId, [{ id: randomUUID(), role: "system", parts: [{ type: "text", text }] }]);
	};

	return {
		propose(input: BotProposalInput): BotProposal | null {
			const proposal = db.transaction(() => {
				const source = store.get(input.conversationId);
				if (source === null || appIdOf(source.id) === null || source.archivedAt !== null ||
					source.persona === "guest" || source.agentType !== null || source.projectId !== null ||
					bots.membership(source.id) !== null) return null;
				const result = insert.run(input.conversationId, input.name, input.instructions, input.model, input.thinking, now().toISOString());
				const pending = row(Number(result.lastInsertRowid));
				if (pending === null) throw new Error("bot proposal insert could not be read");
				presentBotApproval(store, pending);
				return pending;
			}).immediate();
			if (proposal !== null) log.info("bot proposal created", { proposal: proposal.id, conversation: proposal.conversationId });
			else log.info("bot proposal refused", { conversation: input.conversationId });
			return proposal;
		},
		get: row,
		pending: () => pendingQuery.all(),
		approve(id: number):
			| { kind: "approved"; proposal: BotProposal; bot: Bot }
			| { kind: "settled"; proposal: BotProposal }
			| { kind: "missing" } {
			return db.transaction(() => {
				const current = row(id);
				if (current === null) return { kind: "missing" as const };
				if (current.state !== "pending") return { kind: "settled" as const, proposal: current };
				const decidedAt = now();
				const folder = join(workspace(), "bots", String(id));
				mkdirSync(folder, { recursive: true });
				const bot = bots.create({
					id: randomUUID(),
					name: current.name,
					instructions: current.instructions,
					folder,
					model: current.model,
					thinking: current.thinking,
					createdAt: decidedAt,
				}, defaults());
				update.run("approved", decidedAt.toISOString(), bot.id, id);
				const decided = row(id);
				if (decided === null) throw new Error(`approved bot proposal ${id} disappeared`);
				if (store.get(decided.conversationId) !== null) {
					notice(decided.conversationId, `Bot "${decided.name}" was created. It shows under Bots.`);
				}
				return { kind: "approved" as const, proposal: decided, bot };
			}).immediate();
		},
		decline(id: number):
			| { kind: "declined"; proposal: BotProposal }
			| { kind: "settled"; proposal: BotProposal }
			| { kind: "missing" } {
			return db.transaction(() => {
				const current = row(id);
				if (current === null) return { kind: "missing" as const };
				if (current.state !== "pending") return { kind: "settled" as const, proposal: current };
				update.run("declined", now().toISOString(), null, id);
				const decided = row(id);
				if (decided === null) throw new Error(`declined bot proposal ${id} disappeared`);
				if (store.get(decided.conversationId) !== null) {
					notice(decided.conversationId, `Bot proposal "${decided.name}" was declined.`);
				}
				return { kind: "declined" as const, proposal: decided };
			}).immediate();
		},
	};
}

export type BotProposals = ReturnType<typeof makeBotProposals>;

import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Bot, BotStore } from "./bots.ts";
import type { ConversationStore } from "./conversation.ts";
import type { AppBotProposal } from "./http/app-wire.ts";
import { log } from "./log.ts";
import type { ModelSettings } from "./conversation-settings.ts";
import type { Config } from "./config-schema.ts";
import type { ThinkingLevel } from "./config-schema.ts";

interface ProposalRow {
	id: number;
	conversationId: string;
	name: string;
	instructions: string;
	model: string | null;
	thinking: ThinkingLevel | null;
	state: AppBotProposal["state"];
	createdAt: string;
	decidedAt: string | null;
	botId: string | null;
}

export type BotProposalInput = Omit<
	Pick<AppBotProposal, "conversationId" | "name" | "instructions" | "model" | "thinking">,
	"thinking"
> & { thinking: ThinkingLevel | null };

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
) {
	const getQuery = db.query<ProposalRow, [number]>(`${proposalSelect} WHERE id = ?`);
	const pendingQuery = db.query<ProposalRow, []>(`${proposalSelect} WHERE state = 'pending' ORDER BY id`);
	const insert = db.query(
		"INSERT INTO bot_proposals (conversation_id, name, instructions, model, thinking, state, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
	);
	const update = db.query(
		"UPDATE bot_proposals SET state = ?, decided_at = ?, bot_id = ? WHERE id = ? AND state = 'pending'",
	);
	const row = (id: number): ProposalRow | null => getQuery.get(id) ?? null;
	const notice = (conversationId: string, text: string): void => {
		if (store.get(conversationId) === null) throw new Error(`bot proposal target ${conversationId} is missing`);
		store.append(conversationId, [{ id: randomUUID(), role: "system", parts: [{ type: "text", text }] }]);
	};

	return {
		propose(input: BotProposalInput, now = new Date().toISOString()): AppBotProposal {
			if (store.get(input.conversationId) === null) throw new Error("bot proposal target is missing");
			const result = insert.run(
				input.conversationId, input.name, input.instructions, input.model, input.thinking, now,
			);
			const proposal = row(Number(result.lastInsertRowid));
			if (proposal === null) throw new Error("bot proposal insert could not be read");
			log.info("bot proposal created", { proposal: proposal.id, conversation: proposal.conversationId });
			return proposal;
		},
		get: row,
		pending: () => pendingQuery.all(),
		approve(id: number, now = Date.now()):
			| { kind: "approved"; proposal: AppBotProposal; bot: Bot }
			| { kind: "settled"; proposal: AppBotProposal }
			| { kind: "missing" } {
			const proposal = row(id);
			if (proposal === null) return { kind: "missing" };
			if (proposal.state !== "pending") return { kind: "settled", proposal };
			const botId = randomUUID();
			const folder = join(workspace(), "bots", botId);
			mkdirSync(folder, { recursive: true });
			const outcome = db.transaction(() => {
				const current = row(id);
				if (current === null) return { kind: "missing" as const };
				if (current.state !== "pending") return { kind: "settled" as const, proposal: current };
				const bot = bots.create({
					id: botId,
					name: current.name,
					instructions: current.instructions,
					folder,
					model: current.model,
					thinking: current.thinking,
					createdAt: now,
				}, defaults());
				update.run("approved", new Date(now).toISOString(), bot.id, id);
				const decided = row(id);
				if (decided === null) throw new Error(`approved bot proposal ${id} disappeared`);
				return { kind: "approved" as const, proposal: decided, bot };
			}).immediate();
			if (outcome.kind === "approved") {
				notice(outcome.proposal.conversationId, `Bot "${outcome.proposal.name}" was created. It shows under Bots.`);
			}
			return outcome;
		},
		decline(id: number, now = Date.now()):
			| { kind: "declined"; proposal: AppBotProposal }
			| { kind: "settled"; proposal: AppBotProposal }
			| { kind: "missing" } {
			const outcome = db.transaction(() => {
				const current = row(id);
				if (current === null) return { kind: "missing" as const };
				if (current.state !== "pending") return { kind: "settled" as const, proposal: current };
				update.run("declined", new Date(now).toISOString(), null, id);
				const decided = row(id);
				if (decided === null) throw new Error(`declined bot proposal ${id} disappeared`);
				return { kind: "declined" as const, proposal: decided };
			}).immediate();
			if (outcome.kind === "declined") {
				notice(outcome.proposal.conversationId, `Bot proposal "${outcome.proposal.name}" was declined.`);
			}
			return outcome;
		},
	};
}

export type BotProposals = ReturnType<typeof makeBotProposals>;

import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "./conversation.ts";
import { appAddress } from "./conversation-address.ts";
import { makeBotProposals } from "./bot-proposals.ts";
import { tmpDir } from "./testkit.ts";

function fixture(workspace = tmpDir("goblin-bot-proposals-")) {
	const store = openStore(join(workspace, "goblin.sqlite"));
	const source = store.resolve(appAddress("proposal-source"), workspace);
	const proposals = makeBotProposals(
		store.db,
		store.bots,
		store,
		() => workspace,
		() => ({ model: "zai/m", thinking: "medium" }),
	);
	return { store, source, proposals, workspace };
}

function cleanup(f: ReturnType<typeof fixture>): void {
	f.store.close();
}

test("approval creates the bot, an empty main chat, and its folder; repeated approval settles", () => {
	const f = fixture();
	try {
		const proposal = f.proposals.propose({
			conversationId: f.source.id,
			name: "Stockroom",
			instructions: "Track stock.",
			model: null,
			thinking: null,
		});
		if (proposal === null) throw new Error("expected a proposal");
		const approved = f.proposals.approve(proposal.id, 1_800_000_000_000);
		expect(approved.kind).toBe("approved");
		if (approved.kind !== "approved") return;
		expect(approved.bot).toMatchObject({
			name: "Stockroom",
			instructions: "Track stock.",
			model: null,
			thinking: null,
			folder: join(f.workspace, "bots", String(proposal.id)),
			canMoveBack: false,
		});
		expect(f.store.bots.get(approved.bot.id)?.canMoveBack).toBe(false);
		expect(existsSync(approved.bot.folder!)).toBe(true);
		expect(typeof approved.bot.mainConversationId).toBe("string");
		expect(approved.bot.mainConversationId.startsWith("app/")).toBe(true);
		expect(f.store.bots.membership(approved.bot.mainConversationId)).toEqual({
			botId: approved.bot.id,
			mainOrdinal: 1,
		});
		expect(
			f.store.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM events WHERE conversation_id = ?")
				.get(approved.bot.mainConversationId)?.n,
		).toBe(0);
		expect(f.store.get(approved.bot.mainConversationId)).toMatchObject({
			model: "zai/m",
			thinking: "medium",
		});
		expect(f.proposals.approve(proposal.id, 1_800_000_000_001).kind).toBe("settled");
	} finally {
		cleanup(f);
	}
});

test("decline settles a proposal without creating a bot", () => {
	const f = fixture();
	try {
		const proposal = f.proposals.propose({
			conversationId: f.source.id,
			name: "Declined",
			instructions: "Do nothing.",
			model: null,
			thinking: null,
		});
		if (proposal === null) throw new Error("expected a proposal");
		expect(f.proposals.decline(proposal.id, 1_800_000_000_000).kind).toBe("declined");
		expect(f.proposals.get(proposal.id)?.state).toBe("declined");
		expect(f.store.bots.list()).toEqual([]);
	} finally {
		cleanup(f);
	}
});

test("a folder creation failure leaves proposal and bot state untouched", () => {
	const f = fixture();
	try {
		const proposal = f.proposals.propose({
			conversationId: f.source.id,
			name: "Blocked",
			instructions: "Stay safe.",
			model: null,
			thinking: null,
		});
		if (proposal === null) throw new Error("expected a proposal");
		const blockedPath = join(f.workspace, "not-a-directory");
		writeFileSync(blockedPath, "file");
		const blocked = makeBotProposals(
			f.store.db,
			f.store.bots,
			f.store,
			() => blockedPath,
			() => ({ model: "zai/m", thinking: "medium" }),
		);
		expect(() => blocked.approve(proposal.id, 1_800_000_000_000)).toThrow();
		expect(blocked.get(proposal.id)?.state).toBe("pending");
		expect(f.store.bots.list()).toEqual([]);
	} finally {
		cleanup(f);
	}
});

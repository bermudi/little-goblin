import { expect, test } from "bun:test";
import { handoverTool } from "./agent/tools/handover.ts";
import { makeAsks } from "./asks.ts";
import { LITTLE_GOBLIN_BOT_ID } from "./bots.ts";
import { appAddress } from "./conversation-address.ts";
import { openStore } from "./conversation.ts";
import type { Conversation } from "./conversation-read.ts";
import type { Config } from "./config-schema.ts";
import { HANDOVER_OPERATOR_PART, HANDOVER_STOP_PART, handoverCard } from "./handover-message.ts";
import { makeHandovers } from "./handovers.ts";
import { deferred, tmpDb } from "./testkit.ts";
import { openWakeStore } from "./wake-store.ts";

const config = { model: "unused/m", thinking: "medium" } as Config;

function rig() {
	const store = openStore(tmpDb("goblin-handovers-"));
	const current = store.rollApp(config);
	const draft = store.resolve(appAddress("drafts"), "/");
	const promoted = store.bots.convertSideChat(draft.id, "Drafts", 0, () => false);
	if (promoted.kind !== "converted") throw new Error(`unexpected promotion: ${promoted.kind}`);
	const asks = makeAsks(store.db, () => new Date());
	const wakes = openWakeStore(store.db);
	const changed: string[] = [];
	const mount = () => makeHandovers({
		store, asks, wakes, config: () => config, pump: () => {}, changed: (id) => changed.push(id),
	});
	const handovers = mount();
	const operator = (conv: Conversation, id: string) => store.append(conv.id, [{
		id, role: "user",
		parts: [{ type: "text", text: "The operator is here." }, { type: HANDOVER_OPERATOR_PART, data: id }],
	}])[0]!;
	const tool = (source: Conversation, seq: number, service = handovers) => handoverTool(service, source, {
		runId: `${source.id}:${seq}`,
		inputSeqs: () => new Set([seq]),
		sourceInputSeq: () => seq,
	});
	const cards = (conv: Conversation) =>
		store.history(conv.id).flatMap(({ parts }) => handoverCard(parts) ?? []);
	return { store, asks, wakes, current, draft, bot: promoted.bot, tool, operator, cards, mount, changed };
}

test("the fifth send wins a race, the sixth opens one durable question, and only operator input starts fresh", async () => {
	const { store, current, draft, bot, tool, operator, cards, asks, mount } = rig();
	try {
		const seq = operator(current, "first");
		const first = tool(current, seq);
		for (let i = 1; i <= 4; ++i) {
			expect(await first.execute({
				action: "send", to: bot.id, request: `Request ${i}`,
			}, { toolCallId: `call-${i}` })).toEqual({ status: "sent" });
		}
		const received = store.lastEntry(draft.id, "user")!;
		const back = tool(draft, received.seq);
		const waiting = deferred<void>();
		const entered = deferred<void>();
		const sixth = (async () => {
			entered.resolve();
			await waiting.promise;
			return back.execute({ action: "send", to: LITTLE_GOBLIN_BOT_ID, request: "Do not send this sixth request" }, { toolCallId: "six" });
		})();
		await entered.promise;
		expect(await first.execute({ action: "send", to: bot.id, request: "Fifth" }, { toolCallId: "five" })).toEqual({ status: "sent" });
		expect(await first.execute({ action: "send", to: bot.id, request: "Fifth" }, { toolCallId: "five" })).toEqual({ status: "sent" });
		waiting.resolve();
		expect(await sixth).toHaveProperty("status", "paused");
		expect(cards(current).map((card) => card.direction)).toEqual(Array(5).fill("sent"));
		expect(cards(draft).map((card) => card.direction)).toEqual(Array(5).fill("received"));
		const questions = asks.openForAttention();
		expect(questions).toHaveLength(1);
		expect(questions[0]).toMatchObject({ conversationId: draft.id, question: expect.stringContaining("Do not send this sixth request") });
		expect(store.history(draft.id).flatMap((message) => message.parts).filter((part) => part.type === HANDOVER_STOP_PART)).toHaveLength(1);

		const synthetic = store.append(draft.id, [{
			id: "another-worker-notice", role: "user", parts: [{ type: "text", text: "Work finished." }],
		}])[0]!;
		expect(await tool(draft, synthetic, mount()).execute({
			action: "send", to: LITTLE_GOBLIN_BOT_ID, request: "Still blocked after restarting",
		}, { toolCallId: "another" })).toHaveProperty("status", "paused");
		expect(asks.openForAttention()).toEqual(questions);
		const newSeq = operator(draft, "operator-back");
		expect(await tool(draft, newSeq).execute({
			action: "send", to: LITTLE_GOBLIN_BOT_ID, request: "The new request",
		}, { toolCallId: "new" })).toEqual({ status: "sent" });
		expect(cards(current).filter((card) => card.direction === "received").map((card) => card.request)).toEqual(["The new request"]);
	} finally {
		store.close();
	}
});

test("a handover goes to the latest main chat and refuses a target moved while the send waits", async () => {
	const { store, current, draft, bot, operator, tool, cards } = rig();
	try {
		const draftsTool = tool(draft, operator(draft, "draft-owner"));
		const goblinTool = tool(current, operator(current, "main-owner"));
		expect(await draftsTool.execute({ action: "list" }, { toolCallId: "list" })).toEqual({
			bots: [{ id: LITTLE_GOBLIN_BOT_ID, name: "Little Goblin" }],
		});
		const newest = store.rollApp(config);
		expect(await draftsTool.execute({
			action: "send", to: LITTLE_GOBLIN_BOT_ID, request: "Use the latest main chat",
		}, { toolCallId: "to-main" })).toEqual({ status: "sent" });
		expect(cards(newest)[0]).toMatchObject({ direction: "received", from: "Drafts" });
		expect(cards(current)).toEqual([]);

		const waiting = deferred<void>();
		const entered = deferred<void>();
		const pending = (async () => {
			entered.resolve();
			await waiting.promise;
			return goblinTool.execute({ action: "send", to: bot.id, request: "Bot moved" }, { toolCallId: "to-drafts" });
		})();
		await entered.promise;
		expect(store.bots.moveBack(bot.id, () => false)).toEqual({ kind: "moved", conversationId: draft.id });
		waiting.resolve();
		expect(await pending).toHaveProperty("error");
		expect(cards(draft)).toHaveLength(1);
		expect(cards(current)).toEqual([]);
	} finally {
		store.close();
	}
});

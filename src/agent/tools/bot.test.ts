import { expect, test } from "bun:test";
import { makeBotProposals } from "../../bot-proposals.ts";
import { appAddress } from "../../conversation-address.ts";
import { paths } from "../../home-layout.ts";
import { APP_TOKEN_NAME, setup } from "../../http/app-testing.ts";
import { botTool } from "./bot.ts";

test("bot propose stores and presents a proposal; invalid models create nothing", async () => {
	const h = setup({ token: APP_TOKEN_NAME });
	try {
		const conversation = h.store.resolve(appAddress("bot-tool-source"), paths.workspace());
		const proposals = makeBotProposals(
			h.store.db,
			h.store.bots,
			h.store,
			paths.workspace,
			() => ({
				model: h.configRef.current.model,
				thinking: h.configRef.current.thinking,
				providers: h.configRef.current.providers,
			}),
		);
		const tool = botTool({
			proposals,
			store: h.store,
			conversationId: conversation.id,
			configRef: h.configRef,
		});
		const result = await tool.execute({
			action: "propose",
			name: "Research",
			instructions: "Keep research notes.",
		}, { toolCallId: "test" });
		expect(result).toMatchObject({ message: expect.stringContaining("The bot exists only after they approve it.") });
		expect(proposals.pending()).toMatchObject([{ name: "Research", instructions: "Keep research notes." }]);
		expect(h.store.history(conversation.id).at(-1)?.parts).toEqual([
			{ type: "data-approval", data: { kind: "bot", id: proposals.pending()[0]!.id } },
		]);
		const invalid = await tool.execute({
			action: "propose",
			name: "Bad model",
			instructions: "No bot.",
			model: "ghost/nope",
		}, { toolCallId: "invalid" });
		expect(invalid).toHaveProperty("error");
		expect(proposals.pending()).toHaveLength(1);
	} finally {
		h.http.stop();
		await h.runtime.shutdown();
		h.store.close();
	}
});

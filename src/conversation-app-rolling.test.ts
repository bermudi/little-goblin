import { describe, expect, test } from "bun:test";
import type { Config } from "./config-schema.ts";
import { appAddress } from "./conversation-address.ts";
import { openStore, prepareAppSettingsForConfig } from "./conversation.ts";
import { paths } from "./home-layout.ts";
import { tmpDb } from "./testkit.ts";

const config = {
	model: "zai/m",
	thinking: "medium",
	providers: {
		zai: { kind: "openai-compatible", baseUrl: "https://example.com", auth: "zai" },
	},
} as unknown as Config;

function storeFixture() {
	return openStore(tmpDb("goblin-app-roll-store-"));
}

describe("app rolling store", () => {
	test("chain is newest-first and honours limit", () => {
		const store = storeFixture();
		const first = store.rollApp(config);
		const second = store.rollApp(config);
		const third = store.rollApp(config);
		expect(store.appRollChain(2).map((row) => row.id)).toEqual([third.id, second.id]);
		expect(store.appRollChain(50).map((row) => row.id)).toEqual([third.id, second.id, first.id]);
		store.close();
	});

	test("list excludes rolls and includes ordinary app conversations", () => {
		const store = storeFixture();
		const ordinary = store.resolve(appAddress("ordinary"), paths.workspace(), config);
		const rolling = store.rollApp(config);
		expect(store.listAppConversations().map((row) => row.id)).toContain(ordinary.id);
		expect(store.listAppConversations().map((row) => row.id)).not.toContain(rolling.id);
		store.close();
	});

	test("app conversation ids include ordinary chats and rolls", () => {
		const store = storeFixture();
		const ordinary = store.resolve(appAddress("ordinary-id"), paths.workspace(), config);
		const rolling = store.rollApp(config);
		expect(store.listAppConversationIds()).toEqual(
			expect.arrayContaining([ordinary.id, rolling.id]),
		);
		store.close();
	});

	test("provider removal refuses a rolling conversation's selected model", () => {
		const store = storeFixture();
		const rolling = store.rollApp(config);
		store.setMeta(rolling.id, { model: "zai/rolling", thinking: "medium" });
		const next = {
			...config,
			providers: {
				replacement: { kind: "openai-compatible", baseUrl: "https://example.com", auth: "new" },
			},
			model: "replacement/chat",
		} as unknown as Config;
		expect(() => prepareAppSettingsForConfig(store, config, next)).toThrow();
		store.close();
	});

	test("deleting current falls back; deleting all keeps the ordinal high-water", () => {
		const store = storeFixture();
		const first = store.rollApp(config);
		const second = store.rollApp(config);
		store.deleteConversation(second.id);
		expect(store.currentAppRoll()?.id).toBe(first.id);
		store.deleteConversation(first.id);
		expect(store.currentAppRoll()).toBeNull();
		const third = store.rollApp(config);
		expect(store.appRollChain(1)[0]?.id).toBe(third.id);
		expect(store.db.query<{ n: number }, []>("SELECT n FROM app_rolls").get()?.n).toBe(3);
		store.close();
	});

	test("chain skips a deleted middle roll", () => {
		const store = storeFixture();
		const first = store.rollApp(config);
		const middle = store.rollApp(config);
		const last = store.rollApp(config);
		store.deleteConversation(middle.id);
		expect(store.appRollChain(50).map((row) => row.id)).toEqual([last.id, first.id]);
		store.close();
	});

	test("list stays identical to a fresh connection across every mutation kind", () => {
		const dbPath = tmpDb("goblin-app-list-memo-");
		const store = openStore(dbPath);
		const freshList = () => {
			const fresh = openStore(dbPath);
			const out = fresh.listAppConversations();
			fresh.close();
			return out;
		};
		const same = () => expect(store.listAppConversations()).toEqual(freshList());
		try {
			const conv = store.resolve(appAddress("memo-1"), paths.workspace(), config);
			same();
			store.append(conv.id, [{ id: "u1", role: "user", parts: [{ type: "text", text: "one" }] }]);
			same();
			store.append(conv.id, [
				{ id: "a1", role: "assistant", parts: [{ type: "text", text: "reply" }] },
			]);
			same();
			store.listAppConversations();
			same();
			store.editUserMessage(conv.id, "u1", {
				id: "u1",
				role: "user",
				parts: [{ type: "text", text: "edited" }],
			});
			same();
			const branch = store.forkToApp(conv.id, "memo-branch", paths.workspace(), "branch title");
			same();
			const second = store.resolve(appAddress("memo-2"), paths.workspace(), config);
			store.append(second.id, [
				{ id: "u2", role: "user", parts: [{ type: "text", text: "two" }] },
			]);
			store.db.run("UPDATE events SET data = 'not json' WHERE conversation_id = ?", [second.id]);
			same();
			same();
			store.deleteConversation(branch.id);
			same();
			store.deleteConversation(second.id);
			store.deleteConversation(conv.id);
			same();
		} finally {
			store.close();
		}
	});
});

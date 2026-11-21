import { describe, expect, test } from "bun:test";
import type { Config } from "./config-schema.ts";
import { openStore } from "./conversation.ts";
import type { Message } from "./message.ts";
import { routeLaneMessage, type RollDeps, type RollLane } from "./rolling.ts";
import { System1Client, System1Error } from "./system1.ts";
import { tmpDb } from "./testkit.ts";

const config = {
	model: "zai/m",
	thinking: "medium",
	providers: {
		zai: { kind: "openai-compatible", baseUrl: "https://example.com", auth: "zai" },
	},
} as unknown as Config;
const message = (role: "user" | "assistant", text: string): Message => ({
	id: `${role}-${text}`,
	role,
	parts: [{ type: "text", text }],
});

function setup(opts: {
	now?: () => Date;
	gate?: Pick<System1Client, "decide">;
	fail?: boolean;
	busy?: boolean;
}) {
	const store = openStore(tmpDb("goblin-app-roll-test-"));
	const lane: RollLane = {
		current: () => store.currentAppRoll(),
		mint: () => store.rollApp(config),
		logs: {
			rolled: "app lane rolled",
			continued: "app lane continued past gap",
			fields: {},
			rolledFields: {},
		},
	};
	const deps: RollDeps = {
		store,
		runtime: { busy: () => opts.busy ?? false },
		gapMinutes: () => 45,
		...(opts.now ? { now: opts.now } : {}),
		...(opts.gate ? { gate: () => opts.gate } : {}),
	};
	return { store, lane, deps };
}

describe("routeLaneMessage app lane", () => {
	test("first message mints a roll", async () => {
		const { store, lane, deps } = setup({});
		const result = await routeLaneMessage(deps, lane, "hello");
		expect(result.decidedBy).toBe("first");
		expect(result.rolled).toBe(true);
		expect(store.currentAppRoll()?.id).toBe(result.conv.id);
		store.close();
	});

	test("inside the gap joins current", async () => {
		const { store, lane, deps } = setup({});
		const first = store.rollApp(config);
		const result = await routeLaneMessage(deps, lane, "hello");
		expect(result.conv.id).toBe(first.id);
		expect(result.rolled).toBe(false);
		store.close();
	});

	test("new subject past the gap rolls", async () => {
		const { store, lane, deps } = setup({
			now: () => new Date(Date.now() + 3_600_000),
			gate: { decide: async () => ({ answers: { follow_up: 0.1 }, inputTokens: 1, cost: 0 }) },
		});
		const first = store.rollApp(config);
		store.append(first.id, [message("user", "old"), message("assistant", "answer")]);
		const result = await routeLaneMessage(deps, lane, "new");
		expect(result.rolled).toBe(true);
		expect(result.conv.id).not.toBe(first.id);
		store.close();
	});

	test("follow-up past the gap joins", async () => {
		const { store, lane, deps } = setup({
			now: () => new Date(Date.now() + 3_600_000),
			gate: { decide: async () => ({ answers: { follow_up: 0.8 }, inputTokens: 1, cost: 0 }) },
		});
		const first = store.rollApp(config);
		store.append(first.id, [message("user", "old"), message("assistant", "answer")]);
		const result = await routeLaneMessage(deps, lane, "and then?");
		expect(result.rolled).toBe(false);
		expect(result.conv.id).toBe(first.id);
		store.close();
	});

	test("absent and failing gate fall back to current", async () => {
		for (const opts of [
			{},
			{
				gate: {
					decide: async () => {
						throw new System1Error("timeout");
					},
				},
			},
		]) {
			const { store, lane, deps } = setup({
				now: () => new Date(Date.now() + 3_600_000),
				...opts,
			});
			const first = store.rollApp(config);
			store.append(first.id, [message("user", "old"), message("assistant", "answer")]);
			const result = await routeLaneMessage(deps, lane, "next");
			expect(result.decidedBy).toBe("fallback");
			expect(result.conv.id).toBe(first.id);
			store.close();
		}
	});

	test("busy and unanswered current conversations join", async () => {
		const busy = setup({ now: () => new Date(Date.now() + 3_600_000), busy: true });
		const busyConv = busy.store.rollApp(config);
		const busyResult = await routeLaneMessage(busy.deps, busy.lane, "next");
		expect(busyResult.decidedBy).toBe("busy");
		expect(busyResult.conv.id).toBe(busyConv.id);
		busy.store.close();

		const unanswered = setup({ now: () => new Date(Date.now() + 3_600_000) });
		const unansweredConv = unanswered.store.rollApp(config);
		const result = await routeLaneMessage(unanswered.deps, unanswered.lane, "next");
		expect(result.decidedBy).toBe("unanswered");
		expect(result.conv.id).toBe(unansweredConv.id);
		unanswered.store.close();
	});
});

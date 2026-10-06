import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeliveryApi } from "./tg/delivery.ts";
import { openStore, type Conversation } from "./conversation.ts";
import type { Config } from "./config.ts";
import { Runtime, type TurnSink } from "./runtime.ts";
import type { RollDeps } from "./rolling.ts";
import { wake, wakeApp, type WakeDeps } from "./wake.ts";

const nullSink: TurnSink = {
	onTextDelta: () => {},
	onReasoningDelta: () => {},
	onToolCall: () => {},
	onDone: () => {},
};

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs.length = 0;
});

const config: Config = {
	providers: {}, model: "unused/m", tts: false, favorites: [],
	thinking: "medium", allowedUsers: [1], telegram: { dmGapMinutes: 45 },
	http: { port: 8787 }, logLevel: "info",
};

// A wake harness over a fake runtime: submit records its conversation,
// the api records its sends. roll wires the same fakes so a private-chat
// fire routes exactly like intake would.
function harness(gapMinutes: number) {
	const dir = mkdtempSync(join(tmpdir(), "goblin-wake-"));
	dirs.push(dir);
	const store = openStore(join(dir, "goblin.sqlite"));
	const submitted: string[] = [];
	const sends: string[] = [];
	const api = {
		sendMessage: (_chat: number, text: string) => {
			sends.push(text);
			return Promise.resolve({ message_id: 1 });
		},
		sendChatAction: () => Promise.resolve(true),
	} as unknown as DeliveryApi;
	const runtime = {
		busy: () => false,
		submit: (conv: Conversation) => {
			submitted.push(conv.id);
			return true;
		},
	} as unknown as Runtime;
	const roll: RollDeps = { store, runtime, gapMinutes: () => gapMinutes };
	const sinks: TurnSink[] = [];
	const deps: WakeDeps = {
		store, runtime, api,
		configRef: { current: config, ttsDown: false },
		synthesize: async () => [],
		roll,
		bell: () => {
			sinks.push(nullSink);
			return nullSink;
		},
	};
	return { deps, store, submitted, sends, sinks };
}

test("wake after runtime close records history but does not report delivery", async () => {
	const dir = mkdtempSync(join(tmpdir(), "goblin-wake-"));
	dirs.push(dir);
	const store = openStore(join(dir, "goblin.sqlite"));
	const runtime = new Runtime({
		store,
		buildStep: () => { throw new Error("closed runtime must not run a turn"); },
		makeTools: () => ({}),
	});
	await runtime.shutdown();
	const api = {
		sendMessage: () => { throw new Error("history-only notice must not reach Telegram"); },
		sendChatAction: () => Promise.resolve(true), // sink sends an initial typing ping on construction
	} as unknown as DeliveryApi;
	const landed = wake({
		store, runtime, api, configRef: { current: config, ttsDown: false },
		synthesize: async () => [],
		// A topic address never consults the roller — wired because the
		// type requires it.
		roll: { store, runtime, gapMinutes: () => 45 },
		bell: () => nullSink,
	}, { chatId: 1, threadId: 42 }, "delegation notice");
	await Promise.resolve(); // closed runtime fences the sink asynchronously
	expect(landed).toBe(false);
	expect(store.history("topic:1:42").map((message) => message.parts)).toEqual([
		[{ type: "text", text: "delegation notice" }],
	]);
	store.close();
});

test("a DM fire past the gap rolls a new conversation and marks it", () => {
	const { deps, store, submitted, sends } = harness(0); // gap 0 → always past
	store.rollDm(7, "/w"); // dm:7:1 — current when the fire arrives
	const landed = wake(deps, { chatId: 7, threadId: null }, "scheduled job ran");
	expect(landed).toBe(true);
	expect(submitted).toEqual(["dm:7:2"]);
	expect(store.currentDm(7)?.id).toBe("dm:7:2");
	expect(sends).toEqual(["— new conversation —"]);
	store.close();
});

test("a delegation notice past the gap joins — dmTrigger current never rolls", () => {
	const { deps, store, submitted, sends } = harness(0); // gap 0 → always past
	store.rollDm(7, "/w"); // dm:7:1 — current when the notice arrives
	const landed = wake(deps, { chatId: 7, threadId: null }, "delegation finished", {
		dmTrigger: "current",
	});
	expect(landed).toBe(true);
	expect(submitted).toEqual(["dm:7:1"]);
	expect(sends).toEqual([]); // no roll, no marker
	store.close();
});

test("a DM fire within the gap joins the current conversation", () => {
	const { deps, store, submitted, sends } = harness(45);
	store.rollDm(7, "/w"); // dm:7:1 — just created, inside the gap
	const landed = wake(deps, { chatId: 7, threadId: null }, "scheduled job ran");
	expect(landed).toBe(true);
	expect(submitted).toEqual(["dm:7:1"]);
	expect(sends).toEqual([]); // no roll, no marker
	store.close();
});

// ---------- wakeApp (Spin-off → Background turns) ----------

test("wakeApp submits into the app conversation with the bell sink", () => {
	const { deps, store, submitted, sinks } = harness(45);
	const app = store.forkToApp(store.resolve({ kind: "dm", chatId: 1 }, "/w").id, "x1", "/w", "job");
	const landed = wakeApp(deps, app.id, "delegation finished");
	expect(landed).toBe(true);
	expect(submitted).toEqual([app.id]);
	expect(sinks).toHaveLength(1); // the bell, not a delivery sink
	store.close();
});

test("wakeApp on a deleted app conversation drops landed — no submit, no retry loop", () => {
	const { deps, store, submitted, sinks } = harness(45);
	const landed = wakeApp(deps, "app/deleted-conv", "delegation finished");
	expect(landed).toBe(true);
	expect(submitted).toEqual([]);
	expect(sinks).toEqual([]);
	store.close();
});

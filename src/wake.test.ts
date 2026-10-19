import { makeWakeDelivery } from "./tg/wake.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeliveryApi } from "./tg/delivery.ts";
import { appAddress, openStore, type Conversation } from "./conversation.ts";
import type { Config } from "./config.ts";
import { Runtime, type TurnSink } from "./runtime.ts";
import type { RollDeps } from "./rolling.ts";
import { delegationWake } from "./delegation-lifecycle.ts";
import { wake, wakeApp, wakeConversation, type WakeDeps } from "./wake.ts";

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
	providers: {},
	model: "unused/m",
	tts: false,
	favorites: [],
	thinking: "medium",
	operators: [1],
	allowedUsers: [1],
	telegram: { dmGapMinutes: 45, richReplies: true, showReasoning: false },
	http: { port: 8787 },
	logLevel: "info",
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
		accepting: () => true,
		busy: () => false,
		submit: (conv: Conversation) => {
			submitted.push(conv.id);
			return true;
		},
	} as unknown as Runtime;
	const roll: RollDeps = { store, runtime, gapMinutes: () => gapMinutes };
	const sinks: TurnSink[] = [];
	const deps: WakeDeps = {
		store,
		runtime,
		...makeWakeDelivery({
			api,
			store,
			configRef: { current: config, ttsDown: false },
			synthesize: async () => [],
		}),
		roll,
		bell: () => {
			sinks.push(nullSink);
			return nullSink;
		},
	};
	return { deps, store, submitted, sends, sinks };
}

test("wake after runtime close neither records history nor reports delivery", async () => {
	const dir = mkdtempSync(join(tmpdir(), "goblin-wake-"));
	dirs.push(dir);
	const store = openStore(join(dir, "goblin.sqlite"));
	const runtime = new Runtime({
		store,
		buildStep: () => {
			throw new Error("closed runtime must not run a turn");
		},
		makeTools: () => ({}),
	});
	await runtime.shutdown();
	const api = {
		sendMessage: () => {
			throw new Error("history-only notice must not reach Telegram");
		},
		sendChatAction: () => Promise.resolve(true), // sink sends an initial typing ping on construction
	} as unknown as DeliveryApi;
	const landed = wake(
		{
			store,
			runtime,
			...makeWakeDelivery({
				api,
				store,
				configRef: { current: config, ttsDown: false },
				synthesize: async () => [],
			}),
			// A topic address never consults the roller — wired because the
			// type requires it.
			roll: { store, runtime, gapMinutes: () => 45 },
			bell: () => nullSink,
		},
		{ chatId: 1, threadId: 42 },
		"delegation notice",
	);
	await Promise.resolve(); // closed runtime fences the sink asynchronously
	expect(landed).toBe(false);
	expect(store.history("topic:1:42")).toEqual([]);
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

test("a delegation result never rolls the DM — delegationWake pins the join", () => {
	const { deps, store, submitted, sends } = harness(0); // gap 0 → always past
	store.rollDm(7, "/w"); // dm:7:1 — current when the notice arrives
	const landed = delegationWake(deps).wake({ chatId: 7, threadId: null }, "delegation finished");
	expect(landed).toBe(true);
	// Past the gap an ordinary fire rolls (dm:7:2, marker sent); the
	// lifecycle's notice joins dm:7:1 instead.
	expect(submitted).toEqual(["dm:7:1"]);
	expect(sends).toEqual([]);
	store.close();
});

// ---------- wakeApp ----------

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

// ---------- wakeConversation ----------

test("wakeConversation hits the exact stored DM row — never rolls, never creates", () => {
	const { deps, store, submitted, sends } = harness(0); // gap 0 — a rolling path would roll
	store.rollDm(7, "/w"); // dm:7:1 is current
	const landed = wakeConversation(deps, "dm:7:1", "subagent notice");
	expect(landed).toBe(true);
	expect(submitted).toEqual(["dm:7:1"]);
	expect(store.currentDm(7)?.id).toBe("dm:7:1"); // no dm:7:2 was rolled
	expect(sends).toEqual([]); // no roll marker
	store.close();
});

test("wakeConversation to an app origin uses the bell sink", () => {
	const { deps, store, submitted, sinks } = harness(45);
	const app = store.forkToApp(store.resolve({ kind: "dm", chatId: 1 }, "/w").id, "x1", "/w", "job");
	const landed = wakeConversation(deps, app.id, "subagent notice");
	expect(landed).toBe(true);
	expect(submitted).toEqual([app.id]);
	expect(sinks).toHaveLength(1); // bell, not delivery
	store.close();
});

test("wakeConversation to a guest origin delivers on the stored row", () => {
	const { deps, store, submitted, sinks } = harness(45);
	const conv = store.resolve({ kind: "guest", chatId: 5, userId: 9 }, "/w");
	const landed = wakeConversation(deps, conv.id, "subagent notice");
	expect(landed).toBe(true);
	expect(submitted).toEqual([conv.id]);
	expect(sinks).toEqual([]); // delivery sink, not the app bell
	store.close();
});

test("a deleted origin is the intentional drop — true, no submit, no rolling DM", () => {
	const { deps, store, submitted } = harness(0);
	store.rollDm(7, "/w");
	const landed = wakeConversation(deps, "dm:7:99", "subagent notice");
	expect(landed).toBe(true);
	expect(submitted).toEqual([]);
	expect(store.currentDm(7)?.id).toBe("dm:7:1"); // untouched
	store.close();
});

test("a refused submit returns false so the owner retries on scan", () => {
	const { deps, store } = harness(45);
	const conv = store.resolve({ kind: "dm", chatId: 3 }, "/w");
	(deps.runtime as { submit: unknown }).submit = () => false;
	expect(wakeConversation(deps, conv.id, "subagent notice")).toBe(false);
	store.close();
});

test.each(["app", "dm"] as const)(
	"a shutdown %s origin keeps the notice retryable without persisting it",
	async (channel) => {
		const { deps, store, submitted, sinks } = harness(45);
		const conv =
			channel === "app"
				? store.resolve(appAddress("closed"), "/w")
				: store.resolve({ kind: "dm", chatId: 3 }, "/w");
		const runtime = new Runtime({
			store,
			buildStep: () => {
				throw new Error("closed runtime ran a turn");
			},
			makeTools: () => ({}),
		});
		await runtime.shutdown();
		deps.runtime = runtime;
		expect(wakeConversation(deps, conv.id, "retry after restart")).toBe(false);
		if (channel === "app") expect(wakeApp(deps, conv.id, "retry after restart")).toBe(false);
		expect(store.history(conv.id)).toEqual([]);
		expect(submitted).toEqual([]);
		expect(sinks).toEqual([]);
		store.close();
	},
);

test("a throwing submit is released and returns false", () => {
	const { deps, store } = harness(45);
	const conv = store.resolve({ kind: "dm", chatId: 4 }, "/w");
	(deps.runtime as { submit: unknown }).submit = () => {
		throw new Error("runtime gone");
	};
	expect(wakeConversation(deps, conv.id, "subagent notice")).toBe(false);
	store.close();
});

import { makeWakeDelivery, makeWakeDeps } from "./tg/wake.ts";
import { startAgentChildren } from "./agent-children.ts";
import { GENERAL_AGENT_TYPE } from "./agent-types.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api } from "grammy";
import type { DeliveryApi } from "./tg/delivery.ts";
import { sendFileTool } from "./agent/tools/send.ts";
import type { Conversation } from "./conversation-read.ts";
import { openStore } from "./conversation.ts";
import { appAddress } from "./conversation-address.ts";
import type { Config } from "./config-schema.ts";
import { Runtime } from "./runtime.ts";
import type { TurnDone, TurnSink } from "./turn/sink.ts";
import { aiSdkEngine } from "./turn/ai-sdk-engine.ts";
import type { RollDeps } from "./rolling.ts";
import { delegationWake } from "./delegation-lifecycle.ts";
import { sdkScript } from "./testkit/turn-script-sdk.ts";
import { claudeScript } from "./testkit/turn-script-claude.ts";
import { useHome, waitUntil } from "./testkit.ts";
import { sinkFor, wake, wakeApp, wakeTarget, type WakeDeps } from "./wake.ts";

const nullSink: TurnSink = {
	delivery: "headless",
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
	modelFallbacks: [],
	thinking: "medium",
	operators: [1],
	allowedUsers: [1],
	telegram: { enabled: true, dmGapMinutes: 45, richReplies: true, showReasoning: false },
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
	const bellConversations: string[] = [];
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
		bell: (conv) => {
			bellConversations.push(conv.id);
			sinks.push(nullSink);
			return nullSink;
		},
	};
	return { deps, store, submitted, sends, sinks, bellConversations };
}

test("wake after runtime close neither records history nor reports delivery", async () => {
	const dir = mkdtempSync(join(tmpdir(), "goblin-wake-"));
	dirs.push(dir);
	const store = openStore(join(dir, "goblin.sqlite"));
	const runtime = new Runtime({
		engines: [aiSdkEngine],
		store,
		buildStep: () => {
			throw new Error("closed runtime must not run a turn");
		},
	});
	runtime.mount({ makeTools: () => ({}) });
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

test("app wakes retarget rolls to the newest roll but leave ordinary chats alone", () => {
	const { deps, store, submitted, sinks, bellConversations } = harness(45);
	const first = store.rollApp(config);
	const newest = store.rollApp(config);
	expect(wakeTarget(deps, first.id, "old roll target")).toBe(true);
	expect(wakeApp(deps, newest.id, "newest roll target")).toBe(true);
	const ordinary = store.resolve(appAddress("ordinary-with-rolls"), "/w", config);
	expect(wakeApp(deps, ordinary.id, "ordinary chat")).toBe(true);
	expect(submitted).toEqual([newest.id, newest.id, ordinary.id]);
	expect(sinks).toHaveLength(3);
	expect(bellConversations).toEqual([newest.id, newest.id, ordinary.id]);
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

test("wakeTarget routes an app target to its exact conversation", () => {
	const { deps, store, submitted, sinks } = harness(45);
	store.resolve(appAddress("chat-01"), "/w");
	const landed = wakeTarget(deps, "app/chat-01", "scheduled job ran");
	expect(landed).toBe(true);
	expect(submitted).toEqual(["app/chat-01"]);
	expect(sinks).toHaveLength(1);
	store.close();
});

test("wakeTarget keeps Telegram targets on the ordinary wake path", () => {
	const { deps, store, submitted, sends } = harness(0);
	store.rollDm(7, "/w");
	const landed = wakeTarget(deps, "dm:7", "scheduled job ran");
	expect(landed).toBe(true);
	expect(submitted).toEqual(["dm:7:2"]);
	expect(sends).toEqual(["— new conversation —"]);
	store.close();
});

test("no Telegram delivery refuses Telegram targets while app targets keep the bell", () => {
	const { deps, store, submitted, sinks } = harness(45);
	delete deps.delivery;
	delete deps.markRoll;
	expect(wakeTarget(deps, "dm:7", "scheduled job ran")).toBe(false);
	const app = store.resolve(appAddress("chat-01"), "/w");
	expect(wakeTarget(deps, app.id, "scheduled job ran")).toBe(true);
	expect(submitted).toEqual([app.id]);
	expect(sinks).toHaveLength(1);
	store.close();
});

const scriptAdapters = [sdkScript, claudeScript] as const;
for (const make of scriptAdapters) {
test(`${make === sdkScript ? "ai-sdk" : "claude-code"}: background app turn persists generated media without an SSE stream`, async () => {
	const home = useHome("goblin-wake-media-");
	const work = join(home, "work");
	mkdirSync(work, { recursive: true });
	writeFileSync(join(work, "report.txt"), "report-bytes");
	const store = openStore(join(home, "goblin.sqlite"));
	const conv = store.resolve(appAddress("background"), join(home, "workspace"));
	const model = make();
	model.script(
		{ kind: "reply", parts: [{ type: "tool-call", toolName: "send_file", input: { path: "report.txt" }, toolCallId: "file-1" }] },
		{ kind: "reply", parts: [{ type: "text", text: "report sent" }] },
	);
	const runtime = new Runtime({
		engines: model.engines,
		store,
		buildStep: () => model.step(),
	});
	runtime.mount({ makeTools: (_conv, _deliverVoice, _recording, deliverFile) => ({
			send_file: sendFileTool(work, deliverFile!),
		}) });
	const sends: string[] = [];
	const pushed: { conversation: string; done: TurnDone }[] = [];
	const api = {
		sendMessage: (_chat: number, text: string) => {
			sends.push(text);
			return Promise.resolve({ message_id: sends.length });
		},
		sendChatAction: () => Promise.resolve(true),
	} as unknown as Api;
	const deps = makeWakeDeps({
		store,
		runtime,
		api,
		configRef: { current: config, ttsDown: false },
		synthesize: async () => [],
		followUpGate: () => undefined,
		pings: { record: () => {}, lookup: () => null },
		push: {
			notifyDone: (notifyConv, done) => {
				pushed.push({ conversation: notifyConv.id, done });
				return Promise.resolve();
			},
		},
	});

	expect(wakeTarget(deps, "app/background", "run the report")).toBe(true);
	await waitUntil(
		() => store.history(conv.id).filter((m) => m.role === "assistant").length === 2,
		"background media turn lands",
	);
	const media = store
		.history(conv.id)
		.flatMap((m) => m.parts)
		.find((p) => p.type === "data-attachment") as
		| { data: { path: string; filename: string } }
		| undefined;
	expect(media?.data.filename).toBe("report.txt");
	expect(readFileSync(media!.data.path, "utf8")).toBe("report-bytes");
	await waitUntil(() => sends.length === 1, "background ping lands");
	await waitUntil(() => pushed.length === 1, "background push lands");
	expect(pushed[0]).toMatchObject({
		conversation: "app/background",
		done: { kind: "completed" },
	});
	await runtime.shutdown();
	store.close();
});

test(`${make === sdkScript ? "ai-sdk" : "claude-code"}: agent child completion wakes its parent without Telegram or app push`, async () => {
	const home = useHome("goblin-wake-agent-child-");
	const store = openStore(join(home, "goblin.sqlite"));
	const parent = store.resolve(appAddress("parent"), join(home, "workspace"), {
		model: "fake/parent",
		thinking: "low",
	});
	const model = make();
	model.script({ kind: "reply", parts: [{ type: "text", text: "CHILD RESULT" }] });
	const runtime = new Runtime({
		engines: model.engines,
		store,
		buildStep: () => model.step(),
	});
	runtime.mount({ makeTools: () => ({}) });
	const sends: string[] = [];
	const pushed: { conversation: string; done: TurnDone }[] = [];
	const api = {
		sendMessage: (_chat: number, text: string) => {
			sends.push(text);
			return Promise.resolve({ message_id: sends.length });
		},
		sendChatAction: () => Promise.resolve(true),
	} as unknown as Api;
	const wakeDeps = makeWakeDeps({
		store,
		runtime,
		api,
		configRef: { current: config, ttsDown: false },
		synthesize: async () => [],
		followUpGate: () => undefined,
		pings: { record: () => {}, lookup: () => null },
		push: {
			notifyDone: (notifyConv, done) => {
				pushed.push({ conversation: notifyConv.id, done });
				return Promise.resolve();
			},
		},
	});
	let parentWakes = 0;
	const engine = startAgentChildren({
		store,
		runtime,
		record: () => {
			parentWakes++;
			return null;
		},
		bell: (conv) => wakeDeps.bell(conv),
		maxRunning: () => 3,
		now: () => new Date("2026-11-24T00:00:00.000Z"),
	});

	const { child } = await engine.spawn({
		parent,
		type: GENERAL_AGENT_TYPE,
		task: "do the child work",
		tools: [],
	});
	const settlement = await engine.awaitSettlement(child.conversationId);
	expect(settlement.child.status).toBe("done");
	expect(settlement.result).toBe("CHILD RESULT");
	expect(parentWakes).toBe(1);
	expect(sends).toEqual([]);
	expect(pushed).toEqual([]);
	await runtime.shutdown();
	store.close();
});
}

// ---------- sinkFor ----------

function sinkStub(withDelivery: boolean): {
	deps: Pick<WakeDeps, "bell" | "delivery">;
	bellSink: TurnSink;
	deliverySink: TurnSink;
} {
	const bellSink: TurnSink = {
		delivery: "headless",
		onTextDelta: () => {},
		onReasoningDelta: () => {},
		onToolCall: () => {},
		onDone: () => {},
	};
	const deliverySink: TurnSink = {
		delivery: "headless",
		onTextDelta: () => {},
		onReasoningDelta: () => {},
		onToolCall: () => {},
		onDone: () => {},
	};
	const deps: Pick<WakeDeps, "bell" | "delivery"> = {
		bell: () => bellSink,
		...(withDelivery ? { delivery: () => deliverySink } : {}),
	};
	return { deps, bellSink, deliverySink };
}

test("sinkFor routes app conversations to the bell", () => {
	const app = { id: "app/chat-01" } as unknown as Conversation;
	const withDelivery = sinkStub(true);
	expect(sinkFor(withDelivery.deps, app)).toBe(withDelivery.bellSink);
	const withoutDelivery = sinkStub(false);
	expect(sinkFor(withoutDelivery.deps, app)).toBe(withoutDelivery.bellSink);
});

test("sinkFor routes telegram and guest to delivery when attached", () => {
	const { deps, deliverySink } = sinkStub(true);
	const telegram = { id: "dm:7" } as unknown as Conversation;
	const guest = { id: "guest:5:9" } as unknown as Conversation;
	expect(sinkFor(deps, telegram)).toBe(deliverySink);
	expect(sinkFor(deps, guest)).toBe(deliverySink);
});

test("sinkFor falls back to the bell for detached telegram/guest", () => {
	const { deps, bellSink } = sinkStub(false);
	const telegram = { id: "dm:7" } as unknown as Conversation;
	const guest = { id: "guest:5:9" } as unknown as Conversation;
	expect(sinkFor(deps, telegram)).toBe(bellSink);
	expect(sinkFor(deps, guest)).toBe(bellSink);
});

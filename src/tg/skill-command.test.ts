import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UIMessage } from "ai";
import { SKILL_PART } from "../skill-part.ts";
import { fakeApi, type FakeApi } from "../testkit/fake-api.ts";
import { deferred, openTestStore, useHome } from "../testkit.ts";
import type { Config } from "../config.ts";
import type { TurnSink } from "../runtime.ts";
import { SHARED_CHAT_NOTE, makeConversationDeliverySink } from "./turn-input.ts";
import {
	handleSkillCommand,
	handleTempSkillCallback,
	parseTempSkillCallback,
	type SkillCommandDeps,
	type TempSkillQuery,
} from "./skill-command.ts";
import type { Conversation } from "../conversation.ts";

let homes: string[] = [];
afterEach(() => {
	for (const h of homes) rmSync(h, { recursive: true, force: true });
	homes = [];
});

const newHome = (): string => {
	const h = useHome("goblin-skillcmd-");
	homes.push(h);
	return h;
};

const conv = (id = "tg:1:2", chatId = 1, epoch = 0): Conversation =>
	({
		id,
		chatId,
		threadId: 2,
		title: null,
		titleImplicit: false,
		model: null,
		thinking: null,
		voice: false,
		memoryExcluded: false,
		persona: "personal",
		archivedAt: null,
		epoch,
	}) as unknown as Conversation;

const baseConfig = (tts: Config["tts"] = false): Config =>
	({
		providers: { zai: { kind: "openai-compatible", baseUrl: "https://x", auth: "z" } },
		model: "zai/m",
		tts,
		favorites: [],
		thinking: "medium",
		operators: [1],
		allowedUsers: [],
		telegram: { dmGapMinutes: 45, richReplies: false, showReasoning: false },
		http: { port: 0 },
		logLevel: "info",
	}) as Config;

interface Harness {
	api: FakeApi;
	appended: UIMessage[];
	submitted: UIMessage[];
	sinks: TurnSink[];
	gateDecisions: Array<Record<string, number>>;
	synthesized: string[];
	home: string;
	gateWired: boolean;
	cfg: Config;
	now: Date;
	conv: Conversation;
}

function baseDeps(h: Harness, gate: boolean): SkillCommandDeps {
	const fake = fakeApi({});
	h.api = fake;
	const d: SkillCommandDeps = {
		api: fake.api as unknown as SkillCommandDeps["api"],
		store: {
			append: (_id: string, messages: UIMessage[]) => void h.appended.push(...messages),
			get: () => h.conv,
		} as never,
		runtime: {
			submitPersisted: (_conv: unknown, message: UIMessage, sink: TurnSink) => {
				h.submitted.push(message);
				h.sinks.push(sink);
			},
		} as never,
		// The real conversation-configured sink — the same construction
		// intake uses. Config seams live on h.cfg.
		delivery: (target) =>
			makeConversationDeliverySink(fake.api, target, {
				configRef: { current: h.cfg, ttsDown: false },
				store: { lastReplyAnchor: () => null },
				synthesize: (text) => {
					h.synthesized.push(text);
					return Promise.resolve([new Uint8Array([1, 2, 3])]);
				},
			}),
		now: () => h.now,
	};
	if (gate) {
		d.gate = {
			decide: (async () => {
				h.gateDecisions.push({ injection: 0.1, severity: 0.1 });
				return {
					answers: { injection: 0.1, severity: 0.1 },
					tokens: { input: 1, output: 1 },
					latencyMs: 5,
					model: "gate",
				};
			}) as never,
		};
	}
	return d;
}

function harness(opts?: { gate?: boolean; cfg?: Config }): Harness {
	const home = newHome();
	mkdirSync(join(home, "workspace", "skills", "herdr"), { recursive: true });
	writeFileSync(
		join(home, "workspace", "skills", "herdr", "SKILL.md"),
		"---\nname: herdr\ndescription: drive herdr panes\n---\npane body",
	);
	const h: Harness = {
		api: null as never,
		appended: [],
		submitted: [],
		sinks: [],
		gateDecisions: [],
		synthesized: [],
		home,
		gateWired: opts?.gate !== false,
		cfg: opts?.cfg ?? baseConfig(),
		now: new Date("2026-10-22T12:00:00Z"),
		conv: conv(),
	};
	baseDeps(h, h.gateWired);
	return h;
}

const sent = (h: Harness) =>
	h.api.calls
		.filter((c) => c.method === "sendMessage")
		.map((c) => c.args[1] as string)
		.join("\n");

const sends = (h: Harness) =>
	h.api.calls.filter((c) => c.method === "sendMessage").map((c) => c.args[1] as string);

const lastMarkup = (h: Harness): unknown[] => {
	const last = h.api.calls.filter((c) => c.method === "sendMessage").at(-1)!;
	return (last.args[2] as { reply_markup?: { inline_keyboard?: unknown[][] } }).reply_markup!
		.inline_keyboard![0]!;
};

describe("/skill", () => {
	test("bare lists the catalog, manual-only marked", async () => {
		const h = harness();
		mkdirSync(join(h.home, "workspace", "skills", "secret"), { recursive: true });
		writeFileSync(
			join(h.home, "workspace", "skills", "secret", "SKILL.md"),
			"---\nname: secret\ndescription: shh\ndisable-model-invocation: true\n---\nx",
		);
		await handleSkillCommand(harnessDeps(h), conv(), "/skill");
		const text = sent(h);
		expect(text).toContain("herdr — drive herdr panes");
		expect(text).toContain("secret (manual-only)");
	});

	test("name submits the turn with a data-skill part plus held text", async () => {
		const h = harness();
		await handleSkillCommand(harnessDeps(h), conv(), "/skill herdr check the panes");
		const parts = h.submitted[0]!.parts as Array<{ type: string; data?: unknown; text?: string }>;
		expect(parts[0]!.type).toBe(SKILL_PART);
		expect(parts[0]!.data).toEqual({ name: "herdr" });
		expect(parts[1]!.text).toBe("check the panes");
	});

	test("unknown name answers with the catalog, submits nothing", async () => {
		const h = harness();
		await handleSkillCommand(harnessDeps(h), conv(), "/skill nope");
		expect(h.submitted).toHaveLength(0);
		expect(sent(h)).toContain("no skill named");
	});

	test("a group-target invocation prepends the shared-chat note; a DM does not", async () => {
		const h = harness();
		const topic = conv("tg:-100:7", -100);
		await handleSkillCommand(harnessDeps(h), topic, "/skill herdr");
		const groupParts = h.appended[0]!.parts as Array<{ type: string; text?: string }>;
		expect(groupParts[0]!.type).toBe("text");
		expect(groupParts[0]!.text).toBe(SHARED_CHAT_NOTE);
		expect(groupParts[1]!.type).toBe(SKILL_PART);
		await handleSkillCommand(harnessDeps(h), conv(), "/skill herdr");
		const dmParts = h.appended[1]!.parts as Array<{ type: string; text?: string }>;
		expect(dmParts[0]!.type).toBe(SKILL_PART);
	});

	test("a catalog of fat descriptions chunks under 4000 chars with nothing truncated", async () => {
		const h = harness();
		for (let i = 0; i < 6; i++) {
			const name = `fat-${i}`;
			mkdirSync(join(h.home, "workspace", "skills", name), { recursive: true });
			writeFileSync(
				join(h.home, "workspace", "skills", name, "SKILL.md"),
				`---\nname: ${name}\ndescription: d${i}-${"x".repeat(900)}\n---\nx`,
			);
		}
		await handleSkillCommand(harnessDeps(h), conv(), "/skill");
		const texts = sends(h);
		expect(texts.length).toBeGreaterThan(1);
		for (const t of texts) expect(t.length).toBeLessThanOrEqual(4000);
		const all = texts.join("\n");
		for (let i = 0; i < 6; i++) {
			expect(all).toContain(`fat-${i}`);
			expect(all).toContain(`d${i}-`);
		}
		expect(all).toContain("invoke with /skill");
	});

	test("an unbounded unknown name is bounded in the reply, catalog still chunked", async () => {
		const h = harness();
		await handleSkillCommand(harnessDeps(h), conv(), `/skill ${"z".repeat(5000)}`);
		const texts = sends(h);
		expect(texts.length).toBeGreaterThanOrEqual(1);
		for (const t of texts) expect(t.length).toBeLessThanOrEqual(4000);
		expect(sent(h)).toContain("no skill named");
		expect(sent(h)).not.toContain("z".repeat(5000));
	});

	test("a failing send rejects the command", async () => {
		const h = harness();
		const d = baseDeps(h, true);
		const fake = fakeApi({ failOn: (m) => m === "sendMessage" });
		d.api = fake.api as unknown as SkillCommandDeps["api"];
		await expect(handleSkillCommand(d, conv(), "/skill")).rejects.toThrow();
	});

	function harnessDeps(h: Harness): SkillCommandDeps {
		return baseDeps(h, true);
	}
});

describe("/skill delivery sink", () => {
	test("a voice-mode conversation synthesizes and sends Telegram voice", async () => {
		const h = harness({ cfg: baseConfig({ kind: "edge", voice: "en-US-Ava" }) });
		const talking = conv("dm:1", 1);
		talking.voice = true;
		await handleSkillCommand(harnessDeps(h), talking, "/skill herdr");
		expect(h.sinks).toHaveLength(1);
		h.sinks[0]!.onTextDelta("speaking to you");
		await h.sinks[0]!.onDone({ kind: "completed" });
		expect(h.synthesized).toEqual(["speaking to you"]);
		expect(h.api.calls.some((c) => c.method === "sendVoice")).toBe(true);
	});

	test("rich drafts ride the config seam — reasoning reaches the wire", async () => {
		const h = harness({
			cfg: baseConfig(),
		});
		h.cfg = { ...h.cfg, telegram: { ...h.cfg.telegram, richReplies: true, showReasoning: true } };
		await handleSkillCommand(harnessDeps(h), conv("dm:1", 1), "/skill herdr");
		h.sinks[0]!.onReasoningDelta("thinking it through");
		h.sinks[0]!.onTextDelta("a rich answer");
		await h.sinks[0]!.onDone({ kind: "completed" });
		const methods = h.api.calls.map((c) => c.method);
		expect(methods.some((m) => m === "sendRichMessage" || m === "sendRichMessageDraft")).toBe(
			true,
		);
	});

	test("a plain conversation answers by text, never voice", async () => {
		const h = harness();
		await handleSkillCommand(harnessDeps(h), conv("dm:1", 1), "/skill herdr");
		h.sinks[0]!.onTextDelta("a plain answer");
		await h.sinks[0]!.onDone({ kind: "completed" });
		expect(h.synthesized).toHaveLength(0);
		expect(h.api.calls.some((c) => c.method === "sendVoice")).toBe(false);
		expect(h.api.calls.some((c) => c.method === "sendMessage")).toBe(true);
	});

	function harnessDeps(h: Harness): SkillCommandDeps {
		return baseDeps(h, true);
	}
});

describe("/skill <url> (temp)", () => {
	test("fetches, scores, previews with a confirm row", async () => {
		const h = harness();
		const fetchImpl = (async () =>
			new Response((await fixtureTarball()) as never)) as unknown as typeof fetch;
		await handleSkillCommand(depsWithFetch(h, fetchImpl), conv(), "/skill https://github.com/o/r/tree/main/demo do things");
		const text = sent(h);
		expect(text).toContain("temp skill: demo");
		expect(text).toContain("injection check: clean");
		expect(text).toContain("held text: do things");
		expect(lastMarkup(h)).toHaveLength(2);
		expect(h.gateDecisions).toHaveLength(1);
	});

	test("yes submits the held turn with the temp part", async () => {
		const h = harness();
		const fetchImpl = (async () =>
			new Response((await fixtureTarball()) as never)) as unknown as typeof fetch;
		await handleSkillCommand(depsWithFetch(h, fetchImpl), conv(), "/skill https://github.com/o/r/tree/main/demo check things");
		const invokeData = (lastMarkup(h)[0] as { callback_data: string }).callback_data;
		const parsed = parseTempSkillCallback(invokeData);
		expect(parsed?.op).toBe("invoke");
		await handleTempSkillCallback(depsWithFetch(h, fetchImpl), {
			id: "q1",
			data: invokeData,
			message: { message_id: 42, chat: { id: 1 } },
		});
		const parts = h.submitted[0]!.parts as Array<{ type: string; data?: unknown }>;
		expect(parts[0]!.type).toBe(SKILL_PART);
		const data = parts[0]!.data as { url: string; path: string };
		expect(data.url).toContain("github.com/o/r/tree/main/demo");
		expect(data.path).toContain(join(h.home, "state", "skillcache"));
		const edits = h.api.calls.filter((c) => c.method === "editMessageText");
		expect(edits.at(-1)!.args[2] as string).toContain("invoked into the conversation");
	});

	test("drop submits nothing and stamps the preview", async () => {
		const h = harness();
		const fetchImpl = (async () =>
			new Response((await fixtureTarball()) as never)) as unknown as typeof fetch;
		await handleSkillCommand(depsWithFetch(h, fetchImpl), conv(), "/skill https://github.com/o/r/tree/main/demo");
		const dropData = (lastMarkup(h)[1] as { callback_data: string }).callback_data;
		await handleTempSkillCallback(depsWithFetch(h, fetchImpl), {
			id: "q2",
			data: dropData,
			message: { message_id: 42, chat: { id: 1 } },
		});
		expect(h.submitted).toHaveLength(0);
		const edits = h.api.calls.filter((c) => c.method === "editMessageText");
		expect(edits.at(-1)!.args[2] as string).toContain("dropped");
	});

	test("an expired token answers gone and submits nothing", async () => {
		const h = harness();
		await handleTempSkillCallback(harnessDeps(h), {
			id: "q3",
			data: "skilltmp:y:deadbeef",
			message: { message_id: 42, chat: { id: 1 } },
		});
		expect(h.submitted).toHaveLength(0);
		const edits = h.api.calls.filter((c) => c.method === "editMessageText");
		expect(edits.at(-1)!.args[2] as string).toContain("gone");
	});

	test("a pending past its TTL is expired, not invocable", async () => {
		const h = harness();
		const fetchImpl = (async () =>
			new Response((await fixtureTarball()) as never)) as unknown as typeof fetch;
		const deps = depsWithFetch(h, fetchImpl);
		await handleSkillCommand(deps, conv(), "/skill https://github.com/o/r/tree/main/demo");
		const invokeData = (lastMarkup(h)[0] as { callback_data: string }).callback_data;
		h.now = new Date(h.now.getTime() + 20 * 60 * 1000);
		await handleTempSkillCallback(deps, {
			id: "q4",
			data: invokeData,
			message: { message_id: 42, chat: { id: 1 } },
		});
		expect(h.submitted).toHaveLength(0);
		const edits = h.api.calls.filter((c) => c.method === "editMessageText");
		expect(edits.at(-1)!.args[2] as string).toContain("expired");
		const answers = h.api.calls.filter((c) => c.method === "answerCallbackQuery");
		expect((answers.at(-1)!.args[1] as { text: string }).text).toBe("expired");
	});

	test("an epoch bump between preview and tap fences the invoke — real store", async () => {
		const home = newHome();
		mkdirSync(join(home, "workspace", "skills"), { recursive: true });
		const { store } = openTestStore("goblin-skillcmd-real-");
		try {
			const real = store.resolve({ kind: "topic", chatId: -50, threadId: 7 }, "/w");
			const h = harness();
			const fetchImpl = (async () =>
				new Response((await fixtureTarball()) as never)) as unknown as typeof fetch;
			const deps = depsWithFetch(h, fetchImpl);
			deps.store = store;
			await handleSkillCommand(deps, real, "/skill https://github.com/o/r/tree/main/demo");
			const invokeData = (lastMarkup(h)[0] as { callback_data: string }).callback_data;
			// The fence /stop and /new both ride: the conversation epoch moves.
			store.bumpEpoch(real.id);
			await handleTempSkillCallback(deps, {
				id: "q5",
				data: invokeData,
				message: { message_id: 42, chat: { id: -50 } },
			});
			expect(h.submitted).toHaveLength(0);
			expect(store.history(real.id)).toHaveLength(0);
			const edits = h.api.calls.filter((c) => c.method === "editMessageText");
			expect(edits.at(-1)!.args[2] as string).toContain("moved on");
			const answers = h.api.calls.filter((c) => c.method === "answerCallbackQuery");
			expect((answers.at(-1)!.args[1] as { text: string }).text).toBe("stale");
			// Single-use still holds: a second tap is the unknown-token path.
			await handleTempSkillCallback(deps, {
				id: "q6",
				data: invokeData,
				message: { message_id: 42, chat: { id: -50 } },
			});
			const edits2 = h.api.calls.filter((c) => c.method === "editMessageText");
			expect(edits2.at(-1)!.args[2] as string).toContain("gone");
		} finally {
			store.close();
		}
	});

	test("a fence mid-fetch publishes no actionable preview", async () => {
		const h = harness();
		const ball = await fixtureTarball();
		const gate2 = deferred<void>();
		const fetchImpl = (async () => {
			await gate2.promise;
			return new Response(ball as never);
		}) as unknown as typeof fetch;
		const deps = depsWithFetch(h, fetchImpl);
		const running = handleSkillCommand(
			deps,
			conv(),
			"/skill https://github.com/o/r/tree/main/demo",
		);
		h.conv = { ...h.conv, epoch: h.conv.epoch + 1 };
		gate2.resolve();
		await running;
		const text = sent(h);
		expect(text).toContain("cancelled");
		expect(text).not.toContain("Invoke");
		const markups = h.api.calls.filter(
			(c) =>
				c.method === "sendMessage" &&
				(c.args[2] as { reply_markup?: unknown })?.reply_markup !== undefined,
		);
		expect(markups).toHaveLength(0);
		expect(h.gateDecisions).toHaveLength(0);
	});

	test("a fence mid-score publishes no pending confirm", async () => {
		const h = harness();
		const fetchImpl = (async () =>
			new Response((await fixtureTarball()) as never)) as unknown as typeof fetch;
		const deps = depsWithFetch(h, fetchImpl);
		const held = deferred<never>();
		deps.gate = {
			decide: (() => {
				h.conv = { ...h.conv, epoch: h.conv.epoch + 1 };
				return held.promise;
			}) as never,
		};
		const running = handleSkillCommand(
			deps,
			conv(),
			"/skill https://github.com/o/r/tree/main/demo",
		);
		await Bun.sleep(0);
		held.resolve({
			answers: { injection: 0.1, severity: 0.1 },
			tokens: { input: 1, output: 1 },
			latencyMs: 5,
			model: "gate",
		} as never);
		await running;
		const text = sent(h);
		expect(text).toContain("cancelled");
		expect(text).not.toContain("Invoke");
		const markups = h.api.calls.filter(
			(c) =>
				c.method === "sendMessage" &&
				(c.args[2] as { reply_markup?: unknown })?.reply_markup !== undefined,
		);
		expect(markups).toHaveLength(0);
	});

	test("a fence queued inside the score call itself is caught by the probe — no publish", async () => {
		// Regression for the synchronous probe: decide resolves and
		// queues an epoch bump for the very next microtask; the probe
		// must read the bumped epoch, not the pre-fetch capture. With an
		// await between probe and publish this race would be invisible.
		const h = harness();
		const fetchImpl = (async () =>
			new Response((await fixtureTarball()) as never)) as unknown as typeof fetch;
		const deps = depsWithFetch(h, fetchImpl);
		deps.gate = {
			decide: (async () => {
				queueMicrotask(() => {
					h.conv = { ...h.conv, epoch: h.conv.epoch + 1 };
				});
				return {
					answers: { injection: 0.1, severity: 0.1 },
					tokens: { input: 1, output: 1 },
					latencyMs: 5,
					model: "gate",
				};
			}) as never,
		};
		await handleSkillCommand(deps, conv(), "/skill https://github.com/o/r/tree/main/demo");
		expect(sent(h)).toContain("cancelled");
		expect(sent(h)).not.toContain("Invoke");
		const markups = h.api.calls.filter(
			(c) =>
				c.method === "sendMessage" &&
				(c.args[2] as { reply_markup?: unknown })?.reply_markup !== undefined,
		);
		expect(markups).toHaveLength(0);
	});

	test("a confirmed temp in a shared topic: durable note first, voice sink delivers", async () => {
		const h = harness({ cfg: baseConfig({ kind: "edge", voice: "en-US-Ava" }) });
		h.conv = { ...conv("tg:-100:7", -100, 0), voice: true };
		const fetchImpl = (async () =>
			new Response((await fixtureTarball()) as never)) as unknown as typeof fetch;
		const deps = depsWithFetch(h, fetchImpl);
		await handleSkillCommand(deps, h.conv, "/skill https://github.com/o/r/tree/main/demo");
		const invokeData = (lastMarkup(h)[0] as { callback_data: string }).callback_data;
		await handleTempSkillCallback(deps, {
			id: "q8",
			data: invokeData,
			message: { message_id: 42, chat: { id: -100 } },
		});
		expect(h.submitted).toHaveLength(1);
		const durable = h.appended[0]!.parts as Array<{ type: string; text?: string }>;
		expect(durable[0]!.type).toBe("text");
		expect(durable[0]!.text).toBe(SHARED_CHAT_NOTE);
		expect(durable[1]!.type).toBe(SKILL_PART);
		// The callback built the real configured sink — voice mode
		// synthesizes and sends audio, not text.
		h.sinks[0]!.onTextDelta("spoken answer");
		await h.sinks[0]!.onDone({ kind: "completed" });
		expect(h.synthesized).toEqual(["spoken answer"]);
		expect(h.api.calls.some((c) => c.method === "sendVoice")).toBe(true);
	});

	test("no gate wired: temp answers unavailable, nothing submitted", async () => {
		const h = harness({ gate: false });
		await handleSkillCommand(harnessDeps(h), conv(), "/skill https://github.com/o/r/tree/main/demo");
		expect(h.submitted).toHaveLength(0);
		expect(sent(h)).toContain("temp skills are unavailable");
	});

	function depsWithFetch(h: Harness, fetchImpl: typeof fetch): SkillCommandDeps {
		const deps = baseDeps(h, true);
		deps.fetchImpl = fetchImpl;
		return deps;
	}

	function harnessDeps(h: Harness): SkillCommandDeps {
		return baseDeps(h, h.gateWired);
	}
});

// A canonical codeload-style tarball: r-main/demo/SKILL.md plus a
// script dir, so whole-dir staging is observable.
async function fixtureTarball(): Promise<Uint8Array> {
	const src = mkdtempSync(join(tmpdir(), "goblin-skillfixture-"));
	homes.push(src);
	mkdirSync(join(src, "r-main", "demo", "scripts"), { recursive: true });
	writeFileSync(
		join(src, "r-main", "demo", "SKILL.md"),
		"---\nname: demo\ndescription: the demo skill\n---\nrun scripts/run.sh",
	);
	writeFileSync(join(src, "r-main", "demo", "scripts", "run.sh"), "echo hi\n");
	const outDir = mkdtempSync(join(tmpdir(), "goblin-skillfixout-"));
	homes.push(outDir);
	const ball = join(outDir, "b.tgz");
	const proc = Bun.spawn(["tar", "-czf", ball, "r-main"], { cwd: src });
	if ((await proc.exited) !== 0) throw new Error("fixture tar failed");
	return await Bun.file(ball).bytes();
}

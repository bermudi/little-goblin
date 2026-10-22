import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UIMessage } from "ai";
import { SKILL_PART } from "../skill-part.ts";
import { fakeApi, type FakeApi } from "../testkit/fake-api.ts";
import { useHome } from "../testkit.ts";
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

const conv = (id = "tg:1:2"): Conversation =>
	({
		id,
		chatId: 1,
		threadId: 2,
		title: null,
		titleImplicit: false,
		model: null,
		thinking: null,
		voice: false,
		memoryExcluded: false,
		persona: "personal",
		archivedAt: null,
	}) as unknown as Conversation;

interface Harness {
	api: FakeApi;
	submitted: UIMessage[];
	gateDecisions: Array<Record<string, number>>;
	home: string;
	gateWired: boolean;
}

function baseDeps(h: Harness, gate: boolean): SkillCommandDeps {
	const fake = fakeApi({});
	h.api = fake;
	const d: SkillCommandDeps = {
		api: fake.api as unknown as SkillCommandDeps["api"],
		store: {
			append: (_id: string, messages: UIMessage[]) => void h.submitted.push(...messages),
			get: () => conv(),
		} as never,
		runtime: {
			submitPersisted: (_conv: unknown, message: UIMessage) => {
				h.submitted.push(message);
			},
		} as never,
	};
	if (gate) {
		(d as { gate?: unknown }).gate = {
			decide: async () => {
				h.gateDecisions.push({ injection: 0.1, severity: 0.1 });
				return {
					answers: { injection: 0.1, severity: 0.1 },
					tokens: { input: 1, output: 1 },
					latencyMs: 5,
					model: "gate",
				};
			},
		};
	}
	return d;
}

function harness(opts?: { gate?: boolean }): Harness {
	const home = newHome();
	mkdirSync(join(home, "workspace", "skills", "herdr"), { recursive: true });
	writeFileSync(
		join(home, "workspace", "skills", "herdr", "SKILL.md"),
		"---\nname: herdr\ndescription: drive herdr panes\n---\npane body",
	);
	const h: Harness = {
		api: null as never,
		submitted: [],
		gateDecisions: [],
		home,
		gateWired: opts?.gate !== false,
	};
	baseDeps(h, h.gateWired);
	return h;
}

const sent = (h: Harness) =>
	h.api.calls
		.filter((c) => c.method === "sendMessage")
		.map((c) => c.args[1] as string)
		.join("\n");

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

	test("no gate wired: temp answers unavailable, nothing submitted", async () => {
		const h = harness({ gate: false });
		await handleSkillCommand(harnessDeps(h), conv(), "/skill https://github.com/o/r/tree/main/demo");
		expect(h.submitted).toHaveLength(0);
		expect(sent(h)).toContain("temp skills are unavailable");
	});

	function depsWithFetch(h: Harness, fetchImpl: typeof fetch): SkillCommandDeps {
		const deps = baseDeps(h, true);
		(deps as { fetchImpl?: typeof fetch }).fetchImpl = fetchImpl;
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

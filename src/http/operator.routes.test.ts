import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleOperatorRoute, type OperatorActor, type OperatorDeps } from "./operator.ts";
import { appendAuthRecord, loadAuthFile } from "../auth.ts";
import { loadConfig, parseConfig } from "../config.ts";
import { openStore } from "../conversation.ts";
import { HindsightClient, HindsightError, type MemoryDocSummary } from "../memory/hindsight.ts";
import type { MemoryContexts } from "../memory/mod.ts";
import type { MemoryQueue } from "../memory/queue.ts";
import { resolveSkillProposal, type SkillDecision } from "../skill-decisions.ts";
import { SkillSources } from "../skill-provenance.ts";
import type { UIMessage } from "ai";

const ACTOR: OperatorActor = { via: "app" };

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "operator-routes-"));
	process.env.GOBLIN_HOME = home;
});

afterEach(() => {
	delete process.env.GOBLIN_HOME;
	rmSync(home, { recursive: true, force: true });
});

function deps(): OperatorDeps {
	return {
		configRef: {
			current: parseConfig({
				providers: { test: { kind: "codex" } },
				model: "test/m",
				operators: [7],
				allowedUsers: [],
			}),
		},
		onConfigWritten: () => {},
	};
}

function get(tail: string): Promise<Response> {
	return handleOperatorRoute(
		deps(),
		ACTOR,
		new Request(`http://x/${tail}`),
		tail,
		new URL(`http://x/${tail}`),
	) as Promise<Response>;
}

function getWithQuery(tail: string, query: string): Promise<Response> {
	const url = `http://x/${tail}?${query}`;
	return handleOperatorRoute(
		deps(),
		ACTOR,
		new Request(url),
		tail,
		new URL(url),
	) as Promise<Response>;
}

describe("state viewer routes", () => {
	test("skills lists the fixture catalog", () => {
		mkdirSync(join(home, "workspace/skills/weather"), { recursive: true });
		writeFileSync(
			join(home, "workspace/skills/weather/SKILL.md"),
			"---\nname: weather\ndescription: forecast\n---\nsun",
		);
		mkdirSync(join(home, "workspace/skills-proposed"), { recursive: true });
		const res = get("skills");
		return res.then(async (r) => {
			expect(r.status).toBe(200);
			const body = (await r.json()) as {
				skills: unknown[];
				proposed: unknown[];
				catalog: Array<{ name: string; manualOnly: boolean; bodyBytes: number }>;
			};
			expect(body.skills.length).toBe(1);
			expect(body.proposed).toEqual([]);
			// The picker's catalog view rides the same response.
			expect(body.catalog).toHaveLength(1);
			expect(body.catalog[0]!.name).toBe("weather");
			expect(body.catalog[0]!.bodyBytes).toBeGreaterThan(0);
		});
	});
	test("skills/catalog includes manual-only entries", () => {
		mkdirSync(join(home, "workspace/skills/secret"), { recursive: true });
		writeFileSync(
			join(home, "workspace/skills/secret/SKILL.md"),
			"---\nname: secret\ndescription: shh\ndisable-model-invocation: true\n---\nx",
		);
		const res = get("skills");
		return res.then(async (r) => {
			const body = (await r.json()) as {
				catalog: Array<{ name: string; manualOnly: boolean }>;
			};
			expect(body.catalog.map((c) => c.name)).toEqual(["secret"]);
			expect(body.catalog[0]!.manualOnly).toBe(true);
		});
	});

	test("skills/preview fetches, scores, stamps, and answers the card", async () => {
		// Build a canonical tarball fixture — body past the shared
		// checker's default sampling cap, sentinel at the tail, so the
		// gate must see ALL the scored bytes.
		const src = mkdtempSync(join(tmpdir(), "preview-src-"));
		mkdirSync(join(src, "r-main/demo"), { recursive: true });
		const skillBody =
			"---\nname: demo\ndescription: the demo\n---\n" + "pad ".repeat(2500) + "TAIL_SENTINEL";
		writeFileSync(join(src, "r-main/demo/SKILL.md"), skillBody);
		const out = mkdtempSync(join(tmpdir(), "preview-ball-"));
		const proc = Bun.spawn(["tar", "-czf", join(out, "b.tgz"), "r-main"], { cwd: src });
		await proc.exited;
		const ball = await Bun.file(join(out, "b.tgz")).bytes();

		const scoredTexts: string[] = [];
		const d = deps();
		d.skillFetch = {
			gate: {
				decide: (async (text: string) => {
					scoredTexts.push(text);
					return {
						answers: { injection: 0.9, severity: 0.1 },
						tokens: { input: 1, output: 1 },
						latencyMs: 5,
						model: "gate",
					};
				}) as never,
			},
			fetchImpl: (async () => new Response(ball as never)) as unknown as typeof fetch,
		};
		const res = handleOperatorRoute(
			d,
			ACTOR,
			new Request("http://x/skills/preview", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ url: "https://github.com/o/r/tree/main/demo" }),
			}),
			"skills/preview",
			new URL("http://x/skills/preview"),
		) as Promise<Response>;
		const r = await res;
		expect(r.status).toBe(200);
		const body = (await r.json()) as {
			name: string;
			verdict: { status: string };
			path: string;
			digest: string;
			cached: boolean;
		};
		expect(body.name).toBe("demo");
		expect(body.verdict.status).toBe("malicious");
		expect(scoredTexts).toEqual([skillBody]);
		expect(body.cached).toBe(false);
		// The verdict was stamped into the cached descriptor.
		const { readFileSync: rf } = await import("node:fs");
		const descriptor = JSON.parse(
			rf(join(home, "state", "skillcache", body.digest, "skill.json"), "utf8"),
		) as { verdict: { status: string } };
		expect(descriptor.verdict.status).toBe("malicious");
		// A re-preview of the stamped cache reuses the first verdict —
		// the gate is not re-run and the card cannot drift from what
		// injection will inject.
		d.skillFetch!.gate = {
			decide: (async () => {
				scoredTexts.push("RE-SCORED");
				return {
					answers: { injection: 0.0, severity: 0.0 },
					tokens: { input: 1, output: 1 },
					latencyMs: 5,
					model: "gate",
				};
			}) as never,
		};
		const r2 = await (handleOperatorRoute(
			d,
			ACTOR,
			new Request("http://x/skills/preview", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ url: "https://github.com/o/r/tree/main/demo" }),
			}),
			"skills/preview",
			new URL("http://x/skills/preview"),
		) as Promise<Response>);
		expect(r2.status).toBe(200);
		const body2 = (await r2.json()) as { verdict: { status: string }; cached: boolean };
		expect(body2.verdict.status).toBe("malicious");
		expect(body2.cached).toBe(true);
		expect(scoredTexts).toEqual([skillBody]);
		rmSync(src, { recursive: true, force: true });
		rmSync(out, { recursive: true, force: true });
	});

	test("skills/preview without the gate is 503", async () => {
		const res = handleOperatorRoute(
			deps(),
			ACTOR,
			new Request("http://x/skills/preview", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ url: "https://github.com/o/r/tree/main/demo" }),
			}),
			"skills/preview",
			new URL("http://x/skills/preview"),
		) as Promise<Response>;
		expect((await res).status).toBe(503);
	});

	test("skills/file serves SKILL.md and rejects a bad name", async () => {
		mkdirSync(join(home, "workspace/skills/weather"), { recursive: true });
		writeFileSync(join(home, "workspace/skills/weather/SKILL.md"), "content");
		const ok = await getWithQuery("skills/file", "name=weather");
		expect(ok.status).toBe(200);
		expect(((await ok.json()) as { content: string }).content).toBe("content");
		const bad = await getWithQuery("skills/file", "name=../secret");
		expect(bad.status).toBe(400);
		const missing = await getWithQuery("skills/file", "name=nope");
		expect(missing.status).toBe(404);
	});

	test("skills/file serves dotfiles and __dunder__ names the listing exposes", async () => {
		mkdirSync(join(home, "workspace/skills/weather"), { recursive: true });
		writeFileSync(join(home, "workspace/skills/weather/.gitignore"), "node_modules");
		writeFileSync(join(home, "workspace/skills/weather/__init__.py"), "# pkg");
		for (const path of [".gitignore", "__init__.py"]) {
			const res = await getWithQuery("skills/file", `name=weather&path=${path}`);
			expect(res.status).toBe(200);
		}
	});

	test("skills/file still refuses traversal shaped like a dotfile", async () => {
		mkdirSync(join(home, "workspace/skills/weather"), { recursive: true });
		writeFileSync(join(home, "workspace/skills/weather/SKILL.md"), "content");
		for (const path of ["..hidden", ".dot/..", "a/../../x"]) {
			const res = await getWithQuery("skills/file", `name=weather&path=${path}`);
			expect([400, 404]).toContain(res.status);
		}
	});

	test("skills/file rejects a path that escapes", async () => {
		mkdirSync(join(home, "workspace/skills/weather"), { recursive: true });
		writeFileSync(join(home, "workspace/skills/weather/SKILL.md"), "content");
		const res = await getWithQuery("skills/file", "name=weather&path=../../../goblin.json5");
		expect([400, 404]).toContain(res.status);
	});

	test("skills/file round-trips ordinary spaced, dotted and Unicode names", async () => {
		const name = "my skill 日本語";
		const files: Record<string, string> = {
			"SKILL.md": "main",
			"reference guide.md": "spaced",
			"ref/(notes).md": "parens",
			"ref/guide-日本語.md": "unicode",
			".hidden.md": "dotfile",
			"file..name.md": "double-dot substring",
		};
		for (const origin of ["skills", "skills-proposed"]) {
			for (const p of Object.keys(files)) {
				mkdirSync(join(home, "workspace", origin, name, join(p, "..")), { recursive: true });
				writeFileSync(join(home, "workspace", origin, name, p), `${origin}:${p}`);
			}
		}
		const urlFor = (origin: string, path: string) =>
			`origin=${origin}&name=${encodeURIComponent(name)}&path=${encodeURIComponent(path)}`;
		for (const [p] of Object.entries(files)) {
			const installed = await getWithQuery("skills/file", urlFor("skills", p));
			expect(installed.status, `skills ${p}`).toBe(200);
			expect(((await installed.json()) as { content: string }).content).toBe(`skills:${p}`);
			const proposed = await getWithQuery("skills/file", urlFor("proposed", p));
			expect(proposed.status, `proposed ${p}`).toBe(200);
			expect(((await proposed.json()) as { content: string }).content).toBe(`skills-proposed:${p}`);
		}
	});

	test("skills/file still rejects traversal, absolute, backslash and NUL", async () => {
		mkdirSync(join(home, "workspace/skills/weather"), { recursive: true });
		writeFileSync(join(home, "workspace/skills/weather/SKILL.md"), "content");
		for (const query of [
			"name=weather&path=../secret",
			"name=weather&path=a/../../x",
			"name=weather&path=/etc/passwd",
			"name=weather&path=a%5C..%5Cx",
			"name=weather&path=a%00b",
			"name=weather&path=dir/../SKILL.md",
			"name=weather&path=dir//file.md",
			"name=weather&path=trailing/",
			"name=weather&path=.",
			"name=weather&path=..",
			"name=.&path=SKILL.md",
			"name=..&path=SKILL.md",
			"name=a/b&path=SKILL.md",
			"name=a%5Cb&path=SKILL.md",
			"name=a%00b&path=SKILL.md",
		]) {
			const res = await getWithQuery("skills/file", query);
			expect(res.status, query).toBe(400);
		}
	});

	test("identity serves null contents for missing files", async () => {
		mkdirSync(join(home, "workspace"), { recursive: true });
		writeFileSync(join(home, "workspace/SOUL.md"), "# soul");
		const res = await get("identity");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { files: Array<{ name: string; content: string | null }> };
		expect(body.files.find((f) => f.name === "SOUL.md")?.content).toBe("# soul");
		expect(body.files.find((f) => f.name === "USER.md")?.content).toBeNull();
	});

	test("log validates its params and tails the fixture log", async () => {
		mkdirSync(join(home, "state"), { recursive: true });
		writeFileSync(
			join(home, "state/goblin.log"),
			[
				JSON.stringify({ ts: "t1", level: "info", msg: "a" }),
				JSON.stringify({ ts: "t2", level: "error", msg: "b" }),
				"",
			].join("\n"),
		);
		const ok = await getWithQuery("log", "limit=1&level=error");
		expect(ok.status).toBe(200);
		const body = (await ok.json()) as { lines: Array<{ msg: string }>; truncated: boolean };
		expect(body.lines.map((l) => l.msg)).toEqual(["b"]);
		expect(body.truncated).toBe(false);
		const badLimit = await getWithQuery("log", "limit=0");
		expect(badLimit.status).toBe(400);
		const badLevel = await getWithQuery("log", "level=loud");
		expect(badLevel.status).toBe(400);
		const longQ = await getWithQuery("log", `q=${"a".repeat(301)}`);
		expect(longQ.status).toBe(400);
		const atCap = await getWithQuery("log", `q=${"a".repeat(300)}`);
		expect(atCap.status).toBe(200);
	});

	test("attachments serves bytes with a content type", async () => {
		mkdirSync(join(home, "workspace/attachments"), { recursive: true });
		writeFileSync(join(home, "workspace/attachments/pic.png"), "PNG");
		const list = await get("attachments");
		expect(list.status).toBe(200);
		const file = await getWithQuery("attachments/file", "name=pic.png");
		expect(file.status).toBe(200);
		expect(file.headers.get("content-type")).toBe("image/png");
		expect(await file.text()).toBe("PNG");
		const bad = await getWithQuery("attachments/file", "name=..%2Fpic.png");
		expect(bad.status).toBe(400);
	});

	test("attachments with ordinary special names serve with inert headers", async () => {
		mkdirSync(join(home, "workspace/attachments"), { recursive: true });
		for (const [name, bytes] of [
			["my report.zip", "ZIP"],
			["file..name.txt", "TXT"],
			["日本語.txt", "JP"],
		] as const) {
			writeFileSync(join(home, "workspace/attachments", name), bytes);
			const res = await getWithQuery("attachments/file", `name=${encodeURIComponent(name)}`);
			expect(res.status, name).toBe(200);
			expect(res.headers.get("content-disposition")).toBe("attachment");
			expect(res.headers.get("x-content-type-options")).toBe("nosniff");
			expect(res.headers.get("content-security-policy")).toBe("sandbox");
			expect(await res.text()).toBe(bytes);
		}
	});

	test("non-GET is refused on every state viewer route", async () => {
		for (const tail of ["skills", "attachments", "identity", "log"]) {
			const res = await handleOperatorRoute(
				deps(),
				ACTOR,
				new Request(`http://x/${tail}`, { method: "POST" }),
				tail,
				new URL(`http://x/${tail}`),
			);
			expect(res?.status).toBe(405);
		}
	});
});

describe("skills/decide route", () => {
	function postDecide(body: unknown, deps: OperatorDeps = decideDeps()): Promise<Response> {
		return handleOperatorRoute(
			deps,
			ACTOR,
			new Request("http://x/skills/decide", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: typeof body === "string" ? body : JSON.stringify(body),
			}),
			"skills/decide",
			new URL("http://x/skills/decide"),
		) as Promise<Response>;
	}

	function decideDeps(outcome?: SkillDecision): OperatorDeps {
		return {
			...deps(),
			skillDecisions: {
				decide: () => outcome ?? { action: "install", ok: true, replaced: false },
			},
		};
	}

	test("an install decision returns the applied outcome", async () => {
		const res = await postDecide({ name: "smoke-test", action: "install" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			ok: true,
			skill: "smoke-test",
			action: "install",
			replaced: false,
			state: "installed",
		});
	});

	test("a discard reports state gone; a replaced install says so", async () => {
		const gone = await postDecide(
			{ name: "smoke-test", action: "discard" },
			decideDeps({ action: "discard", ok: true }),
		);
		expect(((await gone.json()) as { state: string }).state).toBe("gone");
		const swapped = await postDecide(
			{ name: "smoke-test", action: "install" },
			decideDeps({ action: "install", ok: true, replaced: true }),
		);
		expect(((await swapped.json()) as { replaced: boolean }).replaced).toBe(true);
	});

	test("gone proposals 404; conflicts 409; the unwired seam 503s", async () => {
		const gone = await postDecide(
			{ name: "smoke-test", action: "install" },
			decideDeps({ action: "install", ok: false, reason: "gone" }),
		);
		expect(gone.status).toBe(404);
		const conflict = await postDecide(
			{ name: "smoke-test", action: "install" },
			decideDeps({ action: "install", ok: false, reason: "live skill is a symlink" }),
		);
		expect(conflict.status).toBe(409);
		const unwired = await postDecide({ name: "smoke-test", action: "install" }, deps());
		expect(unwired.status).toBe(503);
	});

	test("bad methods, bodies, names and actions get typed refusals", async () => {
		const get = await handleOperatorRoute(
			decideDeps(),
			ACTOR,
			new Request("http://x/skills/decide"),
			"skills/decide",
			new URL("http://x/skills/decide"),
		);
		expect(get?.status).toBe(405);
		expect((await postDecide("not json{")).status).toBe(400);
		expect((await postDecide({ name: "Bad_Name", action: "install" })).status).toBe(422);
		expect((await postDecide({ name: "fine-name", action: "maybe" })).status).toBe(422);
	});

	test("the seam composes the real disk move plus the history event", async () => {
		mkdirSync(join(home, "workspace/skills-proposed/smoke-test"), { recursive: true });
		writeFileSync(join(home, "workspace/skills-proposed/smoke-test/SKILL.md"), "# smoke");
		const appended: { conversation: string; text: string }[] = [];
		const d: OperatorDeps = {
			...deps(),
			skillDecisions: {
				decide: (skill, action) =>
					resolveSkillProposal(
						{
							workspaceDir: join(home, "workspace"),
							skillsDir: join(home, "workspace/skills"),
							proposedDir: join(home, "workspace/skills-proposed"),
							forSkill: (s) => [
								{
									skill: s,
									conversationId: "app/learned-here",
									kind: "reviewer",
									reviewId: null,
									firstAt: "2026-10-17T00:00:00Z",
									lastAt: "2026-10-17T00:00:00Z",
								},
							],
							store: {
								append: (id: string, messages: UIMessage[]) => {
									appended.push({
										conversation: id,
										text: (messages[0]!.parts[0] as { text: string }).text,
									});
								},
							},
						},
						skill,
						action,
					),
			},
		};
		const res = await postDecide({ name: "smoke-test", action: "install" }, d);
		expect(res.status).toBe(200);
		expect(existsSync(join(home, "workspace/skills/smoke-test/SKILL.md"))).toBe(true);
		expect(appended).toEqual([
			{
				conversation: "app/learned-here",
				text: "skill proposal resolved: smoke-test — installed",
			},
		]);
	});
});

describe("skills/forget-thread route", () => {
	function skillsDeps(): {
		d: OperatorDeps;
		sources: SkillSources;
		store: ReturnType<typeof openStore>;
	} {
		const store = openStore(join(home, "goblin.sqlite"));
		const sources = new SkillSources(store.db);
		const d: OperatorDeps = {
			...deps(),
			skillSources: {
				forgetConversation: (conversationId: string) =>
					sources.forgetConversation(conversationId),
				forConversation: (conversationId: string) => sources.forConversation(conversationId),
				skillsDir: join(home, "workspace/skills"),
				proposedDir: join(home, "workspace/skills-proposed"),
			},
		};
		return { d, sources, store };
	}

	function postSkillsForget(body: unknown, d: OperatorDeps): Promise<Response | null> {
		return handleOperatorRoute(
			d,
			ACTOR,
			new Request("http://x/skills/forget-thread", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: typeof body === "string" ? body : JSON.stringify(body),
			}),
			"skills/forget-thread",
			new URL("http://x/skills/forget-thread"),
		);
	}

	test("forgets only the named thread's provenance rows", async () => {
		const { d, sources, store } = skillsDeps();
		try {
			sources.record("app/1", "herdr", "reviewer");
			sources.record("app/1", "smoke-test", "turn");
			sources.record("dm:1", "herdr", "reviewer");
			const res = await postSkillsForget({ conversation: "app/1" }, d);
			expect(res?.status).toBe(200);
			expect(await res?.json()).toEqual({ ok: true, removed: 2 });
			expect(sources.forConversation("app/1")).toEqual([]);
			expect(sources.forConversation("dm:1")).toHaveLength(1);
		} finally {
			store.close();
		}
	});

	test("bad methods and bodies get typed refusals; the unwired seam 503s", async () => {
		const get = await handleOperatorRoute(
			deps(),
			ACTOR,
			new Request("http://x/skills/forget-thread"),
			"skills/forget-thread",
			new URL("http://x/skills/forget-thread"),
		);
		expect(get?.status).toBe(405);
		const { d, store } = skillsDeps();
		try {
			expect((await postSkillsForget("not json{", d))?.status).toBe(400);
			expect((await postSkillsForget({ conversation: "" }, d))?.status).toBe(422);
			expect((await postSkillsForget({ conversation: "a".repeat(257) }, d))?.status).toBe(422);
		} finally {
			store.close();
		}
		expect((await postSkillsForget({ conversation: "app/1" }, deps()))?.status).toBe(503);
	});
});

describe("secrets route", () => {
	function secretsDeps(): OperatorDeps {
		const file = join(home, "auth.jsonl");
		const store = loadAuthFile(file);
		return {
			...deps(),
			secrets: {
				has: (n) => store.has(n),
				isCommand: (n) => store.isCommand(n),
				store: (n, v) => {
					appendAuthRecord(file, n, v);
					store.put(n, v);
				},
			},
		};
	}

	function postSecret(body: unknown): Promise<Response | null> {
		return handleOperatorRoute(
			secretsDeps(),
			ACTOR,
			new Request("http://x/secrets", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
			"secrets",
			new URL("http://x/secrets"),
		);
	}

	test("a key stores as a literal record and resolves live", async () => {
		const res = await postSecret({ name: "groq", value: "gsk_test" });
		expect(res?.status).toBe(200);
		expect(await res?.json()).toEqual({ ok: true, name: "groq", replaced: false });
		const file = join(home, "auth.jsonl");
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(await loadAuthFile(file).resolve("groq")).toBe("gsk_test");
	});

	test("a !-led value is refused — command records stay hand-edited", async () => {
		const res = await postSecret({ name: "evil", value: "!cat /etc/passwd" });
		expect(res?.status).toBe(422);
		expect(existsSync(join(home, "auth.jsonl"))).toBe(false);
	});

	test("a command record's name is refused, a literal's rotates", async () => {
		writeFileSync(join(home, "auth.jsonl"), '{"name":"k","value":"!pass-keys get p k"}\n');
		chmodSync(join(home, "auth.jsonl"), 0o600);
		const refused = await postSecret({ name: "k", value: "x" });
		expect(refused?.status).toBe(409);
		const ok = await postSecret({ name: "lit", value: "v1" });
		expect(ok?.status).toBe(200);
		const rotated = await postSecret({ name: "lit", value: "v2" });
		expect(await rotated?.json()).toEqual({ ok: true, name: "lit", replaced: true });
		expect(await loadAuthFile(join(home, "auth.jsonl")).resolve("lit")).toBe("v2");
	});

	test("bad names and bodies get typed refusals; unwired seam 503s", async () => {
		expect((await postSecret({ name: "bad name!", value: "x" }))?.status).toBe(422);
		expect((await postSecret({ name: "k", value: "" }))?.status).toBe(422);
		expect((await postSecret({ name: "k" }))?.status).toBe(422);
		const noSeam = await handleOperatorRoute(
			deps(),
			ACTOR,
			new Request("http://x/secrets", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			}),
			"secrets",
			new URL("http://x/secrets"),
		);
		expect(noSeam?.status).toBe(503);
	});
});

describe("config save", () => {
	async function postConfig(d: OperatorDeps, body: unknown): Promise<Response | null> {
		const view = await handleOperatorRoute(
			d,
			ACTOR,
			new Request("http://x/config"),
			"config",
			new URL("http://x/config"),
		);
		const etag = view?.headers.get("etag") ?? "";
		return handleOperatorRoute(
			d,
			ACTOR,
			new Request("http://x/config", {
				method: "POST",
				headers: { "content-type": "application/json", "if-match": etag },
				body: JSON.stringify(body),
			}),
			"config",
			new URL("http://x/config"),
		);
	}

	test.each([
		["vision", { model: "new/m" }],
		["image", { model: "new/m" }],
		["transcription", { kind: "openai", auth: "speech" }],
	] as const)(
		"first-time %s enablement accepts and persists its supplied block",
		async (key, block) => {
			const d = deps();
			expect(d.configRef.current[key]).toBeUndefined();
			expect(d.configRef.current.parked?.[key]).toBeUndefined();
			// Models may name a provider added by the same save: validation
			// must see the resulting config, not just the incumbent.
			const res = await postConfig(d, {
				providers: {
					...d.configRef.current.providers,
					new: { kind: "openai-compatible", baseUrl: "https://example.com/v1", auth: "new" },
				},
				capabilities: { [key]: true },
				[key]: block,
			});
			expect(res?.status).toBe(200);
			expect(d.configRef.current[key]).toMatchObject(block);
			expect(loadConfig()?.[key]).toEqual(d.configRef.current[key]);
			expect(d.configRef.current.parked?.[key]).toBeUndefined();
		},
	);

	test.each([
		["vision", { model: "missing/m" }, "vision"],
		["image", { model: "test/m" }, "image"],
		["transcription", { kind: "not-an-engine" }, "transcription"],
	] as const)(
		"first-time %s enablement validates its supplied block before writing",
		async (key, block, error) => {
			const d = deps();
			const before = d.configRef.current;
			const res = await postConfig(d, { capabilities: { [key]: true }, [key]: block });
			expect(res?.status).toBe(422);
			const detail = (await res?.json()) as { error: string };
			expect(detail.error).toContain(error);
			expect(detail.error).not.toContain("pick an engine/model");
			expect(d.configRef.current).toBe(before);
			expect(loadConfig()).toBeNull();
		},
	);

	test.each(["vision", "image", "transcription"] as const)(
		"first-time %s enablement still requires a block",
		async (key) => {
			const d = deps();
			const res = await postConfig(d, { capabilities: { [key]: true } });
			expect(res?.status).toBe(422);
			expect((await res?.json()) as { error: string }).toHaveProperty(
				"error",
				expect.stringContaining("pick an engine/model"),
			);
			expect(d.configRef.current[key]).toBeUndefined();
			expect(loadConfig()).toBeNull();
		},
	);

	test("the write persists the rung the model's ladder can express", async () => {
		const d = deps();
		const res = await postConfig(d, { model: "test/glm-5.3", thinking: "xhigh" });
		expect(res?.status).toBe(200);
		// glm-5.3's ladder is low|high|max — xhigh lands where the wire
		// clamp would send it, and the pinned telegram pair (its own
		// model, where medium is real) is untouched.
		expect(d.configRef.current.model).toBe("test/glm-5.3");
		expect(d.configRef.current.thinking).toBe("max");
		expect(d.configRef.current.telegram).toMatchObject({
			model: "test/m",
			thinking: "medium",
		});
		// "off" on a forced-thinking model lands on its floor.
		expect((await postConfig(d, { thinking: "off" }))?.status).toBe(200);
		expect(d.configRef.current.thinking).toBe("low");
		// The telegram pin clamps against its own model's ladder too.
		expect(
			(await postConfig(d, { telegram: { model: "test/glm-5.3", thinking: "xhigh" } }))?.status,
		).toBe(200);
		expect(d.configRef.current.telegram).toMatchObject({
			model: "test/glm-5.3",
			thinking: "max",
		});
	});

	test("provider removal under a disabled telegram keeps its pin; re-enable needs it back", async () => {
		const gone = {
			kind: "openai-compatible" as const,
			baseUrl: "https://api.example.org",
			auth: "ref",
		};
		const d: OperatorDeps = {
			configRef: {
				current: parseConfig({
					providers: { test: { kind: "codex" }, gone },
					model: "test/m",
					operators: [],
					allowedUsers: [],
					telegram: { enabled: false, model: "gone/glm-5.3", thinking: "xhigh" },
				}),
			},
			onConfigWritten: () => {},
		};
		// Removing the dormant pin's provider is fine while the channel is
		// off — and the dormant model/thinking ride through unclamped even
		// though glm-5.3's ladder can't express xhigh.
		expect(
			(
				await postConfig(d, {
					providers: { test: { kind: "codex" }, gone },
					model: "test/glm-5.3",
				})
			)?.status,
		).toBe(200);
		expect((await postConfig(d, { providers: { test: { kind: "codex" } } }))?.status).toBe(200);
		expect(d.configRef.current.telegram).toMatchObject({
			enabled: false,
			model: "gone/glm-5.3",
			thinking: "xhigh",
		});
		// Re-enabling without the provider is a 422 until it is restored.
		expect(
			(
				await postConfig(d, {
					telegram: { enabled: true },
					operators: [7],
				})
			)?.status,
		).toBe(422);
		expect(
			(
				await postConfig(d, {
					providers: { test: { kind: "codex" }, gone },
					telegram: { enabled: true },
					operators: [7],
				})
			)?.status,
		).toBe(200);
		expect(d.configRef.current.telegram).toMatchObject({
			enabled: true,
			model: "gone/glm-5.3",
		});
	});
});

describe("memory/blocked route", () => {
	function postBlocked(body: unknown, d: OperatorDeps): Promise<Response | null> {
		return handleOperatorRoute(
			d,
			ACTOR,
			new Request("http://x/memory/blocked", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
			"memory/blocked",
			new URL("http://x/memory/blocked"),
		);
	}

	function memoryDeps(): { d: OperatorDeps; store: ReturnType<typeof openStore>; target: string } {
		const store = openStore(join(home, "goblin.sqlite"));
		const client = new HindsightClient({ baseUrl: "http://127.0.0.1:1", bankId: "g" });
		const d = deps();
		d.configRef.current = parseConfig({
			providers: { test: { kind: "codex" } },
			model: "test/m",
			operators: [7],
			allowedUsers: [],
			memory: { baseUrl: "http://127.0.0.1:1", bankId: "g" },
		});
		d.memory = {
			target: { baseUrl: "http://127.0.0.1:1", bankId: "g" },
			client,
			queue: store.memoryQueue,
			counts: () => store.memoryQueue.counts(client.target),
			deletingAll: () => store.memoryQueue.deletingCount(),
			blockedDetail: () => store.memoryQueue.blockedDetail(client.target),
			lastRecallOk: () => null,
			lastRecallAt: () => null,
		};
		return { d, store, target: client.target };
	}

	test("retry and dismiss act on the durable blocked rows", async () => {
		const { d, store, target } = memoryDeps();
		try {
			const enqueueBlocked = (id: string) => {
				const op = store.memoryQueue.enqueue(target, {
					id,
					content: "Operator: hi\nGoblin: hello",
					timestamp: new Date().toISOString(),
					conversationId: "app/chat-01",
					sourceIds: ["u1", "a1"],
				});
				const item = store.memoryQueue.get(op);
				if (item === null) throw new Error("expected queued memory");
				store.memoryQueue.update(item, "blocked", 0, "Hindsight http failure (HTTP 429)");
			};
			enqueueBlocked("exchange/app/chat-01/1/a");

			const retried = await postBlocked({ action: "retry" }, d);
			expect(retried?.status).toBe(200);
			expect(await retried?.json()).toEqual({ ok: true, action: "retry", affected: 1 });
			expect(store.memoryQueue.counts(target).blocked).toBe(0);
			expect(store.memoryQueue.counts(target).pending).toBe(1);

			enqueueBlocked("exchange/app/chat-01/2/a");
			const dismissed = await postBlocked({ action: "dismiss" }, d);
			expect(dismissed?.status).toBe(200);
			expect(await dismissed?.json()).toEqual({ ok: true, action: "dismiss", affected: 1 });
			expect(store.memoryQueue.counts(target).blocked).toBe(0);
			expect(store.memoryQueue.counts(target).dismissed).toBe(1);
		} finally {
			store.close();
		}
	});

	test("bad actions and unwired memory get typed refusals", async () => {
		const { d, store } = memoryDeps();
		try {
			expect((await postBlocked({ action: "maybe" }, d))?.status).toBe(422);
		} finally {
			store.close();
		}
		expect((await postBlocked({ action: "retry" }, deps()))?.status).toBe(503);
	});
});

describe("memory/forget-thread route", () => {
	const summary = (id: string): MemoryDocSummary => ({
		id,
		created_at: "2026-10-01T00:00:00Z",
		updated_at: null,
		text_length: 10,
		memory_unit_count: 1,
	});

	function forgetThreadDeps(
		items: MemoryDocSummary[],
		failDelete?: (id: string) => boolean,
	): { d: OperatorDeps; store: ReturnType<typeof openStore>; deleted: string[] } {
		const store = openStore(join(home, "goblin.sqlite"));
		const deleted: string[] = [];
		const client = {
			listDocuments: (o: { limit: number; offset: number }) =>
				Promise.resolve({
					items: items.slice(o.offset, o.offset + o.limit),
					total: items.length,
					limit: o.limit,
					offset: o.offset,
				}),
			deleteDocument: (id: string) => {
				if (failDelete?.(id)) return Promise.reject(new HindsightError("http", 500));
				deleted.push(id);
				return Promise.resolve();
			},
		} as unknown as HindsightClient;
		const contexts = {
			suppress: () => {},
			deleteByDocument: () => 1,
		} as unknown as MemoryContexts;
		const queue = {
			documentDestinations: () => [],
			markDocumentDeleting: () => 0,
			confirmDeleted: () => 1,
		} as unknown as MemoryQueue;
		const d = deps();
		d.configRef.current = parseConfig({
			providers: { test: { kind: "codex" } },
			model: "test/m",
			operators: [7],
			allowedUsers: [],
			memory: { baseUrl: "http://127.0.0.1:1", bankId: "g" },
		});
		d.memory = {
			client,
			contexts,
			queue,
			withWorkerPaused: async <T>(fn: () => Promise<T>) => fn(),
			counts: () => ({
				pending: 0,
				submitted: 0,
				completed: 0,
				blocked: 0,
				dismissed: 0,
				deleting: 0,
			}),
			deletingAll: () => 0,
			blockedDetail: () => [],
			lastRecallOk: () => null,
			lastRecallAt: () => null,
		};
		return { d, store, deleted };
	}

	function postForgetThread(body: unknown, d: OperatorDeps): Promise<Response | null> {
		return handleOperatorRoute(
			d,
			ACTOR,
			new Request("http://x/memory/forget-thread", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: typeof body === "string" ? body : JSON.stringify(body),
			}),
			"memory/forget-thread",
			new URL("http://x/memory/forget-thread"),
		);
	}

	test("forgets every retained exchange of the thread, paging past foreign ids", async () => {
		// 150 upstream docs force the limit-100 scan to page; the two
		// matching ids sit on both pages and the collision ids never
		// match (app/12 is a different thread, app/1/child adds a
		// segment).
		const wanted = [summary("exchange/app/1/1/a"), summary("exchange/app/1/2/b")];
		const items: MemoryDocSummary[] = [wanted[0]!];
		for (let i = 0; i < 74; i++) items.push(summary(`exchange/app/12/${i}/x`));
		for (let i = 0; i < 74; i++) items.push(summary(`exchange/app/1/child/${i}/x`));
		items.push(wanted[1]!);
		const { d, store, deleted } = forgetThreadDeps(items);
		try {
			const res = await postForgetThread({ conversation: "app/1" }, d);
			expect(res?.status).toBe(200);
			expect(await res?.json()).toEqual({ ok: true, forgotten: 2, failed: [], remaining: 0 });
			expect(deleted).toEqual(["exchange/app/1/1/a", "exchange/app/1/2/b"]);
		} finally {
			store.close();
		}
	});

	test("a thread with no retained exchanges forgets nothing, successfully", async () => {
		const { d, store } = forgetThreadDeps([summary("exchange/dm:1/2/abc")]);
		try {
			const res = await postForgetThread({ conversation: "app/1" }, d);
			expect(res?.status).toBe(200);
			expect(await res?.json()).toEqual({ ok: true, forgotten: 0, failed: [], remaining: 0 });
		} finally {
			store.close();
		}
	});

	test("one failed document is reported and the rest still forget", async () => {
		const { d, store, deleted } = forgetThreadDeps(
			[summary("exchange/app/1/1/a"), summary("exchange/app/1/2/b")],
			(id) => id === "exchange/app/1/2/b",
		);
		try {
			const res = await postForgetThread({ conversation: "app/1" }, d);
			expect(res?.status).toBe(200);
			expect(await res?.json()).toEqual({
				ok: true,
				forgotten: 1,
				failed: [{ id: "exchange/app/1/2/b", error: "memory unavailable — try again later" }],
				remaining: 1,
			});
			expect(deleted).toEqual(["exchange/app/1/1/a"]);
		} finally {
			store.close();
		}
	});

	test("bad methods and bodies get typed refusals; unwired memory 503s", async () => {
		const get = await handleOperatorRoute(
			deps(),
			ACTOR,
			new Request("http://x/memory/forget-thread"),
			"memory/forget-thread",
			new URL("http://x/memory/forget-thread"),
		);
		expect(get?.status).toBe(405);
		const { d, store } = forgetThreadDeps([]);
		try {
			expect((await postForgetThread("not json{", d))?.status).toBe(400);
			expect((await postForgetThread({ conversation: "" }, d))?.status).toBe(422);
			expect((await postForgetThread({ conversation: "a".repeat(257) }, d))?.status).toBe(422);
		} finally {
			store.close();
		}
		expect((await postForgetThread({ conversation: "app/1" }, deps()))?.status).toBe(503);
	});
});

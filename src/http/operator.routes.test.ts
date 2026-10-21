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
import { parseConfig } from "../config.ts";
import { resolveSkillProposal, type SkillDecision } from "../skill-decisions.ts";
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
		writeFileSync(join(home, "workspace/skills/weather/SKILL.md"), "d");
		mkdirSync(join(home, "workspace/skills-proposed"), { recursive: true });
		const res = get("skills");
		return res.then(async (r) => {
			expect(r.status).toBe(200);
			const body = (await r.json()) as { skills: unknown[]; proposed: unknown[] };
			expect(body.skills.length).toBe(1);
			expect(body.proposed).toEqual([]);
		});
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
});

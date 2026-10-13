// Route-level tests for the state viewer tails: the zod gates at the
// router (bad names, bad paths, bad params) and one happy path per
// route, all through handleOperatorRoute against a fixture $GOBLIN_HOME.
// The containment wall under these routes is tested in stateview.test.ts.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleOperatorRoute, type OperatorActor, type OperatorDeps } from "./operator.ts";
import { parseConfig } from "../config.ts";

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

	test("skills/file rejects a path that escapes", async () => {
		mkdirSync(join(home, "workspace/skills/weather"), { recursive: true });
		writeFileSync(join(home, "workspace/skills/weather/SKILL.md"), "content");
		const res = await getWithQuery("skills/file", "name=weather&path=../../../goblin.json5");
		// ".." never passes the router's zod gate; a traversal that slips
		// the regex shape would still hit stateview's containment null → 404.
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
		// One match, limit 1 — nothing was dropped, so not truncated.
		expect(body.truncated).toBe(false);
		const badLimit = await getWithQuery("log", "limit=0");
		expect(badLimit.status).toBe(400);
		const badLevel = await getWithQuery("log", "level=loud");
		expect(badLevel.status).toBe(400);
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

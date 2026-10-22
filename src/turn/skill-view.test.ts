import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage, UIMessage } from "ai";
import { SKILL_PART } from "../skill-part.ts";
import {
	buildModelView,
	convertSteeredMessage,
	type ViewContext,
} from "./view.ts";

let dirs: string[] = [];
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

const user = (id: string, text: string): UIMessage => ({
	id,
	role: "user",
	parts: [{ type: "text", text }],
});

const skillMsg = (id: string, data: unknown, text = "do it"): UIMessage =>
	({
		id,
		role: "user",
		parts: [
			{ type: SKILL_PART, data },
			{ type: "text", text },
		],
	}) as unknown as UIMessage;

const texts = (view: ModelMessage[]): string[] =>
	view.flatMap((m) =>
		typeof m.content === "string"
			? [m.content]
			: m.content.map((p) => (p as { text: string }).text),
	);

const entries = (msgs: UIMessage[]) => msgs.map((m, i) => ({ seq: i + 1, message: m }));

describe("skill invocation in the model view", () => {
	test("marker in every view; body only for the owning seq", async () => {
		const bodyText = "SKILL BODY";
		const seen: string[] = [];
		const ctx: ViewContext = {
			convId: "dm:1",
			tools: {},
			modalities: undefined,
			carries: () => false,
			skillRef: (ref) => {
				if (!("name" in ref)) throw new Error("unexpected temp ref");
				seen.push(ref.name);
				return { name: ref.name, body: `wrapped ${bodyText}` };
			},
		};
		const history = [skillMsg("s1", { name: "herdr" }), user("u2", "later")];

		const owning = await buildModelView(ctx, {
			entries: entries(history),
			prior: [],
			current: null,
			partial: null,
			ownedSeqs: [1],
			assertAuthority: () => {},
		});
		const owningTexts = texts(owning);
		expect(owningTexts).toContain("[skill: herdr]");
		// The body lands AFTER the invoking message's own content and
		// before the next message.
		const bodyIdx = owningTexts.findIndex((t) => t.includes(bodyText));
		const markerIdx = owningTexts.findIndex((t) => t === "[skill: herdr]");
		const laterIdx = owningTexts.indexOf("later");
		expect(bodyIdx).toBeGreaterThan(markerIdx);
		expect(bodyIdx).toBeLessThan(laterIdx);
		expect(seen).toEqual(["herdr"]);

		seen.length = 0;
		const later = await buildModelView(ctx, {
			entries: entries(history),
			prior: [],
			current: null,
			partial: null,
			ownedSeqs: [2],
			assertAuthority: () => {},
		});
		const laterTexts = texts(later);
		expect(laterTexts).toContain("[skill: herdr]");
		expect(laterTexts.some((t) => t.includes(bodyText))).toBe(false);
	});

	test("a refused body degrades to the marker alone", async () => {
		const ctx: ViewContext = {
			convId: "dm:1",
			tools: {},
			modalities: undefined,
			carries: () => false,
			skillRef: () => ({ name: "gone", body: null }),
		};
		const view = await buildModelView(ctx, {
			entries: entries([skillMsg("s1", { name: "gone" })]),
			prior: [],
			current: null,
			partial: null,
			ownedSeqs: [1],
			assertAuthority: () => {},
		});
		expect(texts(view)).toContain("[skill: gone]");
	});

	test("malformed part data degrades to a placeholder, not a throw", async () => {
		const ctx: ViewContext = {
			convId: "dm:1",
			tools: {},
			modalities: undefined,
			carries: () => false,
			skillRef: () => {
				throw new Error("resolver must not see malformed data");
			},
		};
		const view = await buildModelView(ctx, {
			entries: entries([skillMsg("s1", { nope: true })]),
			prior: [],
			current: null,
			partial: null,
			ownedSeqs: [1],
			assertAuthority: () => {},
		});
		expect(texts(view).join("\n")).toContain("skill invocation could not be rendered");
	});

	test("temp marker carries the descriptor's name and host", async () => {
		// The wire schema pins temp paths to the real cache root — stage
		// an actual copy for the part to reference.
		const home = mkdtempSync(join(tmpdir(), "goblin-skillmark-"));
		dirs.push(home);
		process.env.GOBLIN_HOME = home;
		const { mkdirSync: mkd } = await import("node:fs");
		const cached = join(home, "state", "skillcache", "d1", "claude-api", "SKILL.md");
		mkd(join(cached, ".."), { recursive: true });
		writeFileSync(cached, "x");
		const ctx: ViewContext = {
			convId: "dm:1",
			tools: {},
			modalities: undefined,
			carries: () => false,
			skillRef: () => ({ name: "claude-api", body: "temp body" }),
		};
		const view = await buildModelView(ctx, {
			entries: entries([
				skillMsg("s1", {
					url: "https://github.com/anthropics/skills/tree/main/skills/claude-api",
					path: cached,
				}),
			]),
			prior: [],
			current: null,
			partial: null,
			ownedSeqs: [1],
			assertAuthority: () => {},
		});
		const joined = texts(view).join("\n");
		expect(joined).toContain("[temp skill: claude-api (github.com)]");
		expect(joined).toContain("temp body");
	});

	test("steered invocation: the claiming turn owns the body", async () => {
		const ctx: ViewContext = {
			convId: "dm:1",
			tools: {},
			modalities: undefined,
			carries: () => false,
			skillRef: (ref) =>
				"name" in ref ? { name: ref.name, body: "steered body" } : { name: "x", body: null },
		};
		const view = await convertSteeredMessage(ctx, skillMsg("st1", { name: "mq" }));
		const joined = texts(view).join("\n");
		expect(joined).toContain("[skill: mq]");
		expect(joined).toContain("steered body");
	});

	test("ownership maps by message id when recall blocks shift positions", async () => {
		const ctx: ViewContext = {
			convId: "dm:1",
			tools: {},
			modalities: undefined,
			carries: () => false,
			skillRef: () => ({ name: "mq", body: "shifted body" }),
		};
		const history = [user("u0", "first"), skillMsg("s1", { name: "mq" })];
		const withBlock = await buildModelView(ctx, {
			entries: entries(history),
			prior: [
				{ anchorSeq: 1, content: "memory block rides before its anchor", sourceIds: ["e1"] },
			],
			current: null,
			partial: null,
			ownedSeqs: [2],
			assertAuthority: () => {},
		});
		const joined = texts(withBlock).join("\n");
		// The block must not inherit the body — the id map keeps it on s1.
		expect(joined).toContain("shifted body");
	});
});

describe("resolveSkillRef (real fs)", () => {
	test("catalog skill reads live; missing degrades to null body", async () => {
		const home = mkdtempSync(join(tmpdir(), "goblin-skillref-"));
		dirs.push(home);
		process.env.GOBLIN_HOME = home;
		const { mkdirSync } = await import("node:fs");
		mkdirSync(join(home, "workspace", "skills", "mq"), { recursive: true });
		writeFileSync(
			join(home, "workspace", "skills", "mq", "SKILL.md"),
			"---\nname: mq\ndescription: d\n---\nbody here",
		);
		const { resolveSkillRef } = await import("./../agent/skill-inject.ts");
		const found = resolveSkillRef({ name: "mq" });
		expect(found.name).toBe("mq");
		expect(found.body).toContain("body here");
		expect(resolveSkillRef({ name: "absent" }).body).toBeNull();
		// A traversal-shaped name never reads the disk.
		expect(resolveSkillRef({ name: "../escape" } as never).body).toBeNull();
	});

	test("temp skill refuses an unstamped verdict and rides a stamped one", async () => {
		const home = mkdtempSync(join(tmpdir(), "goblin-skillref2-"));
		dirs.push(home);
		process.env.GOBLIN_HOME = home;
		const { mkdirSync } = await import("node:fs");
		const digestDir = join(home, "state", "skillcache", "d1");
		mkdirSync(join(digestDir, "demo"), { recursive: true });
		writeFileSync(join(digestDir, "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\nT");
		const { writeFileSync: wf } = await import("node:fs");
		const { resolveSkillRef } = await import("./../agent/skill-inject.ts");
		const ref = {
			url: "https://github.com/o/r/tree/main/demo",
			path: join(digestDir, "demo", "SKILL.md"),
		};
		// No descriptor at all.
		expect(resolveSkillRef(ref).body).toBeNull();
		// Descriptor present, verdict unstamped.
		wf(
			join(digestDir, "skill.json"),
			JSON.stringify({
				name: "demo",
				description: "d",
				sourceUrl: ref.url,
				fetchedAt: "2026-10-21T00:00:00Z",
				verdict: { status: "unavailable", injection: null, severity: null },
			}),
		);
		const unstamped = resolveSkillRef(ref);
		expect(unstamped.name).toBe("demo");
		expect(unstamped.body).toBeNull();
		// Stamped — the preamble names source, verdict, and the staged dir.
		wf(
			join(digestDir, "skill.json"),
			JSON.stringify({
				name: "demo",
				description: "d",
				sourceUrl: ref.url,
				fetchedAt: "2026-10-21T00:00:00Z",
				verdict: { status: "clean", injection: 0.1, severity: 0.2 },
			}),
		);
		const stamped = resolveSkillRef(ref);
		expect(stamped.body).not.toBeNull();
		expect(stamped.body).toContain(ref.url);
		expect(stamped.body).toContain("injection check: clean");
		expect(stamped.body).toContain(join(digestDir, "demo"));
		expect(stamped.body).toContain("T");
	});
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { decideSkillProposal } from "../../src/skill-decisions.ts";
import { listSkills, readSkillFile } from "../../src/stateview.ts";
import { SkillsView } from "./SkillsView.tsx";

let home: string;
let win: Window;
let container: HTMLElement;
let root: Root | null = null;
const realFetch = globalThis.fetch;
const globals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "skills-view-"));
	win = new Window({ url: "http://localhost/app/skills" });
	const div = win.document.createElement("div");
	win.document.body.appendChild(div);
	container = div as unknown as HTMLElement;
	for (const [name, value] of [
		["window", win],
		["document", win.document],
		["navigator", win.navigator],
		["IS_REACT_ACT_ENVIRONMENT", true],
	] as const) {
		globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Reflect.set(globalThis, name, value);
	}
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	await win.happyDOM.close();
	globalThis.fetch = realFetch;
	for (const [name, descriptor] of globals) {
		if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
		else Object.defineProperty(globalThis, name, descriptor);
	}
	globals.clear();
	rmSync(home, { recursive: true, force: true });
});

const skillMd = (description: string, body: string) =>
	`---\nname: NAME\ndescription: ${description}\n---\n${body}\n`;

function writeSkill(
	base: string,
	name: string,
	description: string,
	body: string,
	extra?: [string, string],
) {
	mkdirSync(join(base, name), { recursive: true });
	writeFileSync(join(base, name, "SKILL.md"), skillMd(description, body).replace("NAME", name));
	if (extra !== undefined) writeFileSync(join(base, name, extra[0]), extra[1]);
}

// Only HTTP is replaced: the list, the file reads and the decision all run
// the real disk mechanics, so the lifecycle proven here is the real one.
function diskServer(
	skills: string,
	proposed: string,
	posts: { name: string; action: string }[] = [],
) {
	const workspaceDir = join(home, "workspace");
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
			if (url.pathname === "/api/app/skills") return Response.json(listSkills(skills, proposed));
			if (url.pathname === "/api/app/skills/file") {
				const origin = url.searchParams.get("origin");
				if (origin !== "skills" && origin !== "proposed")
					return Response.json({ error: "bad origin" }, { status: 400 });
				const file = readSkillFile(
					skills,
					proposed,
					origin,
					url.searchParams.get("name") ?? "",
					url.searchParams.get("path") ?? "",
				);
				return file === null
					? Response.json({ error: "not found" }, { status: 404 })
					: Response.json(file);
			}
			if (url.pathname === "/api/app/skills/decide" && init?.method === "POST") {
				const body = JSON.parse(String(init.body)) as {
					name: string;
					action: "install" | "discard";
				};
				posts.push(body);
				const outcome = decideSkillProposal(
					{ workspaceDir, skillsDir: skills, proposedDir: proposed },
					body.name,
					body.action,
				);
				if (!outcome.ok) return Response.json({ error: outcome.reason }, { status: 409 });
				return Response.json({
					ok: true,
					skill: body.name,
					action: outcome.action,
					replaced: outcome.action === "install" ? outcome.replaced : false,
					state: outcome.action === "install" ? "installed" : "gone",
				});
			}
			throw new Error(`unexpected request: ${url.pathname}`);
		},
		{ preconnect: realFetch.preconnect },
	);
}

const button = (scope: Element, label: string) =>
	[...scope.querySelectorAll("button")].find((el) => el.textContent === label);

test("proposals come first with their diff open; installed skills say what they do", async () => {
	const skills = join(home, "skills");
	const proposed = join(home, "proposed");
	writeSkill(skills, "weather", "Look up the forecast for a city.", "live body");
	writeSkill(skills, "notes", "Keep short notes.", "n");
	writeSkill(proposed, "weather", "Look up the forecast for a city.", "updated body");
	writeSkill(proposed, "tide", "Read tide tables.", "tide body");
	diskServer(skills, proposed);
	root = createRoot(container);
	await act(async () => root?.render(<SkillsView token={null} />));

	const headings = [...container.querySelectorAll(".ops-h2")].map((h) => h.textContent);
	expect(headings).toEqual(["Proposed (2)", "Installed (2)"]);
	const cards = [...container.querySelectorAll(".skill-proposal")];
	const update = cards.find((c) => c.querySelector(".op-item-title")?.textContent === "weather")!;
	expect(update.querySelector(".pill")?.textContent).toBe("update");
	expect(update.querySelector(".diff-line.del")?.textContent).toBe("-live body");
	expect(update.querySelector(".diff-line.add")?.textContent).toBe("+updated body");
	expect(button(update, "Install update")).toBeDefined();
	expect(button(update, "Discard update")).toBeDefined();
	// A new skill has no diff, so its SKILL.md is already open.
	const fresh = cards.find((c) => c.querySelector(".op-item-title")?.textContent === "tide")!;
	expect(fresh.querySelector(".pill")?.textContent).toBe("new");
	expect(fresh.querySelector("pre")?.textContent).toContain("tide body");
	// SKILL.md's frontmatter is metadata, not evidence — the source skips it.
	expect(fresh.querySelector("pre")?.textContent).not.toContain("name: tide");
	expect(button(fresh, "Install")).toBeDefined();
	// The table carries the description from SKILL.md.
	const rows = [...container.querySelectorAll(".dtable .dt-row")];
	expect(rows.map((r) => r.textContent)).toEqual([
		expect.stringContaining("Keep short notes."),
		expect.stringContaining("Look up the forecast for a city."),
	]);
});

test("opening a skill replaces the list with its detail; back returns", async () => {
	const skills = join(home, "skills");
	const proposed = join(home, "proposed");
	writeSkill(skills, "weather", "Look up the forecast.", "live body", ["refs.md", "more"]);
	diskServer(skills, proposed);
	root = createRoot(container);
	await act(async () => root?.render(<SkillsView token={null} />));
	await act(async () => (container.querySelector(".dt-row") as HTMLElement).click());
	expect(container.querySelector(".dtable")).toBeNull();
	expect(container.querySelector(".prose")?.textContent).toBe("Look up the forecast.");
	// SKILL.md reads without a click; another file is one click away.
	expect(container.querySelector("pre")?.textContent).toContain("live body");
	await act(async () => button(container, "refs.md")?.click());
	expect(container.querySelector("pre")?.textContent).toBe("more");
	await act(async () => button(container, "‹ Skills")?.click());
	expect(container.querySelector(".dtable")).not.toBeNull();
});

test("Install update puts the proposed files on disk and the proposal leaves the list", async () => {
	const skills = join(home, "skills");
	const proposed = join(home, "proposed");
	writeSkill(skills, "weather", "Old.", "live body");
	writeSkill(proposed, "weather", "New.", "updated body", ["extra.md", "added"]);
	const posts: { name: string; action: string }[] = [];
	diskServer(skills, proposed, posts);
	root = createRoot(container);
	await act(async () => root?.render(<SkillsView token={null} />));
	await act(async () => button(container, "Install update")?.click());
	expect(posts).toEqual([{ name: "weather", action: "install" }]);
	expect(readFileSync(join(skills, "weather/SKILL.md"), "utf8")).toContain("updated body");
	expect(readFileSync(join(skills, "weather/extra.md"), "utf8")).toBe("added");
	expect(container.querySelector(".skill-proposal")).toBeNull();
	expect(container.querySelector(".dt-row")?.textContent).toContain("New.");
});

test("discarding an update deletes the staged copy, never the installed one", async () => {
	const skills = join(home, "skills");
	const proposed = join(home, "proposed");
	writeSkill(skills, "weather", "Old.", "live body");
	writeSkill(proposed, "weather", "New.", "updated body");
	const posts: { name: string; action: string }[] = [];
	diskServer(skills, proposed, posts);
	root = createRoot(container);
	await act(async () => root?.render(<SkillsView token={null} />));
	await act(async () => button(container, "Discard update")?.click());
	expect(posts).toEqual([{ name: "weather", action: "discard" }]);
	expect(existsSync(join(proposed, "weather"))).toBe(false);
	expect(readFileSync(join(skills, "weather/SKILL.md"), "utf8")).toContain("live body");
	expect(container.querySelector(".skill-proposal")).toBeNull();
	expect(container.querySelector(".dt-row")).not.toBeNull();
});

test("a skill without frontmatter still lists, saying it has no description", async () => {
	const skills = join(home, "skills");
	mkdirSync(join(skills, "bare"), { recursive: true });
	writeFileSync(join(skills, "bare/SKILL.md"), "just text");
	diskServer(skills, join(home, "proposed"));
	root = createRoot(container);
	await act(async () => root?.render(<SkillsView token={null} />));
	expect(container.querySelector(".dt-row")?.textContent).toContain("No description");
});

test("a slow file response never overwrites a newer selection", async () => {
	const skills = join(home, "skills");
	writeSkill(skills, "weather", "d", "a body", ["b.md", "b body"]);
	const pending = new Map<string, (r: Response) => void>();
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
			if (url.pathname === "/api/app/skills")
				return Response.json(listSkills(skills, join(home, "p")));
			if (url.pathname === "/api/app/skills/file")
				return new Promise<Response>((resolve) =>
					pending.set(url.searchParams.get("path") ?? "", resolve),
				);
			throw new Error(`unexpected request: ${url.pathname}`);
		},
		{ preconnect: realFetch.preconnect },
	);
	root = createRoot(container);
	await act(async () => root?.render(<SkillsView token={null} />));
	await act(async () => (container.querySelector(".dt-row") as HTMLElement).click());
	// SKILL.md was requested on open; the operator then picks b.md.
	await act(async () => button(container, "b.md")?.click());
	await act(async () => pending.get("b.md")!(Response.json({ content: "bee" })));
	await act(async () => pending.get("SKILL.md")!(Response.json({ content: "aye" })));
	expect(container.querySelector("pre")?.textContent).toBe("bee");
	expect(container.querySelector(".error")).toBeNull();
});

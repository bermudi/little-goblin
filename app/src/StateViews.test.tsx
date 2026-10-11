import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { listSkills, readSkillFile } from "../../src/stateview.ts";
import { SkillsView } from "./StateViews.tsx";

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

test("installed and proposed file clicks round-trip the actual catalog paths", async () => {
	const skills = join(home, "skills");
	const proposed = join(home, "proposed");
	for (const [dir, name] of [
		[skills, "weather"],
		[proposed, "draft"],
	] as const) {
		mkdirSync(join(dir, name, "refs"), { recursive: true });
		writeFileSync(join(dir, name, "SKILL.md"), `${name} body`);
		writeFileSync(join(dir, name, "refs/example.md"), `${name} extra`);
	}
	// Only HTTP is replaced: both catalog and file responses come from
	// the real disk readers, so fixture paths cannot conceal a mismatch.
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
			if (url.pathname === "/api/app/skills") return Response.json(listSkills(skills, proposed));
			if (url.pathname === "/api/app/skills/file") {
				const origin = url.searchParams.get("origin");
				if (origin !== "skills" && origin !== "proposed") {
					return Response.json({ error: "bad origin" }, { status: 400 });
				}
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
			throw new Error(`unexpected request: ${url.pathname}`);
		},
		{ preconnect: realFetch.preconnect },
	);
	root = createRoot(container);
	await act(async () => root?.render(<SkillsView token={null} />));
	for (const name of ["weather", "draft"]) {
		const card = [...container.querySelectorAll(".card")].find(
			(el) => el.querySelector(".op-item-title")?.textContent === name,
		);
		expect(card).toBeDefined();
		for (const [path, content] of [
			["SKILL.md", `${name} body`],
			["refs/example.md", `${name} extra`],
		]) {
			const button = [...card!.querySelectorAll("button")].find((el) => el.textContent === path);
			expect(button).toBeDefined();
			await act(async () => button?.click());
			expect(card!.querySelector("pre")?.textContent).toBe(content);
			expect(card!.querySelector(".error")).toBeNull();
		}
	}
});

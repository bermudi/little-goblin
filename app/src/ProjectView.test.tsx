import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { AppNoteList, AppProject } from "../../src/http/app-wire.ts";
import { ProjectView } from "./ProjectView.tsx";

const project: AppProject = {
	id: "project-1",
	name: "Writing",
	slug: "writing",
	dir: "/workspace/writing",
	managed: true,
	instructions: "",
	memory: "shared",
	createdAt: "2026-10-14T00:00:00Z",
	archivedAt: null,
};

let win: Window;
let root: Root | null = null;
let container: HTMLElement;
let response: AppNoteList;
const realFetch = globalThis.fetch;
const globals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
	win = new Window({ url: "http://localhost/app/p/project-1" });
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
	response = {
		notes: [
			{
				id: "note-1",
				projectId: project.id,
				title: "Outline",
				rev: 1,
				pinnedAt: null,
				archivedAt: null,
				updatedAt: project.createdAt,
				preview: "Chapter one",
			},
		],
		truncated: true,
	};
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : String(input), win.location.href);
			expect(url.pathname).toBe("/api/app/notes");
			expect(url.searchParams.get("project")).toBe(project.id);
			return Response.json(response);
		},
		{ preconnect: realFetch.preconnect },
	);
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
});

test("project notes disclose a capped list and clear the warning after a complete refresh", async () => {
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<ProjectView
				token={null}
				project={project}
				conversations={[]}
				renderRow={() => null}
				onChanged={() => {}}
				onOpenNote={() => {}}
			/>,
		),
	);
	expect(container.textContent).toContain("Outline");
	expect(container.querySelector('[role="status"]')?.textContent).toContain(
		"Showing the first 1 notes",
	);
	expect(container.textContent).toContain("Use the Notes search");

	response = { ...response, truncated: false };
	await act(async () => win.dispatchEvent(new win.Event("focus")));
	expect(container.querySelector('[role="status"]')).toBeNull();
	expect(container.textContent).toContain("Outline");
});

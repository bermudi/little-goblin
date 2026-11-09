import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { NewProjectDialog, ProjectsIndex, ProjectView } from "./ProjectView.tsx";
import type {
	AppConversationList,
	AppNote,
	AppProject,
	AppNoteList,
} from "../../src/http/app-wire.ts";

type Summary = AppConversationList["conversations"][number];

describe("main branch regressions", () => {
	// StrictMode liveness: the dialog's `live` and the notes section's
	// `mounted` refs gate late completions, and their effects must rearm
	// on replay — otherwise StrictMode's mount cleanup leaves every
	// success, error, and busy reset fenced forever. The wire is faked at
	// globalThis.fetch with test-owned failure flips; no module mocks.

	const jsonResponse = (body: unknown, status = 200): Response =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});

	const projRow = (name: string, over: Partial<AppProject> = {}): AppProject => ({
		id: `p-${name.split(" ")[0]!.toLowerCase()}`,
		name,
		slug: name.toLowerCase().replaceAll(" ", "-"),
		dir: `/tmp/${name}`,
		managed: true,
		instructions: "",
		memory: "shared",
		createdAt: "2026-10-08T00:00:00.000Z",
		archivedAt: null,
		...over,
	});

	const createdNote: AppNote = {
		id: "n-new",
		projectId: "p-goblin",
		title: "Untitled note",
		body: "",
		rev: 1,
		stateRev: 1,
		lastSource: "app",
		pinnedAt: null,
		archivedAt: null,
		createdAt: "2026-10-10T00:00:00.000Z",
		updatedAt: "2026-10-10T00:00:00.000Z",
	};

	describe("ProjectView StrictMode liveness", () => {
		let win: Window;
		let container: HTMLElement;
		let root: Root | null = null;
		let installed: string[] = [];
		let projectReplies: () => Promise<Response>;
		let noteReplies: () => Promise<Response>;
		let noteLists: number;
		const realFetch = globalThis.fetch;

		const installGlobal = (name: string, value: unknown) => {
			Reflect.set(globalThis, name, value);
			installed.push(name);
		};

		beforeEach(() => {
			win = new Window({ url: "http://localhost/app/" });
			const div = win.document.createElement("div");
			win.document.body.appendChild(div);
			container = div as unknown as HTMLElement;
			installed = [];
			noteLists = 0;
			projectReplies = () =>
				Promise.resolve(jsonResponse(projRow("Side Hustle", { id: "p-new" }), 201));
			noteReplies = () => Promise.resolve(jsonResponse(createdNote, 201));
			installGlobal("window", win);
			installGlobal("document", win.document);
			installGlobal("navigator", win.navigator);
			installGlobal("localStorage", win.localStorage);
			installGlobal("sessionStorage", win.sessionStorage);
			installGlobal("Event", win.Event);
			installGlobal("CustomEvent", win.CustomEvent);
			installGlobal("getComputedStyle", win.getComputedStyle);
			installGlobal("dispatchEvent", win.dispatchEvent.bind(win));
			installGlobal("addEventListener", win.addEventListener.bind(win));
			installGlobal("removeEventListener", win.removeEventListener.bind(win));
			for (const name of [
				"MutationObserver",
				"Range",
				"Node",
				"HTMLElement",
				"HTMLUnknownElement",
				"requestAnimationFrame",
				"cancelAnimationFrame",
			] as const) {
				const value = Reflect.get(win as unknown as Record<string, unknown>, name);
				if (value !== undefined) installGlobal(name, value);
			}
			Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
			globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
				const url =
					typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				const method = init?.method ?? (input instanceof Request ? input.method : "GET");
				if (url === "/api/app/projects" && method === "POST") return projectReplies();
				if (url === "/api/app/notes" && method === "POST") return noteReplies();
				if (url === "/api/app/notes" || url.startsWith("/api/app/notes?")) {
					noteLists += 1;
					return Promise.resolve(jsonResponse({ notes: [] }));
				}
				return Promise.resolve(jsonResponse({ error: `unfaked ${method} ${url}` }, 500));
			}) as typeof fetch;
		});

		afterEach(async () => {
			if (root !== null) {
				await act(async () => {
					root?.unmount();
				});
				root = null;
			}
			await win.happyDOM.close();
			globalThis.fetch = realFetch;
			Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
			for (const name of installed) Reflect.deleteProperty(globalThis, name);
			installed = [];
		});

		const settle = async () => {
			await act(async () => {
				await new Promise((r) => setTimeout(r, 30));
			});
		};
		const click = async (el: Element | null | undefined) => {
			expect(el).toBeTruthy();
			await act(async () => {
				el?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event);
			});
			await settle();
		};
		const typeInto = async (el: Element, value: string, proto: object) => {
			await act(async () => {
				(el as HTMLElement).focus();
				Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
				el.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
				el.dispatchEvent(
					new win.KeyboardEvent("keyup", {
						bubbles: true,
						key: "e",
					}) as unknown as Event,
				);
			});
			await settle();
		};

		const mountDialog = (onCreated: (p: AppProject) => void) => {
			root = createRoot(container);
			return act(async () => {
				root!.render(
					<StrictMode>
						<NewProjectDialog token={null} onClose={() => {}} onCreated={onCreated} />
					</StrictMode>,
				);
			});
		};
		const mountPage = (onOpenNote: (id: string) => void) => {
			root = createRoot(container);
			return act(async () => {
				root!.render(
					<StrictMode>
						<ProjectView
							token={null}
							project={projRow("Goblin")}
							conversations={[]}
							renderRow={(c) => <li key={c.id}>{c.title ?? "chat"}</li>}
							onChanged={() => {}}
							onOpenNote={onOpenNote}
						/>
					</StrictMode>,
				);
			});
		};
		const submitDialog = async (name?: string) => {
			const sheet = container.querySelector(".msheet form")!;
			expect(sheet).not.toBeNull();
			if (name !== undefined) {
				await typeInto(sheet.querySelector("input")!, name, win.HTMLInputElement.prototype);
			}
			await act(async () => {
				sheet.dispatchEvent(
					new win.Event("submit", {
						bubbles: true,
						cancelable: true,
					}) as unknown as Event,
				);
			});
			await settle();
		};
		const submitButton = (): HTMLButtonElement =>
			container.querySelector<HTMLButtonElement>('.msheet button[type="submit"]')!;
		const alertText = (): string | null =>
			container.querySelector('p.err-inline[role="alert"], p.error[role="alert"]')?.textContent ??
			null;

		test("a dialog create still reaches onCreated after strict effect replay", async () => {
			const created: AppProject[] = [];
			await mountDialog((p) => created.push(p));
			await submitDialog("Side Hustle");
			expect(created).toHaveLength(1);
			expect(created[0]!.id).toBe("p-new");
		});

		test("a refused create surfaces inline, frees the form, and a retry navigates", async () => {
			const created: AppProject[] = [];
			projectReplies = () => Promise.resolve(jsonResponse({ error: "name already taken" }, 422));
			await mountDialog((p) => created.push(p));
			await submitDialog("Side Hustle");
			expect(alertText()).toBe("name already taken");
			expect(submitButton().disabled).toBe(false);
			expect(created).toHaveLength(0);

			projectReplies = () =>
				Promise.resolve(jsonResponse(projRow("Side Hustle", { id: "p-new" }), 201));
			await submitDialog();
			expect(alertText()).toBeNull();
			expect(created).toHaveLength(1);
			expect(created[0]!.id).toBe("p-new");
		});

		test("a project New note still reaches onOpenNote after strict effect replay", async () => {
			const opened: string[] = [];
			await mountPage((id) => opened.push(id));
			expect(noteLists).toBe(2);
			await click(
				[...container.querySelectorAll("button")].find((b) => b.textContent === "New note"),
			);
			expect(opened).toEqual(["n-new"]);
		});

		test("a failed project note create surfaces inline after strict effect replay", async () => {
			const opened: string[] = [];
			noteReplies = () => Promise.resolve(jsonResponse({ error: "disk full" }, 500));
			await mountPage((id) => opened.push(id));
			expect(noteLists).toBe(2);
			await click(
				[...container.querySelectorAll("button")].find((b) => b.textContent === "New note"),
			);
			expect(opened).toHaveLength(0);
			expect(alertText()).toBe("Couldn't create the note: disk full");
		});
	});
});

describe("quiet harbor regressions", () => {
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
					stateRev: 1,
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
				const url = new URL(
					input instanceof Request ? input.url : String(input),
					win.location.href,
				);
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
});

describe("projects index table (#168)", () => {
	const row = (name: string, over: Partial<AppProject> = {}): AppProject => ({
		id: `p-${name.toLowerCase()}`,
		name,
		slug: name.toLowerCase(),
		dir: `/home/x/${name}`,
		managed: true,
		instructions: "",
		memory: "shared",
		createdAt: "2026-10-08T00:00:00.000Z",
		archivedAt: null,
		...over,
	});

	test("active projects are table rows with the kind as a status pill; archived ones wait in the shelf", () => {
		const html = renderToStaticMarkup(
			<ProjectsIndex
				projects={[
					row("Alpha", { managed: false, memory: "off" }),
					row("Beta"),
					row("Old", { archivedAt: "2026-10-09T00:00:00.000Z" }),
				]}
				onOpen={() => {}}
				onNew={() => {}}
			/>,
		);
		const doc = new Window().document;
		doc.body.innerHTML = html;
		const tables = [...doc.querySelectorAll(".dtable")];
		expect(tables).toHaveLength(2);
		const active = [...tables[0]!.querySelectorAll("button.dt-row")];
		expect(active.map((r) => r.querySelector(".dt-main")?.textContent)).toEqual(["Alpha", "Beta"]);
		expect(active[0]!.querySelector(".dt-status .pill")?.textContent).toBe("linked");
		expect(active[0]!.textContent).toContain("off");
		expect(tables[0]!.querySelector(".dt-head")?.textContent).toContain("Directory");
		expect(doc.querySelector("details.tuning")?.contains(tables[1]!)).toBe(true);
	});
});

describe("project page layout (#171)", () => {
	const project: AppProject = {
		id: "p-garden",
		name: "Balcony garden",
		slug: "balcony-garden",
		dir: "/home/x/projects/balcony-garden",
		managed: true,
		instructions: "",
		memory: "shared",
		createdAt: "2026-10-14T00:00:00Z",
		archivedAt: null,
	};
	const chat = (id: string, over: Partial<Summary> = {}): Summary => ({
		id,
		title: null,
		createdAt: "2026-10-14T00:00:00Z",
		updatedAt: "2026-10-14T00:00:00Z",
		preview: "",
		archivedAt: null,
		pinnedAt: null,
		projectId: project.id,
		...over,
	});
	const view = (over: Partial<AppProject> = {}, convs: Summary[] = []) => {
		const doc = new Window().document;
		doc.body.innerHTML = renderToStaticMarkup(
			<ProjectView
				token={null}
				project={{ ...project, ...over }}
				conversations={convs}
				renderRow={(c) => <li key={c.id}>{c.id}</li>}
				onChanged={() => {}}
				onOpenNote={() => {}}
			/>,
		);
		return doc;
	};

	test("each section heading shares one line with its action; chats are a table", () => {
		const doc = view({}, [
			chat("app/1", {
				title: "Soil mix",
				preview: "Use 2 parts coco\ncoir",
				pinnedAt: "2026-10-15T00:00:00Z",
			}),
			chat("app/2", { preview: "water the basil" }),
			chat("app/3", { title: "Old", archivedAt: "2026-10-16T00:00:00Z" }),
			chat("app/other", { projectId: "p-else", title: "Elsewhere" }),
		]);
		const heads = [...doc.querySelectorAll(".proj-sec-head")];
		const byTitle = (t: string) =>
			heads.find((h) => h.querySelector("h2")?.textContent?.startsWith(t));
		expect(byTitle("Instructions")?.querySelector("button")?.textContent).toBe("Save");
		expect(byTitle("Notes")?.querySelector("button")?.textContent).toBe("New note");
		const rows = [...doc.querySelectorAll(".dtable button.dt-row")];
		expect(rows.map((r) => r.querySelector(".dt-main")?.textContent)).toEqual([
			"Soil mix",
			"water the basil",
		]);
		expect(rows[0]!.textContent).toContain("Use 2 parts coco coir");
		expect(rows[0]!.querySelector(".dt-status .pill")?.textContent).toBe("pinned");
		expect(doc.querySelector("details.tuning")?.textContent).toContain("app/3");
	});

	test("archive lives in a footer danger zone, after the chats", () => {
		const doc = view();
		const foot = doc.querySelector(".proj-foot.danger-zone")!;
		expect(foot.querySelector("button.danger")?.textContent).toBe("Archive project");
		const chats = [...doc.querySelectorAll(".proj-sec")].at(-1)!;
		expect(chats.compareDocumentPosition(foot) & 4).toBeTruthy(); // foot follows
		expect(view({ archivedAt: "2026-10-16T00:00:00Z" }).querySelector(".danger")).toBeNull();
	});

	test("memory is a labelled two-way control, not a dropdown", () => {
		const doc = view({ memory: "off" });
		expect(doc.querySelector("select")).toBeNull();
		const radios = [
			...doc.querySelectorAll('[role="radiogroup"][aria-label="Memory mode"] [role="radio"]'),
		];
		expect(radios.map((r) => [r.textContent, r.getAttribute("aria-checked")])).toEqual([
			["Shared", "false"],
			["Off", "true"],
		]);
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import {
	authDefaults,
	parseConfig,
	transcriptionDefaults,
	transcriptionKinds,
} from "../../src/config.ts";
import type {
	AppConversationList,
	AppNote,
	AppNoteSummary,
	AppProject,
} from "../../src/http/app-wire.ts";
import { App } from "./App.tsx";

// Late completions must not drive navigation: a held create dialog's
// onCreated, a held note mint's onOpenNote, and a second note→chat
// start all resolve after the operator has moved on. Full App mount
// in happy-dom like App.test.tsx's projects surface — the wire is
// faked at globalThis.fetch with test-owned hold gates.

const jsonResponse = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const SETTINGS = parseConfig({
	providers: {
		main: { kind: "openai-compatible", baseUrl: "https://api.example.test", auth: "fixture" },
	},
	model: "main/test",
	operators: [111],
	allowedUsers: [111],
	telegram: { model: "main/test", thinking: "medium" },
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

const noteRow = (title: string, over: Partial<AppNoteSummary> = {}): AppNoteSummary => ({
	id: `n-${title.split(" ")[0]!.toLowerCase()}`,
	projectId: null,
	title,
	rev: 1,
	stateRev: 1,
	pinnedAt: null,
	archivedAt: null,
	updatedAt: "2026-10-10T00:00:00.000Z",
	preview: "",
	...over,
});

const noteFull = (s: AppNoteSummary, body = ""): AppNote => ({
	...s,
	body,
	lastSource: "app",
	createdAt: "2026-10-08T00:00:00.000Z",
});

describe("navigation races: late completions", () => {
	let win: Window;
	let container: HTMLElement;
	let root: Root | null = null;
	let installed: string[] = [];
	let convs: AppConversationList["conversations"];
	let projs: AppProject[];
	let notes: AppNoteSummary[];
	let noteBodies: Record<string, string>;
	let posts: { url: string; body: unknown }[];
	let confirmCalls: number;
	let deletedConversations: string[];
	// Held replies — a POST waits on its gate until the test releases
	// it; pendingGates resolve in afterEach so a failed assertion can
	// never strand a pending mocked fetch.
	let convCreateHold: Promise<void> | null;
	let convDeleteHold: Promise<void> | null;
	let projCreateHold: Promise<void> | null;
	let noteCreateHold: Promise<void> | null;
	let pendingGates: PromiseWithResolvers<void>[];
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
		convs = [];
		projs = [];
		notes = [];
		noteBodies = {};
		posts = [];
		confirmCalls = 0;
		deletedConversations = [];
		convCreateHold = null;
		convDeleteHold = null;
		projCreateHold = null;
		noteCreateHold = null;
		pendingGates = [];
		installGlobal("window", win);
		installGlobal("document", win.document);
		installGlobal("navigator", win.navigator);
		installGlobal("localStorage", win.localStorage);
		installGlobal("sessionStorage", win.sessionStorage);
		installGlobal("Event", win.Event);
		installGlobal("CustomEvent", win.CustomEvent);
		installGlobal("getComputedStyle", win.getComputedStyle);
		// The note page lazy-mounts Milkdown — its ctx signals readiness
		// with bare dispatchEvent/addEventListener, which must ride the
		// happy-dom realm (App.test.tsx's ruling).
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
		// The dirty-settings guard declines — a phantom confirm means a
		// late completion reached a navigation it had no business in.
		Reflect.set(win, "confirm", () => {
			confirmCalls += 1;
			return false;
		});
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const method = init?.method ?? (input instanceof Request ? input.method : "GET");
			const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
			if (method === "DELETE" && url.startsWith("/api/app/conversations/")) {
				deletedConversations.push(url);
				const reply = () => Promise.resolve(jsonResponse({ ok: true }));
				return convDeleteHold === null ? reply() : convDeleteHold.then(reply);
			}
			if (url === "/api/app/conversations") {
				if (method === "POST") {
					posts.push({ url, body });
					const reply = () =>
						Promise.resolve(
							jsonResponse(
								{ id: "app/minted", title: null, createdAt: "2026-10-10T00:00:00Z" },
								201,
							),
						);
					return convCreateHold === null ? reply() : convCreateHold.then(reply);
				}
				return Promise.resolve(jsonResponse({ conversations: convs }));
			}
			if (url === "/api/app/projects") {
				if (method === "POST") {
					posts.push({ url, body });
					const reply = () => {
						const req = body as { name: string };
						const project = projRow(req.name, { id: "p-new" });
						projs.push(project);
						return Promise.resolve(jsonResponse(project, 201));
					};
					return projCreateHold === null ? reply() : projCreateHold.then(reply);
				}
				return Promise.resolve(jsonResponse({ projects: projs }));
			}
			if (url.startsWith("/api/app/notes/")) {
				const id = decodeURIComponent(url.slice("/api/app/notes/".length).split("/")[0]!);
				const n = notes.find((x) => x.id === id);
				if (n === undefined) return Promise.resolve(jsonResponse({ error: "not found" }, 404));
				if (method === "PATCH") {
					const req = body as { title?: string; body?: string };
					const headers = (init?.headers ?? {}) as Record<string, string>;
					const im = headers["if-match"];
					if (req.title !== undefined || req.body !== undefined) {
						if (im === undefined || Number(im.replaceAll('"', "")) !== n.rev)
							return Promise.resolve(
								jsonResponse({ error: "conflict", note: noteFull(n, noteBodies[n.id] ?? "") }, 409),
							);
						if (req.title !== undefined) n.title = req.title;
						if (req.body !== undefined) noteBodies[n.id] = req.body;
						n.rev += 1;
						n.stateRev += 1;
						n.updatedAt = "2026-10-12T00:00:00.000Z";
					}
				}
				return Promise.resolve(jsonResponse(noteFull(n, noteBodies[n.id] ?? "")));
			}
			if (url === "/api/app/notes" || url.startsWith("/api/app/notes?")) {
				if (method === "POST") {
					posts.push({ url, body });
					const reply = () => {
						const req = body as { title: string; projectId?: string };
						const n = noteRow(req.title, { id: "n-new", projectId: req.projectId ?? null });
						notes.push(n);
						return Promise.resolve(jsonResponse(noteFull(n), 201));
					};
					return noteCreateHold === null ? reply() : noteCreateHold.then(reply);
				}
				const u = new URL(url, "http://localhost");
				const scope = u.searchParams.get("project");
				return Promise.resolve(
					jsonResponse({
						notes: notes.filter(
							(n) =>
								n.archivedAt === null &&
								(scope === null || scope === "all"
									? true
									: scope === "loose"
										? n.projectId === null
										: n.projectId === scope),
						),
					}),
				);
			}
			if (url.endsWith("/messages"))
				return Promise.resolve(jsonResponse({ messages: [], ratings: [], rateableMessageIds: [] }));
			if (url.endsWith("/stream")) return Promise.resolve(new Response(null, { status: 204 }));
			if (url.endsWith("/chat")) {
				posts.push({ url, body });
				return Promise.resolve(
					new Response("data: [DONE]\n\n", {
						status: 200,
						headers: {
							"content-type": "text/event-stream",
							"x-vercel-ai-ui-message-stream": "v1",
						},
					}),
				);
			}
			if (url === "/api/app/settings" && method === "POST")
				return Promise.resolve(jsonResponse({ ok: true }));
			if (url === "/api/app/settings")
				return Promise.resolve(
					new Response(
						JSON.stringify({
							config: SETTINGS,
							providerKinds: ["openai-compatible", "openrouter"],
							searchKinds: ["ddg", "brave", "jina"],
							fetchKinds: ["local", "firecrawl", "jina"],
							transcriptionKinds,
							transcriptionDefaults,
							authDefaults,
							authNames: ["main"],
							modelCatalog: [],
						}),
						{ headers: { "content-type": "application/json", etag: '"v1"' } },
					),
				);
			if (url.includes("thinking-levels"))
				return Promise.resolve(jsonResponse({ levels: ["off", "low", "medium", "high"] }));
			if (url === "/api/app/memory/status")
				return Promise.resolve(
					jsonResponse({
						state: "healthy",
						detail: "",
						deleting: 0,
						completed: 0,
						blocked: 0,
						dismissed: 0,
						queued: 0,
						lastRecallAt: null,
						lastRecallOk: null,
						topicNote: null,
						blockedDetail: [],
					}),
				);
			if (url.startsWith("/api/app/memory/documents"))
				return Promise.resolve(jsonResponse({ items: [], total: 0, limit: 20, offset: 0 }));
			if (url === "/api/app/programs") return Promise.resolve(jsonResponse({ programs: [] }));
			if (url === "/api/app/delegations") return Promise.resolve(jsonResponse({ delegations: [] }));
			if (url === "/api/app/status")
				return Promise.resolve(
					jsonResponse({
						version: "test",
						startedAt: "2026-10-10T00:00:00Z",
						uptimeSec: 1,
						restartHints: [],
						memory: { state: "disabled", detail: "" },
						programs: null,
						delegations: null,
					}),
				);
			// The composers' config loads and anything else.
			return Promise.resolve(
				jsonResponse({
					model: "fixture/model",
					thinking: "off",
					favorites: [],
					thinkingLevels: ["off"],
				}),
			);
		}) as typeof fetch;
	});

	afterEach(async () => {
		await act(async () => {
			for (const g of pendingGates) g.resolve();
		});
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

	const hold = () => {
		const g = Promise.withResolvers<void>();
		pendingGates.push(g);
		return g;
	};
	const settle = async () => {
		await act(async () => {
			await new Promise((r) => setTimeout(r, 30));
		});
	};
	const waitFor = async (pred: () => boolean, label: string) => {
		for (let i = 0; i < 100; i++) {
			if (pred()) return;
			await settle();
		}
		throw new Error(`timed out waiting for ${label}`);
	};
	const mount = async () => {
		root = createRoot(container);
		await act(async () => {
			root?.render(<App />);
		});
		await settle();
	};
	const click = async (el: Element | null | undefined) => {
		expect(el).toBeTruthy();
		await act(async () => {
			el?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event);
		});
		await settle();
	};
	const typeInto = async (el: Element, value: string, proto: object) => {
		await act(async () => {
			// Focus + keyup too — React's text-input fallback needs it in
			// this environment (the create-dialog test's ruling).
			(el as HTMLElement).focus();
			Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
			el.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
			el.dispatchEvent(
				new win.KeyboardEvent("keyup", { bubbles: true, key: "e" }) as unknown as Event,
			);
		});
		await settle();
	};
	const openPage = async (label: string) =>
		click([...container.querySelectorAll(".rail-ops button")].find((b) => b.textContent === label));

	const submitNewProject = async (name: string) => {
		await click(
			[...container.querySelectorAll(".rail-projects button")].find(
				(b) => b.textContent === "New project",
			),
		);
		const sheet = container.querySelector(".msheet form")!;
		expect(sheet).not.toBeNull();
		await typeInto(sheet.querySelector("input")!, name, win.HTMLInputElement.prototype);
		await act(async () => {
			sheet.dispatchEvent(
				new win.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
			);
		});
		await settle();
	};

	test("a dismissed create dialog's held reply can't navigate or ask — the draft stays", async () => {
		await mount();
		const gate = hold();
		projCreateHold = gate.promise;
		await submitNewProject("Side Hustle");
		expect(posts.some((p) => p.url === "/api/app/projects")).toBe(true);

		// Dismiss mid-flight, then open Settings and dirty the editor —
		// publicUrl is serialized dirty without needing a save POST.
		await click(container.querySelector('.msheet-head button[aria-label="Close"]'));
		expect(container.querySelector(".msheet")).toBeNull();
		await openPage("Settings");
		await waitFor(() => container.querySelector(".settings") !== null, "settings page");
		await click(
			[...container.querySelectorAll("button.idx")].find((b) => b.textContent?.includes("Access")),
		);
		const field = [...container.querySelectorAll(".frow")].find(
			(r) => r.querySelector(".flabel")?.textContent === "Public url",
		)!;
		await typeInto(
			field.querySelector("input")!,
			"https://x.example.test",
			win.HTMLInputElement.prototype,
		);
		await waitFor(() => container.textContent?.includes("unsaved") === true, "dirty marker");

		const confirmsBefore = confirmCalls;
		gate.resolve();
		await settle();
		// The late success never ran onCreated: Settings stays mounted,
		// the draft survives, and the guard was never even asked.
		expect(win.location.pathname).toBe("/app/settings");
		expect(container.querySelector(".settings")).not.toBeNull();
		expect(container.textContent).toContain("unsaved");
		expect(confirmCalls).toBe(confirmsBefore);
		expect(projs.some((p) => p.id === "p-new")).toBe(true);
	});

	test("a live dialog's create still refreshes and lands on the new project", async () => {
		await mount();
		const gate = hold();
		projCreateHold = gate.promise;
		await submitNewProject("Side Hustle");
		gate.resolve();
		await settle();
		expect(win.location.pathname).toBe("/app/p/p-new");
		expect(container.querySelector(".msheet")).toBeNull();
		await waitFor(
			() => container.querySelector("main")!.textContent?.includes("Side Hustle") === true,
			"the new project's page",
		);
	});

	test("a held note create from a project page can't navigate after leaving", async () => {
		projs = [projRow("Goblin")];
		win.history.replaceState(null, "", "/app/p/p-goblin");
		await mount();
		expect(win.location.pathname).toBe("/app/p/p-goblin");
		await waitFor(
			() => [...container.querySelectorAll("button")].some((b) => b.textContent === "New note"),
			"the project notes section",
		);

		const gate = hold();
		noteCreateHold = gate.promise;
		await click(
			[...container.querySelectorAll("button")].find((b) => b.textContent === "New note"),
		);
		expect(posts.some((p) => p.url === "/api/app/notes")).toBe(true);

		// The operator moves on while the mint is in flight — the
		// ProjectNotes component unmounts with the page.
		await openPage("Memories");
		expect(win.location.pathname).toBe("/app/memory");
		gate.resolve();
		await settle();
		expect(win.location.pathname).toBe("/app/memory");
		expect(container.querySelector(".note-title")).toBeNull();
		expect(notes.some((n) => n.id === "n-new")).toBe(true);
	});

	test("a held Notes-index create cannot interrupt dirty Settings after leaving", async () => {
		win.history.replaceState(null, "", "/app/notes");
		await mount();
		await waitFor(() => container.querySelector(".note-filters") !== null, "notes index");
		const gate = hold();
		noteCreateHold = gate.promise;
		await click(
			[...container.querySelectorAll("button")].find((b) => b.textContent === "New note"),
		);
		expect(posts.filter((p) => p.url === "/api/app/notes")).toHaveLength(1);
		await openPage("Settings");
		await waitFor(() => container.querySelector(".settings") !== null, "settings page");
		await click(
			[...container.querySelectorAll("button.idx")].find((b) => b.textContent?.includes("Access")),
		);
		const field = [...container.querySelectorAll(".frow")].find(
			(r) => r.querySelector(".flabel")?.textContent === "Public url",
		)!;
		await typeInto(
			field.querySelector("input")!,
			"https://x.example.test",
			win.HTMLInputElement.prototype,
		);
		await waitFor(() => container.textContent?.includes("unsaved") === true, "dirty marker");

		const confirmsBefore = confirmCalls;
		gate.resolve();
		await settle();
		expect(win.location.pathname).toBe("/app/settings");
		expect(container.querySelector(".settings")).not.toBeNull();
		expect(container.textContent).toContain("unsaved");
		expect(confirmCalls).toBe(confirmsBefore);
		expect(notes.some((n) => n.id === "n-new")).toBe(true);
	});

	test("a live Notes-index create opens the new note", async () => {
		win.history.replaceState(null, "", "/app/notes");
		await mount();
		await waitFor(() => container.querySelector(".note-filters") !== null, "notes index");
		const gate = hold();
		noteCreateHold = gate.promise;
		await click(
			[...container.querySelectorAll("button")].find((b) => b.textContent === "New note"),
		);
		gate.resolve();
		await settle();
		expect(win.location.pathname).toBe("/app/n/n-new");
		await waitFor(() => container.querySelector(".note-title") !== null, "new note");
	});

	test("a cancelled project start restores only its origin, preserves the destination draft, and removes its row", async () => {
		projs = [projRow("Alpha"), projRow("Beta")];
		win.history.replaceState(null, "", "/app/p/p-alpha");
		await mount();
		const gate = hold();
		convCreateHold = gate.promise;
		const composer = () => container.querySelector<HTMLTextAreaElement>(".composer textarea")!;
		await typeInto(composer(), "Alpha message", win.HTMLTextAreaElement.prototype);
		await act(async () => {
			composer().dispatchEvent(
				new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event,
			);
		});
		await settle();
		await click(
			[...container.querySelectorAll(".rail-projects .proj")].find((b) => b.textContent === "Beta"),
		);
		await typeInto(composer(), "Beta draft", win.HTMLTextAreaElement.prototype);
		gate.resolve();
		await settle();
		expect(composer().value).toBe("Beta draft");
		expect(deletedConversations).toEqual(["/api/app/conversations/minted"]);
		await click(
			[...container.querySelectorAll(".rail-projects .proj")].find(
				(b) => b.textContent === "Alpha",
			),
		);
		expect(composer().value).toBe("Alpha message");
	});

	test("restoration preserves edits typed in the originating composer after its send", async () => {
		projs = [projRow("Alpha"), projRow("Beta")];
		win.history.replaceState(null, "", "/app/p/p-alpha");
		await mount();
		const gate = hold();
		convCreateHold = gate.promise;
		const composer = () => container.querySelector<HTMLTextAreaElement>(".composer textarea")!;
		await typeInto(composer(), "sent message", win.HTMLTextAreaElement.prototype);
		await act(async () => {
			composer().dispatchEvent(
				new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event,
			);
		});
		await click(
			[...container.querySelectorAll(".rail-projects .proj")].find((b) => b.textContent === "Beta"),
		);
		await click(
			[...container.querySelectorAll(".rail-projects .proj")].find(
				(b) => b.textContent === "Alpha",
			),
		);
		await typeInto(composer(), "newer draft", win.HTMLTextAreaElement.prototype);
		gate.resolve();
		await settle();
		expect(composer().value).toBe("newer draft");
	});

	test("a fenced note chat removes its row without staging the note in a composer", async () => {
		notes = [noteRow("Shopping")];
		win.history.replaceState(null, "", "/app/n/n-shopping");
		await mount();
		await waitFor(() => container.querySelector(".ProseMirror") !== null, "note editor");
		const gate = hold();
		convCreateHold = gate.promise;
		await click(
			[...container.querySelectorAll("button")].find(
				(b) => b.textContent === "Chat with this note",
			),
		);
		await click(container.querySelector("button.new"));
		gate.resolve();
		await settle();
		expect(deletedConversations).toEqual(["/api/app/conversations/minted"]);
		expect(container.querySelector(".composer")!.textContent).not.toContain("Shopping");
	});

	test("a second chat start while the mint is held mints once — the first id wins", async () => {
		notes = [noteRow("Shopping")];
		noteBodies = { "n-shopping": "milk" };
		win.history.replaceState(null, "", "/app/n/n-shopping");
		await mount();
		await waitFor(() => container.querySelector(".ProseMirror") !== null, "the note editor");
		const chatButton = () =>
			[...container.querySelectorAll(".note-flags button")].find(
				(b) => b.textContent === "Chat with this note",
			) as HTMLButtonElement;

		const gate = hold();
		convCreateHold = gate.promise;
		await click(chatButton());
		expect(posts.filter((p) => p.url === "/api/app/conversations")).toHaveLength(1);
		expect(chatButton().disabled).toBe(true);
		await click(chatButton());
		expect(posts.filter((p) => p.url === "/api/app/conversations")).toHaveLength(1);
		expect(chatButton().disabled).toBe(true);

		gate.resolve();
		await settle();
		expect(win.location.pathname).toBe("/app/c/minted");
	});

	test("a note chat click during a fenced start's held cleanup fails loud, then succeeds once free", async () => {
		notes = [noteRow("Shopping")];
		noteBodies = { "n-shopping": "milk" };
		await mount();
		const gate = hold();
		convCreateHold = gate.promise;
		const composer = () => container.querySelector<HTMLTextAreaElement>(".composer textarea")!;
		await typeInto(composer(), "hi", win.HTMLTextAreaElement.prototype);
		await act(async () => {
			composer().dispatchEvent(
				new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event,
			);
		});
		await settle();
		expect(posts.filter((p) => p.url === "/api/app/conversations")).toHaveLength(1);

		// The operator moves to a note while the mint is held — the
		// navigation fences the start's continuation, whose cleanup
		// (delete the unselected row, refresh) still holds the start
		// lane busy.
		await click(
			[...container.querySelectorAll(".rail-projects button")].find(
				(b) => b.textContent === "Notes",
			),
		);
		// The index debounces its fetch — wait for the row, not the chrome.
		await waitFor(
			() =>
				[...container.querySelectorAll("button.idx")].some((b) =>
					b.textContent?.includes("Shopping"),
				),
			"the notes index row",
		);
		await click(
			[...container.querySelectorAll("button.idx")].find((b) =>
				b.textContent?.includes("Shopping"),
			),
		);
		await waitFor(() => container.querySelector(".ProseMirror") !== null, "the note editor");

		// Hold the cleanup's delete so the busy window stays open.
		const delGate = hold();
		convDeleteHold = delGate.promise;
		gate.resolve();
		await settle();
		expect(deletedConversations).toEqual(["/api/app/conversations/minted"]);

		const chatButton = () =>
			[...container.querySelectorAll(".note-flags button")].find(
				(b) => b.textContent === "Chat with this note",
			) as HTMLButtonElement;
		await click(chatButton());
		// The busy start refused loudly — a named error, and no second
		// mint slipped through.
		expect(posts.filter((p) => p.url === "/api/app/conversations")).toHaveLength(1);
		expect(container.querySelector('p.error[role="alert"]')?.textContent).toContain(
			"still starting",
		);

		delGate.resolve();
		await settle();
		await click(chatButton());
		await waitFor(() => win.location.pathname === "/app/c/minted", "the chat opens");
		expect(posts.filter((p) => p.url === "/api/app/conversations")).toHaveLength(2);
	});
});

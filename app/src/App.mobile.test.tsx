// Mobile (M): phone widths retire the drawer — /app is the chats screen,
// a thread, the staged composer, or a project page stands it down, and
// the thumb bar owns navigation with the More sheet carrying the system
// surfaces. The matchMedia stub is what makes this realm a phone;
// everything else rides the same fetch-at-the-edge fakes as App.test.tsx.
import { describe, beforeEach, afterEach, test, expect } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import {
	authDefaults,
	parseConfig,
	transcriptionDefaults,
	transcriptionKinds,
} from "../../src/config.ts";
import type { AppConversationList, AppProject } from "../../src/http/app-wire.ts";
import { App } from "./App.tsx";

const json = (body: unknown, status = 200) =>
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

const projRow = (name: string): AppProject => ({
	id: `p-${name.split(" ")[0]!.toLowerCase()}`,
	name,
	slug: name.toLowerCase().replaceAll(" ", "-"),
	dir: `/tmp/${name}`,
	managed: true,
	instructions: "",
	memory: "shared",
	createdAt: "2026-10-08T00:00:00.000Z",
	archivedAt: null,
});

describe("mobile (M): thumb bar, chats screen, staged composer", () => {
	let win: Window;
	let container: HTMLElement;
	let root: Root | null = null;
	let installed: string[] = [];
	let phone: boolean;
	let conversations: AppConversationList["conversations"];
	let projects: AppProject[];
	let settings: typeof SETTINGS;
	let confirmAnswer = false;
	let confirmCalls = 0;
	let confirmMessages: string[] = [];
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
		phone = true;
		projects = [];
		settings = SETTINGS;
		confirmAnswer = false;
		confirmCalls = 0;
		confirmMessages = [];
		conversations = [
			{
				id: "app/fixture",
				title: "fixture chat",
				preview: "fixture",
				createdAt: "2026-10-23T00:00:00Z",
				updatedAt: "2026-10-23T00:00:00Z",
				archivedAt: null,
				pinnedAt: "2026-10-23T00:00:00Z",
				projectId: null,
			},
			{
				id: "app/second",
				title: "second chat",
				preview: "second",
				createdAt: "2026-10-22T00:00:00Z",
				updatedAt: "2026-10-22T00:00:00Z",
				archivedAt: null,
				pinnedAt: null,
				projectId: null,
			},
		];
		installGlobal("window", win);
		installGlobal("document", win.document);
		installGlobal("navigator", win.navigator);
		installGlobal("localStorage", win.localStorage);
		installGlobal("sessionStorage", win.sessionStorage);
		installGlobal("Event", win.Event);
		installGlobal("CustomEvent", win.CustomEvent);
		installGlobal("getComputedStyle", win.getComputedStyle);
		installGlobal("requestAnimationFrame", win.requestAnimationFrame.bind(win));
		Reflect.set(win, "confirm", (message: string) => {
			confirmCalls += 1;
			confirmMessages.push(message);
			return confirmAnswer;
		});
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
		// The realm's width: the stub is what puts the realm on a phone.
		Reflect.set(win, "matchMedia", (query: string) => ({
			matches: phone && query.includes("max-width: 720"),
			media: query,
			addEventListener() {},
			removeEventListener() {},
		}));
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === "/api/app/conversations" && init?.method === "POST")
				return Promise.resolve(
					json({ id: "app/created", title: null, createdAt: "2026-10-10T00:00:00Z" }),
				);
			if (url === "/api/app/conversations") return Promise.resolve(json({ conversations }));
			if (url === "/api/app/projects") return Promise.resolve(json({ projects }));
			if (url.startsWith("/api/app/notes"))
				return Promise.resolve(json({ notes: [] }));
			if (url === "/api/app/settings")
				return Promise.resolve(
					new Response(
						JSON.stringify({
							config: settings,
							providerKinds: ["openai-compatible", "responses", "openrouter", "codex"],
							searchKinds: ["ddg", "brave", "jina"],
							fetchKinds: ["local", "firecrawl", "jina"],
							transcriptionKinds,
							transcriptionDefaults,
							authDefaults,
							authNames: ["main", "groq"],
							modelCatalog: [],
						}),
						{ headers: { "content-type": "application/json", etag: '"v1"' } },
					),
				);
			if (url === "/api/app/conversations/fixture/messages")
				return Promise.resolve(json({ messages: [], ratings: [], rateableMessageIds: [] }));
			if (url === "/api/app/conversations/fixture/stream")
				return Promise.resolve(new Response(null, { status: 204 }));
			if (url === "/api/app/conversations/fixture/window")
				return Promise.resolve(
					json({
						model: "main/test",
						capturedAt: "2026-10-22T10:00:00.000Z",
						capturedModel: "main/test",
						steps: 1,
						segments: { identity: 10, environment: 0, project: 0, agentsMd: 0, userMd: 0, skills: 0, toolDefs: 0, history: 20, toolResults: 0, system: "x", messages: 0 },
						system: "You are goblin.",
						tools: [],
						messages: [],
						calls: [],
					}),
				);
			if (url === "/api/app/status")
				return Promise.resolve(
					json({
						version: "test",
						startedAt: "2026-10-10T00:00:00Z",
						uptimeSec: 1,
						restartHints: [],
						memory: { state: "disabled", detail: "" },
						programs: null,
						delegations: null,
					}),
				);
			return Promise.resolve(
				json({
					model: "main/test",
					thinking: "medium",
					favorites: [],
					catalog: [],
					thinkingLevels: ["off"],
				}),
			);
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
	const waitFor = async (pred: () => boolean, label: string) => {
		for (let i = 0; i < 100; i++) {
			if (pred()) return;
			await settle();
		}
		throw new Error(`timed out waiting for ${label}`);
	};
	const click = async (el: Element | null | undefined) => {
		expect(el).toBeTruthy();
		await act(async () => {
			el?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event);
		});
		await settle();
	};
	const mount = async () => {
		root = createRoot(container);
		await act(async () => {
			root?.render(<App />);
		});
		await waitFor(() => container.querySelector(".chatlist-screen") !== null, "chats screen");
	};
	const tab = (label: string) =>
		[...container.querySelectorAll<HTMLElement>(".tabbar .tab")].find(
			(b) => b.textContent?.trim() === label,
		);

	test("phone: /app is the chats screen under a five-slot thumb bar", async () => {
		await mount();

		const rows = [...container.querySelectorAll(".chatlist-screen .conv-title")].map(
			(el) => el.textContent,
		);
		expect(rows).toEqual(["fixture chat", "second chat"]);
		expect(container.querySelectorAll(".tabbar .tab").length).toBe(5);
		expect(tab("Chats")?.getAttribute("aria-current")).toBe("page");
		// The list screen replaces the composer as the chat surface — the
		// empty-state composer is not in this screen.
		expect(container.querySelector(".chatlist-screen .composer")).toBeNull();
	});

	test("phone: opening a conversation stands the bar down; back returns to the list", async () => {
		await mount();

		await click(
			[...container.querySelectorAll(".chatlist-screen .conv")].find(
				(r) => r.querySelector(".conv-title")?.textContent === "fixture chat",
			)?.querySelector(".conv-main"),
		);
		await waitFor(
			() => container.querySelector(".tabbar") === null,
			"thumb bar to stand down in a thread",
		);
		expect(container.querySelector(".mobile-back")).toBeTruthy();

		await click(container.querySelector(".mobile-back"));
		await waitFor(
			() => container.querySelector(".chatlist-screen") !== null,
			"chats screen to return",
		);
		expect(container.querySelector(".tabbar")).toBeTruthy();
	});

	test("phone: More opens the system sheet; a row lands on its page", async () => {
		await mount();

		await click(tab("More"));
		const sheet = container.querySelector('.msheet[aria-label="System"]');
		expect(sheet).toBeTruthy();
		const rows = [...sheet?.querySelectorAll(".sheet-row") ?? []].map((b) => b.textContent);
		expect(rows).toEqual([
			"Delegations",
			"Memories",
			"Programs",
			"Skills",
			"Files",
			"Status",
			"Log",
			"Settings",
		]);

		await click([...sheet?.querySelectorAll(".sheet-row") ?? []].find((b) => b.textContent === "Status"));
		expect(container.querySelector(".msheet")).toBeNull();
		await waitFor(
			() => container.querySelector(".status-page") !== null || container.textContent?.includes("Status") === true,
			"status page",
		);
		expect(tab("More")?.classList.contains("on")).toBe(true);
	});

	test("phone: + stages the composer; back returns to the list", async () => {
		await mount();

		await click(container.querySelector('.chatlist-bar [aria-label="New conversation"]'));
		await waitFor(
			() => container.querySelector(".tabbar") === null,
			"thumb bar to stand down for the composer",
		);
		expect(container.querySelector(".mobile-back")).toBeTruthy();
		expect(container.querySelector(".chat .composer")).toBeTruthy();

		await click(container.querySelector(".mobile-back"));
		await waitFor(
			() => container.querySelector(".chatlist-screen") !== null,
			"chats screen to return",
		);
	});

	test("phone: a project page stands the bar down; back returns to the projects index", async () => {
		projects = [projRow("Goblin Work")];
		await mount();

		await click(tab("Projects"));
		await waitFor(
			() =>
					[...container.querySelectorAll("button.idx")].some((b) =>
						b.textContent?.includes("Goblin Work"),
					),
			"projects index",
		);
		await click(
				[...container.querySelectorAll("button.idx")].find((b) =>
					b.textContent?.includes("Goblin Work"),
				),
		);
		await waitFor(
			() => container.querySelector(".tabbar") === null,
			"thumb bar to stand down on a project page",
		);
		// The project composer owns the bottom edge — the fixed bar must
		// not paint over it, and a back door must exist or the operator is
		// stranded with no bar and no other navigation.
		expect(container.querySelector(".chat form.composer")).toBeTruthy();
		const back = container.querySelector(".mobile-back");
		expect(back?.getAttribute("aria-label")).toBe("Back to projects");

		await click(back);
		await waitFor(
			() => container.querySelector(".tabbar") !== null,
			"thumb bar to return with the projects index",
		);
		expect(win.location.pathname).toBe("/app/projects");
	});

	test("phone: the Chats tab asks once about a dirty settings editor", async () => {
		await mount();

		await click(tab("More"));
		await click(
				[...container.querySelectorAll(".sheet-row")].find(
					(b) => b.textContent === "Settings",
				),
		);
		await waitFor(
			() => container.querySelector(".settings") !== null,
			"settings page",
		);
		await click(
				[...container.querySelectorAll("button.idx")].find((b) =>
					b.textContent?.includes("Access"),
			),
		);
		// An invalid edit — dropping the only operator — can never
		// autosave, so the editor stays dirty: exactly the state the
		// navigation guard must question.
		await click(container.querySelector(".chip button"));
		await waitFor(
			() => container.textContent?.includes("unsaved") === true,
			"dirty editor",
		);

		confirmAnswer = true;
		await click(tab("Chats"));
		// One question, one answer — a second confirm declining here
		// would silently cancel a navigation just approved.
		expect(confirmCalls).toBe(1);
		expect(confirmMessages).toEqual(["Discard unsaved settings changes?"]);
		await waitFor(
			() => container.querySelector(".chatlist-screen") !== null,
			"chats screen to return",
		);
	});

	test("desktop: none of the M chrome exists", async () => {
		phone = false;
		root = createRoot(container);
		await act(async () => {
			root?.render(<App />);
		});
		await waitFor(
			() => container.querySelector(".chat .composer") !== null,
			"desktop empty-state composer",
		);
		expect(container.querySelector(".tabbar")).toBeNull();
		expect(container.querySelector(".chatlist-screen")).toBeNull();
		expect(container.querySelector(".mobile-back")).toBeNull();
	});
});

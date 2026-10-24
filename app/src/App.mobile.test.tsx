// Mobile (M): phone widths retire the drawer — /app is the chats screen,
// a thread or the staged composer stands it down, and the thumb bar owns
// navigation with the More sheet carrying the system surfaces. The matchMedia
// stub is what makes this realm a phone; everything else rides the same
// fetch-at-the-edge fakes as App.test.tsx.
import { describe, beforeEach, afterEach, test, expect } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { AppConversationList } from "../../src/http/app-wire.ts";
import { App } from "./App.tsx";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("mobile (M): thumb bar, chats screen, staged composer", () => {
	let win: Window;
	let container: HTMLElement;
	let root: Root | null = null;
	let installed: string[] = [];
	let phone: boolean;
	let conversations: AppConversationList["conversations"];
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
			if (url === "/api/app/projects") return Promise.resolve(json({ projects: [] }));
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

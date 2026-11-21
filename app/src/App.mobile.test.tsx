// Mobile (M): phone widths retire the drawer — /app is the chats screen,
// a thread, the staged composer, or a project page stands it down, and
// the thumb bar owns navigation with the More sheet carrying the system
// surfaces. The matchMedia stub is what makes this realm a phone;
// everything else rides the same fetch-at-the-edge fakes as App.test.tsx.
import { describe, beforeEach, afterEach, test, expect } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { parseConfig } from "../../src/config.ts";
import {
	authDefaults,
	transcriptionDefaults,
	transcriptionKinds,
} from "../../src/config-schema.ts";
import type { AppConversationList, AppMessageList, AppProject } from "../../src/http/app-wire.ts";
import { App } from "./App.tsx";
import { clickConfirm, confirmSheet, confirmText } from "./testkit.ts";

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
	let patches: { id: string; body: Record<string, unknown> }[];
	let threadMessages: AppMessageList["messages"];
	let settings: typeof SETTINGS;
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
		patches = [];
		threadMessages = [];
		settings = SETTINGS;
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
				parentId: null,
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
				parentId: null,
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
		installGlobal("HTMLElement", win.HTMLElement);
		installGlobal("HTMLFieldSetElement", win.HTMLFieldSetElement);
		installGlobal("HTMLInputElement", win.HTMLInputElement);
		installGlobal("HTMLTextAreaElement", win.HTMLTextAreaElement);
		installGlobal("Element", win.Element);
		installGlobal("ShadowRoot", win.ShadowRoot);
		installGlobal("MutationObserver", win.MutationObserver);
		installGlobal("ResizeObserver", win.ResizeObserver);
		installGlobal("NodeFilter", (win as unknown as { NodeFilter: unknown }).NodeFilter);
		installGlobal("requestAnimationFrame", win.requestAnimationFrame.bind(win));
		installGlobal("cancelAnimationFrame", win.cancelAnimationFrame.bind(win));
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
			const method = init?.method ?? (input instanceof Request ? input.method : "GET");
			const patchMatch = /^\/api\/app\/conversations\/([^/]+)$/.exec(url);
			if (patchMatch !== null && method === "PATCH") {
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				patches.push({ id: patchMatch[1]!, body });
				const conversation = conversations.find((item) => item.id === `app/${patchMatch[1]}`);
				if (conversation !== undefined) {
					if (body.archived === true) conversation.archivedAt = "2026-10-24T00:00:00Z";
					if (body.archived === false) conversation.archivedAt = null;
					if (body.pinned === true) conversation.pinnedAt = "2026-10-24T00:00:00Z";
					if (body.pinned === false) conversation.pinnedAt = null;
					if (typeof body.title === "string") conversation.title = body.title;
				}
				return Promise.resolve(json(body));
			}
			if (url === "/api/app/conversations" && init?.method === "POST")
				return Promise.resolve(
					json({ id: "app/created", title: null, createdAt: "2026-10-10T00:00:00Z" }),
				);
			if (url === "/api/app/conversations") return Promise.resolve(json({ conversations }));
			if (url === "/api/app/projects") return Promise.resolve(json({ projects }));
			if (url === "/api/app/notes")
				return Promise.resolve(json({ notes: [], truncated: false }));
			if (url === "/api/app/attention")
				return Promise.resolve(json({ items: [], unavailable: [] }));
			if (url.startsWith("/api/app/notes")) return Promise.resolve(json({ notes: [] }));
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
				return Promise.resolve(
					json({ messages: threadMessages, ratings: [], rateableMessageIds: [] }),
				);
			if (url === "/api/app/conversations/fixture/stream")
				return Promise.resolve(new Response(null, { status: 204 }));
			if (url === "/api/app/conversations/fixture/window")
				return Promise.resolve(
					json({
						model: "main/test",
						capturedAt: "2026-10-22T10:00:00.000Z",
						capturedModel: "main/test",
						steps: 1,
						segments: {
							identity: 10,
							environment: 0,
							project: 0,
							agentsMd: 0,
							userMd: 0,
							skills: 0,
							toolDefs: 0,
							history: 20,
							toolResults: 0,
							system: "x",
							messages: 0,
						},
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
			el?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event);
		});
		await settle();
	};
	const pointer = async (
		el: Element,
		type: "pointerdown" | "pointerup",
		pointerType: "touch" | "mouse",
	) => {
		const event = new win.Event(type, { bubbles: true, cancelable: true });
		for (const [key, value] of Object.entries({
			pointerId: 1,
			pointerType,
			button: 0,
			isPrimary: true,
			clientX: 10,
			clientY: 10,
		}))
			Object.defineProperty(event, key, { value });
		await act(async () => {
			el.dispatchEvent(event as unknown as globalThis.Event);
		});
	};
	const hold = async (el: Element, pointerType: "touch" | "mouse") => {
		await pointer(el, "pointerdown", pointerType);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 600));
		});
		await pointer(win.document as unknown as Element, "pointerup", pointerType);
		await settle();
	};
	const typeInto = async (el: HTMLInputElement, value: string) => {
		await act(async () => {
			el.focus();
			Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(el, value);
			el.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as globalThis.Event);
			el.dispatchEvent(
				new win.KeyboardEvent("keyup", { bubbles: true, key: "e" }) as unknown as globalThis.Event,
			);
		});
		await settle();
	};
	// The leave ask is a sheet in the app chrome — answering is a click
	// on its buttons, like the operator.
	const answerConfirm = async (ok: boolean) => {
		await act(async () => {
			clickConfirm(container, ok);
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

	test("touch hold opens row actions without opening the chat; mouse hold does not", async () => {
		await mount();
		const link = container.querySelector('.chatlist-screen .conv-main[href="/app/c/fixture"]');
		expect(link).toBeTruthy();
		await hold(link!, "touch");
		const dialog = container.querySelector('[role="dialog"]');
		const titleId = dialog?.getAttribute("aria-labelledby");
		expect(titleId).toBeTruthy();
		expect(win.document.getElementById(titleId!)?.textContent).toBe("fixture chat");
		expect(dialog?.textContent).toContain("fixture chat");
		expect(dialog?.textContent).toContain("Unpin");
		expect(dialog?.textContent).toContain("Rename");
		expect(dialog?.textContent).toContain("Archive");
		expect(win.location.pathname).toBe("/app/");
		await click(dialog?.querySelector(".row-sheet-action"));
		expect(win.location.pathname).toBe("/app/");

		await hold(
			container.querySelector('.chatlist-screen .conv-main[href="/app/c/fixture"]')!,
			"mouse",
		);
		expect(container.querySelector(".row-sheet")).toBeNull();
	});

	test("a row can open its action sheet again after Rename remounts its link", async () => {
		await mount();
		const link = container.querySelector('.chatlist-screen .conv-main[href="/app/c/second"]')!;
		await hold(link, "touch");
		await click(
			[...container.querySelectorAll(".row-sheet-action")].find((button) =>
				button.textContent?.includes("Rename"),
			),
		);
		const editor = container.querySelector<HTMLInputElement>(".conv.editing input");
		await typeInto(editor!, "renamed twice");
		await act(async () => {
			editor?.dispatchEvent(
				new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as globalThis.Event,
			);
		});
		await waitFor(
			() => patches.some((patch) => patch.body.title === "renamed twice"),
			"rename PATCH",
		);
		await waitFor(
			() =>
				container.querySelector('.chatlist-screen .conv-main[href="/app/c/second"] .conv-title')
					?.textContent === "renamed twice",
			"renamed row link",
		);
		const renamedLink = container.querySelector('.chatlist-screen .conv-main[href="/app/c/second"]');
		expect(renamedLink).toBeTruthy();
		await hold(renamedLink!, "touch");
		expect(container.querySelector('[role="dialog"]')).toBeTruthy();
	}, 15_000);

	test("the row sheet archives, pins, renames, and offers archived actions", async () => {
		projects = [projRow("Goblin Work")];
		await mount();
		await hold(
			container.querySelector('.chatlist-screen .conv-main[href="/app/c/second"]')!,
			"touch",
		);
		await click(
			[...container.querySelectorAll(".row-sheet-action")].find((button) =>
				button.textContent?.includes("Pin"),
			),
		);
		expect(patches).toContainEqual({ id: "second", body: { pinned: true } });
		await hold(
			container.querySelector('.chatlist-screen .conv-main[href="/app/c/second"]')!,
			"touch",
		);
		await click(
			[...container.querySelectorAll(".row-sheet-action")].find((button) =>
				button.textContent?.includes("Rename"),
			),
		);
		const rename = container.querySelector<HTMLInputElement>(".conv.editing input");
		expect(rename?.value).toBe("second chat");
		await typeInto(rename!, "renamed second");
		expect(rename?.value).toBe("renamed second");
		await act(async () => {
			rename?.dispatchEvent(
				new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as globalThis.Event,
			);
		});
		expect(patches).toContainEqual({ id: "second", body: { title: "renamed second" } });

		const link = container.querySelector('.chatlist-screen .conv-main[href="/app/c/fixture"]')!;
		await hold(link, "touch");
		await click(
			[...container.querySelectorAll(".row-sheet-action")].find((button) =>
				button.textContent?.includes("Archive"),
			),
		);
		await waitFor(() => patches.some((patch) => patch.body.archived === true), "archive PATCH");
		expect(patches).toContainEqual({ id: "fixture", body: { archived: true } });
		expect(container.querySelector(".undo-toast")?.textContent).toContain('Archived "fixture chat"');

	}, 15_000);

	test("an archived project chat offers rename, unarchive, and delete on hold", async () => {
		projects = [projRow("Goblin Work")];
		conversations[0]!.archivedAt = "2026-10-24T00:00:00Z";
		conversations[0]!.projectId = "p-goblin";
		await mount();
		await click(tab("Projects"));
		await waitFor(
			() => container.querySelector(".ops .ops-h2")?.textContent === "Projects",
			"projects index",
		);
		await click(
			[...container.querySelectorAll("button.dt-row")].find((button) =>
				button.textContent?.includes("Goblin Work"),
			),
		);
		await waitFor(() => container.querySelector(".ops.projfields") !== null, "project page");
		await click(container.querySelector(".ops.projfields details summary"));
		const archived = container.querySelector(".ops.projfields details .conv-main");
		expect(archived).toBeTruthy();
		await hold(archived!, "touch");
		expect([...container.querySelectorAll(".row-sheet-action")].map((item) => item.textContent)).toEqual([
			"Rename",
			"Unarchive",
			"Delete",
		]);
	});

	test("phone: New project uses the folder-plus glyph, not the new-chat plus", async () => {
		await mount();
		const newProject = container.querySelector('.chatlist-bar [aria-label="New project"]');
		expect(newProject?.querySelector('svg path[d^="M3 7"]')).not.toBeNull();
	});

	test("phone: opening a conversation stands the bar down; back returns to the list", async () => {
		await mount();

		await click(
			[...container.querySelectorAll(".chatlist-screen .conv")]
				.find((r) => r.querySelector(".conv-title")?.textContent === "fixture chat")
				?.querySelector(".conv-main"),
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

	test("phone: the outline rail never enters a thread's DOM", async () => {
		threadMessages = [
			{ id: "m1", role: "user", parts: [{ type: "text", text: "section one" }] },
			{ id: "m2", role: "assistant", parts: [{ type: "text", text: "answer" }] },
		];
		await mount();

		await click(
			[...container.querySelectorAll(".chatlist-screen .conv")]
				.find((r) => r.querySelector(".conv-title")?.textContent === "fixture chat")
				?.querySelector(".conv-main"),
		);
		await waitFor(
			() => container.querySelector("[data-outline-anchor]") !== null,
			"thread section to render",
		);
		// The thread has a section to outline, but the rail is a hover
		// affordance — on a phone it must not exist in the DOM at all,
		// not even hidden.
		expect(container.querySelector(".outline")).toBeNull();
	});

	test("phone: More opens the system sheet; a row lands on its page", async () => {
		await mount();

		await click(tab("More"));
		const sheet = container.querySelector('.msheet[aria-label="System"]');
		expect(sheet).toBeTruthy();
		const rows = [...(sheet?.querySelectorAll(".sheet-row") ?? [])].map((b) => b.textContent);
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

		await click(
			[...(sheet?.querySelectorAll(".sheet-row") ?? [])].find((b) => b.textContent === "Status"),
		);
		expect(container.querySelector(".msheet")).toBeNull();
		await waitFor(
			() =>
				container.querySelector(".status-page") !== null ||
				container.textContent?.includes("Status") === true,
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
				[...container.querySelectorAll("button.dt-row")].some((b) =>
					b.textContent?.includes("Goblin Work"),
				),
			"projects index",
		);
		await click(
			[...container.querySelectorAll("button.dt-row")].find((b) =>
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
			[...container.querySelectorAll(".sheet-row")].find((b) => b.textContent === "Settings"),
		);
		await waitFor(() => container.querySelector(".settings") !== null, "settings page");
		await click(
			[...container.querySelectorAll("button.idx")].find((b) => b.textContent?.includes("Access")),
		);
		// An invalid edit — dropping the only operator — can never
		// autosave, so the editor stays dirty: exactly the state the
		// navigation guard must question.
		await click(container.querySelector(".chip button"));
		await waitFor(() => container.textContent?.includes("unsaved") === true, "dirty editor");

		await click(tab("Chats"));
		// One question, one answer — a second ask declining here would
		// silently cancel a navigation just approved.
		expect(confirmText(container)).toBe("Discard unsaved settings changes?");
		await answerConfirm(true);
		expect(confirmSheet(container)).toBeNull();
		await waitFor(
			() => container.querySelector(".chatlist-screen") !== null,
			"chats screen to return",
		);
	});

	test("desktop: none of the M chrome exists", async () => {
		phone = false;
		threadMessages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "section one" }] }];
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
		// The gate's other side: a sectioned thread in a wide realm does
		// mount the rail — what keeps it off phones is the gate, not an
		// empty transcript.
		await click(container.querySelector(".conv-main"));
		await waitFor(() => container.querySelector(".outline") !== null, "outline rail");
	});
});

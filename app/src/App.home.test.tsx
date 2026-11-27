import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AppAttentionItem, AppBot, AppConversationList } from "../../src/http/app-wire.ts";
import { App } from "./App.tsx";
import { LIST_ENTRY, emitLiveVersions, goblinFeedResponse, goblinLive } from "./testkit.ts";

type Conv = AppConversationList["conversations"][number];

const conv = (id: string, fields: Partial<Conv> = {}): Conv => ({
	id: `app/${id}`,
	title: id,
	preview: "A reply",
	createdAt: "2026-11-01T00:00:00Z",
	updatedAt: "2026-11-01T00:00:00Z",
	archivedAt: null,
	pinnedAt: null,
	projectId: null,
	parentId: null,
	newReply: null,
	busy: false,
	...fields,
});

const approval: AppAttentionItem = {
	id: "loose",
	kind: "program-approval",
	title: "Review program",
	detail: "Needs approval",
	createdAt: "2026-11-01T00:00:00Z",
	conversationId: null,
	target: { kind: "page", page: "programs" },
};

describe("home screen", () => {
	let win: Window;
	let container: HTMLElement;
	let root: Root | null;
	let installed: string[];
	let phone: boolean;
	let hidden: boolean;
	let conversations: Conv[];
	let bots: AppBot[];
	let chain: Conv[];
	let attention: AppAttentionItem[];
	let otherBusy: number;
	let listVersion: number;
	let listGets: number;
	let tokenDead: boolean;
	let messageGets: string[];
	let posts: string[];
	let reads: { id: string; body: unknown; settle: (ok: boolean) => Promise<void> }[];
	const realFetch = globalThis.fetch;

	const installGlobal = (name: string, value: unknown) => {
		Reflect.set(globalThis, name, value);
		installed.push(name);
	};

	const respond = (url: string, init?: RequestInit): Response | Promise<Response> => {
		const method = init?.method ?? "GET";
		const path = url.split("?")[0]!;
		if (method === "POST") posts.push(path);
		if (
			typeof init?.body === "string" &&
			new Headers(init.headers).get("content-type") !== "application/json"
		)
			return Response.json({ error: "expected application/json" }, { status: 415 });
		const read = /^\/api\/app\/conversations\/([^/]+)\/read$/.exec(path);
		if (read !== null && method === "POST") {
			return new Promise((resolve) => {
				reads.push({
					id: read[1]!,
					body: JSON.parse(String(init?.body)) as unknown,
					settle: (ok) =>
						act(async () => {
							resolve(
								ok
									? Response.json({ ok: true })
									: Response.json({ error: "failed" }, { status: 500 }),
							);
						}),
				});
			});
		}
		if (path === "/api/app/activity") return Response.json({ busy: [], otherBusy, posts: [] });
		if (path === "/api/app/attention")
			return Response.json({ items: attention, unavailable: [] });
		const feed = goblinFeedResponse(path);
		if (feed !== null) return feed;
		if (path === "/api/app/conversations") {
			listGets++;
			if (tokenDead) return Response.json({ error: "unauthorized" }, { status: 401 });
			return Response.json(
				{ conversations, rolling: { chain }, bots } satisfies AppConversationList,
				{ headers: { "x-goblin-version": `v${listVersion}` } },
			);
		}
		if (path === "/api/app/conversations/workshop/convert-to-bot" && method === "POST") {
			const body = JSON.parse(String(init?.body)) as { name: string };
			const bot: AppBot = {
				id: "bot-1", name: body.name, mainConversationId: "app/workshop",
				sideConversationIds: [], canMoveBack: true,
			};
			bots = [bot];
			listVersion++;
			return Response.json(bot, { status: 201 });
		}
		if (path === "/api/app/bots/bot-1/move-back" && method === "POST") {
			bots = [];
			listVersion++;
			return Response.json({ conversationId: "app/workshop" });
		}
		if (path === "/api/app/projects") return Response.json({ projects: [] });
		if (path === "/api/app/notes") return Response.json({ notes: [], truncated: false });
		if (path === "/api/app/approvals")
			return Response.json({ programs: [], mail: [], serverTimeZone: "UTC" });
		if (path === "/api/app/skills")
			return Response.json({ skills: [], proposed: [], usage: [] });
		if (path === "/api/app/settings")
			return Response.json({
				config: {},
				providerKinds: [],
				searchKinds: [],
				fetchKinds: [],
				transcriptionKinds: [],
				transcriptionDefaults: {},
				authDefaults: {},
				authNames: [],
				modelCatalog: [],
			});
		if (path === "/api/app/identity" || path === "/api/app/attachments")
			return Response.json({ files: [] });
		if (path.endsWith("/messages")) {
			messageGets.push(path.split("/").at(-2)!);
			return Response.json({
				messages: [],
				start: 0,
				olderCursor: null,
				ratings: [],
				rateableMessageIds: [],
				compactions: [],
			});
		}
		if (path.endsWith("/pending")) return Response.json({ items: [] });
		if (path.endsWith("/events"))
			return new Response(new ReadableStream(), {
				headers: { "content-type": "text/event-stream" },
			});
		if (path.endsWith("/stream")) return new Response(null, { status: 204 });
		return Response.json({ error: `unfaked ${method} ${url}` }, { status: 500 });
	};

	beforeEach(() => {
		win = new Window({ url: "http://localhost/app/" });
		const div = win.document.createElement("div");
		win.document.body.appendChild(div);
		container = div as unknown as HTMLElement;
		root = null;
		installed = [];
		phone = false;
		hidden = false;
		conversations = [];
		bots = [];
		chain = [];
		attention = [];
		otherBusy = 0;
		listVersion = 1;
		listGets = 0;
		tokenDead = false;
		messageGets = [];
		posts = [];
		reads = [];
		goblinLive.feed = null;
		for (const [name, value] of [
			["window", win],
			["document", win.document],
			["navigator", win.navigator],
			["localStorage", win.localStorage],
			["sessionStorage", win.sessionStorage],
			["Event", win.Event],
			["MouseEvent", win.MouseEvent],
			["PointerEvent", win.PointerEvent],
			["CustomEvent", win.CustomEvent],
			["getComputedStyle", win.getComputedStyle],
			["HTMLElement", win.HTMLElement],
			["HTMLButtonElement", win.HTMLButtonElement],
			["HTMLFieldSetElement", win.HTMLFieldSetElement],
			["HTMLInputElement", win.HTMLInputElement],
			["HTMLSelectElement", win.HTMLSelectElement],
			["HTMLTextAreaElement", win.HTMLTextAreaElement],
			["Element", win.Element],
			["ShadowRoot", win.ShadowRoot],
			["MutationObserver", win.MutationObserver],
			["ResizeObserver", win.ResizeObserver],
			["NodeFilter", win.NodeFilter],
			["requestAnimationFrame", win.requestAnimationFrame.bind(win)],
			["cancelAnimationFrame", win.cancelAnimationFrame.bind(win)],
		] as const) installGlobal(name, value);
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
		Reflect.set(win, "matchMedia", (query: string) => ({
			matches: phone && query.includes("max-width: 720"),
			media: query,
			addEventListener() {},
			removeEventListener() {},
		}));
		Object.defineProperty(win.document, "visibilityState", {
			configurable: true,
			get: () => (hidden ? "hidden" : "visible"),
		});
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
			respond(
				typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
				init,
			)) as typeof fetch;
	});

	afterEach(async () => {
		await act(async () => root?.unmount());
		root = null;
		globalThis.fetch = realFetch;
		for (const name of installed) Reflect.deleteProperty(globalThis, name);
		Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
		await win.happyDOM.close();
	});

	const settle = () => act(async () => {});
	const waitFor = async (pred: () => boolean, label: string) => {
		for (let i = 0; i < 400; i++) {
			if (pred()) return;
			await settle();
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error(`timed out waiting for ${label}`);
	};
	const quiet = async () => {
		for (let i = 0; i < 10; i++) {
			await settle();
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	};
	const open = async (path: string, entry: typeof LIST_ENTRY | null = LIST_ENTRY) => {
		win.history.replaceState(entry, "", path);
		root = createRoot(container);
		await act(async () => root?.render(<App />));
		await waitFor(
			() => container.querySelector(".rail-body, .chatlist-screen") !== null && goblinLive.feed !== null,
			"the app",
		);
		await quiet();
	};
	const goTo = async (path: string) => {
		await act(async () => {
			win.history.pushState(null, "", path);
			win.dispatchEvent(new win.PopStateEvent("popstate"));
		});
		await quiet();
	};
	const publish = async (changes: {
		conversations?: Conv[];
		chain?: Conv[];
	} = {}) => {
		conversations = changes.conversations ?? conversations;
		chain = changes.chain ?? chain;
		listVersion++;
		const before = listGets;
		await act(async () => emitLiveVersions({ conversations: `v${listVersion}` }));
		await waitFor(() => listGets > before, "the list read");
		await quiet();
	};
	const setHidden = async (value: boolean) => {
		hidden = value;
		await act(async () => {
			win.document.dispatchEvent(new win.Event("visibilitychange"));
		});
		await quiet();
	};
	const click = async (selector: string) => {
		const element = container.querySelector(selector);
		if (element === null) throw new Error(`nothing to click at ${selector}`);
		await act(async () => {
			element.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event);
		});
		await quiet();
	};
	const markOf = (id: string) =>
		container.querySelector(`.conv-main[href="/app/c/${id}"]`)?.closest(".conv")?.getAttribute("data-mark") ?? null;
	const list = () => [...container.querySelectorAll(phone ? ".chatlist-screen li" : ".rail-body li")]
		.map((item) => {
			if (item.matches(".rail-chats-label, .rail-project-head")) return `# ${item.textContent}`;
			return item.querySelector(":scope > .conv .conv-title")?.textContent ?? null;
		})
		.filter((label) => label !== null);

	test("a side chat becomes a bot in place and moves back from its settings page", async () => {
		conversations = [conv("workshop", { title: "Repair workshop" })];
		await open("/app/c/workshop");
		await click("button.title-trigger");
		const chooseConversion = async () => {
			const item = [...container.querySelectorAll('[role="menuitem"]')].find(
				(element) => element.textContent === "Convert to bot…",
			);
			expect(item).toBeDefined();
			await act(async () => {
				item?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event);
			});
		};
		await chooseConversion();
		expect(container.querySelector<HTMLInputElement>('[role="dialog"] input')?.value).toBe("Repair workshop");
		await click('[role="dialog"] .confirm-cancel');
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		expect(posts).toEqual([]);

		await click("button.title-trigger");
		await chooseConversion();
		await act(async () => {
			container.querySelector('[role="dialog"] form')?.dispatchEvent(
				new win.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
			);
		});
		await waitFor(() => container.querySelector('[role="dialog"]') === null, "the conversion dialog to close");
		expect(posts).toContain("/api/app/conversations/workshop/convert-to-bot");
		expect(bots[0]).toMatchObject({ name: "Repair workshop", mainConversationId: "app/workshop" });
		expect(win.location.pathname).toBe("/app/c/workshop");
		await click("button.title-trigger");
		expect([...container.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent))
			.not.toContain("Convert to bot…");
		const settings = [...container.querySelectorAll('[role="menuitem"]')].find(
			(item) => item.textContent === "Bot settings",
		);
		expect(list()).toEqual(["Little Goblin", "# Bots", "Repair workshop", "# Projects"]);
		expect(container.querySelector(".goblin-column")?.getAttribute("aria-label")).toBe("Repair workshop");
		expect(settings).toBeDefined();
		await act(async () => {
			settings?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event);
		});
		await waitFor(() => win.location.pathname === "/app/b/bot-1", "bot settings route");
		expect(container.querySelector<HTMLInputElement>(".bot-settings input")?.value).toBe("Repair workshop");
		await click(".rail-body .bot-row a");
		expect(win.location.pathname).toBe("/app/c/workshop");
		await click('.goblin-profile-button[aria-label="Settings for Repair workshop"]');
		expect(win.location.pathname).toBe("/app/b/bot-1");
		await click(".bot-settings .danger");
		await waitFor(() => container.querySelector(".bot-row") === null, "the bot row to disappear");
		expect(win.location.pathname).toBe("/app/c/workshop");
		expect(list()).toEqual(["Little Goblin", "Repair workshop", "# Projects"]);
		expect(container.querySelector(".goblin-column")?.getAttribute("aria-label")).toBe("Little Goblin");
	});

	test("T14: an open chat with a new reply is marked read once, and the list is read again", async () => {
		conversations = [conv("one", { newReply: 42 })];
		await open("/app/c/one");
		expect(reads.map(({ id, body }) => ({ id, body }))).toEqual([
			{ id: "one", body: { seq: 42 } },
		]);
		await publish();
		expect(reads).toHaveLength(1);
		const before = listGets;
		conversations = [conv("one")];
		await reads[0]!.settle(true);
		await waitFor(() => listGets > before, "the list read after the mark");
		await publish();
		expect(reads).toHaveLength(1);
	});

	test("T15: a chat that still replies is marked read only when the reply ends", async () => {
		conversations = [conv("one", { newReply: 7, busy: true })];
		await open("/app/c/one");
		await publish();
		expect(reads).toEqual([]);
		await publish({ conversations: [conv("one", { newReply: 9 })] });
		expect(reads.map((read) => read.body)).toEqual([{ seq: 9 }]);
	});

	test("T16: a hidden tab reads nothing and shows the new reply; visible again marks it", async () => {
		conversations = [conv("one")];
		await open("/app/c/one");
		await setHidden(true);
		await setHidden(false);
		hidden = true;
		await publish({ conversations: [conv("one", { newReply: 3 })] });
		expect(reads).toEqual([]);
		await setHidden(true);
		expect(markOf("one")).toBe("new");
		await setHidden(false);
		expect(reads.map((read) => read.body)).toEqual([{ seq: 3 }]);
		expect(markOf("one")).toBeNull();
	});

	test("T17: a failed mark is tried again on a list change, not in a loop", async () => {
		conversations = [conv("one", { newReply: 3 })];
		await open("/app/c/one");
		await reads[0]!.settle(false);
		await quiet();
		expect(reads).toHaveLength(1);
		await publish();
		expect(reads.map((read) => read.body)).toEqual([{ seq: 3 }, { seq: 3 }]);
	});

	test("T17: a failed mark is tried again when the tab is visible again", async () => {
		conversations = [conv("one", { newReply: 3 })];
		await open("/app/c/one");
		await reads[0]!.settle(false);
		await setHidden(true);
		expect(reads).toHaveLength(1);
		await setHidden(false);
		expect(reads.length).toBeGreaterThan(1);
	});

	test("T17: a failed mark is tried again when the live feed is back", async () => {
		conversations = [conv("one", { newReply: 3 })];
		await open("/app/c/one");
		await reads[0]!.settle(false);
		await quiet();
		expect(reads).toHaveLength(1);
		const gets = listGets;
		const lost = goblinLive.feed;
		await act(async () => lost?.close());
		await waitFor(() => goblinLive.feed !== lost, "the reconnect");
		await quiet();
		expect(listGets).toBe(gets);
		expect(reads.length).toBeGreaterThan(1);
	});

	test("T18: a chat on screen shows no new reply; the context window page does not mark read", async () => {
		conversations = [conv("one")];
		await open("/app/c/one");
		await publish({ conversations: [conv("one", { newReply: 4 })] });
		expect(markOf("one")).toBeNull();
		expect(reads).toHaveLength(1);
		await goTo("/app/c/one/window");
		await publish({ conversations: [conv("one", { newReply: 6 })] });
		expect(markOf("one")).toBe("new");
		expect(reads).toHaveLength(1);
	});

	test("T18 and T19: the Rolling row opens the roll with the mark and marks that roll read", async () => {
		chain = [conv("newest"), conv("older", { newReply: 9 })];
		conversations = [conv("one")];
		await open("/app/c/one");
		expect(container.querySelector(".rolling-row")?.getAttribute("data-mark")).toBe("new");
		await click(".rolling-row a");
		expect(win.location.pathname).toBe("/app/rolling");
		expect(messageGets.at(-1)).toBe("older");
		expect(reads.map(({ id, body }) => ({ id, body }))).toEqual([
			{ id: "older", body: { seq: 9 } },
		]);
		expect(container.querySelector(".rolling-row")?.hasAttribute("data-mark")).toBe(false);
	});

	test("T19: the Rolling row works on the Rolling page, and opens the newest roll without a mark", async () => {
		chain = [conv("newest"), conv("older")];
		await open("/app/rolling");
		expect(messageGets.at(-1)).toBe("newest");
		await publish({ chain: [conv("newest"), conv("older", { newReply: 9 })] });
		await click(".rolling-row a");
		expect(messageGets.at(-1)).toBe("older");
		await publish({ chain: [conv("newest"), conv("older")] });
		await click(".rolling-row a");
		expect(messageGets.at(-1)).toBe("newest");
	});

	for (const width of ["desktop", "phone"] as const) {
		test(`T20: ${width} order is Little Goblin, Active and Projects`, async () => {
			phone = width === "phone";
			chain = [conv("newest", { preview: "**bold** words" })];
			conversations = [
				conv("plain"),
				conv("kid", { parentId: "app/plain" }),
				conv("fresh", { projectId: "project", newReply: 2 }),
				conv("pinned", { pinnedAt: "2026-11-02T00:00:00Z" }),
			];
			attention = [approval];
			await open("/app/");
			expect(container.querySelector('[aria-label="New side chat"]')).not.toBeNull();
			expect(list()).toEqual([
				"Little Goblin",
				"# Active",
				"Review program",
				"fresh",
				"# Projects",
			]);
			const rolling = container.querySelector(".rolling-row")!;
			expect(rolling.querySelector(".rolling-avatar img")).not.toBeNull();
			expect(rolling.querySelector(".conv-preview")?.textContent).toBe("bold words");
			expect(container.querySelector(".needs-banner")).toBeNull();
		});
	}

	test("T21: subagents stay out of the chat list while their parent shows work", async () => {
		conversations = [
			conv("one"),
			conv("child1", { parentId: "app/one", busy: true }),
			conv("child2", { parentId: "app/one" }),
		];
		await open("/app/");
		expect(container.querySelector(".rolling-row")?.getAttribute("data-mark")).toBe("working");
		expect(container.querySelector(".home-kids")).toBeNull();
		expect(container.querySelector('a[href="/app/c/child1"]')).toBeNull();
		expect(container.querySelector('a[href="/app/c/child2"]')).toBeNull();
	});

	test("T-D1: opening a side chat opens its list, then a manual fold stays closed", async () => {
		conversations = [conv("side")];
		await open("/app/c/side");
		const disclosure = container.querySelector<HTMLButtonElement>('[aria-label="Side chats"]')!;
		expect(disclosure.getAttribute("aria-expanded")).toBe("true");
		expect(container.querySelector(".side-chat[data-flip='app/side']")).not.toBeNull();
		await click('[aria-label="Side chats"]');
		expect(disclosure.getAttribute("aria-expanded")).toBe("false");
		await publish();
		expect(container.querySelector('[aria-label="Side chats"]')?.getAttribute("aria-expanded")).toBe("false");
	});

	test("T-D3: a folded row with a side chat's mark opens that side chat", async () => {
		chain = [conv("newest")];
		conversations = [conv("trip", { title: "Trip plans", newReply: 2 })];
		await open("/app/");
		const row = container.querySelector(".rolling-row")!;
		expect(row.getAttribute("data-mark")).toBe("new");
		expect(row.querySelector(".conv-preview")?.textContent).toBe("New reply in Trip plans");
		await click(".rolling-row a");
		expect(win.location.pathname).toBe("/app/c/trip");
		expect(container.querySelector('[aria-label="Side chats"]')?.getAttribute("aria-expanded")).toBe("true");
	});

	test("T-D2: a project chat folds the side chats, and the next side chat opens them", async () => {
		conversations = [conv("side"), conv("other"), conv("work", { projectId: "project" })];
		await open("/app/c/side");
		const expanded = () => container.querySelector('[aria-label="Side chats"]')?.getAttribute("aria-expanded");
		expect(expanded()).toBe("true");
		await goTo("/app/c/work");
		expect(win.location.pathname).toBe("/app/c/work");
		expect(expanded()).toBe("false");
		expect(container.querySelector(".side-chat")).toBeNull();
		await goTo("/app/c/other");
		expect(expanded()).toBe("true");
	});

	test("T23: the face is in the desktop chat header and closes and opens the panel", async () => {
		conversations = [conv("one")];
		await open("/app/c/one");
		expect(container.querySelector("aside.goblin-column")).not.toBeNull();
		await click("main > header .goblin-panel-toggle");
		expect(container.querySelector("aside.goblin-column")).toBeNull();
		await click("main > header .goblin-panel-toggle");
		expect(container.querySelector("aside.goblin-column")).not.toBeNull();
	});

	for (const [surface, path, face] of [
		["chats bar", "/app/", ".chatlist-bar .goblin-panel-toggle"],
		["chat header", "/app/c/one", "main > header .goblin-panel-toggle"],
		["Rolling header", "/app/rolling", "main > header .goblin-panel-toggle"],
	] as const) {
		test(`T23: on a phone the face in the ${surface} opens the sheet`, async () => {
			phone = true;
			chain = [conv("newest")];
			conversations = [conv("one")];
			await open("/app/c/one");
			if (path !== "/app/c/one") await goTo(path);
			expect(container.querySelector('[role="dialog"]')).toBeNull();
			await click(face);
			expect(container.querySelector('[role="dialog"] .goblin-panel-sheet')).not.toBeNull();
		});
	}

	test("T24: the face counts Telegram work and what needs the operator", async () => {
		conversations = [conv("one")];
		otherBusy = 2;
		attention = [approval];
		await open("/app/c/one");
		const face = container.querySelector("main > header .goblin-panel-toggle");
		expect(face?.getAttribute("aria-label")).toBe("Little Goblin, 2 jobs, 1 needs you");
		expect(face?.querySelector(".goblin-avatar")?.hasAttribute("data-working")).toBe(true);
		expect(face?.textContent).toBe("1");
	});

	test("T32: a token that dies while the list is on screen shows the way back in", async () => {
		conversations = [conv("one", { newReply: 2 })];
		await open("/app/");
		tokenDead = true;
		await publish();
		expect(container.querySelector(".gate")?.textContent).toContain("The stored token stopped working.");
	});

	test("T25: an approval without a chat is a row that opens its page and posts nothing", async () => {
		phone = true;
		attention = [approval];
		conversations = [conv("one")];
		await open("/app/c/one");
		await goTo("/app/");
		await click('.conv[data-mark="needs"] a[href="/app/programs"]');
		expect(win.location.pathname).toBe("/app/programs");
		expect(posts).toEqual([]);
	});

	for (const width of ["desktop", "phone"] as const) {
		test(`T29: on a ${width} the app opens in the newest roll; the lists are one step away`, async () => {
			phone = width === "phone";
			chain = [conv("newest"), conv("older")];
			conversations = [conv("one")];
			await open("/app/", null);
			expect(win.location.pathname).toBe("/app/rolling");
			expect([...new Set(messageGets)]).toEqual(["newest"]);
			expect(container.querySelector("main > header .header-title")?.textContent).toBe("Little Goblin");
			if (phone) {
				expect(container.querySelector(".chatlist-screen")).toBeNull();
				await click(".mobile-back");
				expect(win.location.pathname).toBe("/app/");
				expect(container.querySelector(".chatlist-screen")).not.toBeNull();
			}
			expect(list().slice(0, 2)).toEqual(["Little Goblin", "one"]);
		});
	}

	test("T30: the app opens in the Rolling chat before the first roll exists", async () => {
		await open("/app/", null);
		expect(win.location.pathname).toBe("/app/rolling");
		expect(container.querySelector("main")?.textContent).toContain("your chat with Little Goblin starts here");
		expect(container.querySelector("main")?.textContent).not.toContain("Rolling chat");
	});

	test("T31: a link to a chat opens that chat, and a reload of the list stays on the list", async () => {
		phone = true;
		chain = [conv("newest")];
		conversations = [conv("one")];
		await open("/app/c/one", null);
		expect(win.location.pathname).toBe("/app/c/one");
		expect([...new Set(messageGets)]).toEqual(["one"]);
		await click(".mobile-back");
		expect(win.location.pathname).toBe("/app/");
		await act(async () => root?.unmount());
		goblinLive.feed = null;
		root = createRoot(container);
		await act(async () => root?.render(<App />));
		await waitFor(() => goblinLive.feed !== null, "the reload");
		await quiet();
		expect(win.location.pathname).toBe("/app/");
		expect(container.querySelector(".chatlist-screen")).not.toBeNull();
	});
});

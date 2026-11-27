import { describe, beforeEach, afterEach, test, expect } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import { parseConfig } from "../../src/config.ts";
import {
	authDefaults,
	transcriptionDefaults,
	transcriptionKinds,
} from "../../src/config-schema.ts";
import type {
	AppAttentionItem,
	AppConversationList,
	AppMessageList,
	AppProject,
} from "../../src/http/app-wire.ts";
import { App } from "./App.tsx";
import { loadComposerDraft } from "./composerDraft.ts";
import { boxView } from "./chat/MessageBox.tsx";
import { LIST_ENTRY, clickConfirm, confirmSheet, confirmText, goblinFeedResponse } from "./testkit.ts";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const roll = (id: string, preview = id): AppConversationList["rolling"]["chain"][number] => ({
	id: `app/${id}`,
	title: null,
	preview,
	createdAt: "2026-10-23T00:00:00Z",
	updatedAt: "2026-10-23T00:00:00Z",
	archivedAt: null,
	pinnedAt: null,
	projectId: null,
	parentId: null,
	newReply: null,
	busy: false,
});

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

describe("mobile: chats screen and navigation", () => {
	let win: Window;
	let container: HTMLElement;
	let root: Root | null = null;
	let installed: string[] = [];
	let phone: boolean;
	let conversations: AppConversationList["conversations"];
	let projects: AppProject[];
	let patches: { id: string; body: Record<string, unknown> }[];
	let projectMoveRequests: string[];
	let movePatchFail: boolean;
	let threadMessages: AppMessageList["messages"];
	let rollingChain: AppConversationList["rolling"]["chain"];
	let rollingHistories: Map<string, AppMessageList["messages"]>;
	let rollingRequests: { body: { rolling?: boolean; conversationId?: unknown; message?: { parts?: { text?: string }[] } } }[];
	let rollingReply: { status: number; conversationId: string; rolled: boolean; chain: AppConversationList["rolling"]["chain"] } | null;
	let rollingRollRequests: { method: string; url: string }[];
	let rollingRollReply: { status: number; body: { conversationId?: string; rolled?: boolean; error?: string }; chain?: AppConversationList["rolling"]["chain"] } | null;
	let contextTurns: number;
	let holdRollingList = false;
	let rollingListResolvers: Array<() => void> = [];
	let settings: typeof SETTINGS;
	let attention: AppAttentionItem[];
	let attentionFail: boolean;
	let posts: string[];
	const realFetch = globalThis.fetch;

	const installGlobal = (name: string, value: unknown) => {
		Reflect.set(globalThis, name, value);
		installed.push(name);
	};

	beforeEach(() => {
		win = new Window({ url: "http://localhost/app/" });
		win.history.replaceState(LIST_ENTRY, "");
		const div = win.document.createElement("div");
		win.document.body.appendChild(div);
		container = div as unknown as HTMLElement;
		installed = [];
		phone = true;
		projects = [];
		patches = [];
		projectMoveRequests = [];
		movePatchFail = false;
		threadMessages = [];
		rollingChain = [];
		rollingHistories = new Map();
		rollingRequests = [];
		rollingReply = null;
		rollingRollRequests = [];
		rollingRollReply = null;
		contextTurns = 0;
		holdRollingList = false;
		rollingListResolvers = [];
		settings = SETTINGS;
		attention = [];
		attentionFail = false;
		posts = [];
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
				newReply: null,
				busy: false,
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
				newReply: null,
				busy: false,
			},
		];
		installGlobal("window", win);
		installGlobal("document", win.document);
		installGlobal("navigator", win.navigator);
		installGlobal("localStorage", win.localStorage);
		installGlobal("sessionStorage", win.sessionStorage);
		installGlobal("Event", win.Event);
		installGlobal("MouseEvent", win.MouseEvent);
		installGlobal("PointerEvent", win.PointerEvent);
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
			if ((init?.method ?? "GET") === "POST") posts.push(url);
			if (url === "/api/app/attention")
				return Promise.resolve(
					attentionFail
						? json({ error: "failed" }, 500)
						: json({ items: attention, unavailable: [] }),
				);
			if (url === "/api/app/approvals") return Promise.resolve(json({ programs: [], mail: [] }));
			if (url === "/api/app/push") return Promise.resolve(json({ configured: false, subscriptions: [] }));
			if (url === "/api/app/skills") return Promise.resolve(json({ skills: [], proposed: [], usage: [] }));
			if (url === "/api/app/attachments" || url === "/api/app/identity")
				return Promise.resolve(json({ files: [] }));
			if (url.startsWith("/api/app/log?")) return Promise.resolve(json({ lines: [] }));
			const feed = goblinFeedResponse(url);
			if (feed !== null) return Promise.resolve(feed);
			const method = init?.method ?? (input instanceof Request ? input.method : "GET");
			if (url === "/api/app/rolling/roll") {
				rollingRollRequests.push({ method, url });
				const reply = rollingRollReply ?? { status: 200, body: { conversationId: "app/fresh", rolled: true } };
				if (reply.chain !== undefined) rollingChain = reply.chain;
				return Promise.resolve(json(reply.body, reply.status));
			}
			const patchMatch = /^\/api\/app\/conversations\/([^/]+)$/.exec(url);
			if (patchMatch !== null && method === "PATCH") {
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				patches.push({ id: patchMatch[1]!, body });
				if (body.projectId !== undefined) projectMoveRequests.push(`PATCH:${String(body.projectId)}`);
				if (movePatchFail && body.projectId !== undefined)
					return Promise.resolve(json({ error: "move refused" }, 409));
				const conversation = conversations.find((item) => item.id === `app/${patchMatch[1]}`);
				if (conversation !== undefined) {
					if (body.archived === true) conversation.archivedAt = "2026-10-24T00:00:00Z";
					if (body.archived === false) conversation.archivedAt = null;
					if (body.pinned === true) conversation.pinnedAt = "2026-10-24T00:00:00Z";
					if (body.pinned === false) conversation.pinnedAt = null;
					if (typeof body.title === "string") conversation.title = body.title;
					if (typeof body.projectId === "string") conversation.projectId = body.projectId;
				}
				return Promise.resolve(json(body));
			}
			if (url === "/api/app/conversations" && init?.method === "POST")
				return Promise.resolve(
					json({ id: "app/created", title: null, createdAt: "2026-10-10T00:00:00Z" }),
				);
			if (url === "/api/app/conversations") {
				const response = () => json({ conversations, rolling: { chain: rollingChain } });
				if (holdRollingList && rollingRequests.length > 0)
					return new Promise<Response>((resolve) => rollingListResolvers.push(() => resolve(response())));
				return Promise.resolve(response());
			}
			if (url === "/api/app/projects" && method === "POST") {
				const body = JSON.parse(String(init?.body)) as { name: string };
				projectMoveRequests.push("POST");
				const created = projRow(body.name);
				projects.push(created);
				return Promise.resolve(json(created, 201));
			}
			if (url === "/api/app/projects") return Promise.resolve(json({ projects }));
			if (url === "/api/app/notes")
				return Promise.resolve(json({ notes: [], truncated: false }));
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
			const rollMessages = /^\/api\/app\/conversations\/([^/]+)\/messages$/.exec(url);
			if (rollMessages !== null)
				return Promise.resolve(
					json({
						messages:
							rollMessages[1] === "fixture"
								? threadMessages
								: (rollingHistories.get(`app/${rollMessages[1]}`) ?? []),
						start: 0,
						olderCursor: null,
						ratings: [],
						rateableMessageIds: [],
						compactions: [],
					}),
				);
			if (/^\/api\/app\/conversations\/[^/]+\/stream$/.test(url))
				return Promise.resolve(new Response(null, { status: 204 }));
			if (/^\/api\/app\/conversations\/[^/]+\/events$/.test(url))
				return Promise.resolve(
					new Response('data: {"type":"state","live":false}\n\n', {
						headers: { "content-type": "text/event-stream" },
					}),
				);
			if (/^\/api\/app\/conversations\/[^/]+\/context$/.test(url))
				return Promise.resolve(
					json({
						model: "main/test",
						input: null,
						output: null,
						cacheRead: null,
						cacheWrite: null,
						cacheHitRate: null,
						avgCacheHitRate: null,
						limit: null,
						pct: null,
						modelLimit: null,
						turns: contextTurns,
						segments: null,
					}),
				);
			if (/^\/api\/app\/conversations\/fixture\/window$/.test(url))
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
						toolRuns: [],
						runs: [],
						nowMs: Date.parse("2026-10-22T10:00:00.000Z"),
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
			if (url === "/api/app/chat" && method === "POST") {
				const body = JSON.parse(String(init?.body)) as {
					rolling?: boolean;
					conversationId?: unknown;
					message?: { id?: string; parts?: { type: string; text?: string }[] };
				};
				rollingRequests.push({ body });
				const reply = rollingReply ?? {
					status: 202,
					conversationId: "app/new",
					rolled: true,
					chain: [],
				};
				if (reply.status !== 202) return Promise.resolve(json({ error: "scripted failure" }, reply.status));
				const summary = {
					id: reply.conversationId,
					title: null,
					preview: body.message?.parts?.map((part) => part.text ?? "").join("") ?? "",
					createdAt: "2026-10-23T00:00:00Z",
					updatedAt: "2026-10-23T00:00:00Z",
					archivedAt: null,
					pinnedAt: null,
					projectId: null,
					parentId: null,
					newReply: null,
					busy: false,
				};
				rollingHistories.set(reply.conversationId, [
					...(rollingHistories.get(reply.conversationId) ?? []),
					{
						id: body.message?.id ?? "sent-message",
						role: "user",
						parts: body.message?.parts ?? [],
					} as AppMessageList["messages"][number],
				]);
				rollingChain = reply.chain.length > 0 ? reply.chain : [summary, ...rollingChain];
				return Promise.resolve(
					json({ submitted: true, conversationId: reply.conversationId, rolled: reply.rolled }, 202),
				);
			}
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
	const typeDraft = async (value: string) => {
		const el = container.querySelector<HTMLElement>('.message-box[aria-label="Message draft"]');
		expect(el).toBeTruthy();
		await act(async () => {
			const editor = boxView(el);
			expect(editor).toBeDefined();
			editor!.focus();
			editor!.dispatch(
				editor!.state.tr.replaceWith(
					1,
					editor!.state.doc.content.size - 1,
					value === "" ? [] : editor!.state.schema.text(value),
				),
			);
		});
		await settle();
	};
	const draftText = () => {
		const editor = boxView(container.querySelector(".message-box"));
		if (editor === undefined) return "";
		let text = "";
		editor.state.doc.forEach((paragraph, index) => {
			if (index > 0) text += "\n";
			paragraph.forEach((node) => {
				if (node.isText) text += node.text ?? "";
			});
		});
		return text;
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
	const openRolling = async () => {
		await mount();
		await click(container.querySelector('.rolling-row a[href="/app/rolling"]'));
		await waitFor(() => win.location.pathname === "/app/rolling", "Rolling chat route");
	};
	const releaseRollingLists = async () => {
		holdRollingList = false;
		await act(async () => {
			for (const release of rollingListResolvers.splice(0)) release();
		});
		await settle();
	};
	const rollByHand = async () => {
		rollingChain = [roll("current")];
		rollingHistories.set("app/current", [{
			id: "earlier",
			role: "user",
			parts: [{ type: "text", text: "earlier message" }],
		} as AppMessageList["messages"][number]]);
		rollingHistories.set("app/fresh", []);
		contextTurns = 1;
		if (phone) await openRolling();
		else {
			root = createRoot(container);
			await act(async () => {
				root?.render(<App />);
			});
			await waitFor(
				() => container.querySelector('.rolling-row a[href="/app/rolling"]') !== null,
				"desktop list",
			);
			await click(container.querySelector('.rolling-row a[href="/app/rolling"]'));
			await waitFor(() => win.location.pathname === "/app/rolling", "Rolling chat route");
		}
		await waitFor(
			() => container.querySelector(".transcript")?.textContent?.includes("earlier message") === true,
			"prior transcript",
		);
		await typeDraft("typed before the roll");
		rollingRollReply = {
			status: 200,
			body: { conversationId: "app/fresh", rolled: true },
			chain: [roll("fresh"), roll("current")],
		};
		act(() => (container.querySelector(".ctx-gauge > .ctx-btn") as HTMLButtonElement).click());
		await click(buttonText(".ctx-act", "New conversation"));
		await waitFor(() => rollingRollRequests.length === 1, "manual rolling request");
		expect(rollingRollRequests).toEqual([{ method: "POST", url: "/api/app/rolling/roll" }]);
		await waitFor(
			() => container.querySelector(".transcript")?.textContent?.includes("earlier message") === false,
			"fresh transcript",
		);
	};
	const buttonText = (selector: string, text: string) =>
		[...container.querySelectorAll(selector)].find((b) => b.textContent?.trim() === text);
	const openYou = async (label: string) => {
		await click(container.querySelector('.chatlist-screen [aria-label="You"]'));
		await click(buttonText('[role="menuitem"]', label));
	};
	const attentionItem = (id: string): AppAttentionItem => ({
		id,
		kind: "program-approval",
		title: `Review ${id}`,
		detail: "Evidence",
		createdAt: "2026-11-20T00:00:00.000Z",
		conversationId: null,
		target: { kind: "page", page: "programs" },
	});

	test.each([
		{ count: 2, fail: false, expected: "Goblin, 2 need you" },
		{ count: 1, fail: false, expected: "Goblin, 1 needs you" },
		{ count: 0, fail: false, expected: "Goblin, idle" },
		{ count: 0, fail: true, expected: "Goblin, idle, couldn't load what needs you" },
	])("phone: Goblin face shows attention count=$count failure=$fail", async ({ count, fail, expected }) => {
		attention = Array.from({ length: count }, (_, i) => attentionItem(String(i)));
		attentionFail = fail;
		await mount();
		const face = () => container.querySelector(".chatlist-bar .goblin-panel-toggle");
		await waitFor(() => face()?.getAttribute("aria-label") === expected, expected);
	});

	test("phone: attention opens Goblin and navigates without a POST", async () => {
		attention = [attentionItem("one")];
		await mount();
		await waitFor(() => container.querySelector(".chatlist-bar .goblin-panel-toggle") !== null, "Goblin face");
		await click(container.querySelector(".chatlist-bar .goblin-panel-toggle"));
		const dialog = container.querySelector('[role="dialog"]');
		expect(dialog).toBeTruthy();
		const title = dialog?.getAttribute("aria-labelledby");
		expect(win.document.getElementById(title!)?.textContent).toBe("Goblin");
		await click(buttonText(".goblin-need-row", "Review oneEvidence"));
		await waitFor(() => win.location.pathname === "/app/programs", "programs");
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		expect(posts).toEqual([]);
	});

	test("phone: thread avatar opens the sheet and All programs closes it", async () => {
		await mount();
		await click(container.querySelector('.chatlist-screen .conv-main[href="/app/c/fixture"]'));
		await click(container.querySelector("main > header .goblin-panel-toggle"));
		expect(container.querySelector('[role="dialog"] .goblin-panel-sheet')).toBeTruthy();
		await click(buttonText('[role="tab"]', "Scheduled"));
		await click(buttonText(".goblin-panel-footer", "All programs"));
		await waitFor(() => win.location.pathname === "/app/programs", "programs");
		expect(container.querySelector('[role="dialog"]')).toBeNull();
	});

	test.each([
		"settings",
		"memory",
		"delegations",
		"programs",
		"status",
		"skills",
		"files",
		"log",
		"attention",
		"notes",
		"projects",
		"archive",
	])(
		"phone: %s has one back control to chats",
		async (page) => {
			win.history.replaceState(null, "", `/app/${page}`);
			root = createRoot(container);
			await act(async () => root?.render(<App />));
			await waitFor(() => container.querySelector(".mobile-back") !== null, `${page} back`);
			expect(container.querySelectorAll(".mobile-back")).toHaveLength(1);
			expect(container.querySelector(".mobile-back")?.getAttribute("aria-label")).toBe("Back to chats");
			await click(container.querySelector(".mobile-back"));
			await waitFor(() => container.querySelector(".chatlist-screen") !== null, "chats");
		},
	);

	test.each(["Settings", "Archive"])("phone: You opens %s", async (page) => {
		await mount();
		await openYou(page);
		expect(win.location.pathname).toBe(`/app/${page.toLowerCase()}`);
	});

	test("phone: the context window returns to its conversation", async () => {
		win.history.replaceState(null, "", "/app/c/fixture/window");
		root = createRoot(container);
		await act(async () => root?.render(<App />));
		await waitFor(() => container.querySelector(".mobile-back") !== null, "window back");
		expect(container.querySelectorAll(".mobile-back")).toHaveLength(1);
		expect(container.querySelector(".mobile-back")?.getAttribute("aria-label")).toBe(
			"Back to conversation",
		);
		await click(container.querySelector(".mobile-back"));
		await waitFor(() => win.location.pathname === "/app/c/fixture", "conversation");
	});

	test("phone: a note returns to the notes index", async () => {
		win.history.replaceState(null, "", "/app/n/example");
		root = createRoot(container);
		await act(async () => root?.render(<App />));
		await waitFor(() => container.querySelector(".mobile-back") !== null, "note back");
		expect(container.querySelectorAll(".mobile-back")).toHaveLength(1);
		expect(container.querySelector(".mobile-back")?.getAttribute("aria-label")).toBe("Back to notes");
		await click(container.querySelector(".mobile-back"));
		expect(win.location.pathname).toBe("/app/notes");
	});

	test("phone: /app is the chats screen without a tab bar or More", async () => {
		await mount();

		const rows = [...container.querySelectorAll(".chatlist-screen .conv-title")].map(
			(el) => el.textContent,
		);
		expect(rows).toEqual(["Rolling chat", "fixture chat", "second chat"]);
		expect(container.querySelector(".tabbar")).toBeNull();
		expect(container.textContent).not.toContain("More");
		// The list screen replaces the composer as the chat surface — the
		// empty-state composer is not in this screen.
		expect(container.querySelector(".chatlist-screen .composer")).toBeNull();
	});

	test("Rolling chat is first, opens its page, and has no hold actions", async () => {
		await mount();
		const row = container.querySelector(".chatlist-screen .rolling-row");
		expect(row?.querySelector(".conv-title")?.textContent).toBe("Rolling chat");
		expect(row?.querySelectorAll("button")).toHaveLength(0);
		await hold(row!.querySelector("a")!, "touch");
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		await click(row!.querySelector("a"));
		await waitFor(() => win.location.pathname === "/app/rolling", "Rolling chat route");
	});

	test("T2: a populated rolling chain stays first without hiding ordinary chats", async () => {
		rollingChain = [roll("current", "latest rolling preview")];
		await mount();
		const rows = [...container.querySelectorAll(".chatlist-screen .conv")];
		expect(rows.map((row) => row.querySelector(".conv-title")?.textContent)).toEqual([
			"Rolling chat",
			"fixture chat",
			"second chat",
		]);
		expect(rows[0]?.textContent).toContain("latest rolling preview");
		expect(rows[0]?.querySelectorAll("button")).toHaveLength(0);
	});

	test("T3: empty-chain send routes through rolling and loads the new conversation", async () => {
		await openRolling();
		expect(container.querySelector('.message-box[aria-label="Message draft"]')).toBeTruthy();
		holdRollingList = true;
		let sawEarlier = false;
		const observer = new win.MutationObserver(() => {
			if (container.textContent?.includes("Earlier conversation")) sawEarlier = true;
		});
		observer.observe(win.document.body, { childList: true, subtree: true, characterData: true });
		await typeDraft("first rolling message");
		expect(draftText()).toBe("first rolling message");
		await click(container.querySelector('button[aria-label="Send"]'));
		expect(rollingRequests).toHaveLength(1);
		await waitFor(() => rollingListResolvers.length > 0, "held list refresh");
		await settle();
		expect(sawEarlier).toBe(false);
		await releaseRollingLists();
		await waitFor(
			() => container.querySelector(".transcript")?.textContent?.includes("first rolling message") === true,
			"new roll history",
		);
		observer.disconnect();
		expect(rollingRequests).toHaveLength(1);
		expect(rollingRequests[0]!.body.rolling).toBe(true);
		expect(rollingRequests[0]!.body).not.toHaveProperty("conversationId");
		expect(rollingRequests[0]!.body.message?.parts?.[0]?.text).toBe("first rolling message");
		expect(win.location.pathname).toBe("/app/rolling");
		expect(sawEarlier).toBe(false);
	});

	test("T4: a same-roll send keeps the transcript mounted and renders once", async () => {
		rollingChain = [roll("current")];
		rollingReply = { status: 202, conversationId: "app/current", rolled: false, chain: [roll("current")] };
		await openRolling();
		const transcript = container.querySelector(".transcript");
		expect(transcript).toBeTruthy();
		await typeDraft("same conversation");
		await click(container.querySelector('button[aria-label="Send"]'));
		await waitFor(
			() => container.querySelector(".transcript")?.textContent?.includes("same conversation") === true,
			"same-roll message",
		);
		expect(container.querySelector(".transcript")).toBe(transcript);
		expect([...container.querySelectorAll(".transcript p")].filter((p) => p.textContent === "same conversation")).toHaveLength(1);
		expect(container.textContent).not.toContain("Earlier conversation");
	});

	test("New conversation starts a fresh roll, lands in it, and brings the draft", async () => {
		await rollByHand();
		expect(draftText()).toBe("typed before the roll");
		expect(loadComposerDraft("app/current")).toBeNull();
		expect(container.textContent).toContain("— new conversation —");
		expect(container.textContent).toContain("↑ Previous conversation");
	});

	test("New conversation leaves the composer focused on a desktop width", async () => {
		phone = false;
		await rollByHand();
		expect(draftText()).toBe("typed before the roll");
		const editor = container.querySelector('.message-box[aria-label="Message draft"]');
		expect((win.document.activeElement as unknown) === (editor as unknown)).toBe(true);
	});

	test("New conversation leaves the composer focused on a phone width, once", async () => {
		await rollByHand();
		expect(draftText()).toBe("typed before the roll");
		const editor = container.querySelector('.message-box[aria-label="Message draft"]');
		expect((win.document.activeElement as unknown) === (editor as unknown)).toBe(true);
		await click(buttonText("button", "↑ Previous conversation"));
		await waitFor(() => container.textContent?.includes("Back to latest") === true, "earlier roll");
		const earlier = container.querySelector('.message-box[aria-label="Message draft"]');
		expect((win.document.activeElement as unknown) === (earlier as unknown)).toBe(false);
		await click(buttonText("button", "Back to latest"));
		await waitFor(() => draftText() === "typed before the roll", "back in the new roll");
		const again = container.querySelector('.message-box[aria-label="Message draft"]');
		expect((win.document.activeElement as unknown) === (again as unknown)).toBe(false);
	});

	test("New conversation is off while the latest roll works and an earlier roll is open", async () => {
		rollingChain = [{ ...roll("latest"), busy: true }, roll("earlier")];
		rollingHistories.set("app/latest", [{
			id: "latest-message",
			role: "user",
			parts: [{ type: "text", text: "latest message" }],
		} as AppMessageList["messages"][number]]);
		rollingHistories.set("app/earlier", [{
			id: "earlier-message",
			role: "user",
			parts: [{ type: "text", text: "earlier message" }],
		} as AppMessageList["messages"][number]]);
		contextTurns = 1;
		await openRolling();
		await click(buttonText("button", "↑ Previous conversation"));
		await waitFor(() => container.textContent?.includes("Back to latest") === true, "earlier roll");
		act(() => (container.querySelector(".ctx-gauge > .ctx-btn") as HTMLButtonElement).click());
		expect(
			[...container.querySelectorAll(".ctx-act")].map((button) => [
				button.textContent,
				(button as HTMLButtonElement).disabled,
			]),
		).toEqual([
			["Compact now", false],
			["New conversation", true],
		]);
	});

	test("New conversation refused keeps the conversation and the draft", async () => {
		rollingChain = [roll("current")];
		rollingHistories.set("app/current", [{
			id: "earlier",
			role: "user",
			parts: [{ type: "text", text: "earlier message" }],
		} as AppMessageList["messages"][number]]);
		contextTurns = 1;
		await openRolling();
		await waitFor(() => container.querySelector(".transcript")?.textContent?.includes("earlier message") === true, "prior transcript");
		await typeDraft("typed before the roll");
		rollingRollReply = {
			status: 409,
			body: { error: "a turn is still running in the latest conversation" },
		};
		act(() => (container.querySelector(".ctx-gauge > .ctx-btn") as HTMLButtonElement).click());
		await click(buttonText(".ctx-act", "New conversation"));
		await waitFor(() => container.querySelector(".ctx-outcome") !== null, "roll refusal");
		expect(container.querySelector(".transcript")?.textContent).toContain("earlier message");
		expect(draftText()).toBe("typed before the roll");
		expect(container.querySelector(".ctx-outcome")?.textContent).toBe(
			"couldn't start a new conversation: a turn is still running in the latest conversation",
		);
		expect(rollingChain.map((item) => item.id)).toEqual(["app/current"]);
	});

	test("New conversation into an empty latest roll keeps both drafts", async () => {
		await rollByHand();
		await click(buttonText("button", "↑ Previous conversation"));
		await waitFor(() => container.textContent?.includes("Back to latest") === true, "earlier roll");
		await typeDraft("typed in the earlier roll");
		rollingRollRequests.length = 0;
		rollingRollReply = {
			status: 200,
			body: { conversationId: "app/fresh", rolled: false },
			chain: [roll("fresh"), roll("current")],
		};
		act(() => (container.querySelector(".ctx-gauge > .ctx-btn") as HTMLButtonElement).click());
		await click(buttonText(".ctx-act", "New conversation"));
		await waitFor(() => rollingRollRequests.length === 1, "second manual request");
		await waitFor(() => container.textContent?.includes("Back to latest") === false, "back in the empty roll");
		await waitFor(() => container.querySelector('.message-box[aria-label="Message draft"]') !== null, "composer");
		await settle();
		expect(draftText()).toBe("typed before the roll");
		await click(buttonText("button", "↑ Previous conversation"));
		await waitFor(() => draftText() === "typed in the earlier roll", "draft of the earlier roll kept");
	});

	test("New conversation is not offered on an ordinary chat", async () => {
		await mount();
		await click(container.querySelector('.chatlist-screen .conv-main[href="/app/c/fixture"]'));
		await waitFor(() => container.querySelector(".transcript") !== null, "ordinary chat");
		act(() => (container.querySelector(".ctx-gauge > .ctx-btn") as HTMLButtonElement).click());
		expect([...container.querySelectorAll(".ctx-act")].map((button) => button.textContent)).toEqual(["Compact now"]);
	});

	test("T4: a new routed roll switches once without an earlier bar flash", async () => {
		rollingChain = [roll("current")];
		rollingReply = {
			status: 202,
			conversationId: "app/newer",
			rolled: true,
			chain: [roll("newer"), roll("current")],
		};
		await openRolling();
		holdRollingList = true;
		let sawEarlier = false;
		const observer = new win.MutationObserver(() => {
			if (container.textContent?.includes("Earlier conversation")) sawEarlier = true;
		});
		observer.observe(win.document.body, { childList: true, subtree: true, characterData: true });
		await typeDraft("[new topic] fresh message");
		await click(container.querySelector('button[aria-label="Send"]'));
		await waitFor(() => rollingListResolvers.length > 0, "held list refresh");
		await settle();
		expect(sawEarlier).toBe(false);
		await releaseRollingLists();
		await waitFor(
			() => container.querySelector(".transcript")?.textContent?.includes("[new topic] fresh message") === true,
			"new routed roll",
		);
		observer.disconnect();
		expect([...container.querySelectorAll(".transcript p")].filter((p) => p.textContent === "[new topic] fresh message")).toHaveLength(1);
		expect(sawEarlier).toBe(false);
	});

	test("T5: three rolls link backward at every level and return to latest", async () => {
		rollingChain = [roll("newest"), roll("middle"), roll("oldest")];
		for (const id of ["newest", "middle", "oldest"]) rollingHistories.set(`app/${id}`, []);
		await openRolling();
		expect(container.textContent).toContain("— new conversation —");
		await click(
			[...container.querySelectorAll(".rolling-history-bar button")].find((button) =>
				button.textContent?.includes("Previous conversation"),
			),
		);
		expect(container.textContent).toContain("Earlier conversation");
		expect(container.textContent).toContain("— new conversation —");
		const previous = [...container.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Previous conversation"),
		);
		expect(previous).toBeTruthy();
		await click(previous);
		expect(container.textContent).toContain("Earlier conversation");
		expect(container.textContent).not.toContain("— new conversation —");
		expect(container.textContent).not.toContain("Previous conversation");
		await click([...container.querySelectorAll("button")].find((button) => button.textContent === "Back to latest"));
		expect(container.textContent).not.toContain("Earlier conversation");
		expect(container.textContent).toContain("— new conversation —");
	});

	test("T5: a one-roll chain has no marker or previous link", async () => {
		rollingChain = [roll("only")];
		rollingHistories.set("app/only", []);
		await openRolling();
		expect(container.textContent).not.toContain("— new conversation —");
		expect(container.textContent).not.toContain("Previous conversation");
	});

	test("T6: the lane header offers the project move and no conversation actions", async () => {
		rollingChain = [roll("current")];
		rollingHistories.set("app/current", []);
		await openRolling();
		expect(container.querySelector("main > header .header-title")?.textContent).toBe("Rolling chat");
		await click(container.querySelector("main > header .title-trigger"));
		expect([...container.querySelectorAll('[role="menuitem"]')].some((item) =>
			item.textContent === "Move to project",
		)).toBe(true);
		await click(container.querySelector("main > header .title-trigger"));
		await click(container.querySelector("main > header .goblin-panel-toggle"));
		expect(container.querySelector('[role="dialog"]')).not.toBeNull();
		expect(container.querySelector("main > header [aria-label='Archive']")).toBeNull();
		expect(container.querySelector("main > header [aria-label='Move']")).toBeNull();
		expect(container.querySelector("main > header [aria-label='Delete']")).toBeNull();
		expect(container.querySelector("main > header [aria-label='Rename']")).toBeNull();
	});

	test("T7: a roll deep link opens it in Rolling chat; an unknown id still normalizes home", async () => {
		rollingChain = [roll("newest"), roll("older")];
		rollingHistories.set("app/older", [
			{ id: "older-message", role: "user", parts: [{ type: "text", text: "older roll text" }] } as AppMessageList["messages"][number],
		]);
		win.history.replaceState(null, "", "/app/c/older");
		root = createRoot(container);
		await act(async () => {
			root?.render(<App />);
		});
		await waitFor(() => win.location.pathname === "/app/rolling", "rolling deep-link normalization");
		expect(container.querySelector(".transcript")?.textContent).toContain("older roll text");

		await act(async () => {
			root?.unmount();
		});
		root = null;
		win.history.replaceState(null, "", "/app/c/unknown");
		root = createRoot(container);
		await act(async () => {
			root?.render(<App />);
		});
		await waitFor(() => win.location.pathname === "/app/", "unknown-link normalization");
	});

	test("T8: failed rolling sends keep the draft and show an error on empty and open pages", async () => {
		rollingReply = { status: 500, conversationId: "app/nope", rolled: false, chain: [] };
		await openRolling();
		await typeDraft("keep empty draft");
		await click(container.querySelector('button[aria-label="Send"]'));
		await waitFor(() => container.querySelector(".chat .error") !== null, "empty send error");
		expect(draftText()).toBe("keep empty draft");

		rollingChain = [roll("current")];
		rollingHistories.set("app/current", []);
		await act(async () => {
			root?.unmount();
			root = null;
			container.replaceChildren();
			win.history.replaceState(LIST_ENTRY, "", "/app/");
		});
		await openRolling();
		await typeDraft("keep open draft");
		await click(container.querySelector('button[aria-label="Send"]'));
		await waitFor(() => container.querySelector(".chat .error") !== null, "open send error");
		expect(draftText()).toBe("keep open draft");
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

	test("the hold sheet switches to project choices and moves in place", async () => {
		projects = [projRow("Goblin Work")];
		await mount();
		const sectionToggle = container.querySelector(".rail-section-toggle");
		expect(sectionToggle?.getAttribute("aria-expanded")).toBe("false");
		expect(container.querySelector(".rail-project")).toBeNull();
		await hold(
			container.querySelector('.chatlist-screen .conv-main[href="/app/c/fixture"]')!,
			"touch",
		);
		const dialog = container.querySelector('[role="dialog"]');
		await click(
			[...container.querySelectorAll(".row-sheet-action")].find((button) =>
				button.textContent?.includes("Move to project"),
			),
		);
		expect(container.querySelector('[role="dialog"]')).toBe(dialog);
		expect([...container.querySelectorAll(".row-sheet-action")].map((button) => button.textContent)).toEqual([
			"Back",
			"Goblin Work",
			"New project…",
		]);
		await click(
			[...container.querySelectorAll(".row-sheet-action")].find(
				(button) => button.textContent === "Goblin Work",
			),
		);
		await waitFor(() => patches.some((patch) => patch.body.projectId === "p-goblin"), "move PATCH");
		expect(patches).toContainEqual({ id: "fixture", body: { projectId: "p-goblin" } });
		expect(win.location.pathname).toBe("/app/");
		expect(sectionToggle?.getAttribute("aria-expanded")).toBe("true");
		expect(container.querySelector(".rail-project-main")?.textContent).toContain("Goblin Work");
		expect(container.querySelector(".rail-project-main")?.getAttribute("href")).toBe("/app/p/p-goblin");
		const movedPinned = container.querySelector('.chatlist-screen .conv-main[href="/app/c/fixture"]');
		expect(movedPinned?.querySelector(".conv-project")?.textContent).toBe(" in Goblin Work");
		expect(movedPinned?.querySelector(".conv-pin")).not.toBeNull();
	});

	test("Back returns to row actions without moving the chat", async () => {
		projects = [projRow("Goblin Work")];
		await mount();
		await hold(
			container.querySelector('.chatlist-screen .conv-main[href="/app/c/fixture"]')!,
			"touch",
		);
		await click(
			[...container.querySelectorAll(".row-sheet-action")].find((button) =>
				button.textContent?.includes("Move to project"),
			),
		);
		await click(
			[...container.querySelectorAll(".row-sheet-action")].find(
				(button) => button.textContent === "Back",
			),
		);
		expect([...container.querySelectorAll(".row-sheet-action")].map((button) => button.textContent)).toEqual([
			"Unpin",
			"Rename",
			"Move to project",
			"Archive",
		]);
		expect(patches.filter((patch) => patch.body.projectId !== undefined)).toEqual([]);
	});

	test("the hold sheet can create a project, then move the chat without leaving the list", async () => {
		await mount();
		await hold(
			container.querySelector('.chatlist-screen .conv-main[href="/app/c/fixture"]')!,
			"touch",
		);
		await click(
			[...container.querySelectorAll(".row-sheet-action")].find((button) =>
				button.textContent?.includes("Move to project"),
			),
		);
		await click(
			[...container.querySelectorAll(".row-sheet-action")].find(
				(button) => button.textContent === "New project…",
			),
		);
		const form = container.querySelector<HTMLFormElement>(".msheet form");
		expect(form).toBeTruthy();
		await typeInto(form!.querySelector("input")!, "Side Hustle");
		await act(async () => {
			form!.dispatchEvent(
				new win.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
			);
		});
		await waitFor(
			() => patches.some((patch) => patch.body.projectId === "p-side"),
			"move after project create",
		);
		expect(projectMoveRequests).toEqual(["POST", "PATCH:p-side"]);
		expect(win.location.pathname).toBe("/app/");
	});

	test("a refused move from the hold sheet shows the list alert", async () => {
		projects = [projRow("Goblin Work")];
		movePatchFail = true;
		await mount();
		await hold(
			container.querySelector('.chatlist-screen .conv-main[href="/app/c/fixture"]')!,
			"touch",
		);
		await click(
			[...container.querySelectorAll(".row-sheet-action")].find((button) =>
				button.textContent?.includes("Move to project"),
			),
		);
		await click(
			[...container.querySelectorAll(".row-sheet-action")].find(
				(button) => button.textContent === "Goblin Work",
			),
		);
		await waitFor(
			() => container.querySelector('[role="alert"]')?.textContent === "move refused",
			"list move error",
		);
		expect(win.location.pathname).toBe("/app/");
	});

	test("unpinned project chats stay off the chat list", async () => {
		projects = [projRow("Goblin Work")];
		conversations[0]!.projectId = "p-goblin";
		conversations[0]!.pinnedAt = null;
		await mount();
		await click(container.querySelector(".rail-section-toggle"));
		expect(container.querySelector(".rail-project-main")?.textContent).toContain("Goblin Work");
		expect(container.querySelector('.chatlist-screen .conv-main[href="/app/c/fixture"]')).toBeNull();
	});

	test("a child chat has no row on the chats screen", async () => {
		conversations[0]!.parentId = "app/second";
		await mount();
		expect(container.querySelector('.chatlist-screen .conv-main[href="/app/c/second"]')).not.toBeNull();
		expect(container.querySelector('.chatlist-screen .conv-main[href="/app/c/fixture"]')).toBeNull();
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
		await openYou("Projects");
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
		expect(container.querySelector(".row-sheet")?.textContent).not.toContain("Move to project");
	});

	test("phone: New project uses the folder-plus glyph, not the new-chat plus", async () => {
		await mount();
		const newProject = container.querySelector('.rail-project-head [aria-label="New project"]');
		expect(newProject?.querySelector('svg path[d^="M3 7"]')).not.toBeNull();
	});

	test("phone: back from a conversation returns to the list", async () => {
		await mount();

		await click(
			[...container.querySelectorAll(".chatlist-screen .conv")]
				.find((r) => r.querySelector(".conv-title")?.textContent === "fixture chat")
				?.querySelector(".conv-main"),
		);
		await waitFor(
			() => win.location.pathname === "/app/c/fixture",
			"conversation",
		);
		expect(container.querySelector(".mobile-back")).toBeTruthy();

		await click(container.querySelector(".mobile-back"));
		await waitFor(
			() => container.querySelector(".chatlist-screen") !== null,
			"chats screen to return",
		);
		expect(container.querySelector(".tabbar")).toBeNull();
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

	test("phone: + stages the composer; back returns to the list", async () => {
		await mount();

		await click(container.querySelector('.chatlist-bar [aria-label="New chat"]'));
		await waitFor(
			() => container.querySelector(".chat .composer") !== null,
			"staged composer",
		);
		expect(container.querySelector(".mobile-back")).toBeTruthy();
		expect(container.querySelector("main > header .goblin-panel-toggle")).toBeTruthy();
		expect(container.querySelector(".chat .composer")).toBeTruthy();

		await click(container.querySelector(".mobile-back"));
		await waitFor(
			() => container.querySelector(".chatlist-screen") !== null,
			"chats screen to return",
		);
	});

	test("phone: a project page returns to the projects index", async () => {
		projects = [projRow("Goblin Work")];
		await mount();

		await openYou("Projects");
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
			() => container.querySelector(".ops.projfields") !== null,
			"project page",
		);
		expect(container.querySelector(".chat form.composer")).toBeTruthy();
		const back = container.querySelector(".mobile-back");
		expect(container.querySelectorAll(".mobile-back")).toHaveLength(1);
		expect(back?.getAttribute("aria-label")).toBe("Back to projects");

		await click(back);
		await waitFor(
			() => win.location.pathname === "/app/projects",
			"projects index",
		);
		expect(win.location.pathname).toBe("/app/projects");
	});

	test("phone: Back to chats asks once about a dirty settings editor", async () => {
		await mount();

		await openYou("Settings");
		await waitFor(() => container.querySelector(".settings") !== null, "settings page");
		await click(
			[...container.querySelectorAll("button.idx")].find((b) => b.textContent?.includes("Access")),
		);
		// An invalid edit — dropping the only operator — can never
		// autosave, so the editor stays dirty: exactly the state the
		// navigation guard must question.
		await click(container.querySelector(".chip button"));
		await waitFor(() => container.textContent?.includes("unsaved") === true, "dirty editor");

		await click(container.querySelector('[aria-label="Back to chats"]'));
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
		expect(container.querySelector(".needs-banner")).toBeNull();
		expect(container.querySelector('main > header button[aria-label="Goblin"]')).toBeNull();
		// The gate's other side: a sectioned thread in a wide realm does
		// mount the rail — what keeps it off phones is the gate, not an
		// empty transcript.
		await click(container.querySelector('.conv-main[href="/app/c/fixture"]'));
		await waitFor(() => container.querySelector(".outline") !== null, "outline rail");
	});

	test("desktop: the header Sidebar button shows and hides the whole list", async () => {
		phone = false;
		win.happyDOM.setWindowSize({ width: 1280, height: 800 });
		const style = win.document.createElement("style");
		style.textContent = readFileSync(join(import.meta.dir, "styles.css"), "utf8");
		win.document.head.appendChild(style);
		root = createRoot(container);
		await act(async () => {
			root?.render(<App />);
		});
		await waitFor(() => container.querySelector("nav.app-rail") !== null, "desktop list");
		const toggle = container.querySelector('main > header button[aria-label="Sidebar"]');
		expect(toggle).not.toBeNull();
		expect(getComputedStyle(toggle!).display).toBe("inline-flex");
		expect(toggle?.getAttribute("aria-expanded")).toBe("true");
		await click(toggle);
		expect(container.querySelector('nav[aria-label="Sidebar"]')).toBeNull();
		expect(toggle?.getAttribute("aria-expanded")).toBe("false");
		await click(toggle);
		expect(container.querySelector('nav[aria-label="Sidebar"]')).not.toBeNull();
		expect(toggle?.getAttribute("aria-expanded")).toBe("true");
	});

	test.each([
		[193, "none"],
		[399, "none"],
		[400, "inline-flex"],
		[752, "inline-flex"],
	])("desktop: a %ipx column shows the chat width selector as %s; the composer bar wraps", async (width, display) => {
		phone = false;
		win.happyDOM.setWindowSize({ width: 721, height: 800 });
		const style = win.document.createElement("style");
		style.textContent = readFileSync(join(import.meta.dir, "styles.css"), "utf8");
		win.document.head.appendChild(style);
		const observers: { target: Element; report: (width: number) => void }[] = [];
		class LayoutResizeObserver {
			constructor(private readonly callback: (entries: unknown[], observer: unknown) => void) {}
			observe(target: Element) {
				observers.push({
					target,
					report: (w) => this.callback([{ target, contentRect: { width: w } }], this),
				});
			}
			unobserve() {}
			disconnect() {}
		}
		Reflect.set(win, "ResizeObserver", LayoutResizeObserver);
		root = createRoot(container);
		await act(async () => {
			root?.render(<App />);
		});
		await click(container.querySelector('.conv-main[href="/app/c/fixture"]'));
		await waitFor(
			() => container.querySelector(".chat .composer-bar") !== null,
			"chat composer",
		);
		const column = container.querySelector("main");
		await act(async () => {
			for (const o of observers) if (o.target === column) o.report(width);
		});
		const selector = container.querySelector('main > header [aria-label="Chat width"]');
		expect(selector).not.toBeNull();
		expect(getComputedStyle(selector!).display).toBe(display);
		expect(getComputedStyle(container.querySelector(".chat .composer-bar")!).flexWrap).toBe("wrap");
	});
});

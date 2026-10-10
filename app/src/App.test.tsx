import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { parseConfig, transcriptionDefaults, transcriptionKinds } from "../../src/config.ts";
import type { AppConversationList } from "../../src/http/app-wire.ts";
import type { ConfigPostBody } from "../../src/http/operator-wire.ts";
import { App, deepLinkConv, flatLine } from "./App.tsx";

// Stored titles predate store-side flattening — the sidebar row must
// render them clean regardless of the server's vintage.

describe("flatLine", () => {
	test("a fenced title loses the fence and language tag", () => {
		expect(flatLine("```typescript const slug = (s: string): string => s.trim(); ```")).toBe(
			"const slug = (s: string): string => s.trim();",
		);
	});

	test("inline backticks, links, and emphasis flatten", () => {
		expect(flatLine("run `bun test` then see [docs](https://a.dev) — **bold**")).toBe(
			"run bun test then see docs — bold",
		);
	});

	test("line-lead markers and whitespace collapse", () => {
		expect(flatLine("## multi\n   line   title")).toBe("multi line title");
	});

	test("a title reduced to markdown furniture empties out", () => {
		expect(flatLine("``` ```")).toBe("");
	});
});

// The spin-off deep link — /app/c/<appId> claims the conversation id.
describe("deepLinkConv", () => {
	test("a valid path yields the app/ conversation id", () => {
		expect(deepLinkConv("/app/c/spun-1_valid")).toBe("app/spun-1_valid");
	});
	test("the root, other paths, and malformed ids claim nothing", () => {
		expect(deepLinkConv("/app/")).toBeNull();
		expect(deepLinkConv("/app/c/")).toBeNull();
		expect(deepLinkConv("/app/c/-bad")).toBeNull();
		expect(deepLinkConv("/app/c/valid/extra")).toBeNull();
		expect(deepLinkConv("/settings")).toBeNull();
	});
});

// The empty-state send creates the conversation and unmounts that
// composer (#118): an upload still in flight resolves after the
// unmount, and its chip must still be there in the new conversation's
// composer — staged uploads belong to the operator's composer, not to
// whichever instance happens to be mounted. Full App mount in
// happy-dom like ChatView.test.tsx; the wire (api.ts + the SDK's
// transport) is faked at globalThis.fetch, with the upload POSTs held
// back so the test owns when each one finishes.
interface Deferred {
	promise: Promise<Response>;
	settle: {
		ok: (ref: { path: string; mediaType: string; filename: string; size: number }) => void;
	};
}

const jsonResponse = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function deferredUpload(): Deferred {
	let ok!: (res: Response) => void;
	const promise = new Promise<Response>((res) => {
		ok = res;
	});
	return {
		promise,
		settle: {
			ok: (ref) => ok(jsonResponse({ ref }, 201)),
		},
	};
}

describe("App empty-state send keeps unfinished uploads (issue #118)", () => {
	let win: Window;
	let container: HTMLElement;
	let root: Root | null = null;
	let uploads: Deferred[] = [];
	let created = false;
	let installed: string[] = [];
	const realFetch = globalThis.fetch;

	const installGlobal = (name: string, value: unknown) => {
		Reflect.set(globalThis, name, value);
		installed.push(name);
	};

	beforeEach(() => {
		win = new Window();
		const div = win.document.createElement("div");
		win.document.body.appendChild(div);
		container = div as unknown as HTMLElement;
		uploads = [];
		created = false;
		installed = [];
		installGlobal("window", win);
		installGlobal("document", win.document);
		installGlobal("navigator", win.navigator);
		installGlobal("localStorage", win.localStorage);
		installGlobal("Event", win.Event);
		installGlobal("CustomEvent", win.CustomEvent);
		installGlobal("getComputedStyle", win.getComputedStyle);
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const method = init?.method ?? (input instanceof Request ? input.method : "GET");
			if (url === "/api/app/attachments") {
				const d = deferredUpload();
				uploads.push(d);
				return d.promise;
			}
			if (url === "/api/app/conversations") {
				if (method === "POST") {
					created = true;
					return Promise.resolve(jsonResponse({ id: "app/fixture", title: null }));
				}
				return Promise.resolve(
					jsonResponse({
						conversations: created
							? [
									{
										id: "app/fixture",
										title: null,
										preview: "fixture",
										updatedAt: new Date().toISOString(),
										archivedAt: null,
									},
								]
							: [],
					}),
				);
			}
			if (url.endsWith("/messages")) return Promise.resolve(jsonResponse({ messages: [] }));
			if (url.endsWith("/stream")) return Promise.resolve(new Response(null, { status: 204 }));
			if (url.endsWith("/chat"))
				return Promise.resolve(
					new Response("data: [DONE]\n\n", {
						status: 200,
						headers: {
							"content-type": "text/event-stream",
							"x-vercel-ai-ui-message-stream": "v1",
						},
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

	test("an upload still in flight when the conversation is created stays staged", async () => {
		root = createRoot(container);
		await act(async () => {
			root?.render(<App />);
		});
		// Gate probe + first list load land before there is a DOM to poke.
		await act(async () => {
			await new Promise((r) => setTimeout(r, 20));
		});

		const input = container.querySelector('input[type="file"]');
		expect(input).not.toBeNull();
		Object.defineProperty(input, "files", {
			value: [
				new File(["a"], "ready.jpg", { type: "image/jpeg" }),
				new File(["b"], "pending.jpg", { type: "image/jpeg" }),
			],
		});
		await act(async () => {
			input?.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event);
		});
		expect(uploads.length).toBe(2);
		await act(async () => {
			uploads[0]?.settle.ok({
				path: "attachments/ready",
				mediaType: "image/jpeg",
				filename: "ready.jpg",
				size: 1,
			});
		});
		// The still-uploading chip is part of the composer before the send.
		expect(container.textContent).toContain("pending.jpg");

		// Send: the ready attachment creates the conversation — the
		// empty-state composer unmounts, ChatView mounts with the seed.
		await act(async () => {
			container
				.querySelector("form")
				?.dispatchEvent(
					new win.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
				);
		});
		await act(async () => {
			await new Promise((r) => setTimeout(r, 30));
		});
		expect(created).toBe(true);

		// The second upload finishes after the unmount — its chip must
		// still be there in the new conversation's composer.
		await act(async () => {
			uploads[1]?.settle.ok({
				path: "attachments/pending",
				mediaType: "image/jpeg",
				filename: "pending.jpg",
				size: 1,
			});
		});
		expect(container.textContent).toContain("pending.jpg");
	});
});

// The rail rows: three icon actions per row (aria-labeled glyphs) — pin
// · rename · archive on active rows, rename · unarchive · delete on
// archived ones — and a pinned row floating above the activity order
// (design/app.md → Pinning). Same happy-dom mount as above; the fetch
// fake keeps mutable pin/archive stamps so the list reflects each
// PATCH. The payload arrives in activity order (fresh first) so the
// client's own pinned-first partition is what puts the pinned row on
// top.
describe("rail row actions and the pinned pool", () => {
	let win: Window;
	let container: HTMLElement;
	let root: Root | null = null;
	let installed: string[] = [];
	let pinnedStamp: string | null;
	let freshStamp: string | null;
	let archived: Record<"pinned" | "fresh", string | null>;
	let patches: { id: string; body: unknown }[];
	let failPatch: boolean;
	const realFetch = globalThis.fetch;

	const installGlobal = (name: string, value: unknown) => {
		Reflect.set(globalThis, name, value);
		installed.push(name);
	};

	const row = (title: string) => ({
		id: `app/${title.split(" ")[0]}`,
		title,
		preview: `${title} preview`,
		createdAt: "2026-10-08T00:00:00.000Z",
		updatedAt: "2026-10-09T00:00:00.000Z",
		archivedAt: null,
		pinnedAt: null,
	});

	beforeEach(() => {
		win = new Window();
		const div = win.document.createElement("div");
		win.document.body.appendChild(div);
		container = div as unknown as HTMLElement;
		installed = [];
		pinnedStamp = "2026-10-08T12:00:00.000Z";
		freshStamp = null;
		archived = { pinned: null, fresh: null };
		patches = [];
		failPatch = false;
		installGlobal("window", win);
		installGlobal("document", win.document);
		installGlobal("navigator", win.navigator);
		installGlobal("localStorage", win.localStorage);
		installGlobal("Event", win.Event);
		installGlobal("CustomEvent", win.CustomEvent);
		installGlobal("getComputedStyle", win.getComputedStyle);
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const method = init?.method ?? (input instanceof Request ? input.method : "GET");
			if (url === "/api/app/conversations" && method === "GET") {
				return Promise.resolve(
					jsonResponse({
						conversations: [
							{ ...row("fresh chat"), pinnedAt: freshStamp, archivedAt: archived.fresh },
							{ ...row("pinned chat"), pinnedAt: pinnedStamp, archivedAt: archived.pinned },
						],
					}),
				);
			}
			const patchMatch = /^\/api\/app\/conversations\/(pinned|fresh)$/.exec(url);
			if (patchMatch !== null && method === "PATCH") {
				if (failPatch)
					return Promise.resolve(jsonResponse({ error: "db is locked" }, 500));
				const id = patchMatch[1] as "pinned" | "fresh";
				const body = JSON.parse(String(init?.body)) as { pinned?: boolean; archived?: boolean };
				patches.push({ id, body });
				if (body.pinned !== undefined) {
					if (id === "pinned") pinnedStamp = body.pinned ? "2026-10-09T12:00:00.000Z" : null;
					else freshStamp = body.pinned ? "2026-10-09T12:00:00.000Z" : null;
				}
				if (body.archived !== undefined) {
					archived[id] = body.archived ? "2026-10-09T13:00:00.000Z" : null;
				}
				return Promise.resolve(jsonResponse(body));
			}
			if (url.endsWith("/messages")) return Promise.resolve(jsonResponse({ messages: [] }));
			if (url.endsWith("/stream")) return Promise.resolve(new Response(null, { status: 204 }));
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
		await act(async () => {
			el?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event);
		});
		await settle();
	};

	const domOrder = (): (string | null)[] =>
		[...container.querySelectorAll(".conv-title")].map((t) => t.textContent);

	const rowActions = (title: string): string[] => {
		const found = [...container.querySelectorAll(".conv")].find(
			(r) => r.querySelector(".conv-title")?.textContent === title,
		);
		if (found === undefined) return [];
		// Icon-only buttons — the accessible name is the contract.
		return [...found.querySelectorAll(".conv-actions button")].map(
			(b) => b.getAttribute("aria-label") ?? "",
		);
	};

	test("a pinned row floats above the activity order, marked and unpin-able", async () => {
		root = createRoot(container);
		await act(async () => {
			root?.render(<App />);
		});
		await settle();

		// fresh is newer by activity, the pinned row is older — the pin
		// wins the top slot.
		expect(domOrder()).toEqual(["pinned chat", "fresh chat"]);
		expect(container.querySelector(".conv-pin")).not.toBeNull();

		// Three labeled buttons per row, label reflecting the state.
		expect(rowActions("pinned chat")).toEqual(["Unpin", "Rename", "Archive"]);
		expect(rowActions("fresh chat")).toEqual(["Pin", "Rename", "Archive"]);

		// Pinning the fresh row PATCHes and pulls it into the pinned
		// group, keeping its activity lead inside the group.
		await click(
			[...container.querySelectorAll(".conv")]
				.find((r) => r.querySelector(".conv-title")?.textContent === "fresh chat")
				?.querySelector(".conv-actions button"),
		);
		expect(patches).toEqual([{ id: "fresh", body: { pinned: true } }]);
		expect(domOrder()).toEqual(["fresh chat", "pinned chat"]);
		expect(rowActions("fresh chat")).toEqual(["Unpin", "Rename", "Archive"]);

		// Unpin drops it back below the remaining pin.
		await click(
			[...container.querySelectorAll(".conv")]
				.find((r) => r.querySelector(".conv-title")?.textContent === "fresh chat")
				?.querySelector(".conv-actions button"),
		);
		expect(patches).toEqual([
			{ id: "fresh", body: { pinned: true } },
			{ id: "fresh", body: { pinned: false } },
		]);
		expect(domOrder()).toEqual(["pinned chat", "fresh chat"]);
		expect(rowActions("fresh chat")).toEqual(["Pin", "Rename", "Archive"]);
	});

	test("archive shelves the row; the archived row swaps pin/archive for unarchive and delete", async () => {
		root = createRoot(container);
		await act(async () => {
			root?.render(<App />);
		});
		await settle();

		// Delete is unreachable from the rail — the archived section first.
		expect(
			[...container.querySelectorAll(".conv-actions button")].some(
				(b) => b.getAttribute("aria-label") === "Delete",
			),
		).toBe(false);

		await click(
			[...container.querySelectorAll(".conv")]
				.find((r) => r.querySelector(".conv-title")?.textContent === "fresh chat")
				?.querySelectorAll(".conv-actions button")[2],
		);
		expect(patches).toEqual([{ id: "fresh", body: { archived: true } }]);
		// Only the fresh row shelves — the pinned row stays on the rail.
		expect(rowActions("fresh chat")).toEqual([]);
		expect(rowActions("pinned chat")).toEqual(["Unpin", "Rename", "Archive"]);
		const toggle = container.querySelector(".rail-archived");
		expect(toggle?.textContent).toBe("Archived (1)");

		await click(toggle);
		expect(rowActions("fresh chat")).toEqual(["Rename", "Unarchive", "Delete"]);

		await click(
			[...container.querySelectorAll(".conv")]
				.find((r) => r.querySelector(".conv-title")?.textContent === "fresh chat")
				?.querySelectorAll(".conv-actions button")[1],
		);
		expect(patches).toEqual([
			{ id: "fresh", body: { archived: true } },
			{ id: "fresh", body: { archived: false } },
		]);
		expect(rowActions("fresh chat")).toEqual(["Pin", "Rename", "Archive"]);
	});

	test("a failed row mutation surfaces an alert naming the action and the row", async () => {
		failPatch = true;
		root = createRoot(container);
		await act(async () => {
			root?.render(<App />);
		});
		await settle();

		await click(
			[...container.querySelectorAll(".conv")]
				.find((r) => r.querySelector(".conv-title")?.textContent === "fresh chat")
				?.querySelector(".conv-actions button"),
		);
		const alert = container.querySelector('p.error[role="alert"]');
		expect(alert?.textContent).toContain('Couldn\'t pin "fresh chat"');
		expect(alert?.textContent).toContain("db is locked");
		// The row didn't move — the list reflects the unchanged server.
		expect(domOrder()).toEqual(["pinned chat", "fresh chat"]);
	});
});

// Back/forward is a navigation like any other. An unsaved settings editor
// gets the same question the in-app links ask. Indexed history can undo a
// declined traversal. Without native keys, legacy entries expose no direction:
// retain the draft and warn, rather than overwrite the destination entry.
describe("browser back/forward and the unsaved settings editor", () => {
	let win: Window;
	let container: HTMLElement;
	let root: Root | null = null;
	let installed: string[] = [];
	let confirmAnswer = false;
	let confirmCalls = 0;
	let confirmMessages: string[] = [];
	let conversations: AppConversationList["conversations"] = [];
	let settings: typeof SETTINGS;
	let savedBodies: ConfigPostBody[] = [];
	const realFetch = globalThis.fetch;

	const installGlobal = (name: string, value: unknown) => {
		Reflect.set(globalThis, name, value);
		installed.push(name);
	};

	const SETTINGS = parseConfig({
		providers: {
			main: { kind: "openai-compatible", baseUrl: "https://api.example.test", auth: "fixture" },
		},
		model: "main/test",
		allowedUsers: [111],
		telegram: { model: "main/test", thinking: "medium" },
	});

	beforeEach(() => {
		win = new Window({ url: "http://localhost/app/settings" });
		const div = win.document.createElement("div");
		win.document.body.appendChild(div);
		container = div as unknown as HTMLElement;
		installed = [];
		confirmAnswer = false;
		confirmCalls = 0;
		confirmMessages = [];
		conversations = [];
		settings = SETTINGS;
		savedBodies = [];
		installGlobal("window", win);
		installGlobal("document", win.document);
		installGlobal("navigator", win.navigator);
		installGlobal("localStorage", win.localStorage);
		installGlobal("Event", win.Event);
		installGlobal("CustomEvent", win.CustomEvent);
		installGlobal("getComputedStyle", win.getComputedStyle);
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
		Reflect.set(win, "confirm", (message: string) => {
			confirmCalls += 1;
			confirmMessages.push(message);
			return message.startsWith("Delete ") || confirmAnswer;
		});
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === "/api/app/conversations") return Promise.resolve(jsonResponse({ conversations }));
			if (url === "/api/app/conversations/fixture") {
				if (init?.method === "DELETE") conversations = [];
				if (init?.method === "PATCH")
					conversations = conversations.map((c) => ({ ...c, archivedAt: "2026-10-10T00:00:00Z" }));
				return Promise.resolve(jsonResponse({ ok: true }));
			}
			if (url.endsWith("/messages")) return Promise.resolve(jsonResponse({ messages: [] }));
			if (url.endsWith("/stream")) return Promise.resolve(new Response(null, { status: 204 }));
			if (url === "/api/app/settings" && init?.method === "POST") {
				savedBodies.push(JSON.parse(String(init.body)) as ConfigPostBody);
				return Promise.resolve(jsonResponse({ ok: true }));
			}
			if (url === "/api/app/settings")
				return Promise.resolve(
					new Response(
						JSON.stringify({
							config: settings,
							providerKinds: ["openai-compatible"],
							searchKinds: ["ddg", "brave", "jina"],
							fetchKinds: ["local", "firecrawl", "jina"],
							transcriptionKinds,
							transcriptionDefaults,
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
			return Promise.resolve(
				jsonResponse({
					model: "main/test",
					thinking: "medium",
					favorites: [],
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
	const mount = async () => {
		root = createRoot(container);
		await act(async () => {
			root?.render(<App />);
		});
		await waitFor(() => container.querySelector(".settings") !== null, "settings page");
	};
	const click = async (el: Element | null | undefined) => {
		expect(el).toBeTruthy();
		await act(async () => {
			el?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event);
		});
		await settle();
	};
	const dirtyTheForm = async () => {
		await click(
			[...container.querySelectorAll("button.idx")].find((b) => b.textContent?.includes("Access")),
		);
		await click(
			[...container.querySelectorAll('[aria-label="Log level"] button')].find(
				(b) => b.textContent === "debug",
			),
		);
		expect(container.textContent).toContain("unsaved");
	};
	// The browser has already moved to `path`; popstate is what it delivers.
	const browserGoesTo = async (path: string) => {
		await act(async () => {
			win.history.replaceState(null, "", path);
			win.dispatchEvent(new win.PopStateEvent("popstate"));
		});
		await settle();
	};

	const openPage = async (label: string) =>
		click([...container.querySelectorAll(".rail-ops button")].find((b) => b.textContent === label));
	const traverse = async (direction: "back" | "forward") => {
		await act(async () => {
			win.history[direction]();
			await new Promise((r) => setTimeout(r, 30));
		});
		await settle();
	};

	const seedConversation = (archived = false) => {
		conversations = [
			{
				id: "app/fixture",
				title: "fixture chat",
				preview: "fixture",
				createdAt: "2026-10-10T00:00:00Z",
				updatedAt: "2026-10-10T00:00:00Z",
				archivedAt: archived ? "2026-10-10T00:00:00Z" : null,
				pinnedAt: null,
			},
		];
	};
	const selectFixture = async (archived = false) => {
		if (archived) await click(container.querySelector(".rail-archived"));
		await click(container.querySelector(".conv-main"));
		expect(win.location.pathname).toBe("/app/c/fixture");
	};
	const removeFixture = async (action: "Archive" | "Delete") =>
		click(
			[...container.querySelectorAll(".conv-actions button")].find(
				(b) => (b.getAttribute("aria-label") ?? b.textContent) === action,
			),
		);

	test("repeated conversation and empty-chat selection do not add history entries", async () => {
		seedConversation();
		await mount();
		await selectFixture();
		const selectedState = win.history.state;
		const selectedLength = win.history.length;
		await selectFixture();
		expect(win.history.state).toEqual(selectedState);
		expect(win.history.length).toBe(selectedLength);

		// The remembered id is not a reason to skip leaving an operator page.
		await openPage("Memories");
		await selectFixture();
		expect(container.querySelector(".chat")).not.toBeNull();
		await click(container.querySelector(".new"));
		const emptyState = win.history.state;
		const emptyLength = win.history.length;
		await click(container.querySelector(".new"));
		expect(win.location.pathname).toBe("/app/");
		expect(win.history.state).toEqual(emptyState);
		expect(win.history.length).toBe(emptyLength);
	});

	for (const action of ["Archive", "Delete"] as const) {
		for (const label of [
			"Settings",
			"Memories",
			"Delegations",
			"Programs",
			"Status",
			"dirty Settings",
		]) {
			test(`${action} of the remembered conversation preserves ${label} without a discard prompt`, async () => {
				const archived = action === "Delete";
				seedConversation(archived);
				await mount();
				await selectFixture(archived);
				await openPage(label === "dirty Settings" ? "Settings" : label);
				if (label === "dirty Settings") await dirtyTheForm();
				const page = container.querySelector("main > header .header-title")?.textContent;
				const path = win.location.pathname;
				const state = win.history.state;
				const length = win.history.length;
				const editor = container.querySelector(".settings");

				await removeFixture(action);

				expect(win.location.pathname).toBe(path);
				expect(win.history.state).toEqual(state);
				expect(win.history.length).toBe(length);
				expect(container.querySelector("main > header .header-title")?.textContent).toBe(page);
				expect(container.querySelector(".settings")).toBe(editor);
				expect(confirmMessages).toEqual(archived ? ['Delete "fixture chat"?'] : []);
				if (label === "dirty Settings") {
					expect(container.textContent).toContain("unsaved");
					expect(container.querySelector('[aria-label="Log level"] button.on')?.textContent).toBe(
						"debug",
					);
				}
				if (archived) expect(conversations).toEqual([]);
				else {
					expect(conversations[0]?.archivedAt).not.toBeNull();
					await click(container.querySelector(".rail-archived"));
					expect(container.querySelector(".conv")).not.toBeNull();
					expect(container.querySelector(".conv.current")).toBeNull();
				}
			});
		}
		test(`${action} of the open conversation still goes to empty chat`, async () => {
			seedConversation(action === "Delete");
			await mount();
			await selectFixture(action === "Delete");
			await removeFixture(action);
			expect(win.location.pathname).toBe("/app/");
			expect(container.querySelector(".chat")?.textContent).toContain("Pick a conversation");
			expect(container.querySelector("header .header-title")).toBeNull();
		});
	}

	test("search and fetch kind changes clear only the changed provider's credential before save", async () => {
		settings = parseConfig({
			...SETTINGS,
			search: [
				{ kind: "brave", auth: "search-key" },
				{ kind: "jina", auth: "search-fallback" },
			],
			fetch: [
				{ kind: "firecrawl", auth: "fetch-key" },
				{ kind: "jina", auth: "fetch-fallback" },
			],
		});
		await mount();
		await click(
			[...container.querySelectorAll("button.idx")].find((b) => b.textContent?.includes("Web")),
		);
		const providers = [...container.querySelectorAll<HTMLSelectElement>(".chain-card select")];
		const credentials = () =>
			[...container.querySelectorAll<HTMLInputElement>(".chain-card input")].map((e) => e.value);
		const change = async (index: number, kind: string) => {
			await act(async () => {
				const select = providers[index]!;
				select.value = kind;
				select.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event);
			});
			await settle();
		};
		expect(credentials()).toEqual(["search-key", "search-fallback", "fetch-key", "fetch-fallback"]);
		await change(0, "brave");
		await change(2, "firecrawl");
		expect(credentials()).toEqual(["search-key", "search-fallback", "fetch-key", "fetch-fallback"]);
		await change(0, "jina");
		expect(credentials()).toEqual(["", "search-fallback", "fetch-key", "fetch-fallback"]);
		await change(2, "jina");
		expect(credentials()).toEqual(["", "search-fallback", "", "fetch-fallback"]);
		await click([...container.querySelectorAll("button")].find((b) => b.textContent === "Save"));
		expect(savedBodies).toHaveLength(1);
		expect(savedBodies[0]?.search).toEqual([
			{ kind: "jina" },
			{ kind: "jina", auth: "search-fallback" },
		]);
		expect(savedBodies[0]?.fetch).toEqual([
			{ kind: "jina" },
			{ kind: "jina", auth: "fetch-fallback" },
		]);
	});

	for (const direction of ["back", "forward"] as const) {
		test(`declining real browser ${direction} preserves the history stack and draft`, async () => {
			await mount();
			await openPage("Memories");
			if (direction === "back") {
				await openPage("Settings");
			} else {
				await traverse("back");
			}
			await dirtyTheForm();
			const entries = win.history.length;

			await traverse(direction);
			expect(confirmCalls).toBe(1);
			expect(win.location.pathname).toBe("/app/settings");
			expect(win.history.length).toBe(entries);
			expect(container.textContent).toContain("unsaved");
			expect(container.querySelector('[aria-label="Log level"] button.on')?.textContent).toBe(
				"debug",
			);

			confirmAnswer = true;
			await traverse(direction);
			expect(confirmCalls).toBe(2);
			expect(win.location.pathname).toBe("/app/memory");
			expect(container.querySelector(".settings")).toBeNull();
			await traverse(direction === "back" ? "forward" : "back");
			expect(win.location.pathname).toBe("/app/settings");
			expect(container.querySelector(".settings")).not.toBeNull();
		});
	}

	for (const direction of ["back", "forward"] as const) {
		test(`without native navigation, legacy ${direction} preserves the draft and destination and warns`, async () => {
			if (direction === "back") {
				win.history.replaceState({ legacy: "memory" }, "", "/app/memory");
				win.history.pushState({ legacy: "settings" }, "", "/app/settings");
				await mount();
			} else {
				// happy-dom's replaceState truncates forward history. Seed
				// the unmarked destination after the initial mount instead.
				await mount();
				win.history.pushState({ legacy: "memory" }, "", "/app/memory");
				await traverse("back");
			}
			await dirtyTheForm();

			await traverse(direction);
			expect(confirmCalls).toBe(1);
			expect(container.querySelector(".settings")).not.toBeNull();
			expect(container.textContent).toContain("unsaved");
			expect(container.querySelector('[role="alert"]')?.textContent).toContain(
				"cannot restore an older history entry",
			);
			expect(win.location.pathname).toBe("/app/memory");
			expect(win.history.state).toEqual({ legacy: "memory" });

			await traverse(direction === "back" ? "forward" : "back");
			confirmAnswer = true;
			await traverse(direction);
			expect(confirmCalls).toBe(2);
			expect(container.querySelector(".settings")).toBeNull();
			expect(win.location.pathname).toBe("/app/memory");
		});
	}

	test("leaving the document warns only when the settings editor is dirty", async () => {
		await mount();
		const clean = new win.Event("beforeunload", { cancelable: true });
		win.dispatchEvent(clean);
		expect(clean.defaultPrevented).toBe(false);
		await dirtyTheForm();
		const dirty = new win.Event("beforeunload", { cancelable: true });
		win.dispatchEvent(dirty);
		expect(dirty.defaultPrevented).toBe(true);
		confirmAnswer = true;
		await openPage("Memories");
		const afterLeaving = new win.Event("beforeunload", { cancelable: true });
		win.dispatchEvent(afterLeaving);
		expect(afterLeaving.defaultPrevented).toBe(false);
	});

	test("an accepted legacy gap breaks index continuity instead of guessing a restoration distance", async () => {
		await mount();
		await openPage("Memories");
		const memoryState = win.history.state;
		win.history.pushState({ legacy: true }, "", "/app/memory");
		await traverse("back");
		await traverse("forward");
		await openPage("Settings");
		await dirtyTheForm();
		await act(async () => {
			win.history.go(-2);
			await new Promise((r) => setTimeout(r, 30));
		});
		await settle();
		expect(confirmCalls).toBe(1);
		expect(container.textContent).toContain("unsaved");
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			"cannot restore an older history entry",
		);
		expect(win.history.state).toEqual(memoryState);
		await act(async () => {
			win.history.go(2);
			await new Promise((r) => setTimeout(r, 30));
		});
		expect(win.location.pathname).toBe("/app/settings");
		expect(container.querySelector('[aria-label="Log level"] button.on')?.textContent).toBe(
			"debug",
		);
	});

	test("Back into the conversation list also asks while the editor is dirty", async () => {
		await mount();
		await dirtyTheForm();
		await browserGoesTo("/app/");
		expect(confirmCalls).toBe(1);
		expect(container.querySelector(".settings")).not.toBeNull();
	});

	test("pushing after a declined legacy traversal starts a new segment at the browser's actual position", async () => {
		await mount();
		win.history.pushState({ legacy: "memory" }, "", "/app/memory");
		await traverse("back");
		await dirtyTheForm();
		await traverse("forward");
		confirmAnswer = true;
		await openPage("Memories");
		const memoryState = win.history.state;
		await openPage("Settings");
		await dirtyTheForm();
		await act(async () => {
			win.history.go(-3);
			await new Promise((r) => setTimeout(r, 30));
		});
		await settle();
		expect(win.location.pathname).toBe("/app/settings");
		const calls = confirmCalls;
		confirmAnswer = false;
		await act(async () => {
			win.history.go(2);
			await new Promise((r) => setTimeout(r, 30));
		});
		await settle();
		expect(confirmCalls - calls).toBe(1);
		expect(win.history.state).toEqual(memoryState);
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			"cannot restore an older history entry",
		);
		expect(container.querySelector('[aria-label="Log level"] button.on')?.textContent).toBe(
			"debug",
		);
	});

	test("Back from a clean editor needs no question", async () => {
		await mount();
		await browserGoesTo("/app/memory");
		expect(confirmCalls).toBe(0);
		expect(container.querySelector(".settings")).toBeNull();
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { UIMessage } from "ai";
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
	AppNoteVersion,
	AppNoteVersionMeta,
	AppProject,
} from "../../src/http/app-wire.ts";
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
			if (url === "/api/app/projects") {
				return Promise.resolve(jsonResponse({ projects: [] }));
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
			if (url === "/api/app/projects") {
				return Promise.resolve(jsonResponse({ projects: [] }));
			}
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
				if (failPatch) return Promise.resolve(jsonResponse({ error: "db is locked" }, 500));
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
			if (url === "/api/app/projects") return Promise.resolve(jsonResponse({ projects: [] }));
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
							authDefaults,
							authNames: ["main", "groq"],
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
		// An invalid edit: dropping the last allowed user can never
		// validate, so the autosave can't write it and the editor stays
		// dirty — that's the state the nav guard must still question.
		await click(container.querySelector(".chip button"));
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
				projectId: null,
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
					expect(container.querySelectorAll(".chips .chip")).toHaveLength(0);
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
		// Edits write themselves — the last posted body must carry the
		// final state.
		await waitFor(() => savedBodies.length > 0, "the edits to write themselves");
		expect(savedBodies.at(-1)?.search).toEqual([
			{ kind: "jina" },
			{ kind: "jina", auth: "search-fallback" },
		]);
		expect(savedBodies.at(-1)?.fetch).toEqual([
			{ kind: "jina" },
			{ kind: "jina", auth: "fetch-fallback" },
		]);
	});

	test("a valid edit writes itself — no Save click needed", async () => {
		await mount();
		await click(
			[...container.querySelectorAll("button.idx")].find((b) => b.textContent?.includes("Access")),
		);
		await click(
			[...container.querySelectorAll('[aria-label="Log level"] button')].find(
				(b) => b.textContent === "debug",
			),
		);
		await waitFor(() => savedBodies.length > 0, "settings to write themselves");
		expect(savedBodies.at(-1)?.logLevel).toBe("debug");
		expect(container.textContent).not.toContain("unsaved");
	});

	test("an invalid edit cannot write itself — it stays unsaved with the reason", async () => {
		await mount();
		await dirtyTheForm();
		for (let i = 0; i < 40; i++) await settle();
		expect(savedBodies).toHaveLength(0);
		expect(container.textContent).toContain("unsaved");
		expect(container.textContent).toContain("Allowed users must keep at least one Telegram id.");
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
			expect(container.querySelectorAll(".chips .chip")).toHaveLength(0);

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
		expect(container.querySelectorAll(".chips .chip")).toHaveLength(0);
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
		expect(container.querySelectorAll(".chips .chip")).toHaveLength(0);
	});

	test("Back from a clean editor needs no question", async () => {
		await mount();
		await browserGoesTo("/app/memory");
		expect(confirmCalls).toBe(0);
		expect(container.querySelector(".settings")).toBeNull();
	});
});

// The Telegram mini app door (design/telegram.md → Mini Apps): /t/
// renders the operator surface only, over initData, and never touches
// the app channel — no token gate, no rail, no conversations.
describe("App telegram door", () => {
	let win: Window;
	let container: HTMLElement;
	let root: Root | null = null;
	let installed: string[] = [];
	let appDoorHits: string[] = [];
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
		win = new Window({ url: "http://localhost/t/settings" });
		Reflect.set(win, "Telegram", {
			WebApp: { initData: "user=%7B%22id%22%3A111%7D&hash=abc" },
		});
		const div = win.document.createElement("div");
		win.document.body.appendChild(div);
		container = div as unknown as HTMLElement;
		installed = [];
		appDoorHits = [];
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
			if (url.startsWith("/api/app/")) {
				appDoorHits.push(url);
				return Promise.resolve(new Response(null, { status: 404 }));
			}
			if (url === "/api/settings")
				return Promise.resolve(
					new Response(
						JSON.stringify({
							config: SETTINGS,
							providerKinds: ["openai-compatible"],
							searchKinds: ["ddg"],
							fetchKinds: ["local"],
							transcriptionKinds,
							transcriptionDefaults,
							authDefaults,
							authNames: ["main"],
						}),
						{ headers: { "content-type": "application/json", etag: '"v1"' } },
					),
				);
			if (url === "/api/memory/status")
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
			if (url.startsWith("/api/memory/documents"))
				return Promise.resolve(jsonResponse({ items: [], total: 0, limit: 20, offset: 0 }));
			if (url.includes("thinking-levels"))
				return Promise.resolve(jsonResponse({ levels: ["off", "low", "medium", "high"] }));
			return Promise.resolve(jsonResponse({}));
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

	const renderDoor = async () => {
		root = createRoot(container);
		await act(async () => {
			root?.render(<App />);
		});
		await act(async () => {
			await new Promise((r) => setTimeout(r, 20));
		});
	};

	test("settings render over initData; the app door is never touched", async () => {
		await renderDoor();
		expect(container.querySelector('input[type="password"]')).toBeNull(); // no token gate
		expect(container.textContent).not.toContain("New conversation"); // no rail
		expect(container.textContent).not.toContain("Pick a conversation"); // no chat
		expect(appDoorHits).toEqual([]);
	});

	test("initData rides every request as x-init-data", async () => {
		const seen: string[] = [];
		const real = globalThis.fetch;
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			seen.push(String(init?.headers ? new Headers(init.headers).get("x-init-data") : null));
			return real(input, init);
		}) as typeof fetch;
		await renderDoor();
		expect(seen.filter((v) => v === "user=%7B%22id%22%3A111%7D&hash=abc").length).toBeGreaterThan(
			0,
		);
		expect(seen.includes("null")).toBe(false);
	});

	test("a plain browser has no initData — a notice, not a form that cannot save", async () => {
		Reflect.deleteProperty(win, "Telegram");
		await renderDoor();
		expect(container.textContent).toContain("Open this page from Telegram");
		expect(appDoorHits).toEqual([]);
	});

	test("the door's page scope is settings and memories — /t/memory renders memories", async () => {
		win.history.replaceState({}, "", "/t/memory");
		await renderDoor();
		expect(container.textContent).toContain("Memories");
		expect(appDoorHits).toEqual([]);
	});
});

// Projects (design/projects.md): the rail's Projects section above the
// chat list, bound chats living only on their project's page, the
// create dialog's wire shape, and the project composer's creation-time
// binding. Same happy-dom mount + fetch-at-the-edge fake as above.
describe("app projects surface", () => {
	let win: Window;
	let container: HTMLElement;
	let root: Root | null = null;
	let installed: string[] = [];
	let convs: AppConversationList["conversations"];
	let projs: AppProject[];
	let notes: AppNoteSummary[];
	let stored: UIMessage[];
	let conflictPatch: boolean;
	// Conversation creation control: POST /api/app/conversations 500s.
	let failCreate: boolean;
	// Focus-refresh controls: the note GET fails, or answers with a
	// remote version newer than the fixture row.
	let noteGetFail: boolean;
	let noteGetOverride: AppNote | null;
	// PATCH attempts — a blur during conflict must not even try.
	let patchCalls: number;
	let versionRows: AppNoteVersionMeta[];
	let versionPreview: AppNoteVersion | null;
	let posts: { url: string; body: unknown }[];
	const realFetch = globalThis.fetch;

	const installGlobal = (name: string, value: unknown) => {
		Reflect.set(globalThis, name, value);
		installed.push(name);
	};

	const convRow = (
		title: string,
		over: Partial<AppConversationList["conversations"][number]> = {},
	) => ({
		id: `app/${title.split(" ")[0]}`,
		title,
		preview: `${title} preview`,
		createdAt: "2026-10-08T00:00:00.000Z",
		updatedAt: "2026-10-09T00:00:00.000Z",
		archivedAt: null,
		pinnedAt: null,
		projectId: null,
		...over,
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
		pinnedAt: null,
		archivedAt: null,
		updatedAt: "2026-10-10T00:00:00.000Z",
		preview: "",
		...over,
	});
	const noteFull = (s: AppNoteSummary, body = "") => ({
		...s,
		body,
		lastSource: "app" as const,
		createdAt: "2026-10-08T00:00:00.000Z",
	});

	beforeEach(() => {
		// A real URL — history.pushState can't leave about:blank.
		win = new Window({ url: "http://localhost/app/" });
		const div = win.document.createElement("div");
		win.document.body.appendChild(div);
		container = div as unknown as HTMLElement;
		installed = [];
		convs = [];
		projs = [];
		notes = [];
		stored = [];
		conflictPatch = false;
		failCreate = false;
		noteGetFail = false;
		noteGetOverride = null;
		patchCalls = 0;
		versionRows = [];
		versionPreview = null;
		posts = [];
		installGlobal("window", win);
		installGlobal("document", win.document);
		installGlobal("navigator", win.navigator);
		installGlobal("localStorage", win.localStorage);
		installGlobal("Event", win.Event);
		installGlobal("CustomEvent", win.CustomEvent);
		installGlobal("getComputedStyle", win.getComputedStyle);
		// The note page lazy-mounts Milkdown — its ctx signals readiness
		// with bare dispatchEvent/addEventListener, which must ride the
		// happy-dom realm, not Bun's (noteMarkdown.test.ts's ruling).
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
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const method = init?.method ?? (input instanceof Request ? input.method : "GET");
			const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
			if (url === "/api/app/conversations") {
				if (method === "POST") {
					posts.push({ url, body });
					if (failCreate) return Promise.resolve(jsonResponse({ error: "mint down" }, 500));
					return Promise.resolve(
						jsonResponse({ id: "app/minted", title: null, createdAt: "2026-10-10T00:00:00Z" }, 201),
					);
				}
				return Promise.resolve(jsonResponse({ conversations: convs }));
			}
			if (url === "/api/app/projects") {
				if (method === "POST") {
					posts.push({ url, body });
					const req = body as { name: string };
					const project = projRow(req.name, { id: "p-new" });
					projs.push(project);
					return Promise.resolve(jsonResponse(project, 201));
				}
				return Promise.resolve(jsonResponse({ projects: projs }));
			}
			if (url.startsWith("/api/app/notes/")) {
				const id = decodeURIComponent(url.slice("/api/app/notes/".length).split("/")[0]!);
				if (url.endsWith("/rewrite") && method === "POST") {
					posts.push({ url, body });
					return Promise.resolve(jsonResponse({ replacement: "a tighter take" }));
				}
				if (url.endsWith("/append")) {
					posts.push({ url, body });
					const n = notes.find((x) => x.id === id);
					return Promise.resolve(
						n === undefined ? jsonResponse({ error: "not found" }, 404) : jsonResponse(noteFull(n)),
					);
				}
				if (url.endsWith("/versions"))
					return Promise.resolve(jsonResponse({ versions: versionRows }));
				if (/\/versions\/\d+$/.test(url))
					return Promise.resolve(
						versionPreview === null
							? jsonResponse({ error: "not found" }, 404)
							: jsonResponse(versionPreview),
					);
				if (method === "PATCH") patchCalls++;
				if (method === "PATCH" && conflictPatch) {
					const n = notes.find((x) => x.id === id);
					return Promise.resolve(
						jsonResponse({ error: "conflict", note: { ...noteFull(n!), rev: 5 } }, 409),
					);
				}
				if (method === "GET") {
					if (noteGetFail) return Promise.resolve(jsonResponse({ error: "list down" }, 500));
					if (noteGetOverride !== null) return Promise.resolve(jsonResponse(noteGetOverride));
				}
				const n = notes.find((x) => x.id === id);
				return Promise.resolve(
					n === undefined ? jsonResponse({ error: "not found" }, 404) : jsonResponse(noteFull(n)),
				);
			}
			if (url === "/api/app/notes" || url.startsWith("/api/app/notes?")) {
				if (method === "POST") {
					posts.push({ url, body });
					const req = body as { title: string; projectId?: string };
					const n = noteRow(req.title, { id: "n-new", projectId: req.projectId ?? null });
					notes.push(n);
					return Promise.resolve(jsonResponse(noteFull(n), 201));
				}
				const u = new URL(url, "http://localhost");
				const archivedOnly = u.searchParams.get("archived") === "1";
				const scope = u.searchParams.get("project");
				return Promise.resolve(
					jsonResponse({
						notes: notes.filter(
							(n) =>
								(n.archivedAt !== null) === archivedOnly &&
								(scope === null || scope === "all"
									? true
									: scope === "loose"
										? n.projectId === null
										: n.projectId === scope),
						),
					}),
				);
			}
			if (url.endsWith("/messages")) return Promise.resolve(jsonResponse({ messages: stored }));
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

	const settle = async () => {
		await act(async () => {
			await new Promise((r) => setTimeout(r, 30));
		});
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
			// this environment (MemoryView.test's ruling).
			(el as HTMLElement).focus();
			Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
			el.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
			el.dispatchEvent(
				new win.KeyboardEvent("keyup", { bubbles: true, key: "e" }) as unknown as Event,
			);
		});
		await settle();
	};

	test("the rail's Projects section lists active projects; bound chats leave the main list", async () => {
		projs = [
			projRow("Goblin Work"),
			projRow("Old Stuff", { archivedAt: "2026-10-09T00:00:00.000Z" }),
		];
		convs = [convRow("loose chat"), convRow("inside chat", { projectId: "p-goblin" })];
		await mount();

		const section = container.querySelector(".rail-projects");
		expect(section).not.toBeNull();
		expect(section!.textContent).toContain("Goblin Work");
		expect(section!.textContent).toContain("New project");
		// Archived projects stay off the rail — they wait on the index.
		expect(section!.textContent).not.toContain("Old Stuff");

		const railTitles = [...container.querySelectorAll(".rail .conv-title")].map(
			(t) => t.textContent,
		);
		expect(railTitles).toContain("loose chat");
		expect(railTitles).not.toContain("inside chat");

		// The project page is where bound chats live.
		await click(
			[...section!.querySelectorAll(".proj")].find((b) => b.textContent === "Goblin Work"),
		);
		expect(win.location.pathname).toBe("/app/p/p-goblin");
		expect(container.querySelector("main")!.textContent).toContain("Goblin Work");
		expect([...container.querySelectorAll("main .conv-title")].map((t) => t.textContent)).toEqual([
			"inside chat",
		]);

		// The index page holds the archived shelf — collapsed by
		// default, like the rail's archived chats.
		await click(container.querySelector(".rail-section"));
		expect(win.location.pathname).toBe("/app/projects");
		const details = container.querySelector("main .tuning");
		expect(details).not.toBeNull();
		expect(details!.textContent).toContain("Archived projects (1)");
		expect((details as HTMLDetailsElement).open).toBe(false);
		expect(details!.textContent).toContain("Old Stuff");
	});

	test("the create dialog posts its fields and lands on the new project's page", async () => {
		await mount();
		await click(
			[...container.querySelectorAll(".rail-projects button")].find(
				(b) => b.textContent === "New project",
			),
		);
		const sheet = container.querySelector(".msheet form");
		expect(sheet).not.toBeNull();
		const nameInput = sheet!.querySelector("input")!;
		await typeInto(nameInput, "Side Hustle", win.HTMLInputElement.prototype);
		expect((nameInput as HTMLInputElement).value).toBe("Side Hustle");
		await typeInto(
			sheet!.querySelector("textarea")!,
			"Ship the thing.",
			win.HTMLTextAreaElement.prototype,
		);
		await act(async () => {
			sheet!.dispatchEvent(
				new win.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
			);
		});
		await settle();
		expect(posts).toHaveLength(1);
		// Managed home and shared memory are the defaults — they ride
		// only when the operator asks for something else.
		expect(posts[0]).toEqual({
			url: "/api/app/projects",
			body: { name: "Side Hustle", instructions: "Ship the thing." },
		});
		expect(win.location.pathname).toBe("/app/p/p-new");
		expect(container.querySelector("main")!.textContent).toContain("Side Hustle");
	});

	test("the project page composer binds the new conversation at creation", async () => {
		projs = [projRow("Goblin Work")];
		win.history.replaceState(null, "", "/app/p/p-goblin");
		await mount();
		expect(win.location.pathname).toBe("/app/p/p-goblin");

		const composer = container.querySelector("form.composer");
		expect(composer).not.toBeNull();
		await typeInto(
			composer!.querySelector("textarea")!,
			"hello project",
			win.HTMLTextAreaElement.prototype,
		);
		await act(async () => {
			composer!.dispatchEvent(
				new win.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
			);
		});
		await settle();
		const created = posts.find((p) => p.url === "/api/app/conversations");
		expect(created?.body).toEqual({ projectId: "p-goblin" });
	});

	test("an archived project shows a note instead of the composer", async () => {
		projs = [projRow("Goblin Work", { archivedAt: "2026-10-10T00:00:00.000Z" })];
		win.history.replaceState(null, "", "/app/p/p-goblin");
		await mount();

		expect(container.querySelector("form.composer")).toBeNull();
		expect(container.querySelector("main")!.textContent).toContain(
			"This project is archived — unarchive it to start new chats here.",
		);
	});

	test("the rail's Notes entry opens the index", async () => {
		notes = [noteRow("Shopping"), noteRow("Trip plans", { pinnedAt: "2026-10-09T00:00:00Z" })];
		await mount();

		await click(
			[...container.querySelectorAll(".rail-projects .rail-section")].find(
				(b) => b.textContent === "Notes",
			),
		);
		await settleSlow();
		expect(win.location.pathname).toBe("/app/notes");
		const main = container.querySelector("main")!;
		expect(main.textContent).toContain("Shopping");
		expect(main.textContent).toContain("Trip plans");
	});

	// The picker's debounce outlasts settle() — give it its own wait.
	const settleSlow = async () => {
		await act(async () => {
			await new Promise((r) => setTimeout(r, 300));
		});
	};

	test("the composer's note picker stages a chip that sends as data-note", async () => {
		notes = [noteRow("Shopping")];
		await mount();

		await click(container.querySelector('button[aria-label="Attach a note"]'));
		await settleSlow();
		const pick = container.querySelector(".composer-pick");
		expect(pick).not.toBeNull();
		await click([...pick!.querySelectorAll("li button")].find((b) => b.textContent === "Shopping"));
		expect(container.querySelector(".note-chip")!.textContent).toContain("Shopping");

		const form = container.querySelector("form.composer")!;
		await act(async () => {
			form.dispatchEvent(
				new win.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
			);
		});
		await settle();
		const chat = posts.find((p) => p.url === "/api/app/chat");
		expect(chat).toBeTruthy();
		const msg = (chat!.body as { message: { parts: { type: string; data?: unknown }[] } }).message;
		expect(msg.parts).toContainEqual({ type: "data-note", data: { id: "n-shopping" } });
	});

	test("a stored data-note part renders as a chip that opens the note", async () => {
		notes = [noteRow("Shopping", { rev: 3 })];
		convs = [convRow("note chat")];
		stored = [
			{
				id: "m1",
				role: "user",
				parts: [
					{ type: "text", text: "take a look" },
					{
						type: "data-note",
						data: { id: "n-shopping", title: "Shopping", rev: 3, body: "milk", projectId: null },
					} as never,
				],
			},
		];
		await mount();
		await click(
			[...container.querySelectorAll(".conv-title")].find((t) => t.textContent === "note chat"),
		);
		const chip = container.querySelector(".note-chip");
		expect(chip).not.toBeNull();
		expect(chip!.textContent).toContain("Note · Shopping · rev 3");
		await click(chip!.querySelector("button.attachment-name"));
		expect(win.location.pathname).toBe("/app/n/n-shopping");
	});

	test("a fenced note block offers an append card that POSTs the body", async () => {
		notes = [noteRow("Shopping")];
		convs = [convRow("fence chat")];
		stored = [
			{
				id: "m1",
				role: "assistant",
				parts: [
					{
						type: "text",
						text: 'here:\n\n````note title="List ideas"\nbread\n- milk\n\n```ts\ninner();\n```\n````',
					},
				],
			},
		];
		await mount();
		await click(
			[...container.querySelectorAll(".conv-title")].find((t) => t.textContent === "fence chat"),
		);
		const card = container.querySelector(".note-card");
		expect(card).not.toBeNull();
		// The inner triple fence survives inside the card's body.
		expect(card!.textContent).toContain("inner()");
		await click(
			[...card!.querySelectorAll("button")].find((b) => b.textContent === "Append to note…"),
		);
		await settleSlow();
		await click(
			[...card!.querySelectorAll(".note-pick li button")].find((b) => b.textContent === "Shopping"),
		);
		await settle();
		const append = posts.find((p) => p.url === "/api/app/notes/n-shopping/append");
		expect(append).toBeTruthy();
		expect((append!.body as { text: string }).text).toBe("bread\n- milk\n\n```ts\ninner();\n```");
		expect(card!.querySelector(".note-card-status")!.textContent).toContain("Appended to");
	});

	test("the append card's New note binds to the conversation's project", async () => {
		projs = [projRow("goblin")];
		notes = [noteRow("Shopping")];
		convs = [convRow("inside chat", { projectId: "p-goblin" })];
		stored = [
			{
				id: "m1",
				role: "assistant",
				parts: [{ type: "text", text: '````note title="Ideas"\nbread\n````' }],
			},
		];
		// Bound chats live on their project page, not the rail — deep-link.
		win.history.replaceState(null, "", "/app/c/inside");
		await mount();
		const card = container.querySelector(".note-card");
		expect(card).not.toBeNull();
		await click(
			[...card!.querySelectorAll("button")].find((b) => b.textContent === "Append to note…"),
		);
		await settleSlow();
		await click(
			[...card!.querySelectorAll(".note-pick li button")].find(
				(b) => b.textContent === "New note “Ideas”",
			),
		);
		await settle();
		const created = posts.find((p) => p.url === "/api/app/notes");
		expect((created!.body as { projectId?: string }).projectId).toBe("p-goblin");
	});

	test("the note page shows the conflict bar when a title save hits a newer rev", async () => {
		notes = [noteRow("Shopping")];
		conflictPatch = true;
		win.history.replaceState(null, "", "/app/n/n-shopping");
		await mount();
		expect(win.location.pathname).toBe("/app/n/n-shopping");

		const title = container.querySelector("input.note-title")!;
		await typeInto(title, "Shopping 2", win.HTMLInputElement.prototype);
		await act(async () => {
			title.dispatchEvent(
				new win.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }) as unknown as Event,
			);
		});
		await settle();
		const bar = container.querySelector(".note-conflict");
		expect(bar).not.toBeNull();
		expect(bar!.textContent).toContain("rev 5");
		expect(bar!.textContent).toContain("Load theirs");
		expect(bar!.textContent).toContain("Keep mine");
	});

	test("a clean focus refresh updates the title and flags", async () => {
		notes = [noteRow("Shopping")];
		win.history.replaceState(null, "", "/app/n/n-shopping");
		await mount();
		// The remote moved forward while we were away — clean page,
		// so the new title lands and flags follow.
		noteGetOverride = {
			...noteFull(notes[0]!),
			title: "Groceries",
			rev: 2,
			pinnedAt: "2026-10-11T00:00:00.000Z",
			updatedAt: "2026-10-11T00:00:00.000Z",
		};
		await act(async () => {
			win.dispatchEvent(new win.Event("focus"));
		});
		await settle();
		expect((container.querySelector("input.note-title") as HTMLInputElement).value).toBe(
			"Groceries",
		);
		expect(container.querySelector("main .pill")!.textContent).toBe("pinned");
	});

	test("a focus refresh meeting a dirty title raises the conflict bar", async () => {
		notes = [noteRow("Shopping")];
		win.history.replaceState(null, "", "/app/n/n-shopping");
		await mount();
		const title = container.querySelector("input.note-title")!;
		await typeInto(title, "Shopping 2", win.HTMLInputElement.prototype);
		noteGetOverride = { ...noteFull(notes[0]!), rev: 2, title: "Remote", updatedAt: "z" };
		await act(async () => {
			win.dispatchEvent(new win.Event("focus"));
		});
		await settle();
		const bar = container.querySelector(".note-conflict");
		expect(bar).not.toBeNull();
		// The local draft is untouched.
		expect((title as HTMLInputElement).value).toBe("Shopping 2");
	});

	test("a failed focus refresh shows an inline error and keeps the editor", async () => {
		notes = [noteRow("Shopping")];
		win.history.replaceState(null, "", "/app/n/n-shopping");
		await mount();
		noteGetFail = true;
		await act(async () => {
			win.dispatchEvent(new win.Event("focus"));
		});
		await settle();
		expect(container.querySelector(".error")!.textContent).toContain("Couldn't refresh");
		// The editor must still be mounted — a fatal return would have
		// dropped the buffer.
		expect(container.querySelector(".note-editor")).not.toBeNull();
	});

	test("a title blur while conflicted sends nothing — and restore stays locked", async () => {
		notes = [noteRow("Shopping")];
		conflictPatch = true;
		versionRows = [{ rev: 1, source: "app", conversation: null, at: "x", bytes: 4 }];
		versionPreview = {
			rev: 1,
			source: "app",
			conversation: null,
			at: "x",
			bytes: 4,
			title: "Shopping",
			body: "milk",
		};
		win.history.replaceState(null, "", "/app/n/n-shopping");
		await mount();
		const title = container.querySelector("input.note-title")!;
		await typeInto(title, "Shopping 2", win.HTMLInputElement.prototype);
		await act(async () => {
			title.dispatchEvent(
				new win.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }) as unknown as Event,
			);
		});
		await settle();
		expect(container.querySelector(".note-conflict")).not.toBeNull();
		expect(patchCalls).toBe(1);
		// A blur while the bar is up must not send the draft.
		await typeInto(title, "Shopping 3", win.HTMLInputElement.prototype);
		await act(async () => {
			title.dispatchEvent(new win.FocusEvent("focusout", { bubbles: true }) as unknown as Event);
		});
		await settle();
		expect(patchCalls).toBe(1);
		// Restore is locked while the conflict stands — it swaps the doc.
		await click(
			[...container.querySelectorAll("button")].find((b) => b.textContent === "Versions"),
		);
		await click(container.querySelector(".note-versions button.link"));
		const restore = [...container.querySelectorAll(".note-version-preview button")].find(
			(b) => b.textContent === "Restore",
		) as HTMLButtonElement;
		expect(restore.disabled).toBe(true);
		expect(container.querySelector(".note-version-preview")!.textContent).toContain(
			"Save or resolve edits before restoring",
		);
	});

	test("a rewrite flow locks the page controls until it closes", async () => {
		notes = [noteRow("Shopping")];
		noteGetOverride = {
			...noteFull(notes[0]!, "alpha beta gamma"),
			rev: 1,
		};
		win.history.replaceState(null, "", "/app/n/n-shopping");
		await mount();
		// The lazy editor mounts async — wait for its DOM.
		let pm: Element | null = null;
		for (let i = 0; i < 20 && pm === null; i++) {
			pm = container.querySelector(".ProseMirror");
			if (pm === null) await settle();
		}
		expect(pm).not.toBeNull();
		const title = container.querySelector("input.note-title")! as HTMLInputElement;
		const flagsSelect = container.querySelector(".note-flags select")! as HTMLSelectElement;
		const flagButton = (label: string) =>
			[...container.querySelectorAll(".note-flags button")].find(
				(b) => b.textContent === label,
			) as HTMLButtonElement;
		const chat = flagButton("Chat with this note");
		expect(title.disabled).toBe(false);
		expect(flagsSelect.disabled).toBe(false);
		expect(chat.disabled).toBe(false);

		// A real DOM selection inside the doc — ProseMirror maps it to a
		// state selection, which is what the toolbar button watches.
		const text = pm!.querySelector("p")!.firstChild!;
		await act(async () => {
			(pm as HTMLElement).focus();
			win
				.getSelection()!
				.setBaseAndExtent(
					text as unknown as import("happy-dom").Node,
					6,
					text as unknown as import("happy-dom").Node,
					10,
				);
			document.dispatchEvent(new win.Event("selectionchange") as unknown as Event);
		});
		await settle();
		const rewriteBtn = [...container.querySelectorAll("button")].find(
			(b) => b.textContent === "Rewrite selection",
		) as HTMLButtonElement;
		expect(rewriteBtn.disabled).toBe(false);
		await click(rewriteBtn);
		await settle();
		expect(container.querySelector(".note-rewrite")).not.toBeNull();
		expect(title.disabled).toBe(true);
		expect(flagsSelect.disabled).toBe(true);
		expect(flagButton("Pin").disabled).toBe(true);
		expect(flagButton("Archive").disabled).toBe(true);
		expect(chat.disabled).toBe(true);

		await typeInto(
			container.querySelector(".note-rewrite-field textarea")!,
			"tighten it",
			win.HTMLTextAreaElement.prototype,
		);
		await click(
			[...container.querySelectorAll("button")].find((b) => b.textContent === "Generate rewrite"),
		);
		await settle();
		expect(container.querySelector(".note-rewrite-preview")!.textContent).toContain(
			"a tighter take",
		);
		expect(title.disabled).toBe(true);

		await click([...container.querySelectorAll("button")].find((b) => b.textContent === "Discard"));
		await settle();
		expect(container.querySelector(".note-rewrite")).toBeNull();
		expect(title.disabled).toBe(false);
		expect(chat.disabled).toBe(false);
	});

	for (const [variant, projectId] of [
		["loose", null],
		["project", "p-goblin"],
	] as const) {
		test(`a failed chat mint on a ${variant} note page stays put and shows the alert`, async () => {
			if (projectId !== null) projs = [projRow("Goblin")];
			notes = [noteRow("Shopping", { projectId })];
			failCreate = true;
			win.history.replaceState(null, "", "/app/n/n-shopping");
			await mount();
			// The lazy editor mounts async — the page must survive the
			// failure, so wait for its DOM first.
			let pm: Element | null = null;
			for (let i = 0; i < 20 && pm === null; i++) {
				pm = container.querySelector(".ProseMirror");
				if (pm === null) await settle();
			}
			expect(pm).not.toBeNull();

			await click(
				[...container.querySelectorAll("button")].find(
					(b) => b.textContent === "Chat with this note",
				),
			);
			expect(win.location.pathname).toBe("/app/n/n-shopping");
			expect(container.querySelector(".note-editor")).not.toBeNull();
			const alert = container.querySelector('p.error[role="alert"]');
			expect(alert).not.toBeNull();
			expect(alert!.textContent).toBe(
				"Couldn't start a conversation — check the tailnet, then resend.",
			);

			// A retry after the mint recovers navigates and clears the alert.
			failCreate = false;
			await click(
				[...container.querySelectorAll("button")].find(
					(b) => b.textContent === "Chat with this note",
				),
			);
			expect(win.location.pathname).toBe("/app/c/minted");
			expect(container.querySelector('p.error[role="alert"]')).toBeNull();
		});
	}
});

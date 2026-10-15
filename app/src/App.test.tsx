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
	AppSearchHit,
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
		installGlobal("sessionStorage", win.sessionStorage);
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
		installGlobal("sessionStorage", win.sessionStorage);
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
	// When set, POST /api/app/conversations waits on it — the create is
	// held in flight while the operator navigates.
	let createGate: Promise<void> | null = null;
	let settingsGate: Promise<void> | null = null;
	let settingsReleases: (() => void)[];
	let saveStatus = 200;
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
		operators: [111],
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
		createGate = null;
		settingsGate = null;
		settingsReleases = [];
		saveStatus = 200;
		installGlobal("window", win);
		installGlobal("document", win.document);
		installGlobal("navigator", win.navigator);
		installGlobal("localStorage", win.localStorage);
		installGlobal("sessionStorage", win.sessionStorage);
		installGlobal("Event", win.Event);
		installGlobal("CustomEvent", win.CustomEvent);
		installGlobal("getComputedStyle", win.getComputedStyle);
		// The restore effect parks the cursor via rAF — must ride the
		// happy-dom realm like the rest of the DOM globals here.
		installGlobal("requestAnimationFrame", win.requestAnimationFrame.bind(win));
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
		Reflect.set(win, "confirm", (message: string) => {
			confirmCalls += 1;
			confirmMessages.push(message);
			return message.startsWith("Delete ") || confirmAnswer;
		});
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === "/api/app/conversations" && init?.method === "POST")
				return (createGate ?? Promise.resolve()).then(() =>
					jsonResponse({ id: "app/created", title: null, createdAt: "2026-10-10T00:00:00Z" }),
				);
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
				if (saveStatus !== 200)
					return Promise.resolve(jsonResponse({ error: `http ${saveStatus}` }, saveStatus));
				return (settingsGate ?? Promise.resolve()).then(() => jsonResponse({ ok: true }));
			}
			if (url === "/api/app/settings")
				return Promise.resolve(
					new Response(
						JSON.stringify({
							config: settings,
							providerKinds: ["openai-compatible", "openrouter"],
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
		for (const r of settingsReleases) r();
		settingsReleases = [];
		settingsGate = null;
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

	const holdSettingsPost = () => {
		const g = Promise.withResolvers<void>();
		settingsGate = g.promise;
		settingsReleases.push(() => g.resolve());
		return () => {
			g.resolve();
			settingsGate = null;
		};
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
		await waitFor(() => container.querySelector(".settings") !== null, "settings page");
	};
	const click = async (el: Element | null | undefined) => {
		expect(el).toBeTruthy();
		await act(async () => {
			el?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event);
		});
		await settle();
	};
	// The invalid edit removes the operator chip — scope chip counts to
	// that editor (the allowed-users editor keeps its fixture chip).
	const operatorChips = (): number =>
		container
			.querySelector('[aria-label="add operator"]')
			?.closest(".frow")
			?.querySelectorAll(".chip").length ?? -1;

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
					expect(operatorChips()).toBe(0);
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

	const openProviders = async () => {
		await click(
			[...container.querySelectorAll("button.idx")].find((b) =>
				b.textContent?.includes("Providers"),
			),
		);
		expect(container.querySelector(".prov.card")).not.toBeNull();
	};
	const authInput = () =>
		container.querySelector('.prov.card input[aria-label="secret name"]') as HTMLInputElement;
	const nameInput = () =>
		container.querySelector('.prov.card input[aria-label="provider name"]') as HTMLInputElement;
	const renameProviderCard = async (name: string) => {
		await typeInto(nameInput(), name, win.HTMLInputElement.prototype);
		await act(async () => {
			nameInput().dispatchEvent(
				new win.FocusEvent("focusout", { bubbles: true }) as unknown as Event,
			);
		});
		await settle();
	};

	test("a blanked provider auth materializes from the submitted body — a rename can't re-point it", async () => {
		await mount();
		await openProviders();
		expect(authInput().value).toBe("fixture");
		await typeInto(authInput(), "", win.HTMLInputElement.prototype);
		await waitFor(() => savedBodies.length > 0, "the blank-auth save");
		expect(savedBodies.at(-1)?.providers["main"]).toEqual({
			kind: "openai-compatible",
			baseUrl: "https://api.example.test",
			auth: "main",
		});
		await waitFor(() => authInput().value === "main", "the materialized auth input");
		expect(container.querySelector(".dirty-pill")).toBeNull();
		await renameProviderCard("primary");
		await waitFor(() => savedBodies.length > 1, "the rename save");
		expect(savedBodies.at(-1)?.providers["primary"]).toEqual({
			kind: "openai-compatible",
			baseUrl: "https://api.example.test",
			auth: "main",
		});
		expect(savedBodies.at(-1)?.providers["main"]).toBeUndefined();
	});

	test("edits that land under a held settings ack survive it — rename keeps the credential, explicit edits win", async () => {
		await mount();
		await openProviders();
		await typeInto(authInput(), "", win.HTMLInputElement.prototype);
		let release = holdSettingsPost();
		await waitFor(() => savedBodies.length > 0, "the held save");
		await renameProviderCard("primary");
		release();
		await waitFor(() => savedBodies.length > 1, "the rename's save");
		expect(nameInput().value).toBe("primary");
		expect(authInput().value).toBe("main");
		expect(savedBodies.at(-1)?.providers["primary"]).toEqual({
			kind: "openai-compatible",
			baseUrl: "https://api.example.test",
			auth: "main",
		});

		await typeInto(authInput(), "", win.HTMLInputElement.prototype);
		release = holdSettingsPost();
		await waitFor(() => savedBodies.length > 2, "the second held save");
		await typeInto(authInput(), "rotated", win.HTMLInputElement.prototype);
		release();
		await waitFor(() => savedBodies.length > 3, "the rotated save");
		expect(authInput().value).toBe("rotated");
		expect(savedBodies.at(-1)?.providers["primary"]).toEqual({
			kind: "openai-compatible",
			baseUrl: "https://api.example.test",
			auth: "rotated",
		});

		await typeInto(authInput(), "", win.HTMLInputElement.prototype);
		release = holdSettingsPost();
		await waitFor(() => savedBodies.length > 4, "the third held save");
		await act(async () => {
			const select = container.querySelector(
				'.prov.card select[aria-label="provider type"]',
			) as HTMLSelectElement;
			select.value = "openrouter";
			select.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event);
		});
		await settle();
		release();
		await waitFor(() => savedBodies.length > 5, "the kind-change save");
		expect(
			(
				container.querySelector(
					'.prov.card select[aria-label="provider type"]',
				) as HTMLSelectElement
			).value,
		).toBe("openrouter");
		expect(savedBodies.at(-1)?.providers["primary"]).toEqual({
			kind: "openrouter",
			auth: authDefaults.openrouter,
		});
	}, 30_000);
	test("a conflicted save offers no retry — only a transient failure does", async () => {
		saveStatus = 409;
		await mount();
		await click(
			[...container.querySelectorAll("button.idx")].find((b) => b.textContent?.includes("Access")),
		);
		const level = (name: string) =>
			[...container.querySelectorAll('[aria-label="Log level"] button')].find(
				(b) => b.textContent === name,
			);
		const retry = () =>
			[...container.querySelectorAll(".savebar button")].find((b) => b.textContent === "retry");
		await click(level("debug"));
		await waitFor(() => savedBodies.length > 0, "the edit to post");
		await waitFor(
			() => container.textContent?.includes("reload the page") === true,
			"the conflict notice",
		);
		// The notice itself says only a reload fixes it — a retry button
		// here would re-run the same stale-etag write and fail again.
		expect(retry()).toBeUndefined();
		// A transient failure keeps the affordance — and it works.
		saveStatus = 500;
		await click(level("warn"));
		await waitFor(() => savedBodies.length > 1, "the second edit to post");
		await waitFor(() => retry() !== undefined, "the retry button");
		saveStatus = 200;
		await click(retry());
		await waitFor(() => savedBodies.length > 2, "the retry to post");
		expect(savedBodies.at(-1)?.logLevel).toBe("warn");
		await waitFor(() => container.textContent?.includes("Saved") === true, "the saved notice");
		expect(container.textContent).not.toContain("unsaved");
	});

	test("an invalid edit cannot write itself — it stays unsaved with the reason", async () => {
		await mount();
		await dirtyTheForm();
		for (let i = 0; i < 40; i++) await settle();
		expect(savedBodies).toHaveLength(0);
		expect(container.textContent).toContain("unsaved");
		expect(container.textContent).toContain("Operators must keep at least one Telegram id.");
	});

	test("publicUrl stages for the explicit Save — the debounce never carries an in-between value", async () => {
		settings = parseConfig({ ...SETTINGS, publicUrl: "https://g.example.ts.net" });
		await mount();
		await click(
			[...container.querySelectorAll("button.idx")].find((b) => b.textContent?.includes("Access")),
		);
		const field = [...container.querySelectorAll(".frow")].find(
			(r) => r.querySelector(".flabel")?.textContent === "Public url",
		)!;
		const input = field.querySelector("input")!;
		// Clearing is a VALID value — before staging, the debounce wrote
		// it and the tab's own origin fell out of the allowlist.
		await typeInto(input, "", win.HTMLInputElement.prototype);
		expect(container.textContent).toContain("unsaved");
		expect(container.textContent).toContain("public url");
		// Well past the 800ms debounce — nothing may have posted.
		for (let i = 0; i < 40; i++) await settle();
		expect(savedBodies).toHaveLength(0);
		// Other pending edits wait on the same commit — the save body is
		// the whole draft, so an unstaged autosave would carry the
		// half-edited allowlist.
		await click(
			[...container.querySelectorAll('[aria-label="Log level"] button')].find(
				(b) => b.textContent === "debug",
			),
		);
		for (let i = 0; i < 40; i++) await settle();
		expect(savedBodies).toHaveLength(0);
		// The explicit Save writes everything at once.
		await click(container.querySelector(".savebar-save"));
		await waitFor(() => savedBodies.length > 0, "the explicit save");
		expect(savedBodies.at(-1)?.publicUrl).toBe("");
		expect(savedBodies.at(-1)?.logLevel).toBe("debug");
		expect(container.textContent).not.toContain("unsaved");
	});

	test("a create resolving after navigation to dirty Settings is dropped — no silent close", async () => {
		win.history.replaceState(null, "", "/app/");
		let releaseCreate!: () => void;
		createGate = new Promise<void>((r) => (releaseCreate = r));
		root = createRoot(container);
		await act(async () => {
			root?.render(<App />);
		});
		await waitFor(() => container.querySelector("form.composer") !== null, "the composer");
		const composer = container.querySelector("form.composer")!;
		await typeInto(composer.querySelector("textarea")!, "hello", win.HTMLTextAreaElement.prototype);
		await act(async () => {
			composer.dispatchEvent(
				new win.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
			);
		});
		// The create is still in flight — the operator opens Settings
		// (that navigation is what fences the pending send) and dirties
		// the editor.
		await openPage("Settings");
		await dirtyTheForm();
		const confirmsBefore = confirmCalls;
		await act(async () => releaseCreate());
		await settle();
		// The stale success never reached select(): Settings stays open,
		// the guard was never asked, the draft survives.
		expect(win.location.pathname).toBe("/app/settings");
		expect(container.querySelector(".settings")).not.toBeNull();
		expect(confirmCalls).toBe(confirmsBefore);
		expect(container.textContent).toContain("unsaved");
		expect(operatorChips()).toBe(0);
	});

	test("a start fenced by navigation hands the composer its input back", async () => {
		win.history.replaceState(null, "", "/app/");
		let releaseCreate!: () => void;
		createGate = new Promise<void>((r) => (releaseCreate = r));
		root = createRoot(container);
		await act(async () => {
			root?.render(<App />);
		});
		await waitFor(() => container.querySelector("form.composer") !== null, "the composer");
		await typeInto(
			container.querySelector("form.composer textarea")!,
			"hello",
			win.HTMLTextAreaElement.prototype,
		);
		await act(async () => {
			container
				.querySelector("form.composer")!
				.dispatchEvent(
					new win.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
				);
		});
		await settle();
		// The create is still in flight — the operator opens Settings,
		// and that navigation is what fences the pending send.
		await openPage("Settings");
		await act(async () => releaseCreate());
		await settle();
		// No alert — deliberately: the fenced path sets no failure. The
		// input must not be gone with it: back on the empty state the
		// composer holds the cleared text, exactly once.
		expect(container.textContent).not.toContain("Couldn't start a conversation");
		const newChat = () =>
			click(
				[...container.querySelectorAll("nav button.new")].find(
					(b) => b.textContent === "New conversation",
				),
			);
		await newChat();
		await waitFor(() => container.querySelector("form.composer") !== null, "the composer again");
		const restored = container.querySelector("form.composer textarea")! as HTMLTextAreaElement;
		expect(restored.value).toBe("hello");
		// Away and back — a consumed restore must not replay over a fresh
		// composer on remount.
		await openPage("Settings");
		await newChat();
		await waitFor(() => container.querySelector("form.composer") !== null, "the composer third");
		expect((container.querySelector("form.composer textarea")! as HTMLTextAreaElement).value).toBe(
			"",
		);
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
			expect(operatorChips()).toBe(0);

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
		expect(operatorChips()).toBe(0);
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
		expect(operatorChips()).toBe(0);
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
		operators: [111],
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
		savedBodies = [];
		installGlobal("window", win);
		installGlobal("document", win.document);
		installGlobal("navigator", win.navigator);
		installGlobal("localStorage", win.localStorage);
		installGlobal("sessionStorage", win.sessionStorage);
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
			if (url === "/api/settings" && init?.method === "POST") {
				savedBodies.push(JSON.parse(String(init.body)) as ConfigPostBody);
				return Promise.resolve(jsonResponse({ ok: true }));
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

	// The close guard is the draft's webview-level twin of the in-door
	// confirm: armed while a draft exists, disarmed on save, discard,
	// or unmount (design/telegram.md → Mini Apps).
	const sdkCalls: string[] = [];
	const stubClosingConfirmation = () => {
		sdkCalls.length = 0;
		Reflect.set(win, "Telegram", {
			WebApp: {
				initData: "user=%7B%22id%22%3A111%7D&hash=abc",
				enableClosingConfirmation: () => sdkCalls.push("enable"),
				disableClosingConfirmation: () => sdkCalls.push("disable"),
			},
		});
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
		// Dropping the only operator can never validate — the draft
		// stays dirty pending a save that cannot happen.
		await click(
			container
				.querySelector('[aria-label="add operator"]')
				?.closest(".frow")
				?.querySelector(".chip button"),
		);
		expect(container.textContent).toContain("unsaved");
	};
	const memoriesButton = () =>
		[...container.querySelectorAll(".rail-ops button")].find((b) => b.textContent === "Memories");

	test("a pristine door disarms the closing confirmation at mount", async () => {
		stubClosingConfirmation();
		await renderDoor();
		expect(sdkCalls).toEqual(["disable"]);
	});

	test("a dirty draft arms the guard; discarding or saving disarms it", async () => {
		stubClosingConfirmation();
		let confirmAnswer = false;
		let confirmCalls = 0;
		Reflect.set(win, "confirm", () => {
			confirmCalls += 1;
			return confirmAnswer;
		});
		await renderDoor();
		await dirtyTheForm();
		expect(sdkCalls.at(-1)).toBe("enable");
		// A declined navigation keeps the draft — and the armed guard.
		await click(memoriesButton());
		expect(confirmCalls).toBe(1);
		expect(container.textContent).toContain("unsaved");
		expect(sdkCalls.at(-1)).toBe("enable");
		// An accepted navigation throws the draft away: ref cleared,
		// guard disarmed, page switched.
		confirmAnswer = true;
		await click(memoriesButton());
		expect(confirmCalls).toBe(2);
		expect(sdkCalls.at(-1)).toBe("disable");
		expect(container.textContent).toContain("Memories");
		expect(container.textContent).not.toContain("unsaved");
	});

	test("a completed autosave disarms the closing confirmation", async () => {
		stubClosingConfirmation();
		await renderDoor();
		await click(
			[...container.querySelectorAll("button.idx")].find((b) => b.textContent?.includes("Access")),
		);
		await click(
			[...container.querySelectorAll('[aria-label="Log level"] button')].find(
				(b) => b.textContent === "debug",
			),
		);
		expect(sdkCalls.at(-1)).toBe("enable");
		await waitFor(() => savedBodies.length > 0, "the settings write");
		expect(savedBodies.at(-1)?.logLevel).toBe("debug");
		await waitFor(() => sdkCalls.at(-1) === "disable", "the guard to disarm");
	});

	test("unmounting the door disarms the closing confirmation", async () => {
		stubClosingConfirmation();
		await renderDoor();
		await dirtyTheForm();
		expect(sdkCalls.at(-1)).toBe("enable");
		await act(async () => {
			root?.unmount();
		});
		root = null;
		expect(sdkCalls.at(-1)).toBe("disable");
	});

	test("a WebApp without the optional methods still renders and edits", async () => {
		// The fixture's WebApp carries only initData — no guard methods.
		await renderDoor();
		expect(container.textContent).not.toContain("Open this page from Telegram");
		await dirtyTheForm();
		expect(container.textContent).toContain("unsaved");
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
	// Recorded PATCHes: note writes carry their If-Match rev, project
	// writes their id — a draft stranded on the previous page must
	// never reach the wire under the next page's identity.
	let notePatches: { id: string; ifMatch: string | null; body: unknown }[];
	let projectPatches: { id: string; body: unknown }[];
	// Per-note bodies for the GET — the summary rows carry none.
	let noteBodies: Record<string, string>;
	let versionRows: AppNoteVersionMeta[];
	let versionPreview: AppNoteVersion | null;
	// Restore endpoint: the reply a held-or-failed POST eventually
	// returns — tests hold it to land edits mid-flight.
	let restoreReply: AppNote | null;
	let restoreHold: Promise<void> | null;
	let restoreFail: boolean;
	let posts: { url: string; body: unknown }[];
	// Scripted /api/app/search replies keyed by decoded q — a hold gate
	// keeps the reply pending until the test releases it.
	let searchCalls: string[];
	let searchScript: Map<string, { fail?: boolean; hold?: Promise<void>; hits?: AppSearchHit[] }>;
	// A held conversation create answers only once this gate resolves.
	let createHold: Promise<void> | null;
	// Same for a note PATCH — the stored row still mutates at request
	// time (the restore ruling); only the reply is held.
	let notePatchHold: Promise<void> | null;
	// Test-owned gates, resolved in afterEach so a failed assertion can
	// never strand a pending mocked fetch.
	let pendingGates: PromiseWithResolvers<void>[];
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
		stateRev: 1,
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
		notePatches = [];
		projectPatches = [];
		noteBodies = {};
		versionRows = [];
		versionPreview = null;
		restoreReply = null;
		restoreHold = null;
		restoreFail = false;
		posts = [];
		searchCalls = [];
		searchScript = new Map();
		createHold = null;
		notePatchHold = null;
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
					const reply = () =>
						failCreate
							? Promise.resolve(jsonResponse({ error: "mint down" }, 500))
							: Promise.resolve(
									jsonResponse(
										{ id: "app/minted", title: null, createdAt: "2026-10-10T00:00:00Z" },
										201,
									),
								);
					return createHold === null ? reply() : createHold.then(reply);
				}
				return Promise.resolve(jsonResponse({ conversations: convs }));
			}
			if (url.startsWith("/api/app/search")) {
				const q = new URL(url, "http://localhost").searchParams.get("q") ?? "";
				searchCalls.push(q);
				const script = searchScript.get(q);
				const reply = () =>
					script?.fail === true
						? Promise.resolve(jsonResponse({ error: "search down" }, 500))
						: Promise.resolve(jsonResponse({ hits: script?.hits ?? [] }));
				return script?.hold !== undefined ? script.hold.then(reply) : reply();
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
			const projPatchMatch = /^\/api\/app\/projects\/([^/]+)$/.exec(url);
			if (projPatchMatch !== null && method === "PATCH") {
				const id = decodeURIComponent(projPatchMatch[1]!);
				projectPatches.push({ id, body });
				const p = projs.find((x) => x.id === id);
				if (p === undefined) return Promise.resolve(jsonResponse({ error: "not found" }, 404));
				const req = body as {
					name?: string;
					instructions?: string;
					memory?: "shared" | "off";
					archived?: boolean;
				};
				if (req.name !== undefined) p.name = req.name;
				if (req.instructions !== undefined) p.instructions = req.instructions;
				if (req.memory !== undefined) p.memory = req.memory;
				if (req.archived !== undefined)
					p.archivedAt = req.archived ? "2026-10-11T00:00:00.000Z" : null;
				return Promise.resolve(jsonResponse(p));
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
				if (/\/versions\/\d+\/restore$/.test(url) && method === "POST") {
					posts.push({ url, body });
					// Restore is a guarded content write — app-channel
					// refuses it without If-Match, and a stale guard 409s
					// with the live note instead of mutating anything.
					const target = notes.find((x) => x.id === id);
					if (!restoreFail && target !== undefined) {
						const im = ((init?.headers ?? {}) as Record<string, string>)["if-match"];
						if (im === undefined)
							return Promise.resolve(jsonResponse({ error: "If-Match required for restore" }, 428));
						if (Number(im.replaceAll('"', "")) !== target.rev)
							return Promise.resolve(
								jsonResponse(
									{ error: "conflict", note: noteFull(target, noteBodies[target.id] ?? "") },
									409,
								),
							);
					}
					// The restore write lands when the POST does — a held
					// gate can only delay the reply, not the stored state.
					if (!restoreFail && restoreReply !== null) {
						const restored = notes.find((x) => x.id === restoreReply!.id);
						if (restored !== undefined) {
							restored.rev = restoreReply.rev;
							restored.stateRev = restoreReply.stateRev;
							restored.title = restoreReply.title;
							restored.updatedAt = restoreReply.updatedAt;
							noteBodies[restored.id] = restoreReply.body;
						}
					}
					const reply = () =>
						restoreFail
							? Promise.resolve(jsonResponse({ error: "restore down" }, 500))
							: Promise.resolve(
									restoreReply === null
										? jsonResponse({ error: "not found" }, 404)
										: jsonResponse(restoreReply),
								);
					return restoreHold === null ? reply() : restoreHold.then(reply);
				}
				if (/\/versions\/\d+$/.test(url))
					return Promise.resolve(
						versionPreview === null
							? jsonResponse({ error: "not found" }, 404)
							: jsonResponse(versionPreview),
					);
				if (method === "PATCH") {
					patchCalls++;
					const headers = (init?.headers ?? {}) as Record<string, string>;
					notePatches.push({ id, ifMatch: headers["if-match"] ?? null, body });
				}
				if (method === "PATCH" && conflictPatch) {
					conflictPatch = false;
					const n = notes.find((x) => x.id === id);
					// The write that won already landed server-side — the
					// stored row moves to the state the 409 reports.
					const remote = {
						...noteFull(n!, noteBodies[n!.id] ?? ""),
						rev: 5,
						stateRev: n!.stateRev + 4,
					};
					n!.rev = remote.rev;
					n!.stateRev = remote.stateRev;
					n!.updatedAt = remote.updatedAt;
					return Promise.resolve(jsonResponse({ error: "conflict", note: remote }, 409));
				}
				if (method === "GET") {
					if (noteGetFail) return Promise.resolve(jsonResponse({ error: "list down" }, 500));
					if (noteGetOverride !== null) return Promise.resolve(jsonResponse(noteGetOverride));
				}
				const n = notes.find((x) => x.id === id);
				if (n === undefined) return Promise.resolve(jsonResponse({ error: "not found" }, 404));
				if (method === "PATCH") {
					// app-channel.ts semantics: a content write rides the
					// If-Match etag (refused before any field mutates), flag
					// writes apply guard-free, and only an actual title/body
					// change bumps rev and updatedAt — while every accepted
					// mutation moves stateRev (notes.ts).
					const req = body as {
						title?: string;
						body?: string;
						pinned?: boolean;
						archived?: boolean;
						projectId?: string | null;
					};
					const wantsContent = req.title !== undefined || req.body !== undefined;
					if (wantsContent) {
						const headers = (init?.headers ?? {}) as Record<string, string>;
						const im = headers["if-match"];
						if (im === undefined)
							return Promise.resolve(
								jsonResponse({ error: "If-Match required for content writes" }, 428),
							);
						if (Number(im.replaceAll('"', "")) !== n.rev)
							return Promise.resolve(
								jsonResponse(
									{
										error: "conflict",
										note: noteFull(n, noteBodies[n.id] ?? ""),
									},
									409,
								),
							);
					}
					if (req.pinned !== undefined) n.pinnedAt = req.pinned ? "2026-10-12T00:00:00.000Z" : null;
					if (req.archived !== undefined)
						n.archivedAt = req.archived ? "2026-10-12T00:00:00.000Z" : null;
					if (req.projectId !== undefined) n.projectId = req.projectId;
					const storedBody = noteBodies[n.id] ?? "";
					const nextTitle = req.title ?? n.title;
					const nextBody = req.body ?? storedBody;
					const contentMoved = nextTitle !== n.title || nextBody !== storedBody;
					if (contentMoved) {
						n.title = nextTitle;
						noteBodies[n.id] = nextBody;
						n.rev += 1;
						n.updatedAt = "2026-10-12T00:00:00.000Z";
					}
					if (
						contentMoved ||
						req.pinned !== undefined ||
						req.archived !== undefined ||
						req.projectId !== undefined
					) {
						n.stateRev += 1;
					}
				}
				// The reply carries the state the request landed on — a
				// held answer must stay stale if the row moved again while
				// it was parked.
				const reply = jsonResponse(noteFull(n, noteBodies[n.id] ?? ""));
				return Promise.resolve(
					method === "PATCH" && notePatchHold !== null ? notePatchHold.then(() => reply) : reply,
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

	// The note autosave outlasts even that: PM's DOM observer →
	// Milkdown's ~200ms listener debounce → the editor's own 1s
	// save debounce. Real time — the debounce is the product's.
	const settleLong = async () => {
		await act(async () => {
			await new Promise((r) => setTimeout(r, 1500));
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
		// The display title rides along for the optimistic chip; the
		// server still expands the stored note authoritatively.
		expect(msg.parts).toContainEqual({
			type: "data-note",
			data: { id: "n-shopping", title: "Shopping" },
		});
		// The live transcript labels the just-sent chip before any
		// history reload — and the chip still navigates.
		const chips = container.querySelectorAll(".note-chip");
		expect(chips).toHaveLength(1);
		expect(chips[0]!.textContent).toContain("Note · Shopping");
		await click(chips[0]!.querySelector("button.attachment-name"));
		expect(win.location.pathname).toBe("/app/n/n-shopping");
	});

	test("the note picker's Enter and Escape stay picker-local — no send, draft kept", async () => {
		notes = [noteRow("Shopping")];
		await mount();
		const draft = container.querySelector("form.composer textarea")! as HTMLTextAreaElement;
		await typeInto(draft, "keep me", win.HTMLTextAreaElement.prototype);

		await click(container.querySelector('button[aria-label="Attach a note"]'));
		const picker = container.querySelector(".composer-pick input")!;
		expect(picker).not.toBeNull();

		// Enter inside a form input would implicitly submit — the picker
		// cancels and contains it, so no chat POST and the draft stands.
		const enter = new win.KeyboardEvent("keydown", {
			bubbles: true,
			cancelable: true,
			key: "Enter",
		});
		await act(async () => {
			picker.dispatchEvent(enter as unknown as Event);
		});
		expect(enter.defaultPrevented).toBe(true);
		expect(posts.some((p) => p.url === "/api/app/chat")).toBe(false);
		expect(draft.value).toBe("keep me");
		expect(container.querySelector(".composer-pick")).not.toBeNull();

		// Escape closes the picker without touching the draft.
		const escape = new win.KeyboardEvent("keydown", {
			bubbles: true,
			cancelable: true,
			key: "Escape",
		});
		await act(async () => {
			picker.dispatchEvent(escape as unknown as Event);
		});
		expect(escape.defaultPrevented).toBe(true);
		expect(container.querySelector(".composer-pick")).toBeNull();
		expect(draft.value).toBe("keep me");
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
		const status = card!.querySelector(".note-card-status")!.textContent!;
		expect(status).toContain("Appended to");
		expect(status).not.toContain("Created");
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
		const status = card!.querySelector(".note-card-status")!;
		expect(status.textContent).toContain("Created");
		expect(status.textContent).not.toContain("Appended to");
		await click(status.querySelector("button.link"));
		expect(win.location.pathname).toBe("/app/n/n-new");
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
			stateRev: 2,
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
		noteGetOverride = {
			...noteFull(notes[0]!),
			rev: 2,
			stateRev: 2,
			title: "Remote",
			updatedAt: "z",
		};
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

	test("an equal-state own save acknowledgement clears the focus-refresh conflict", async () => {
		notes = [noteRow("Shopping")];
		noteBodies = { "n-shopping": "milk" };
		await notePage("/app/n/n-shopping");
		const title = container.querySelector("input.note-title")!;
		const gate = hold();
		notePatchHold = gate.promise;
		await typeInto(title, "Groceries", win.HTMLInputElement.prototype);
		await act(async () => {
			(title as HTMLInputElement).blur();
		});
		expect(notePatches).toHaveLength(1);
		await act(async () => {
			win.dispatchEvent(new win.Event("focus"));
		});
		await settle();
		expect(container.querySelector(".note-conflict")).not.toBeNull();
		gate.resolve();
		await settle();
		expect(container.querySelector(".note-conflict")).toBeNull();
		const chat = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
			(b) => b.textContent === "Chat with this note",
		)!;
		expect(chat.disabled).toBe(false);
		expect(notePatches).toHaveLength(1);
		expect(container.querySelector(".ProseMirror")!.textContent).toContain("milk");
	});

	test("a title reverted and blurred before the rename acknowledgement is saved next", async () => {
		notes = [noteRow("Shopping")];
		await notePage("/app/n/n-shopping");
		const title = container.querySelector("input.note-title")! as HTMLInputElement;
		const gate = hold();
		notePatchHold = gate.promise;
		await typeInto(title, "Groceries", win.HTMLInputElement.prototype);
		await act(async () => {
			title.blur();
		});
		await typeInto(title, "Shopping", win.HTMLInputElement.prototype);
		await act(async () => {
			title.blur();
		});
		expect(notePatches).toHaveLength(1);
		gate.resolve();
		await settle();
		expect(notePatches).toHaveLength(2);
		expect((notePatches[1]!.body as { title: string }).title).toBe("Shopping");
		expect(notes[0]!.title).toBe("Shopping");
		expect(title.value).toBe("Shopping");
	});

	test("a delayed initial note fetch cannot roll back a newer focus response", async () => {
		notes = [noteRow("Shopping")];
		noteBodies = { "n-shopping": "old body" };
		const gate = hold();
		const fetch = globalThis.fetch;
		let first = true;
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const result = fetch(input, init);
			if (first && input === "/api/app/notes/n-shopping" && (init?.method ?? "GET") === "GET") {
				first = false;
				return gate.promise.then(() => result);
			}
			return result;
		}) as typeof fetch;
		win.history.replaceState(null, "", "/app/n/n-shopping");
		await mount();
		noteGetOverride = {
			...noteFull(notes[0]!, "new body"),
			title: "Groceries",
			rev: 2,
			stateRev: 2,
		};
		await act(async () => {
			win.dispatchEvent(new win.Event("focus"));
		});
		await settle();
		expect((container.querySelector("input.note-title") as HTMLInputElement).value).toBe(
			"Groceries",
		);
		gate.resolve();
		await settle();
		expect((container.querySelector("input.note-title") as HTMLInputElement).value).toBe(
			"Groceries",
		);
		expect(container.querySelector(".ProseMirror")!.textContent).toContain("new body");
	});

	test("Enter + blur during a held title PATCH commit once — no false conflict", async () => {
		notes = [noteRow("Shopping")];
		const gate = hold();
		notePatchHold = gate.promise;
		await notePage("/app/n/n-shopping");
		const title = container.querySelector("input.note-title")!;
		await typeInto(title, "Shopping 2", win.HTMLInputElement.prototype);
		await act(async () => {
			title.dispatchEvent(
				new win.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }) as unknown as Event,
			);
		});
		// The first PATCH is in flight — the blur's commit re-arms; a
		// second write on the same If-Match would land 409 after the
		// first and raise a conflict that never happened.
		await act(async () => {
			(title as HTMLInputElement).blur();
		});
		await settle();
		expect(patchCalls).toBe(1);
		// The held write already landed server-side (rev 2); releasing
		// the reply runs the armed commit, which no-ops on the landed
		// title instead of re-firing.
		gate.resolve();
		await settle();
		expect(patchCalls).toBe(1);
		expect(container.querySelector(".note-conflict")).toBeNull();
		// A later distinct commit still writes — the guard isn't a wedge.
		await typeInto(title, "Shopping 3", win.HTMLInputElement.prototype);
		await act(async () => {
			(title as HTMLInputElement).blur();
		});
		await settle();
		expect(patchCalls).toBe(2);
		expect(notePatches.at(-1)?.ifMatch).toBe('"2"');
	});

	// Mutate the rendered PM text node — the DOM observer reads it into
	// the doc, dirty lands synchronously via editor.dirty() even though
	// the autosave debounce (~1s) hasn't fired.
	const editBody = async (extra: string) => {
		const pm = container.querySelector(".ProseMirror")!;
		expect(pm).not.toBeNull();
		const textNode = pm.querySelector("p")!.firstChild!;
		await act(async () => {
			textNode.nodeValue = `${textNode.nodeValue ?? ""}${extra}`;
		});
		await settleSlow();
	};

	test("a same-rev archive flip under a dirty body raises the bar — the editor survives", async () => {
		notes = [noteRow("Shopping")];
		noteBodies = { "n-shopping": "milk" };
		await notePage("/app/n/n-shopping");
		const pm = container.querySelector(".ProseMirror")!;
		await editBody("x");
		expect(notePatches).toHaveLength(0);
		// The server side archived the note — a flag flip moves only
		// the token, not rev or the stored body.
		notes[0]!.archivedAt = "2026-10-12T00:00:00.000Z";
		notes[0]!.stateRev += 1;
		await act(async () => {
			win.dispatchEvent(new win.Event("focus"));
		});
		await settle();
		expect(container.querySelector(".note-conflict")).not.toBeNull();
		// The same editor element stayed mounted — the readonly swap
		// would have dropped the dirty buffer it warns about.
		expect(container.querySelector(".ProseMirror")).toBe(pm);
		expect(pm.textContent).toContain("milkx");
		expect(container.querySelector(".note-readonly")).toBeNull();
		// No autosave may slip past the bar.
		await settleLong();
		expect(notePatches).toHaveLength(0);
	});

	test("Keep mine on an edited+archived conflict saves the buffer at the remote rev, then reads readonly", async () => {
		notes = [noteRow("Shopping")];
		noteBodies = { "n-shopping": "milk" };
		await notePage("/app/n/n-shopping");
		await editBody("x");
		// Remote wrote new content AND archived — a real rev bump.
		notes[0]!.rev = 2;
		notes[0]!.stateRev = 2;
		notes[0]!.title = "Remote";
		notes[0]!.archivedAt = "2026-10-12T00:00:00.000Z";
		notes[0]!.updatedAt = "2026-10-12T00:00:00.000Z";
		noteBodies["n-shopping"] = "remote body";
		await act(async () => {
			win.dispatchEvent(new win.Event("focus"));
		});
		await settle();
		expect(container.querySelector(".note-conflict")).not.toBeNull();
		await click(
			[...container.querySelectorAll("button")].find((b) => b.textContent === "Keep mine"),
		);
		await settle();
		const mine = notePatches.at(-1);
		expect(mine).toBeTruthy();
		expect(mine!.ifMatch).toBe('"2"');
		expect((mine!.body as { body?: string }).body).toContain("milkx");
		// The saved note is still archived — the page settles to the
		// readonly view of what was written.
		expect(container.querySelector(".note-conflict")).toBeNull();
		expect(container.querySelector(".note-readonly")!.textContent).toContain("milkx");
	});

	test("Load theirs on an edited+archived conflict discards the buffer only on the click", async () => {
		notes = [noteRow("Shopping")];
		noteBodies = { "n-shopping": "milk" };
		await notePage("/app/n/n-shopping");
		const pm = container.querySelector(".ProseMirror")!;
		await editBody("x");
		notes[0]!.rev = 2;
		notes[0]!.stateRev = 2;
		notes[0]!.title = "Remote";
		notes[0]!.archivedAt = "2026-10-12T00:00:00.000Z";
		notes[0]!.updatedAt = "2026-10-12T00:00:00.000Z";
		noteBodies["n-shopping"] = "remote body";
		await act(async () => {
			win.dispatchEvent(new win.Event("focus"));
		});
		await settle();
		// Before the click the buffer is still there.
		expect(pm.textContent).toContain("milkx");
		expect(notePatches).toHaveLength(0);
		await click(
			[...container.querySelectorAll("button")].find((b) => b.textContent === "Load theirs"),
		);
		await settle();
		expect(container.querySelector(".note-conflict")).toBeNull();
		const ro = container.querySelector(".note-readonly");
		expect(ro).not.toBeNull();
		expect(ro!.textContent).toContain("remote body");
		expect((container.querySelector("input.note-title") as HTMLInputElement).value).toBe("Remote");
	});

	test("a same-rev archive flip on a clean page just goes readonly", async () => {
		notes = [noteRow("Shopping")];
		noteBodies = { "n-shopping": "milk" };
		await notePage("/app/n/n-shopping");
		notes[0]!.archivedAt = "2026-10-12T00:00:00.000Z";
		notes[0]!.stateRev += 1;
		await act(async () => {
			win.dispatchEvent(new win.Event("focus"));
		});
		await settle();
		expect(container.querySelector(".note-conflict")).toBeNull();
		expect(container.querySelector(".note-readonly")!.textContent).toContain("milk");
	});

	// An archived note never mounts the editor — a stored draft would
	// hide in localStorage until somebody unarchived on faith. The bar
	// discloses it and offers the explicit paths without unarchiving.
	const DRAFT_KEY = `goblin.note-draft.v1:${encodeURIComponent("n-shopping")}`;
	const draftBar = () =>
		[...container.querySelectorAll('[role="alert"]')].find((el) =>
			el.textContent?.includes("draft"),
		);

	test("an archived note with a stored draft discloses it — show and discard", async () => {
		notes = [noteRow("Shopping", { archivedAt: "2026-10-12T00:00:00.000Z" })];
		noteBodies = { "n-shopping": "milk" };
		win.localStorage.setItem(
			DRAFT_KEY,
			JSON.stringify({
				version: 1,
				noteId: "n-shopping",
				baseRev: 1,
				baseBody: "milk",
				body: "unsaved typing",
			}),
		);
		win.history.replaceState(null, "", "/app/n/n-shopping");
		await mount();
		await settle();

		expect(container.querySelector(".ProseMirror")).toBeNull();
		expect(container.querySelector(".note-readonly")!.textContent).toContain("milk");
		const bar = draftBar();
		expect(bar?.textContent).toContain("Unsaved local edits");

		await click([...bar!.querySelectorAll("button")].find((b) => b.textContent === "Show draft"));
		expect(container.textContent).toContain("unsaved typing");
		// Nothing touched the record — viewing isn't consent to drop it.
		expect(win.localStorage.getItem(DRAFT_KEY)).toContain("unsaved typing");

		await click(
			[...bar!.querySelectorAll("button")].find((b) => b.textContent === "Discard draft"),
		);
		expect(win.localStorage.getItem(DRAFT_KEY)).toBeNull();
		expect(draftBar()).toBeUndefined();
	});

	test("an unreadable stored draft on an archived note warns without deleting it", async () => {
		notes = [noteRow("Shopping", { archivedAt: "2026-10-12T00:00:00.000Z" })];
		win.localStorage.setItem(DRAFT_KEY, "{not json");
		win.history.replaceState(null, "", "/app/n/n-shopping");
		await mount();
		await settle();

		const bar = draftBar();
		expect(bar?.textContent).toContain("couldn't be read");
		// The raw bytes never reach the alert text.
		expect(bar?.textContent).not.toContain("not json");
		// Held until the operator's explicit discard.
		expect(win.localStorage.getItem(DRAFT_KEY)).toBe("{not json");
		expect(bar?.textContent).toContain("Download draft");
		expect(bar?.textContent).not.toContain("Show draft");
		await click(
			[...bar!.querySelectorAll("button")].find((b) => b.textContent === "Discard draft"),
		);
		expect(win.localStorage.getItem(DRAFT_KEY)).toBeNull();
	});

	// A cleared title is a real in-progress edit too — the dirty
	// predicate compares drafts, not truthiness.
	for (const draft of ["Local title", ""]) {
		test(`a same-rev archive flip under a dirty title (${draft === "" ? "cleared" : "typed"}) keeps the draft and raises the bar`, async () => {
			notes = [noteRow("Shopping")];
			noteBodies = { "n-shopping": "milk" };
			await notePage("/app/n/n-shopping");
			const pm = container.querySelector(".ProseMirror")!;
			const title = container.querySelector("input.note-title")! as HTMLInputElement;
			await typeInto(title, draft, win.HTMLInputElement.prototype);
			notes[0]!.archivedAt = "2026-10-12T00:00:00.000Z";
			notes[0]!.stateRev += 1;
			await act(async () => {
				win.dispatchEvent(new win.Event("focus"));
			});
			await settle();
			expect(container.querySelector(".note-conflict")).not.toBeNull();
			expect(title.value).toBe(draft);
			expect(container.querySelector(".ProseMirror")).toBe(pm);
			// The bar holds the autosave — nothing may PATCH under it.
			await settleLong();
			expect(notePatches).toHaveLength(0);
		});
	}

	test("a trimmed title save syncs the draft — a remote flip doesn't read it as dirty", async () => {
		notes = [noteRow("Shopping")];
		noteBodies = { "n-shopping": "milk" };
		await notePage("/app/n/n-shopping");
		const title = container.querySelector("input.note-title")! as HTMLInputElement;
		await typeInto(title, "Groceries ", win.HTMLInputElement.prototype);
		await act(async () => {
			title.dispatchEvent(new win.FocusEvent("focusout", { bubbles: true }) as unknown as Event);
		});
		await settle();
		expect(notePatches).toHaveLength(1);
		expect((notePatches[0]!.body as { title?: string }).title).toBe("Groceries");
		// The stored title is trimmed — the draft follows it, or the
		// trailing whitespace reads as an unsaved edit forever.
		expect(title.value).toBe("Groceries");
		// Proof: a remote flag flip under a clean page goes readonly —
		// a stale-dirty draft would have raised the bar instead.
		notes[0]!.archivedAt = "2026-10-12T00:00:00.000Z";
		notes[0]!.stateRev += 1;
		await act(async () => {
			win.dispatchEvent(new win.Event("focus"));
		});
		await settle();
		expect(container.querySelector(".note-conflict")).toBeNull();
		expect(container.querySelector(".note-readonly")!.textContent).toContain("milk");
	});

	const flagBtn = (label: string) =>
		[...container.querySelectorAll(".note-flags button")].find(
			(b) => b.textContent === label,
		) as HTMLButtonElement;

	test("a delayed flag ack can't resurrect the state it left — a newer remote stands", async () => {
		notes = [noteRow("Shopping")];
		noteBodies = { "n-shopping": "milk" };
		await notePage("/app/n/n-shopping");
		const gate = hold();
		notePatchHold = gate.promise;
		await click(flagBtn("Pin"));
		expect(notePatches).toHaveLength(1); // parked, unanswered
		// While the pin ack hangs, a remote archive lands via focus —
		// newer than anything the held reply can describe.
		notes[0]!.archivedAt = "2026-10-12T00:00:00.000Z";
		notes[0]!.stateRev += 1;
		await act(async () => {
			win.dispatchEvent(new win.Event("focus"));
		});
		await settle();
		expect(container.querySelector(".note-readonly")).not.toBeNull();
		// The parked pin ack answers a state behind the adopted one —
		// it can't pull the page back to unarchived.
		gate.resolve();
		await settle();
		expect(container.querySelector(".note-readonly")).not.toBeNull();
		expect(container.querySelector(".note-conflict")).toBeNull();
	});

	for (const dirty of [false, true] as const) {
		test(`a flag ack carrying a remote rename ${dirty ? "keeps the dirty title behind the bar" : "lands the clean title"}`, async () => {
			notes = [noteRow("Shopping")];
			noteBodies = { "n-shopping": "milk" };
			await notePage("/app/n/n-shopping");
			const title = container.querySelector("input.note-title")! as HTMLInputElement;
			if (dirty) await typeInto(title, "Local title", win.HTMLInputElement.prototype);
			// A remote rename+content write landed before our pin PATCH —
			// the flag ack carries that state.
			notes[0]!.title = "Renamed Remotely";
			notes[0]!.rev = 2;
			notes[0]!.stateRev = 2;
			notes[0]!.updatedAt = "2026-10-12T00:00:00.000Z";
			noteBodies["n-shopping"] = "remote body";
			await click(flagBtn("Pin"));
			await settle();
			if (dirty) {
				// The local draft stands — the remote rename is theirs
				// to resolve, not ours to overwrite.
				expect(container.querySelector(".note-conflict")).not.toBeNull();
				expect(title.value).toBe("Local title");
			} else {
				expect(container.querySelector(".note-conflict")).toBeNull();
				expect(title.value).toBe("Renamed Remotely");
				expect(container.querySelector(".ProseMirror")!.textContent).toContain("remote body");
			}
		});
	}

	test("edits typed over an in-flight title PATCH aren't stamped over by its ack", async () => {
		notes = [noteRow("Shopping")];
		noteBodies = { "n-shopping": "milk" };
		await notePage("/app/n/n-shopping");
		const title = container.querySelector("input.note-title")! as HTMLInputElement;
		const gate = hold();
		notePatchHold = gate.promise;
		await typeInto(title, "Renamed", win.HTMLInputElement.prototype);
		await act(async () => {
			(title as HTMLInputElement).blur();
		});
		expect(notePatches).toHaveLength(1); // the "Renamed" write is held
		// A revert typed while the write hangs is dirty work — the
		// ack's trimmed echo must not overwrite it back to "Renamed".
		await typeInto(title, "Shopping", win.HTMLInputElement.prototype);
		gate.resolve();
		await settle();
		expect(title.value).toBe("Shopping");
		expect(container.querySelector(".note-conflict")).toBeNull();
		// The revert commits on the next blur like an ordinary edit.
		await act(async () => {
			title.dispatchEvent(new win.FocusEvent("focusout", { bubbles: true }) as unknown as Event);
		});
		await settle();
		expect(notePatches).toHaveLength(2);
		expect((notePatches[1]!.body as { title?: string }).title).toBe("Shopping");
	});

	const openVersions = async () => {
		await click(
			[...container.querySelectorAll("button")].find((b) => b.textContent === "Versions"),
		);
		await click(container.querySelector(".note-versions button.link"));
		return [...container.querySelectorAll(".note-version-preview button")].find(
			(b) => b.textContent === "Restore" || b.textContent === "Restoring…",
		) as HTMLButtonElement;
	};

	// The real restore endpoint writes the version's title/body at a
	// fresh rev — the fixture store reflects that the moment the POST
	// lands, so GETs and held replies stay coherent.
	const restoreFixture = () => {
		notes = [noteRow("Shopping", { rev: 5, stateRev: 5 })];
		noteBodies = { "n-shopping": "current" };
		versionRows = [{ rev: 1, source: "app", conversation: null, at: "x", bytes: 4 }];
		versionPreview = {
			rev: 1,
			source: "app",
			conversation: null,
			at: "x",
			bytes: 4,
			title: "Old Title",
			body: "old",
		};
		restoreReply = {
			...noteFull(notes[0]!, "old"),
			rev: 6,
			stateRev: 6,
			title: "Old Title",
			updatedAt: "2026-10-12T00:00:00.000Z",
		};
	};

	test("an in-flight restore can't clobber intervening edits — the bar decides", async () => {
		restoreFixture();
		const gate = hold();
		await notePage("/app/n/n-shopping");
		const restore = await openVersions();
		expect(restore.disabled).toBe(false);
		restoreHold = gate.promise;
		await click(restore);
		expect(posts.filter((p) => p.url.endsWith("/restore"))).toHaveLength(1);
		// A duplicate click can't launch a second swap while one flies.
		expect(
			(
				[...container.querySelectorAll(".note-version-preview button")].find(
					(b) => b.textContent === "Restoring…",
				) as HTMLButtonElement
			).disabled,
		).toBe(true);
		await editBody("x");
		gate.resolve();
		await settle();
		// The edit wins the swap decision — bar up, buffer kept.
		expect(container.querySelector(".note-conflict")).not.toBeNull();
		expect(container.querySelector(".ProseMirror")!.textContent).toContain("currentx");
		expect((container.querySelector("input.note-title") as HTMLInputElement).value).toBe(
			"Shopping",
		);
		// No autosave may overwrite while the bar stands.
		await settleLong();
		expect(notePatches).toHaveLength(0);
		// Keep mine saves the local buffer at the restore's rev.
		await click(
			[...container.querySelectorAll("button")].find((b) => b.textContent === "Keep mine"),
		);
		await settle();
		const mine = notePatches.at(-1)!;
		expect(mine.ifMatch).toBe('"6"');
		expect((mine.body as { body?: string }).body).toContain("currentx");
	});

	test("an in-flight restore meeting an unsaved title keeps the draft and adopts metadata", async () => {
		restoreFixture();
		const gate = hold();
		await notePage("/app/n/n-shopping");
		const restore = await openVersions();
		restoreHold = gate.promise;
		await click(restore);
		const title = container.querySelector("input.note-title")! as HTMLInputElement;
		await typeInto(title, "Local title", win.HTMLInputElement.prototype);
		gate.resolve();
		await settle();
		expect(container.querySelector(".note-conflict")).not.toBeNull();
		// The draft survives — the returned title is not stamped over it.
		expect(title.value).toBe("Local title");
		expect(container.querySelector(".ProseMirror")!.textContent).toContain("current");
	});

	test("a restore on a clean buffer reloads the doc and title", async () => {
		restoreFixture();
		await notePage("/app/n/n-shopping");
		await click(await openVersions());
		await settle();
		expect(container.querySelector(".ProseMirror")!.textContent).toContain("old");
		expect((container.querySelector("input.note-title") as HTMLInputElement).value).toBe(
			"Old Title",
		);
		expect(container.querySelector(".note-conflict")).toBeNull();
	});

	test("a stale restore answer can't roll back a newer saved rev", async () => {
		restoreFixture();
		const gate = hold();
		await notePage("/app/n/n-shopping");
		const restore = await openVersions();
		restoreHold = gate.promise;
		await click(restore);
		// The restore landed server-side the moment the POST did — a
		// focus refresh adopts it cleanly while the reply is held.
		await act(async () => {
			win.dispatchEvent(new win.Event("focus"));
		});
		await settle();
		expect((container.querySelector("input.note-title") as HTMLInputElement).value).toBe(
			"Old Title",
		);
		await editBody("x");
		await settleLong();
		expect(notePatches).toHaveLength(1);
		expect(notePatches[0]!.ifMatch).toBe('"6"');
		gate.resolve();
		await settle();
		// The rev-6 reply under a rev-7 page is stale — ignored, no
		// bar, the saved buffer stands.
		expect(container.querySelector(".note-conflict")).toBeNull();
		expect(container.querySelector(".ProseMirror")!.textContent).toContain("oldx");
		expect(notePatches).toHaveLength(1);
	});

	test("a restore answer matching the adopted state isn't a conflict over new edits", async () => {
		restoreFixture();
		const gate = hold();
		await notePage("/app/n/n-shopping");
		const restore = await openVersions();
		restoreHold = gate.promise;
		await click(restore);
		// The POST already wrote server-side — a focus refresh adopts
		// and reloads rev 6 while the reply is still held.
		await act(async () => {
			win.dispatchEvent(new win.Event("focus"));
		});
		await settle();
		expect((container.querySelector("input.note-title") as HTMLInputElement).value).toBe(
			"Old Title",
		);
		await editBody("x");
		gate.resolve();
		await settle();
		// The reply restates exactly what the page holds — the edits on
		// top of it are unsaved work, not a divergence to resolve.
		expect(container.querySelector(".note-conflict")).toBeNull();
		expect(container.querySelector(".ProseMirror")!.textContent).toContain("oldx");
		// Autosave proceeds against the adopted rev — nothing was held.
		await settleLong();
		expect(notePatches).toHaveLength(1);
		expect(notePatches[0]!.ifMatch).toBe('"6"');
		expect((notePatches[0]!.body as { body?: string }).body).toContain("oldx");
	});

	test("a failed restore releases the pending guard", async () => {
		restoreFixture();
		restoreFail = true;
		await notePage("/app/n/n-shopping");
		await click(await openVersions());
		await settle();
		expect(container.querySelector(".note-versions .error")!.textContent).toContain(
			"Couldn't restore",
		);
		const again = [...container.querySelectorAll(".note-version-preview button")].find(
			(b) => b.textContent === "Restore",
		) as HTMLButtonElement;
		expect(again).toBeTruthy();
		expect(again.disabled).toBe(false);
		expect(posts.filter((p) => p.url.endsWith("/restore"))).toHaveLength(1);
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

	const chatButton = () =>
		[...container.querySelectorAll(".note-flags button")].find(
			(b) => b.textContent === "Chat with this note",
		) as HTMLButtonElement;

	test("chat flushes the pending edit before minting — held PATCH, no early navigation", async () => {
		notes = [noteRow("Shopping")];
		noteBodies = { "n-shopping": "milk" };
		await notePage("/app/n/n-shopping");
		await editBody("x");
		const gate = hold();
		notePatchHold = gate.promise;
		await click(chatButton());
		expect(notePatches).toHaveLength(1);
		expect((notePatches[0]!.body as { body?: string }).body).toContain("milkx");
		expect(notePatches[0]!.ifMatch).toBe('"1"');
		expect(posts.some((p) => p.url === "/api/app/conversations")).toBe(false);
		expect(posts.some((p) => p.url === "/api/app/chat")).toBe(false);
		expect(win.location.pathname).toBe("/app/n/n-shopping");
		await click(chatButton());
		gate.resolve();
		await settle();
		await settleSlow();
		expect(posts.filter((p) => p.url === "/api/app/conversations")).toHaveLength(1);
		expect(win.location.pathname).toBe("/app/c/minted");
		const chatPost = posts.find((p) => p.url === "/api/app/chat");
		expect(chatPost).toBeTruthy();
		const parts = (chatPost!.body as { message: { parts: unknown[] } }).message.parts;
		expect(parts).toContainEqual({
			type: "data-note",
			data: { id: "n-shopping", title: "Shopping" },
		});
	});

	test("chat joins an in-flight title PATCH — the flush rides the landed rev", async () => {
		notes = [noteRow("Shopping")];
		noteBodies = { "n-shopping": "milk" };
		await notePage("/app/n/n-shopping");
		const title = container.querySelector("input.note-title")!;
		await typeInto(title, "Shopping 2", win.HTMLInputElement.prototype);
		const gate = hold();
		notePatchHold = gate.promise;
		// The click's blur commits the title — the write mutates the
		// stored rev at request time while its reply stays held. A
		// body flush fired now would ride the stale If-Match and 409
		// over the operator's own rename.
		await act(async () => {
			(title as HTMLInputElement).blur();
		});
		await settle();
		expect(patchCalls).toBe(1);
		await editBody("x");
		await click(chatButton());
		// Still held — the flush queued behind the title write.
		expect(patchCalls).toBe(1);
		expect(posts.some((p) => p.url === "/api/app/conversations")).toBe(false);
		gate.resolve();
		await settle();
		await settleSlow();
		// The body write went out after the title landed, on its rev.
		expect(notePatches).toHaveLength(2);
		expect((notePatches[0]!.body as { title?: string }).title).toBe("Shopping 2");
		expect(notePatches[0]!.ifMatch).toBe('"1"');
		expect((notePatches[1]!.body as { body?: string }).body).toContain("milkx");
		expect(notePatches[1]!.ifMatch).toBe('"2"');
		expect(posts.filter((p) => p.url === "/api/app/conversations")).toHaveLength(1);
		expect(win.location.pathname).toBe("/app/c/minted");
		const chatPost = posts.find((p) => p.url === "/api/app/chat");
		expect(chatPost).toBeTruthy();
		const parts = (chatPost!.body as { message: { parts: unknown[] } }).message.parts;
		expect(parts).toContainEqual({
			type: "data-note",
			data: { id: "n-shopping", title: "Shopping 2" },
		});
	});

	test("a refused flush save blocks the mint — buffer stays, error shows", async () => {
		notes = [noteRow("Shopping")];
		noteBodies = { "n-shopping": "milk" };
		conflictPatch = true;
		await notePage("/app/n/n-shopping");
		await editBody("x");
		await click(chatButton());
		await settle();
		expect(notePatches).toHaveLength(1);
		expect(container.querySelector(".note-conflict")).not.toBeNull();
		expect(posts.some((p) => p.url === "/api/app/conversations")).toBe(false);
		expect(posts.some((p) => p.url === "/api/app/chat")).toBe(false);
		expect(win.location.pathname).toBe("/app/n/n-shopping");
		expect(container.querySelector(".ProseMirror")!.textContent).toContain("milkx");
		const alert = container.querySelector('p.error[role="alert"]');
		expect(alert?.textContent).toContain("Couldn't save pending edits");
	});

	test("an archived note's chat control is disabled — no mint on click", async () => {
		notes = [noteRow("Shopping", { archivedAt: "2026-10-12T00:00:00.000Z" })];
		noteBodies = { "n-shopping": "milk" };
		win.history.replaceState(null, "", "/app/n/n-shopping");
		await mount();
		await settle();
		const chat = chatButton();
		expect(chat).toBeTruthy();
		expect(chat.disabled).toBe(true);
		expect(chat.title).toBe("Unarchive this note to chat with it.");
		await click(chat);
		expect(posts.some((p) => p.url === "/api/app/conversations")).toBe(false);
		expect(posts.some((p) => p.url === "/api/app/chat")).toBe(false);
		expect(win.location.pathname).toBe("/app/n/n-shopping");
		expect(container.querySelector(".note-readonly")).not.toBeNull();
	});

	const railSearch = () => container.querySelector("input.rail-search")!;
	const searchAlert = () =>
		[...container.querySelectorAll("p.error")].find((p) =>
			p.textContent?.includes("Search failed:"),
		)?.textContent ?? null;
	const startAlert = () =>
		[...container.querySelectorAll("main p.error")].find((p) =>
			p.textContent?.includes("Couldn't start a conversation"),
		)?.textContent ?? null;
	const hold = () => {
		const g = Promise.withResolvers<void>();
		pendingGates.push(g);
		return g;
	};
	const sendComposer = async (text: string) => {
		const form = container.querySelector("form.composer")!;
		expect(form).not.toBeNull();
		await typeInto(form.querySelector("textarea")!, text, win.HTMLTextAreaElement.prototype);
		await act(async () => {
			form.dispatchEvent(
				new win.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
			);
		});
		await settle();
	};
	const notePage = async (path: string) => {
		win.history.replaceState(null, "", path);
		await mount();
		for (let i = 0; i < 20 && container.querySelector(".ProseMirror") === null; i++) {
			await settle();
		}
		expect(container.querySelector(".ProseMirror")).not.toBeNull();
	};
	const searchHit = (text: string): AppSearchHit => ({
		conversationId: "app/fixture",
		title: "fixture chat",
		seq: 1,
		role: "user",
		text,
		createdAt: "2026-10-10T00:00:00.000Z",
	});

	test("a failed rail search reports the error instead of reading as no matches", async () => {
		convs = [convRow("fixture chat")];
		searchScript = new Map([["missing", { fail: true }]]);
		await mount();

		await typeInto(railSearch(), "missing", win.HTMLInputElement.prototype);
		await settleSlow();
		expect(searchCalls).toContain("missing");
		expect(searchAlert()).toBe("Search failed: search down");
		expect(container.textContent).not.toContain("No matches.");
		// The hit branch owns the rail on failure — conversation rows must
		// not linger there looking like an outcome.
		expect(container.querySelectorAll(".conv-title").length).toBe(0);
	});

	test("clearing a failed search then querying again drops the stale alert immediately", async () => {
		searchScript = new Map([["missing", { fail: true }]]);
		await mount();
		const box = railSearch();
		await typeInto(box, "missing", win.HTMLInputElement.prototype);
		await settleSlow();
		expect(searchAlert()).toBe("Search failed: search down");

		await typeInto(box, "", win.HTMLInputElement.prototype);
		expect(searchAlert()).toBeNull();
		const gate = hold();
		searchScript.set("fresh", { hold: gate.promise, hits: [searchHit("needle")] });
		await typeInto(box, "fresh", win.HTMLInputElement.prototype);
		await settleSlow();
		expect(searchCalls).toContain("fresh");
		expect(searchAlert()).toBeNull();
		gate.resolve();
		await settle();
		expect(container.textContent).toContain("needle");
		expect(searchAlert()).toBeNull();
	});

	test("a fresh query typed over a displayed failure never flashes 'No matches.'", async () => {
		searchScript = new Map([["missing", { fail: true }]]);
		await mount();
		const box = railSearch();
		await typeInto(box, "missing", win.HTMLInputElement.prototype);
		await settleSlow();
		expect(searchAlert()).toBe("Search failed: search down");

		// Straight to a new query — no clearing step. The old alert stays
		// until the reply lands; the empty hit list must never render as
		// "No matches." in between.
		const gate = hold();
		searchScript.set("fresh", { hold: gate.promise, hits: [searchHit("needle")] });
		await typeInto(box, "fresh", win.HTMLInputElement.prototype);
		await settleSlow();
		expect(searchCalls).toContain("fresh");
		expect(container.textContent).not.toContain("No matches.");
		expect(searchAlert()).toBe("Search failed: search down");
		gate.resolve();
		await settle();
		expect(container.textContent).toContain("needle");
		expect(searchAlert()).toBeNull();
	});

	for (const outcome of ["success", "failure"] as const) {
		test(`a held search cleared mid-flight settles ${outcome} without stale rail state`, async () => {
			convs = [convRow("fixture chat")];
			const gate = hold();
			searchScript = new Map([
				["gone", { hold: gate.promise, fail: outcome === "failure", hits: [searchHit("needle")] }],
			]);
			await mount();
			const box = railSearch();
			await typeInto(box, "gone", win.HTMLInputElement.prototype);
			await settleSlow();
			expect(searchCalls).toContain("gone");
			await typeInto(box, "", win.HTMLInputElement.prototype);
			gate.resolve();
			await settle();
			expect(container.textContent).not.toContain("No matches.");
			expect(container.textContent).not.toContain("Search failed:");
			expect(container.textContent).not.toContain("needle");
			expect(
				[...container.querySelectorAll(".conv-title")].some(
					(t) => t.textContent === "fixture chat",
				),
			).toBe(true);
		});
	}

	test("a start failure clears when navigating from the empty state to a project", async () => {
		projs = [projRow("Goblin")];
		failCreate = true;
		await mount();
		await sendComposer("hi");
		expect(startAlert()).toContain("Couldn't start a conversation");

		await click(
			[...container.querySelectorAll(".rail-projects .proj")].find(
				(b) => b.textContent === "Goblin",
			),
		);
		expect(win.location.pathname).toBe("/app/p/p-goblin");
		expect(startAlert()).toBeNull();
	});

	test("a start failure on a project page clears on opening one of its notes", async () => {
		projs = [projRow("Goblin")];
		notes = [noteRow("Spec", { projectId: "p-goblin" })];
		failCreate = true;
		win.history.replaceState(null, "", "/app/p/p-goblin");
		await mount();
		await sendComposer("hi");
		expect(startAlert()).toContain("Couldn't start a conversation");

		await click(
			[...container.querySelectorAll("button.idx")].find((b) => b.textContent?.startsWith("Spec")),
		);
		expect(win.location.pathname).toBe("/app/n/n-spec");
		expect(startAlert()).toBeNull();
	});

	test("a start failure on a note page clears on New conversation", async () => {
		notes = [noteRow("Shopping")];
		failCreate = true;
		await notePage("/app/n/n-shopping");
		await click(
			[...container.querySelectorAll("button")].find(
				(b) => b.textContent === "Chat with this note",
			),
		);
		expect(startAlert()).toContain("Couldn't start a conversation");

		await click(
			[...container.querySelectorAll("nav button.new")].find(
				(b) => b.textContent === "New conversation",
			),
		);
		expect(win.location.pathname).toBe("/app/");
		expect(startAlert()).toBeNull();
	});

	test("a cleared start failure stays gone through index and operator pages, and reopening the source", async () => {
		notes = [noteRow("Shopping")];
		projs = [projRow("Goblin")];
		failCreate = true;
		await notePage("/app/n/n-shopping");
		await click(
			[...container.querySelectorAll("button")].find(
				(b) => b.textContent === "Chat with this note",
			),
		);
		expect(startAlert()).toContain("Couldn't start a conversation");

		const railSection = (label: string) =>
			click(
				[...container.querySelectorAll(".rail-projects .rail-section")].find(
					(b) => b.textContent === label,
				),
			);
		await railSection("Notes");
		expect(win.location.pathname).toBe("/app/notes");
		expect(startAlert()).toBeNull();
		await railSection("Projects");
		expect(win.location.pathname).toBe("/app/projects");
		expect(startAlert()).toBeNull();
		await click(
			[...container.querySelectorAll(".rail-ops button")].find((b) => b.textContent === "Settings"),
		);
		expect(win.location.pathname).toBe("/app/settings");
		expect(startAlert()).toBeNull();

		await railSection("Notes");
		await settleSlow();
		await click(
			[...container.querySelectorAll("button.idx")].find((b) =>
				b.textContent?.startsWith("Shopping"),
			),
		);
		expect(win.location.pathname).toBe("/app/n/n-shopping");
		expect(startAlert()).toBeNull();
	});

	test("an accepted back/forward traversal clears a stale start failure", async () => {
		notes = [noteRow("Shopping")];
		failCreate = true;
		await notePage("/app/n/n-shopping");
		await click(
			[...container.querySelectorAll("button")].find(
				(b) => b.textContent === "Chat with this note",
			),
		);
		expect(startAlert()).toContain("Couldn't start a conversation");

		await act(async () => {
			win.history.replaceState(null, "", "/app/");
			win.dispatchEvent(new win.PopStateEvent("popstate"));
		});
		await settle();
		expect(win.location.pathname).toBe("/app/");
		expect(startAlert()).toBeNull();
	});

	test("a create that fails after navigating away can't post its alert on the destination", async () => {
		projs = [projRow("Goblin")];
		notes = [noteRow("Shopping")];
		await notePage("/app/n/n-shopping");
		const gate = hold();
		createHold = gate.promise;
		await click(
			[...container.querySelectorAll("button")].find(
				(b) => b.textContent === "Chat with this note",
			),
		);
		expect(posts.some((p) => p.url === "/api/app/conversations")).toBe(true);
		expect(startAlert()).toBeNull();

		await click(
			[...container.querySelectorAll(".rail-projects .proj")].find(
				(b) => b.textContent === "Goblin",
			),
		);
		expect(win.location.pathname).toBe("/app/p/p-goblin");
		failCreate = true;
		gate.resolve();
		await settle();
		expect(win.location.pathname).toBe("/app/p/p-goblin");
		expect(startAlert()).toBeNull();
	});

	// The keyed remounts in App.tsx (`key={noteId}` on NoteView,
	// `key={currentProject.id}` on ProjectView) are load-bearing:
	// without them the previous page's component instance is reused
	// and its dirty state lands on the next page — a draft written
	// under the wrong id or If-Match rev. Drop a key and these fail.
	test("navigating between projects remounts the view — A's drafts never reach B", async () => {
		projs = [
			projRow("Alpha", { instructions: "inst A" }),
			projRow("Beta", { instructions: "inst B" }),
		];
		win.history.replaceState(null, "", "/app/p/p-alpha");
		await mount();
		const instr = () => container.querySelector<HTMLTextAreaElement>(".projfields textarea")!;
		const saveBtn = () =>
			[...container.querySelectorAll<HTMLButtonElement>(".projfields button")].find(
				(b) => b.textContent === "Save",
			)!;
		expect(instr().value).toBe("inst A");

		// Leave A dirty on purpose: an unsaved instructions draft and
		// the rename box open with an uncommitted draft.
		await typeInto(instr(), "A DRAFT", win.HTMLTextAreaElement.prototype);
		await click(container.querySelector('button[aria-label="Rename project"]'));
		await typeInto(
			container.querySelector<HTMLInputElement>(".proj-rename input")!,
			"Alpha renamed",
			win.HTMLInputElement.prototype,
		);

		await click(
			[...container.querySelectorAll(".rail-projects .proj")].find((b) => b.textContent === "Beta"),
		);
		expect(win.location.pathname).toBe("/app/p/p-beta");
		// B's own fresh state: its instructions, no rename box, a clean
		// (disabled) Save — and nothing of A's on the wire.
		expect(instr().value).toBe("inst B");
		expect(container.querySelector(".proj-rename")).toBeNull();
		expect(container.querySelector(".proj-name")!.textContent).toBe("Beta");
		expect(saveBtn().disabled).toBe(true);
		expect(projectPatches).toEqual([]);

		// A save from B's page lands at B's id with B's draft.
		await typeInto(instr(), "inst B v2", win.HTMLTextAreaElement.prototype);
		await click(saveBtn());
		expect(projectPatches).toEqual([{ id: "p-beta", body: { instructions: "inst B v2" } }]);
	});

	test("navigating between notes remounts the editor — the autosave writes B at B's rev", async () => {
		notes = [noteRow("Alpha", { rev: 3 }), noteRow("Beta", { rev: 4 })];
		noteBodies = { "n-alpha": "alpha body", "n-beta": "beta body" };
		await notePage("/app/n/n-alpha");
		expect(container.querySelector(".ProseMirror")!.textContent).toContain("alpha body");

		// The only note→note transition that keeps NoteView mounted is
		// a history traversal — every in-app link leaves through the
		// index (unmounting the subtree regardless of the key). A
		// traversal landing on another note page is the path the key
		// exists for — same popstate shape as the traversal test above.
		await act(async () => {
			win.history.replaceState(null, "", "/app/n/n-beta");
			win.dispatchEvent(new win.PopStateEvent("popstate"));
		});
		expect(win.location.pathname).toBe("/app/n/n-beta");

		// A fresh editor for B — its own body and title, not A's.
		let pm: Element | null = null;
		for (let i = 0; i < 30; i++) {
			const cand = container.querySelector(".ProseMirror");
			if (cand !== null && cand.textContent?.includes("beta body") === true) {
				pm = cand;
				break;
			}
			await settle();
		}
		expect(pm).not.toBeNull();
		expect((container.querySelector("input.note-title") as HTMLInputElement).value).toBe("Beta");

		// A real ProseMirror edit — mutate the rendered text node. The
		// DOM observer reads it into the doc, the listener flags dirty,
		// and the autosave PATCHes at B's rev.
		const textNode = pm!.querySelector("p")!.firstChild!;
		await act(async () => {
			textNode.nodeValue = `${textNode.nodeValue ?? ""}x`;
		});
		await settleLong();
		expect(notePatches).toHaveLength(1);
		expect(notePatches[0]!.id).toBe("n-beta");
		expect(notePatches[0]!.ifMatch).toBe('"4"');
		expect((notePatches[0]!.body as { body?: string }).body).toContain("beta bodyx");
	});
});

// The refresh error path fences like its success path: a stale failure
// resolving after a newer refresh settled must not paint "Couldn't
// refresh the list." over a list that did refresh. The overlap is
// routine — the gate effect, row actions, and startChat all refresh.
describe("a stale refresh failure does not clobber a newer refresh", () => {
	let win: Window;
	let container: HTMLElement;
	let root: Root | null = null;
	let installed: string[] = [];
	let created = false;
	// Conversations GETs queue in order: [probe, refresh #1, refresh #2].
	let gets: PromiseWithResolvers<Response>[] = [];
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
		installed = [];
		created = false;
		gets = [];
		installGlobal("window", win);
		installGlobal("document", win.document);
		installGlobal("navigator", win.navigator);
		installGlobal("localStorage", win.localStorage);
		installGlobal("sessionStorage", win.sessionStorage);
		installGlobal("Event", win.Event);
		installGlobal("CustomEvent", win.CustomEvent);
		installGlobal("getComputedStyle", win.getComputedStyle);
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const method = init?.method ?? (input instanceof Request ? input.method : "GET");
			if (url === "/api/app/conversations") {
				if (method === "POST") {
					created = true;
					return Promise.resolve(jsonResponse({ id: "app/kept", title: null }));
				}
				const g = Promise.withResolvers<Response>();
				gets.push(g);
				return g.promise;
			}
			if (url === "/api/app/projects") return Promise.resolve(jsonResponse({ projects: [] }));
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

	test("a failure landing after a settled refresh paints nothing", async () => {
		root = createRoot(container);
		await act(async () => {
			root?.render(<App />);
		});
		await settle();
		// Probe queued. Answer it (trust mode — gate passes); refresh #1
		// queues behind the flip.
		expect(gets.length).toBe(1);
		await act(async () => gets[0]!.resolve(jsonResponse({ conversations: [] })));
		await settle();
		expect(gets.length).toBe(2);
		// Send from the empty state: the create resolves, selects the new
		// conversation, and its refresh — the newer sequence — settles
		// with the row.
		await act(async () => {
			const ta = container.querySelector("form.composer textarea")! as HTMLTextAreaElement;
			ta.focus();
			Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value")!.set!.call(
				ta,
				"hi",
			);
			ta.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
			ta.dispatchEvent(
				new win.KeyboardEvent("keyup", { bubbles: true, key: "e" }) as unknown as Event,
			);
			container
				.querySelector("form.composer")!
				.dispatchEvent(
					new win.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
				);
		});
		await settle();
		expect(created).toBe(true);
		// startChat's refresh — plus possibly one from the seeded turn's
		// onTurnDone, which lands in the same settle window. Either way
		// every GET after the held one carries a newer sequence.
		expect(gets.length).toBeGreaterThanOrEqual(3);
		await act(async () =>
			gets[gets.length - 1]!.resolve(
				jsonResponse({
					conversations: [
						{
							id: "app/kept",
							title: "kept chat",
							preview: "",
							createdAt: "2026-10-13T00:00:00Z",
							updatedAt: "2026-10-13T00:00:00Z",
							archivedAt: null,
							pinnedAt: null,
							projectId: null,
						},
					],
				}),
			),
		);
		await settle();
		expect(container.textContent).toContain("kept chat");
		// Only now does the stale failure land — after the newer refresh
		// settled. It must paint nothing.
		await act(async () =>
			gets[1]!.resolve(
				new Response(JSON.stringify({ error: "boom" }), {
					status: 500,
					headers: { "content-type": "application/json" },
				}),
			),
		);
		await settle();
		expect(container.textContent).not.toContain("Couldn't refresh the list.");
		expect(container.textContent).toContain("kept chat");
	});
});

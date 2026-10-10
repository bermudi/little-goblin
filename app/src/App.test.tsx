import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
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

// The rail rows: three labeled actions per row — pin · rename · archive
// on active rows, rename · unarchive · delete on archived ones — and a
// pinned row floating above the activity order (design/app.md →
// Pinning). Same happy-dom mount as above; the fetch fake keeps mutable
// pin/archive stamps so the list reflects each PATCH. The payload
// arrives in activity order (fresh first) so the client's own
// pinned-first partition is what puts the pinned row on top.
describe("rail row actions and the pinned pool", () => {
	let win: Window;
	let container: HTMLElement;
	let root: Root | null = null;
	let installed: string[] = [];
	let pinnedStamp: string | null;
	let freshStamp: string | null;
	let archived: Record<"pinned" | "fresh", string | null>;
	let patches: { id: string; body: unknown }[];
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
		return [...found.querySelectorAll(".conv-actions button")].map((b) => b.textContent ?? "");
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
			[...container.querySelectorAll(".conv-actions button")].some((b) => b.textContent === "Delete"),
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
});

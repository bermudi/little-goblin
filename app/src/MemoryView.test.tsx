import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { MemoryView } from "./MemoryView.tsx";

// Mounted like ChatView's reload-window tests: the network is faked at
// globalThis.fetch, the DOM is happy-dom, and the test drives clicks.
describe("MemoryView", () => {
	let win: Window;
	let container: HTMLElement;
	let root: Root | null = null;
	let installed: string[] = [];
	const realFetch = globalThis.fetch;

	const installGlobal = (name: string, value: unknown) => {
		Reflect.set(globalThis, name, value);
		installed.push(name);
	};

	const json = (body: unknown, status = 200): Response =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});

	const STATUS = {
		state: "healthy",
		detail: "",
		deleting: 0,
		completed: 3,
		blocked: 0,
		dismissed: 0,
		queued: 0,
		lastRecallAt: "2026-01-01T00:00:00Z",
		lastRecallOk: true,
		topicNote: null,
		blockedDetail: [],
		lastSaveAt: "2026-01-01T00:00:00Z",
		blockedConversations: [],
		blockedCauses: [],
		retry: null,
	};
	const DOC = {
		id: "doc-1",
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-02T00:00:00Z",
		textLength: 42,
		factCount: 2,
		conversationId: "app/c1",
		conversationName: "Trip plans",
	};
	const NOTHING = { total: 0, conversations: [] };
	const saves = (items: unknown[], total = items.length, nothing: unknown = NOTHING) =>
		json({ kept: { items, total, limit: 20, offset: 0 }, nothingKept: nothing });
	const DETAIL = {
		document: DOC,
		originalText: "the exchange text",
		facts: [
			{ id: "f1", text: "likes rain", factType: "world", state: "valid", occurredStart: null, occurredEnd: null, mentionedAt: null, entities: null },
			{ id: "f2", text: "lives in Oslo", factType: "world", state: "invalidated", occurredStart: null, occurredEnd: null, mentionedAt: null, entities: null },
		],
		factsTotal: 2,
	};
	const pathOf = (input: RequestInfo | URL) => new URL(String(input), "http://localhost");

	beforeEach(() => {
		win = new Window();
		const div = win.document.createElement("div");
		win.document.body.appendChild(div);
		container = div as unknown as HTMLElement;
		installed = [];
		installGlobal("window", win);
		installGlobal("document", win.document);
		installGlobal("navigator", win.navigator);
		installGlobal("localStorage", win.localStorage);
		installGlobal("Event", win.Event);
		installGlobal("CustomEvent", win.CustomEvent);
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
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

	const mount = () => {
		root = createRoot(container);
		act(() => {
			root?.render(<MemoryView token={null} />);
		});
	};
	// The doc list is debounced 250ms — let real timers run inside act.
	const flush = () =>
		act(async () => {
			await new Promise((r) => setTimeout(r, 300));
		});
	const click = async (el: Element | null | undefined) => {
		expect(el).toBeTruthy();
		await act(async () => {
			(el as HTMLElement).click();
		});
	};
	const search = async (value: string) => {
		await act(async () => {
			const input = container.querySelector("input")!;
			// Combined runs can load React before the DOM. Focus + keyup
			// also drives its text-input fallback in that environment.
			input.focus();
			Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(
				input,
				value,
			);
			input.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
			input.dispatchEvent(
				new win.KeyboardEvent("keyup", { bubbles: true, key: "w" }) as unknown as Event,
			);
		});
	};
	const more = () =>
		[...container.querySelectorAll("button")].find((b) => b.textContent === "Load more")!;

	test("health first, rows name the conversation, expand shows facts, forget round-trips", async () => {
		let deleted = false;
		const seen: string[] = [];
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = pathOf(input);
			if (init?.method === "DELETE") seen.push(url.pathname);
			if (url.pathname.endsWith("/memory/status")) return Promise.resolve(json(STATUS));
			if (url.pathname.endsWith("/memory/saves"))
				return Promise.resolve(saves(deleted ? [] : [DOC]));
			if (url.pathname.endsWith("/doc-1")) {
				if (init?.method === "DELETE") {
					deleted = true;
					return Promise.resolve(json({ ok: true, cancelled: 1, redacted: 1 }));
				}
				return Promise.resolve(json(DETAIL));
			}
			return Promise.resolve(json({ error: "unmapped" }, 404));
		}) as typeof fetch;
		Reflect.set(win, "confirm", () => true);
		mount();
		await flush();
		const text = () => container.textContent ?? "";
		expect(container.querySelector("h1")?.textContent).toBe("Memory is working");
		expect(text()).toContain("Trip plans");
		expect(text()).not.toContain("doc-1");
		expect(text()).toContain("Kept 2 facts");
		expect(text()).toContain("3 exchanges processed so far");

		await click(container.querySelector(".mem-saves .dt-row"));
		await act(async () => {});
		expect(text()).toContain("likes rain");
		expect(container.querySelector(".fact.stale")?.textContent).toContain("lives in Oslo");

		await click(container.querySelector(".mem-expand .danger"));
		await act(async () => {});
		expect(seen).toEqual(["/api/app/memory/documents/doc-1"]);
		expect(text()).not.toContain("likes rain");
		expect(text()).toContain("Nothing has been kept yet.");
	});

	test("a declined confirm never issues the delete", async () => {
		const seen: string[] = [];
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = pathOf(input);
			if (init?.method === "DELETE") seen.push(url.pathname);
			if (url.pathname.endsWith("/memory/status")) return Promise.resolve(json(STATUS));
			if (url.pathname.endsWith("/memory/saves")) return Promise.resolve(saves([DOC]));
			return Promise.resolve(json(DETAIL));
		}) as typeof fetch;
		Reflect.set(win, "confirm", () => false);
		mount();
		await flush();
		await click(container.querySelector(".mem-saves .dt-row"));
		await act(async () => {});
		await click(container.querySelector(".mem-expand .danger"));
		expect(seen).toEqual([]);
	});

	test("blocked exchanges show a problem card naming conversations; Try again requeues", async () => {
		const posts: string[] = [];
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = pathOf(input);
			if (init?.method === "POST") {
				posts.push(url.pathname);
				return Promise.resolve(json({ ok: true, requeued: 2 }));
			}
			if (url.pathname.endsWith("/memory/status"))
				return Promise.resolve(
					json({
						...STATUS,
						state: "degraded",
						blocked: 2,
						blockedCauses: [{ error: "hindsight 500", count: 2 }],
						blockedConversations: [{ conversationId: "app/c1", name: "Trip plans", count: 2 }],
					}),
				);
			return Promise.resolve(saves([]));
		}) as typeof fetch;
		mount();
		await flush();
		expect(container.querySelector("h1")?.textContent).toBe("Memory can't save");
		const card = container.querySelector(".mem-problem")!;
		expect(card.textContent).toContain("hindsight 500");
		expect(card.textContent).toContain("Trip plans");
		const retryBtn = [...card.querySelectorAll("button")].find((b) => b.textContent === "Try again");
		await click(retryBtn);
		expect(posts).toHaveLength(1);
	});

	test("retry progress shows done, still queued and failed again per conversation", async () => {
		globalThis.fetch = ((input: RequestInfo | URL) => {
			const url = pathOf(input);
			if (url.pathname.endsWith("/memory/status"))
				return Promise.resolve(
					json({
						...STATUS,
						retry: {
							startedAt: new Date().toISOString(),
							done: 3,
							queued: 2,
							failed: 1,
							conversations: [
								{ conversationId: "app/c1", name: "Trip plans", done: 3, queued: 1, failed: 0 },
								{ conversationId: "app/c2", name: "Budget", done: 0, queued: 1, failed: 1 },
							],
						},
					}),
				);
			return Promise.resolve(saves([]));
		}) as typeof fetch;
		mount();
		await flush();
		const card = container.querySelector(".mem-retry")!;
		expect(card.textContent).toContain("Saving 6 retried exchanges");
		expect(card.textContent).toContain("still queued");
		expect(card.textContent).toContain("Trip plans");
		expect(card.textContent).toContain("Budget");
	});

	test("nothing-kept section is collapsed until opened", async () => {
		globalThis.fetch = ((input: RequestInfo | URL) => {
			const url = pathOf(input);
			if (url.pathname.endsWith("/memory/status")) return Promise.resolve(json(STATUS));
			return Promise.resolve(
				saves([DOC], 1, {
					total: 4,
					conversations: [{ conversationId: "app/c2", name: "Budget", count: 4, latestAt: null }],
				}),
			);
		}) as typeof fetch;
		mount();
		await flush();
		expect(container.querySelector(".mem-fold")?.textContent).toContain("Nothing kept");
		expect(container.querySelector(".mem-fold")?.textContent).toContain("4 exchanges");
		expect(container.textContent).not.toContain("Budget");
		await click(container.querySelector(".mem-fold"));
		expect(container.textContent).toContain("Budget");
	});

	test("pagination waits for replacement results and uses their filter and offset", async () => {
		const requests: URL[] = [];
		let replace!: (response: Response) => void;
		const replacement = new Promise<Response>((resolve) => {
			replace = resolve;
		});
		const row = (id: string) => ({ ...DOC, id, conversationName: id });
		globalThis.fetch = ((input: RequestInfo | URL) => {
			const url = pathOf(input);
			if (url.pathname.endsWith("/memory/status")) return Promise.resolve(json(STATUS));
			requests.push(url);
			if (url.searchParams.get("q") === "new" && url.searchParams.get("offset") === "0")
				return replacement;
			const id = url.searchParams.has("q") ? "new-page-2" : "old-query";
			return Promise.resolve(saves([row(id)], 3));
		}) as typeof fetch;
		mount();
		await flush();
		expect(more().disabled).toBe(false);
		await search("new");
		expect(more().disabled).toBe(true);
		await click(more());
		expect(requests).toHaveLength(1);
		await flush();
		expect(requests).toHaveLength(2);
		expect(requests[1]!.searchParams.get("offset")).toBe("0");
		await act(async () => {
			replace(saves([row("new-query")], 3));
		});
		expect(container.textContent).not.toContain("old-query");
		expect(container.textContent).toContain("new-query");
		expect(more().disabled).toBe(false);
		await click(more());
		expect(requests[2]!.searchParams.get("q")).toBe("new");
		expect(requests[2]!.searchParams.get("offset")).toBe("1");
		expect(container.textContent).toContain("new-page-2");
		expect(container.textContent).not.toContain("old-query");
	});

	test("a failed replacement does not enable pagination on the old rows with a new filter", async () => {
		const requests: URL[] = [];
		globalThis.fetch = ((input: RequestInfo | URL) => {
			const url = pathOf(input);
			if (url.pathname.endsWith("/memory/status")) return Promise.resolve(json(STATUS));
			requests.push(url);
			return Promise.resolve(
				url.searchParams.has("q") ? json({ error: "replacement failed" }, 503) : saves([DOC], 3),
			);
		}) as typeof fetch;
		mount();
		await flush();
		await search("new");
		await flush();
		expect(container.textContent).toContain("replacement failed");
		expect(more().disabled).toBe(true);
		await click(more());
		expect(requests).toHaveLength(2);
	});
});

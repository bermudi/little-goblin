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
		queued: 1,
		lastRecallAt: null,
		lastRecallOk: null,
		topicNote: null,
		blockedDetail: [],
	};
	const DOC = {
		id: "doc-1",
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-02T00:00:00Z",
		textLength: 42,
		factCount: 2,
		conversationId: "tg/1",
	};
	const DOC2 = { ...DOC, id: "doc-2" };
	const DETAIL = {
		document: DOC,
		originalText: "the exchange text",
		facts: [
			{
				id: "f1",
				text: "likes rain",
				factType: "world",
				state: "valid",
				occurredStart: null,
				occurredEnd: null,
				mentionedAt: null,
				entities: null,
			},
			{
				id: "f2",
				text: "lives in Oslo",
				factType: "world",
				state: "invalidated",
				occurredStart: null,
				occurredEnd: null,
				mentionedAt: null,
				entities: null,
			},
		],
		factsTotal: 2,
	};

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

	test("status, list, detail, then forget round-trips through the API", async () => {
		const seen: { method: string; path: string }[] = [];
		let deleted = false;
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const path = new URL(url, "http://localhost").pathname;
			seen.push({ method: init?.method ?? "GET", path });
			if (path === "/api/app/memory/status") return Promise.resolve(json(STATUS));
			if (path === "/api/app/memory/documents")
				return Promise.resolve(
					json({ items: deleted ? [] : [DOC], total: deleted ? 0 : 1, limit: 20, offset: 0 }),
				);
			if (path === "/api/app/memory/documents/doc-1" && init?.method === "DELETE") {
				deleted = true;
				return Promise.resolve(json({ ok: true, cancelled: 1, redacted: 1 }));
			}
			if (path === "/api/app/memory/documents/doc-1") return Promise.resolve(json(DETAIL));
			return Promise.resolve(json({ error: "unmapped" }, 404));
		}) as typeof fetch;
		// The view's confirm gate reads the window global — which IS win.
		Reflect.set(win, "confirm", () => true);

		mount();
		await flush();
		expect(container.textContent).toContain("healthy");
		expect(container.textContent).toContain("doc-1");

		// Open the document — original text and both fact states render.
		await click(container.querySelector(".doc-row"));
		await act(async () => {});
		expect(container.textContent).toContain("the exchange text");
		expect(container.textContent).toContain("likes rain");
		const stale = container.querySelector(".fact.stale");
		expect(stale?.textContent).toContain("lives in Oslo");

		// Forget — confirm-gated DELETE, then back to the list.
		await click(container.querySelector(".danger"));
		await act(async () => {});
		expect(deleted).toBe(true);
		expect(container.textContent).not.toContain("the exchange text");
		expect(
			seen.some((r) => r.method === "DELETE" && r.path === "/api/app/memory/documents/doc-1"),
		).toBe(true);
	});

	test("a declined confirm never issues the delete", async () => {
		const seen: string[] = [];
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const path = new URL(url, "http://localhost").pathname;
			if (init?.method === "DELETE") seen.push(path);
			if (path === "/api/app/memory/status") return Promise.resolve(json(STATUS));
			if (path === "/api/app/memory/documents")
				return Promise.resolve(json({ items: [DOC], total: 1, limit: 20, offset: 0 }));
			if (path === "/api/app/memory/documents/doc-1") return Promise.resolve(json(DETAIL));
			return Promise.resolve(json({ error: "unmapped" }, 404));
		}) as typeof fetch;
		Reflect.set(win, "confirm", () => false);

		mount();
		await flush();
		await click(container.querySelector(".doc-row"));
		await act(async () => {});
		await click(container.querySelector(".danger"));
		expect(seen).toEqual([]);
	});

	test("pagination waits for replacement results and uses their filter and offset", async () => {
		const requests: URL[] = [];
		let replace!: (response: Response) => void;
		const replacement = new Promise<Response>((resolve) => {
			replace = resolve;
		});
		globalThis.fetch = ((input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://localhost");
			if (url.pathname.endsWith("/status")) return Promise.resolve(json(STATUS));
			requests.push(url);
			if (url.searchParams.get("q") === "new" && url.searchParams.get("offset") === "0")
				return replacement;
			const id = url.searchParams.has("q") ? "new-page-2" : "old-query";
			return Promise.resolve(json({ items: [{ ...DOC, id }], total: 3, limit: 20, offset: 0 }));
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
		expect(more().disabled).toBe(true);
		await click(more());
		expect(requests).toHaveLength(2);

		await act(async () => {
			replace(json({ items: [{ ...DOC, id: "new-query" }], total: 3, limit: 20, offset: 0 }));
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

	test("an old page arriving during the new search's debounce is ignored", async () => {
		let resolveOldPage!: (response: Response) => void;
		const oldPage = new Promise<Response>((resolve) => {
			resolveOldPage = resolve;
		});
		globalThis.fetch = ((input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://localhost");
			if (url.pathname.endsWith("/status")) return Promise.resolve(json(STATUS));
			if (url.searchParams.get("offset") === "1") return oldPage;
			const id = url.searchParams.has("q") ? "new-query" : "old-query";
			return Promise.resolve(json({ items: [{ ...DOC, id }], total: 3, limit: 20, offset: 0 }));
		}) as typeof fetch;
		mount();
		await flush();
		await click(more());
		await search("new");
		await act(async () => {
			resolveOldPage(json({ items: [{ ...DOC, id: "stale-page" }], total: 3 }));
		});
		expect(container.textContent).not.toContain("stale-page");
		expect(more().disabled).toBe(true);
		await flush();
		expect(container.textContent).toContain("new-query");
		expect(container.textContent).not.toContain("old-query");
	});

	test("a failed replacement does not enable pagination on the old rows with a new filter", async () => {
		const requests: URL[] = [];
		globalThis.fetch = ((input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://localhost");
			if (url.pathname.endsWith("/status")) return Promise.resolve(json(STATUS));
			requests.push(url);
			return Promise.resolve(
				url.searchParams.has("q")
					? json({ error: "replacement failed" }, 503)
					: json({ items: [DOC], total: 3, limit: 20, offset: 0 }),
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

	test("Forget supersedes a pending search debounce without leaving pagination stuck", async () => {
		let lists = 0;
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "http://localhost");
			if (url.pathname.endsWith("/status")) return Promise.resolve(json(STATUS));
			if (url.pathname.endsWith("/doc-1"))
				return Promise.resolve(
					init?.method === "DELETE" ? json({ ok: true, cancelled: 1, redacted: 1 }) : json(DETAIL),
				);
			++lists;
			return Promise.resolve(json({ items: [DOC], total: 3, limit: 20, offset: 0 }));
		}) as typeof fetch;
		Reflect.set(win, "confirm", () => true);
		mount();
		await flush();
		await search("new");
		await click(container.querySelector(".doc-row"));
		await click(container.querySelector(".danger"));
		await flush();
		expect(lists).toBe(2);
		expect(more().disabled).toBe(false);
	});

	test("a delayed Forget completion refreshes the current filter, not the filter it started with", async () => {
		let finishDelete!: (response: Response) => void;
		const deleted = new Promise<Response>((resolve) => {
			finishDelete = resolve;
		});
		const requests: URL[] = [];
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "http://localhost");
			if (url.pathname.endsWith("/status")) return Promise.resolve(json(STATUS));
			if (url.pathname.endsWith("/old-query")) return Promise.resolve(json(DETAIL));
			if (url.pathname.endsWith("/doc-1"))
				return init?.method === "DELETE" ? deleted : Promise.resolve(json(DETAIL));
			requests.push(url);
			const id = url.searchParams.has("q") ? "new-query" : "old-query";
			return Promise.resolve(json({ items: [{ ...DOC, id }], total: 3, limit: 20, offset: 0 }));
		}) as typeof fetch;
		Reflect.set(win, "confirm", () => true);
		mount();
		await flush();
		await click(container.querySelector(".doc-row"));
		await click(container.querySelector(".danger"));
		await click(container.querySelector(".ops-back button"));
		await search("new");
		await flush();
		expect(container.textContent).toContain("new-query");
		await act(async () => {
			finishDelete(json({ ok: true, cancelled: 1, redacted: 1 }));
		});
		expect(requests.at(-1)!.searchParams.get("q")).toBe("new");
		expect(container.textContent).toContain("new-query");
		expect(container.textContent).not.toContain("old-query");
		expect(more().disabled).toBe(false);
	});

	test("a slower open loses to a newer open, and Forget targets the doc on screen", async () => {
		const resolves = new Map<string, (r: Response) => void>();
		const deleted: string[] = [];
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "http://localhost");
			if (url.pathname.endsWith("/status")) return Promise.resolve(json(STATUS));
			if (url.pathname.endsWith("/documents"))
				return Promise.resolve(
					json({ items: [DOC, DOC2], total: 2, limit: 20, offset: 0 }),
				);
			if (init?.method === "DELETE") {
				deleted.push(url.pathname);
				return Promise.resolve(json({ ok: true, cancelled: 1, redacted: 1 }));
			}
			if (url.pathname.endsWith("/doc-1") || url.pathname.endsWith("/doc-2"))
				return new Promise<Response>((resolve) =>
					resolves.set(url.pathname.split("/").pop()!, resolve),
				);
			return Promise.resolve(json({ error: "unmapped" }, 404));
		}) as typeof fetch;
		Reflect.set(win, "confirm", () => true);
		mount();
		await flush();
		const rows = [...container.querySelectorAll(".doc-row")];
		expect(rows).toHaveLength(2);
		// Open doc-1, then doc-2 before doc-1 answers — doc-2 wins.
		await click(rows[0]);
		await click(rows[1]);
		await act(async () => {
			resolves.get("doc-2")!(json({ ...DETAIL, document: DOC2, originalText: "second text" }));
		});
		expect(container.textContent).toContain("second text");
		await act(async () => {
			resolves.get("doc-1")!(json(DETAIL));
		});
		expect(container.textContent).toContain("second text");
		expect(container.textContent).not.toContain("the exchange text");
		await click(container.querySelector(".danger"));
		await act(async () => {});
		expect(deleted).toEqual(["/api/app/memory/documents/doc-2"]);
	});
});

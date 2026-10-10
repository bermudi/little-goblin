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
});

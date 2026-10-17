import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { ThreadSourcesSheet } from "./ThreadSourcesSheet.tsx";

// Mounted like MemoryView's tests: fetch faked at globalThis.fetch,
// happy-dom, click-driven. The sheet is the thread panel's whole
// surface — skills (read-only) + retained exchanges (detail + forget).
describe("ThreadSourcesSheet", () => {
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

	const SKILLS = {
		items: [
			{
				skill: "open-source-check",
				state: "installed",
				kind: "reviewer",
				firstAt: "2026-10-16T00:43:45.790Z",
				lastAt: "2026-10-16T00:43:45.790Z",
			},
			{
				skill: "weather",
				state: "proposed",
				kind: "reviewer",
				firstAt: "2026-10-06T03:48:37.698Z",
				lastAt: "2026-10-06T03:48:37.698Z",
			},
		],
	};
	const DOC = {
		id: "exchange/app/1/2/abc",
		createdAt: "2026-10-01T00:00:00Z",
		updatedAt: null,
		textLength: 42,
		factCount: 2,
		conversationId: "app/1",
	};
	const DETAIL = {
		document: DOC,
		originalText: "the exchange text",
		facts: [],
		factsTotal: 0,
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
			root?.render(
				<ThreadSourcesSheet
					token={null}
					conversationId="app/1"
					title="weather app"
					onClose={() => {}}
				/>,
			);
		});
	};
	const flush = () =>
		act(async () => {
			await new Promise((r) => setTimeout(r, 20));
		});
	const click = async (el: Element | null | undefined) => {
		expect(el).toBeTruthy();
		await act(async () => {
			(el as HTMLElement).click();
		});
	};
	const confirmSpy = (ok: boolean) => {
		// happy-dom's typings miss confirm; the runtime has it.
		(win as unknown as { confirm(ok: boolean): boolean }).confirm = () => ok;
	};

	test("loads skills and this thread's exchanges, filters by conversation, opens detail, forgets", async () => {
		const seen: { method: string; path: string }[] = [];
		let deleted = false;
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "https://x");
			seen.push({ method: init?.method ?? "GET", path: url.pathname + url.search });
			if (url.pathname === "/api/app/skills/from") {
				expect(url.searchParams.get("conversation")).toBe("app/1");
				return Promise.resolve(json(SKILLS));
			}
			if (url.pathname === "/api/app/memory/documents") {
				expect(url.searchParams.get("conversation")).toBe("app/1");
				if (deleted) return Promise.resolve(json({ items: [], total: 0, limit: 20, offset: 0 }));
				return Promise.resolve(json({ items: [DOC], total: 1, limit: 20, offset: 0 }));
			}
			if (url.pathname === `/api/app/memory/documents/${encodeURIComponent(DOC.id)}`) {
				if (init?.method === "DELETE") {
					deleted = true;
					return Promise.resolve(json({ ok: true, cancelled: 0, redacted: 0 }));
				}
				return Promise.resolve(json(DETAIL));
			}
			return Promise.resolve(json({ error: "unexpected" }, 500));
		}) as typeof fetch;

		mount();
		await flush();

		// Skills: state words, and the proposed row carries the decide
		// affordance — installed rows don't.
		const skillRows = [...container.querySelectorAll(".skill-row")];
		expect(skillRows.map((r) => r.textContent)).toEqual([
			expect.stringContaining("open-source-check"),
			expect.stringContaining("weather"),
		]);
		const proposed = skillRows.find((r) => r.textContent?.includes("weather"))!;
		const installed = skillRows.find((r) => r.textContent?.includes("open-source-check"))!;
		expect(installed.querySelector("button")).toBeNull();
		expect([...proposed.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
			"install",
			"discard",
		]);

		// Exchanges: this conversation's documents.
		const docRow = container.querySelector(".doc-row");
		expect(docRow?.textContent).toContain("exchange/app/1/2/abc");

		// Detail, then forget — the shared sheet flow.
		await click(docRow);
		await flush();
		expect(container.textContent).toContain("the exchange text");

		confirmSpy(true);
		const forget = [...container.querySelectorAll("button")].find(
			(b) => b.textContent === "Forget this exchange",
		);
		await click(forget);
		await flush();
		// The delete rode the doc's own endpoint; the list reload comes
		// back empty.
		expect(seen.some((s) => s.method === "DELETE")).toBe(true);
		expect(container.textContent).toContain("Nothing retained.");
	});

	test("a proposed row's discard posts skills/decide and the list re-reads", async () => {
		const seen: { method: string; path: string; body?: string }[] = [];
		let decided = false;
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "https://x");
			seen.push({
				method: init?.method ?? "GET",
				path: url.pathname + url.search,
				...(typeof init?.body === "string" ? { body: init.body } : {}),
			});
			if (url.pathname === "/api/app/skills/from") {
				const items = decided
					? SKILLS.items.map((s) =>
							s.skill === "weather" ? { ...s, state: "gone" } : s,
						)
					: SKILLS.items;
				return Promise.resolve(json({ items }));
			}
			if (url.pathname === "/api/app/skills/decide") {
				decided = true;
				return Promise.resolve(
					json({ ok: true, skill: "weather", action: "discard", replaced: false, state: "gone" }),
				);
			}
			if (url.pathname === "/api/app/memory/documents")
				return Promise.resolve(json({ items: [], total: 0, limit: 20, offset: 0 }));
			return Promise.resolve(json({ error: "unexpected" }, 500));
		}) as typeof fetch;

		mount();
		await flush();
		const proposed = [...container.querySelectorAll(".skill-row")].find((r) =>
			r.textContent?.includes("weather"),
		);
		const discard = [...proposed!.querySelectorAll("button")].find(
			(b) => b.textContent === "discard",
		);
		await click(discard);
		await flush();
		const post = seen.find((s) => s.path === "/api/app/skills/decide");
		expect(post?.method).toBe("POST");
		expect(JSON.parse(post!.body!)).toEqual({ name: "weather", action: "discard" });
		// The row re-read — the state chip now says gone and the buttons left.
		expect(proposed!.textContent).toContain("gone");
		expect([...proposed!.querySelectorAll("button")]).toHaveLength(0);
	});

	test("both sections surface their own errors without hiding the other", async () => {
		globalThis.fetch = ((input: RequestInfo | URL) => {
			const url = new URL(String(input), "https://x");
			if (url.pathname === "/api/app/skills/from")
				return Promise.resolve(json({ error: "skill provenance unavailable" }, 503));
			if (url.pathname === "/api/app/memory/documents")
				return Promise.resolve(json({ items: [DOC], total: 1, limit: 20, offset: 0 }));
			return Promise.resolve(json({ error: "unexpected" }, 500));
		}) as typeof fetch;

		mount();
		await flush();
		const text = container.textContent ?? "";
		expect(text).toContain("skill provenance unavailable");
		expect(text).toContain("exchange/app/1/2/abc");
	});

	test("empty sections say so — absence of provenance is not an error", async () => {
		globalThis.fetch = ((input: RequestInfo | URL) => {
			const url = new URL(String(input), "https://x");
			if (url.pathname === "/api/app/skills/from") return Promise.resolve(json({ items: [] }));
			if (url.pathname === "/api/app/memory/documents")
				return Promise.resolve(json({ items: [], total: 0, limit: 20, offset: 0 }));
			return Promise.resolve(json({ error: "unexpected" }, 500));
		}) as typeof fetch;

		mount();
		await flush();
		const text = container.textContent ?? "";
		expect(text).toContain("No skills generated from this conversation.");
		expect(text).toContain("Nothing retained.");
	});
});

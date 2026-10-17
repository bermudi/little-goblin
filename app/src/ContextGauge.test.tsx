// The context gauge's contract: label formatting over the server's
// AppContextView, plus the one mounted invariant — reads belong to the
// conversation that produced them, so a conversationId switch on a
// live instance must never show the previous conversation's numbers.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { ContextGauge, contextCount, contextLabel } from "./ChatView.tsx";
import type { AppContextView } from "../../src/http/app-wire.ts";

const view = (patch: Partial<AppContextView>): AppContextView => ({
	model: "test/m",
	input: null,
	output: null,
	cacheRead: null,
	cacheWrite: null,
	cacheHitRate: null,
	avgCacheHitRate: null,
	limit: null,
	pct: null,
	turns: 0,
	...patch,
});

describe("context gauge labels", () => {
	test("counts stay raw below a thousand, compact above it", () => {
		expect(contextCount(340)).toBe("340");
		expect(contextCount(1500)).toBe("1.5k");
		expect(contextCount(104321)).toBe("104.3k");
		expect(contextCount(1000000)).toBe("1.0M");
	});

	test("a fresh conversation names itself instead of showing zeros", () => {
		expect(contextLabel(null)).toBe("…");
		expect(contextLabel(view({ turns: 0 }))).toBe("no turns yet");
	});

	test("the settled label carries input, limit, and percent", () => {
		expect(contextLabel(view({ input: 104321, limit: 1000000, pct: 10.4, turns: 3 }))).toBe(
			"104.3k/1.0M · 10.4%",
		);
	});

	test("an unlisted model still shows the input count", () => {
		expect(contextLabel(view({ input: 512, limit: null, turns: 1 }))).toBe("512 tok");
	});

	test("turns without usable counts read as unknown, not zero", () => {
		expect(contextLabel(view({ input: null, turns: 2 }))).toBe("ctx ?");
	});
});

// Mounted with happy-dom like Composer.test.tsx; the wire is faked at
// globalThis.fetch, the only place the gauge's GET touches the network.
describe("ContextGauge conversation switch", () => {
	let win: Window;
	let container: HTMLElement;
	let root: Root | null = null;
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
		installed = [];
		installGlobal("window", win);
		installGlobal("document", win.document);
		installGlobal("navigator", win.navigator);
		installGlobal("localStorage", win.localStorage);
		installGlobal("Event", win.Event);
		installGlobal("CustomEvent", win.CustomEvent);
		installGlobal("getComputedStyle", win.getComputedStyle);
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

	test("a conversationId switch never wears the previous conversation's numbers", async () => {
		const ctxA = view({ input: 5000, limit: 10000, pct: 50, turns: 3 });
		let failB!: (err: unknown) => void;
		const bFetch = new Promise<Response>((_res, rej) => {
			failB = rej;
		});
		globalThis.fetch = ((input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === "/api/app/conversations/aaa/context")
				return Promise.resolve(
					new Response(JSON.stringify(ctxA), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				);
			if (url === "/api/app/conversations/bbb/context") return bFetch;
			return Promise.reject(new Error(`unexpected fetch ${url}`));
		}) as typeof fetch;

		root = createRoot(container);
		await act(async () => {
			root?.render(<ContextGauge token={null} conversationId="app/aaa" busy={false} />);
		});
		const label = () => container.querySelector(".ctx-btn")?.textContent;
		expect(label()).toBe("5.0k/10.0k · 50%");

		act(() => {
			root?.render(<ContextGauge token={null} conversationId="app/bbb" busy={false} />);
		});
		// B's read is still in flight — the gauge reads as loading,
		// never as the previous conversation.
		expect(label()).toBe("…");

		// And when B's read fails, the failure sentinel stands — the old
		// numbers don't survive it.
		await act(async () => {
			failB(new Error("boom"));
		});
		expect(label()).toBe("ctx ?");
	});

	test("Compact now posts through the conversation's lane and reports the fold", async () => {
		const ctxA = view({ input: 5000, limit: 10000, pct: 50, turns: 3 });
		const hit = { compacted: null as string | null };
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === "/api/app/conversations/aaa/context")
				return Promise.resolve(
					new Response(JSON.stringify(ctxA), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				);
			if (url === "/api/app/conversations/aaa/compact" && init?.method === "POST") {
				hit.compacted = url;
				return Promise.resolve(
					new Response(
						JSON.stringify({
							compacted: true,
							eventsCompacted: 7,
							tailEvents: 3,
							tokensBefore: 4100,
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
				);
			}
			return Promise.reject(new Error(`unexpected fetch ${url}`));
		}) as typeof fetch;

		root = createRoot(container);
		await act(async () => {
			root?.render(<ContextGauge token={null} conversationId="app/aaa" busy={false} />);
		});
		const btn = container.querySelector(".ctx-btn") as HTMLButtonElement;
		act(() => {
			btn.click();
		});
		const act1 = container.querySelector(".ctx-act") as HTMLButtonElement;
		expect(act1.textContent).toBe("Compact now");
		await act(async () => {
			act1.click();
		});
		expect(hit.compacted).toBe("/api/app/conversations/aaa/compact");
		expect(container.querySelector(".ctx-outcome")?.textContent).toBe(
			"folded 7 messages (~4k tok) — kept the last 3",
		);
		// The numbers are the last turn's usage — a fold moves the next
		// turn, not this readout.
		expect(container.querySelector(".ctx-btn")?.textContent).toBe("5.0k/10.0k · 50%");
	});

	test("a late read for the previous conversation is dropped on switch", async () => {
		const ctxA = view({ input: 5000, limit: 10000, pct: 50, turns: 3 });
		const ctxB = view({ input: 2000, limit: 10000, pct: 20, turns: 1 });
		let resolveA!: (res: Response) => void;
		let resolveB!: (res: Response) => void;
		const aFetch = new Promise<Response>((res) => {
			resolveA = res;
		});
		const bFetch = new Promise<Response>((res) => {
			resolveB = res;
		});
		const json = (body: unknown) =>
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		globalThis.fetch = ((input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === "/api/app/conversations/aaa/context") return aFetch;
			if (url === "/api/app/conversations/bbb/context") return bFetch;
			return Promise.reject(new Error(`unexpected fetch ${url}`));
		}) as typeof fetch;

		root = createRoot(container);
		act(() => {
			root?.render(<ContextGauge token={null} conversationId="app/aaa" busy={false} />);
		});
		const label = () => container.querySelector(".ctx-btn")?.textContent;
		expect(label()).toBe("…");

		// The switch lands on a conversation mid-turn — its fetch effect
		// early-returns on busy, so the identity reset alone must retire
		// A's still-pending read.
		act(() => {
			root?.render(<ContextGauge token={null} conversationId="app/bbb" busy={true} />);
		});
		await act(async () => {
			resolveA(json(ctxA));
		});
		expect(label()).toBe("…");

		act(() => {
			root?.render(<ContextGauge token={null} conversationId="app/bbb" busy={false} />);
		});
		await act(async () => {
			resolveB(json(ctxB));
		});
		expect(label()).toBe("2.0k/10.0k · 20%");
	});
});

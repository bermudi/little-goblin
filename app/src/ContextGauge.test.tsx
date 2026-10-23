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
	segments: null,
	...patch,
});

describe("context gauge labels", () => {
	test("counts stay raw below a thousand, compact above it", () => {
		expect(contextCount(340)).toBe("340");
		expect(contextCount(1500)).toBe("1.5k");
		expect(contextCount(104321)).toBe("104.3k");
		expect(contextCount(1000000)).toBe("1M");
		expect(contextCount(200000)).toBe("200k");
	});

	test("a fresh conversation names itself instead of showing zeros", () => {
		expect(contextLabel(null)).toBe("…");
		expect(contextLabel(view({ turns: 0 }))).toBe("no turns yet");
	});

	test("the settled label carries input, limit, and percent", () => {
		expect(contextLabel(view({ input: 104321, limit: 1000000, pct: 10.4, turns: 3 }))).toBe(
			"104.3k/1M · 10.4%",
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
describe("ContextGauge", () => {
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
		expect(label()).toBe("5k/10k · 50%");

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
		expect(label()).toBe("ctx failed");
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
		expect(container.querySelector(".ctx-btn")?.textContent).toBe("5k/10k · 50%");
	});

	test("the popover itemizes the window — strip drops the tool subset, rows keep it", async () => {
		const ctxA = view({
			input: 300,
			limit: 1000,
			pct: 30,
			turns: 1,
			segments: [
				{ key: "identity", tokens: 60 },
				{ key: "environment", tokens: 30 },
				{ key: "toolDefs", tokens: 30 },
				{ key: "history", tokens: 150 },
				{ key: "toolResults", tokens: 60 },
			],
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
			return Promise.reject(new Error(`unexpected fetch ${url}`));
		}) as typeof fetch;

		root = createRoot(container);
		await act(async () => {
			root?.render(<ContextGauge token={null} conversationId="app/aaa" busy={false} />);
		});
		act(() => {
			(container.querySelector(".ctx-btn") as HTMLButtonElement).click();
		});
		const rows = [...container.querySelectorAll(".ctx-seg-rows dt")].map((el) => el.textContent);
		expect(rows).toEqual([
			"Identity (SOUL.md)",
			"Environment",
			"Tool definitions",
			"History",
			"· tool calls & results",
		]);
		// The strip's widths exclude toolResults (a subset of history).
		const bars = [...container.querySelectorAll(".ctx-segbar span")] as HTMLElement[];
		expect(bars).toHaveLength(4);
		const widths = bars.map((el) => Number.parseFloat(el.style.width));
		// segTotal = 270; each width within a rounding whisker of its share.
		expect(widths[0]!).toBeCloseTo((60 / 270) * 100, 5);
		expect(widths[3]!).toBeCloseTo((150 / 270) * 100, 5);
		// No segments → no block at all, not an empty shell.
		await act(async () => {
			root?.render(<ContextGauge token={null} conversationId="app/bbb" busy={false} />);
		});
		expect(container.querySelector(".ctx-segs")).toBeNull();
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
		// Busy reads "turn in flight" — the invariant: never A's numbers,
		// never "no turns yet".
		expect(label()).toBe("turn in flight");

		act(() => {
			root?.render(<ContextGauge token={null} conversationId="app/bbb" busy={false} />);
		});
		await act(async () => {
			resolveB(json(ctxB));
		});
		expect(label()).toBe("2k/10k · 20%");
	});

	test("a conversation switch closes the popover — the next read never pops it open", async () => {
		const ctxA = view({ input: 5000, limit: 10000, pct: 50, turns: 3 });
		const ctxB = view({ input: 2000, limit: 10000, pct: 20, turns: 1 });
		let resolveB!: (res: Response) => void;
		const bFetch = new Promise<Response>((res) => {
			resolveB = res;
		});
		globalThis.fetch = ((input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === "/api/app/conversations/aaa/context") return Promise.resolve(json(ctxA));
			if (url === "/api/app/conversations/bbb/context") return bFetch;
			return Promise.reject(new Error(`unexpected fetch ${url}`));
		}) as typeof fetch;

		root = createRoot(container);
		await act(async () => {
			root?.render(<ContextGauge token={null} conversationId="app/aaa" busy={false} />);
		});
		act(() => {
			(container.querySelector(".ctx-btn") as HTMLButtonElement).click();
		});
		expect(container.querySelector(".ctx-pop")).not.toBeNull();

		act(() => {
			root?.render(<ContextGauge token={null} conversationId="app/bbb" busy={false} />);
		});
		await act(async () => {
			resolveB(json(ctxB));
		});
		expect(container.querySelector(".ctx-btn")?.textContent).toBe("2k/10k · 20%");
		expect(container.querySelector(".ctx-pop")).toBeNull();
	});

	test("an outside press or Escape closes the popover; a press on the gauge keeps it", async () => {
		const ctxA = view({ input: 5000, limit: 10000, pct: 50, turns: 3 });
		globalThis.fetch = mockFetch(() => Promise.resolve(json(ctxA)));

		root = createRoot(container);
		await act(async () => {
			root?.render(<ContextGauge token={null} conversationId="app/aaa" busy={false} />);
		});
		const btn = container.querySelector(".ctx-btn") as HTMLButtonElement;
		const pop = () => container.querySelector(".ctx-pop");

		act(() => btn.click());
		expect(pop()).not.toBeNull();

		// A press on the gauge itself is not an outside press.
		act(() =>
			btn.dispatchEvent(new win.Event("pointerdown", { bubbles: true }) as unknown as Event),
		);
		expect(pop()).not.toBeNull();

		act(() =>
			document.body.dispatchEvent(
				new win.Event("pointerdown", { bubbles: true }) as unknown as Event,
			),
		);
		expect(pop()).toBeNull();

		act(() => btn.click());
		expect(pop()).not.toBeNull();
		act(() =>
			document.dispatchEvent(
				new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event,
			),
		);
		expect(pop()).toBeNull();
		// Escape hands focus back to the control that opened it.
		const active = win.document.activeElement as unknown;
		expect(active).toBe(btn);
	});

	test("a failed read retries on click; the server's reason rides the tooltip", async () => {
		const ctxA = view({ input: 5000, limit: 10000, pct: 50, turns: 3 });
		let calls = 0;
		globalThis.fetch = mockFetch(() => {
			calls++;
			return Promise.resolve(
				calls === 1
					? new Response(JSON.stringify({ error: "store is busy" }), {
							status: 500,
							headers: { "content-type": "application/json" },
						})
					: json(ctxA),
			);
		});

		root = createRoot(container);
		await act(async () => {
			root?.render(<ContextGauge token={null} conversationId="app/aaa" busy={false} />);
		});
		const btn = container.querySelector(".ctx-btn") as HTMLButtonElement;
		expect(btn.textContent).toBe("ctx failed");
		expect(btn.title).toContain("store is busy");
		expect(btn.getAttribute("aria-label")).toContain("read failed");

		// A failed gauge is a retry control, not a dead click.
		await act(async () => {
			btn.click();
		});
		expect(calls).toBe(2);
		expect(btn.textContent).toBe("5k/10k · 50%");
		expect(container.querySelector(".ctx-pop")).toBeNull();
	});

	test("the hot state at 85% colors the label, bar, and ring together", async () => {
		globalThis.fetch = mockFetch(() =>
			Promise.resolve(json(view({ input: 182400, limit: 200000, pct: 91.2, turns: 31 }))),
		);

		root = createRoot(container);
		await act(async () => {
			root?.render(<ContextGauge token={null} conversationId="app/aaa" busy={false} />);
		});
		const hot = (sel: string) => container.querySelector(sel)?.classList.contains("hot") === true;
		expect(container.querySelector(".ctx-btn")?.textContent).toBe("182.4k/200k · 91.2%");
		expect(hot(".ctx-btn")).toBe(true);
		expect(hot(".ctx-ring-fill")).toBe(true);
		act(() => (container.querySelector(".ctx-btn") as HTMLButtonElement).click());
		expect(hot(".ctx-bar")).toBe(true);
	});

	test("a turn in flight on a fresh conversation names the turn — never 'no turns yet'", async () => {
		// The screenshot's lie: a visibly streaming first turn while the
		// gauge read "no turns yet". Busy suppresses the read entirely —
		// ctx stays null — so the label must come from the turn, not the
		// settled view.
		let calls = 0;
		globalThis.fetch = mockFetch(() => {
			calls++;
			return Promise.resolve(json(view({ turns: 0 })));
		});
		root = createRoot(container);
		await act(async () => {
			root?.render(<ContextGauge token={null} conversationId="app/aaa" busy={true} />);
		});
		expect(container.querySelector(".ctx-btn")?.textContent).toBe("turn in flight");
		expect(calls).toBe(0);
	});

	test("a streamed step's usage is the gauge's numbers while the turn runs", async () => {
		globalThis.fetch = mockFetch(() =>
			Promise.resolve(
				json(view({ input: 5000, limit: 10000, pct: 50, turns: 2, cacheHitRate: 0.5 })),
			),
		);
		root = createRoot(container);
		await act(async () => {
			root?.render(<ContextGauge token={null} conversationId="app/aaa" busy={false} />);
		});
		const label = () => container.querySelector(".ctx-btn")?.textContent;
		expect(label()).toBe("5k/10k · 50%");
		const popRow = (name: string) =>
			[...container.querySelectorAll(".ctx-rows > div")]
				.find((r) => r.querySelector("dt")?.textContent === name)
				?.querySelector("dd")?.textContent;

		// A turn starts — before its first step report lands the label
		// counts the turn after the settled ones. The occupancy itself
		// is unknown: the settled read is a turn stale and never stands
		// in, so ring, hero, and rows all read "no number yet".
		await act(async () => {
			root?.render(<ContextGauge token={null} conversationId="app/aaa" busy={true} live={null} />);
		});
		expect(label()).toBe("turn 3 in flight");
		expect(container.querySelector(".ctx-ring-fill")).toBeNull();

		act(() => {
			(container.querySelector(".ctx-btn") as HTMLButtonElement).click();
		});
		expect(container.querySelector(".ctx-head .mono")?.textContent).toBe("—");
		expect(container.querySelector(".ctx-hero")?.textContent).toBe("?");
		expect(popRow("Input")).toBe("—");
		expect(container.querySelector(".ctx-bar span")?.getAttribute("style")).toBe("width: 0%;");
		// The cache-hit row keeps its own fallback — a rate the settled
		// read still owns, unlike the occupancy.
		expect(popRow("Cache hit")).toBe("50.0%");

		// A step the provider didn't meter is the same unknown — the
		// popover's occupancy never falls back to the settled figures.
		await act(async () => {
			root?.render(
				<ContextGauge
					token={null}
					conversationId="app/aaa"
					busy={true}
					live={{ input: null, cacheRead: null }}
				/>,
			);
		});
		expect(label()).toBe("ctx ?");
		expect(container.querySelector(".ctx-ring-fill")).toBeNull();
		expect(container.querySelector(".ctx-hero")?.textContent).toBe("?");
		expect(popRow("Input")).toBe("—");
		expect(popRow("Cache hit")).toBe("50.0%");

		// Then step usage lands — the wire's number reads like the
		// settled label, against the last known limit.
		await act(async () => {
			root?.render(
				<ContextGauge
					token={null}
					conversationId="app/aaa"
					busy={true}
					live={{ input: 23417, cacheRead: 10000 }}
				/>,
			);
		});
		expect(label()).toBe("23.4k/10k · 234.2%");
		expect(popRow("Cache hit")).toBe("42.7%");

		// The open popover wears the same live figures — a ring at 234%
		// over a popover still reporting the settled 50% is the
		// disagreement this exists to kill. The bar clamps the overflow.
		expect(container.querySelector(".ctx-head .mono")?.textContent).toBe("23.4k/10k");
		expect(container.querySelector(".ctx-hero")?.textContent).toBe("234.2%");
		expect(container.querySelector(".ctx-bar span")?.getAttribute("style")).toBe("width: 100%;");
		expect(popRow("Input")).toBe("23.4k tok");

		// A later step that reports no usage reverts to unknown — the
		// last live figure doesn't linger.
		await act(async () => {
			root?.render(
				<ContextGauge
					token={null}
					conversationId="app/aaa"
					busy={true}
					live={{ input: null, cacheRead: null }}
				/>,
			);
		});
		expect(label()).toBe("ctx ?");
		expect(container.querySelector(".ctx-ring-fill")).toBeNull();
		expect(container.querySelector(".ctx-hero")?.textContent).toBe("?");
		expect(popRow("Input")).toBe("—");

		// A reported zero is a number, not an unknown — it meters at 0%.
		await act(async () => {
			root?.render(
				<ContextGauge
					token={null}
					conversationId="app/aaa"
					busy={true}
					live={{ input: 0, cacheRead: null }}
				/>,
			);
		});
		expect(label()).toBe("0/10k · 0%");
		expect(container.querySelector(".ctx-hero")?.textContent).toBe("0%");
		expect(popRow("Input")).toBe("0 tok");

		// The turn settles — the read's settled view takes over again.
		await act(async () => {
			root?.render(
				<ContextGauge
					token={null}
					conversationId="app/aaa"
					busy={false}
					live={{ input: 23417, cacheRead: 10000 }}
				/>,
			);
		});
		expect(label()).toBe("5k/10k · 50%");
		expect(popRow("Cache hit")).toBe("50.0%");
		expect(container.querySelector(".ctx-hero")?.textContent).toBe("50%");
	});

	test("a model change between turns outdates the limit until a fresh read lands", async () => {
		const oldModel = view({ model: "vendor/old", input: 5000, limit: 10000, pct: 50, turns: 2 });
		const newModel = view({ model: "vendor/new", input: 5000, limit: 20000, pct: 25, turns: 2 });
		let gets = 0;
		let resolveSecond!: (res: Response) => void;
		const second = new Promise<Response>((res) => {
			resolveSecond = res;
		});
		globalThis.fetch = ((input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === "/api/app/conversations/aaa/context") {
				gets++;
				return gets === 1 ? Promise.resolve(json(oldModel)) : second;
			}
			return Promise.reject(new Error(`unexpected fetch ${url}`));
		}) as typeof fetch;

		root = createRoot(container);
		await act(async () => {
			root?.render(
				<ContextGauge token={null} conversationId="app/aaa" busy={false} model="vendor/old" />,
			);
		});
		const label = () => container.querySelector(".ctx-btn")?.textContent;
		expect(label()).toBe("5k/10k · 50%");

		// The knob flips — the read for the new model is still in flight,
		// and until it lands the old limit must not dress the new model's
		// window: the count survives, the utilization doesn't.
		act(() => {
			root?.render(
				<ContextGauge token={null} conversationId="app/aaa" busy={false} model="vendor/new" />,
			);
		});
		expect(gets).toBe(2);
		expect(label()).toBe("5k tok");
		expect(container.querySelector(".ctx-ring-fill")).toBeNull();

		// The popover agrees — hero and footer carry the count and the
		// unknown limit, never the previous model's 50%.
		act(() => {
			(container.querySelector(".ctx-btn") as HTMLButtonElement).click();
		});
		expect(container.querySelector(".ctx-hero")?.textContent).toBe("5k tok");
		expect(container.querySelector(".ctx-pop .empty")?.textContent).toContain("limit unknown");

		// The fresh read lands for the new model — utilization returns.
		await act(async () => {
			resolveSecond(json(newModel));
		});
		expect(label()).toBe("5k/20k · 25%");

		// A live figure mid-turn then utilizes against the new model's
		// limit, and the popover's bar and hero move with the label.
		await act(async () => {
			root?.render(
				<ContextGauge
					token={null}
					conversationId="app/aaa"
					busy={true}
					live={{ input: 12000, cacheRead: 8000 }}
					model="vendor/new"
				/>,
			);
		});
		expect(label()).toBe("12k/20k · 60%");
		expect(container.querySelector(".ctx-head .mono")?.textContent).toBe("12k/20k");
		expect(container.querySelector(".ctx-hero")?.textContent).toBe("60%");
		expect(container.querySelector(".ctx-bar span")?.getAttribute("style")).toBe("width: 60%;");
	});

	test.each(["fold", "api error"] as const)(
		"a busy→idle read can't orphan a pending compact's outcome (%s)",
		async (kind) => {
			const ctxA = view({ input: 5000, limit: 10000, pct: 50, turns: 3 });
			let gets = 0;
			let settleCompact!: (res: Response) => void;
			const compactFetch = new Promise<Response>((res) => {
				settleCompact = res;
			});
			globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
				const url =
					typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if (url === "/api/app/conversations/aaa/context") {
					gets++;
					return Promise.resolve(json(ctxA));
				}
				if (url === "/api/app/conversations/aaa/compact" && init?.method === "POST")
					return compactFetch;
				return Promise.reject(new Error(`unexpected fetch ${url}`));
			}) as typeof fetch;

			root = createRoot(container);
			await act(async () => {
				root?.render(<ContextGauge token={null} conversationId="app/aaa" busy={false} />);
			});
			expect(gets).toBe(1);
			const compactBtn = () => container.querySelector(".ctx-act") as HTMLButtonElement;
			act(() => {
				(container.querySelector(".ctx-btn") as HTMLButtonElement).click();
			});
			expect(compactBtn().textContent).toBe("Compact now");

			// A turn starts with the popover still open — the gauge keeps
			// the last read, and the compact POST hangs in flight.
			act(() => {
				root?.render(<ContextGauge token={null} conversationId="app/aaa" busy={true} />);
			});
			act(() => {
				compactBtn().click();
			});
			expect(compactBtn().disabled).toBe(true);
			expect(compactBtn().textContent).toBe("Compacting…");

			// The turn settles — its context read runs while the compact
			// is still pending, and must not orphan it.
			await act(async () => {
				root?.render(<ContextGauge token={null} conversationId="app/aaa" busy={false} />);
			});
			expect(gets).toBe(2);

			await act(async () => {
				settleCompact(
					kind === "fold"
						? json({
								compacted: true,
								eventsCompacted: 7,
								tailEvents: 3,
								tokensBefore: 4100,
							})
						: new Response(JSON.stringify({ error: "lane is busy" }), {
								status: 500,
								headers: { "content-type": "application/json" },
							}),
				);
			});
			expect(compactBtn().disabled).toBe(false);
			expect(compactBtn().textContent).toBe("Compact now");
			expect(container.querySelector(".ctx-outcome")?.textContent).toBe(
				kind === "fold"
					? "folded 7 messages (~4k tok) — kept the last 3"
					: "compact failed: lane is busy",
			);
		},
	);

	test.each([
		["token", "ok"],
		["token", "api error"],
		["conversationId", "ok"],
		["conversationId", "api error"],
	] as const)(
		"a compact orphaned by a %s switch can't leak or stall the next one (old settles: %s)",
		async (dim, oldSettle) => {
			const ctxA = view({ input: 5000, limit: 10000, pct: 50, turns: 3 });
			const ctxB = view({ input: 2000, limit: 10000, pct: 20, turns: 1 });
			const compacts: ((res: Response) => void)[] = [];
			globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
				const url =
					typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if (url === "/api/app/conversations/aaa/context") return Promise.resolve(json(ctxA));
				if (url === "/api/app/conversations/bbb/context") return Promise.resolve(json(ctxB));
				if (url.endsWith("/compact") && init?.method === "POST")
					return new Promise<Response>((res) => {
						compacts.push(res);
					});
				return Promise.reject(new Error(`unexpected fetch ${url}`));
			}) as typeof fetch;

			// Synthetic credentials only — the fetch fake never inspects
			// them, they exist to drive the identity effect.
			const identity = (switched: boolean) =>
				dim === "token"
					? {
							token: switched ? "test-token-b" : "test-token-a",
							conversationId: "app/aaa",
						}
					: {
							token: "test-token",
							conversationId: switched ? "app/bbb" : "app/aaa",
						};
			const compactBtn = () => container.querySelector(".ctx-act") as HTMLButtonElement | null;
			const openPop = () =>
				act(() => {
					(container.querySelector(".ctx-btn") as HTMLButtonElement).click();
				});

			root = createRoot(container);
			await act(async () => {
				root?.render(<ContextGauge {...identity(false)} busy={false} />);
			});
			openPop();
			act(() => {
				compactBtn()?.click();
			});
			expect(compacts.length).toBe(1);
			expect(compactBtn()?.textContent).toBe("Compacting…");

			// The switch lands mid-turn: busy=true holds the fetch effect,
			// so the identity reset alone orphans the pending POST.
			act(() => {
				root?.render(<ContextGauge {...identity(true)} busy={true} />);
			});
			expect(container.querySelector(".ctx-pop")).toBeNull();

			// The turn settles under the new identity; a fresh compact
			// starts and stays pending.
			await act(async () => {
				root?.render(<ContextGauge {...identity(true)} busy={false} />);
			});
			openPop();
			act(() => {
				compactBtn()?.click();
			});
			expect(compacts.length).toBe(2);
			expect(compactBtn()?.textContent).toBe("Compacting…");

			// The orphan settles — no outcome may leak, and its finally
			// must not clear the live compact's spinner.
			await act(async () => {
				compacts[0]?.(
					oldSettle === "ok"
						? json({
								compacted: true,
								eventsCompacted: 7,
								tailEvents: 3,
								tokensBefore: 4100,
							})
						: new Response(JSON.stringify({ error: "lane is busy" }), {
								status: 500,
								headers: { "content-type": "application/json" },
							}),
				);
			});
			expect(container.querySelector(".ctx-outcome")).toBeNull();
			expect(compactBtn()?.disabled).toBe(true);
			expect(compactBtn()?.textContent).toBe("Compacting…");

			// The live compact's own outcome still lands.
			await act(async () => {
				compacts[1]?.(
					json({ compacted: true, eventsCompacted: 5, tailEvents: 2, tokensBefore: 8000 }),
				);
			});
			expect(container.querySelector(".ctx-outcome")?.textContent).toBe(
				"folded 5 messages (~8k tok) — kept the last 2",
			);
			expect(compactBtn()?.disabled).toBe(false);
			expect(compactBtn()?.textContent).toBe("Compact now");
		},
	);

	// A fetch stand-in that satisfies DOM's typeof fetch (preconnect
	// included), so the casts stay honest.
	function mockFetch(impl: (input: RequestInfo | URL) => Promise<Response>): typeof fetch {
		return Object.assign((input: RequestInfo | URL) => impl(input), {
			preconnect: realFetch.preconnect,
		});
	}

	// Shared JSON reply for the cases above.
	function json(body: unknown): Response {
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}
});

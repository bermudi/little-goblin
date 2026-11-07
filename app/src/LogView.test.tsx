import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { LogView } from "./LogView.tsx";

// Same harness as MemoryView.test: fetch is faked at the edge, held
// responses land in the order the test resolves them.
describe("LogView", () => {
	let win: Window;
	let container: HTMLElement;
	let root: Root | null = null;
	let installed: string[] = [];
	const realFetch = globalThis.fetch;

	const installGlobal = (name: string, value: unknown) => {
		Reflect.set(globalThis, name, value);
		installed.push(name);
	};
	type Item = { ts: string; level: string; msg: string; fields: Record<string, unknown> };
	const line = (
		level: string,
		msg: string,
		fields: Record<string, unknown> = {},
		ts = "2026-10-13T00:00:00.000Z",
	): Item => ({ ts, level, msg, fields });
	const body = (lines: Item[], extra: { matched?: number; truncated?: boolean } = {}) =>
		new Response(
			JSON.stringify({
				lines,
				truncated: extra.truncated ?? false,
				scannedBytes: 5000,
				matched: extra.matched ?? lines.length,
			}),
			{ headers: { "content-type": "application/json" } },
		);
	const tail = (level: string, msg: string) => body([line(level, msg)]);
	// Held tails keyed by the request's level param; resolve per test.
	let resolveTail: Map<string | null, (r: Response) => void>;

	beforeEach(() => {
		win = new Window({ url: "http://localhost/app/log" });
		const div = win.document.createElement("div");
		win.document.body.appendChild(div);
		container = div as unknown as HTMLElement;
		installed = [];
		installGlobal("window", win);
		installGlobal("document", win.document);
		installGlobal("navigator", win.navigator);
		installGlobal("Event", win.Event);
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
		resolveTail = new Map();
		globalThis.fetch = ((input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://localhost");
			if (url.pathname === "/api/app/log") {
				const level = url.searchParams.get("level");
				return new Promise<Response>((resolve) => resolveTail.set(level, resolve));
			}
			return Promise.resolve(new Response("{}", { status: 404 }));
		}) as typeof fetch;
	});

	afterEach(async () => {
		if (root !== null) {
			await act(async () => root?.unmount());
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
		act(() => root?.render(<LogView token={null} />));
	};
	const click = async (el: Element | null | undefined) => {
		expect(el).toBeTruthy();
		await act(async () => {
			(el as HTMLElement).click();
		});
	};
	const pickLevel = (label: string) =>
		click(
			[...container.querySelectorAll('[aria-label="level filter"] button')].find(
				(b) => b.textContent === label,
			),
		);
	const refresh = () =>
		click([...container.querySelectorAll("button")].find((b) => b.textContent === "Refresh"));
	const rows = () => [...container.querySelectorAll(".log-row")];
	const msgs = () =>
		[...container.querySelectorAll(".log-row .log-msg")].map((el) => el.textContent);
	const land = async (level: string | null, res: Response) => {
		await act(async () => {
			resolveTail.get(level)!(res);
		});
	};

	test("a stale tail can't overwrite the newer filter's results", async () => {
		mount();
		// Automatic load (all levels) is still in flight.
		expect(resolveTail.has(null)).toBe(true);

		await pickLevel("Errors");
		expect(resolveTail.has("error")).toBe(true);
		await act(async () => {
			resolveTail.get("error")!(tail("error", "disk full"));
		});
		expect(msgs()).toEqual(["disk full"]);

		// The older unfiltered response lands late — fenced.
		await act(async () => {
			resolveTail.get(null)!(tail("info", "routine tick"));
		});
		expect(msgs()).toEqual(["disk full"]);
		expect(container.textContent).not.toContain("routine tick");
	});

	test("a held refresh can't overwrite a filter applied after it", async () => {
		mount();
		await act(async () => {
			resolveTail.get(null)!(tail("info", "routine tick"));
		});
		expect(msgs()).toEqual(["routine tick"]);

		await pickLevel("Errors");
		await act(async () => {
			resolveTail.get("error")!(tail("error", "disk full"));
		});

		// Refresh rides the applied filter, then the operator applies a
		// different one — the refresh must not come back as error rows.
		await refresh();
		await pickLevel("Warnings+");
		await act(async () => {
			resolveTail.get("warn")!(tail("warn", "tailscale down"));
		});
		expect(msgs()).toEqual(["tailscale down"]);
		await act(async () => {
			resolveTail.get("error")!(tail("error", "disk full"));
		});
		expect(msgs()).toEqual(["tailscale down"]);
	});

	test("quiet repeats fold into one ×N row; warnings and errors never fold", async () => {
		mount();
		await land(
			null,
			body([
				line("info", "wake reconcile", {}, "2026-10-13T00:00:01.000Z"),
				line("info", "wake reconcile", {}, "2026-10-13T00:00:02.000Z"),
				line("info", "wake reconcile", {}, "2026-10-13T00:00:03.000Z"),
				line("error", "send failed", { error: "boom" }, "2026-10-13T00:00:04.000Z"),
				line("error", "send failed", { error: "boom" }, "2026-10-13T00:00:05.000Z"),
			]),
		);
		// Newest first: two separate errors, then one folded group.
		expect(msgs()).toEqual(["send failed", "send failed", "wake reconcile×3"]);
		expect(rows()[0]!.className).toContain("lv-error");

		// Opening the group lists its lines.
		await click(rows()[2]);
		expect(msgs().length).toBe(2 + 1 + 3);

		// Turning the fold off shows every line.
		const fold = container.querySelector<HTMLInputElement>(".log-fold input")!;
		await click(fold);
		expect(msgs().length).toBe(5);
	});

	test("opening a line shows its fields as a list, not raw JSON", async () => {
		mount();
		await land(
			null,
			body([line("warn", "slow call", { conversation: "dm:1", took_ms: 4200, tags: ["a", "b"] })]),
		);
		expect(rows()[0]!.getAttribute("aria-expanded")).toBe("false");
		expect(rows()[0]!.textContent).toContain("conversation=dm:1");
		await click(rows()[0]);
		expect(rows()[0]!.getAttribute("aria-expanded")).toBe("true");
		const detail = container.querySelector(".log-detail")!;
		const keys = [...detail.querySelectorAll("dt")].map((e) => e.textContent);
		expect(keys).toEqual(["time", "level", "message", "conversation", "took_ms", "tags"]);
		expect(detail.textContent).toContain("4200");
		expect(detail.querySelector("pre")!.textContent).toContain('"a"');
		expect(detail.textContent).not.toContain('{"conversation"');
	});

	test("says how many older matching lines are hidden and offers more", async () => {
		mount();
		await land(null, body([line("info", "a")], { matched: 41, truncated: true }));
		expect(container.querySelector(".log-more")!.textContent).toContain("40 older matching lines");
		const more = [...container.querySelectorAll("button")].find((b) =>
			b.textContent?.startsWith("Show newest"),
		);
		expect(more!.textContent).toBe("Show newest 500");
	});
});

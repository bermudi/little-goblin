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
	const line = (level: string, msg: string) => ({
		ts: "2026-10-13T00:00:00.000Z",
		level,
		msg,
		line: msg,
	});
	const tail = (level: string, msg: string) =>
		new Response(JSON.stringify({ lines: [line(level, msg)], truncated: false, scannedBytes: 5 }), {
			headers: { "content-type": "application/json" },
		});
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
	const pickLevel = async (level: string) => {
		await act(async () => {
			const sel = container.querySelector('select[aria-label="level filter"]')!;
			Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, "value")!.set!.call(
				sel,
				level,
			);
			sel.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event);
		});
	};
	const apply = () =>
		click([...container.querySelectorAll("button")].find((b) => b.textContent === "apply"));
	const refresh = () =>
		click([...container.querySelectorAll("button")].find((b) => b.textContent === "refresh"));
	const msgs = () =>
		[...container.querySelectorAll(".logline .log-msg")].map((el) => el.textContent);

	test("a stale tail can't overwrite the newer filter's results", async () => {
		mount();
		// Automatic load (all levels) is still in flight.
		expect(resolveTail.has(null)).toBe(true);

		await pickLevel("error");
		await apply();
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

		await pickLevel("error");
		await apply();
		await act(async () => {
			resolveTail.get("error")!(tail("error", "disk full"));
		});

		// Refresh rides the applied filter, then the operator applies a
		// different one — the refresh must not come back as error rows.
		await refresh();
		await pickLevel("warn");
		await apply();
		await act(async () => {
			resolveTail.get("warn")!(tail("warn", "tailscale down"));
		});
		expect(msgs()).toEqual(["tailscale down"]);
		await act(async () => {
			resolveTail.get("error")!(tail("error", "disk full"));
		});
		expect(msgs()).toEqual(["tailscale down"]);
	});
});

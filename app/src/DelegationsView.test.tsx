import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { DelegationsView } from "./DelegationsView.tsx";
import type { OperatorDelegationItem } from "../../src/http/operator-wire.ts";

describe("DelegationsView", () => {
	let win: Window;
	let container: HTMLElement;
	let root: Root | null = null;
	let installed: string[] = [];
	const realFetch = globalThis.fetch;

	const item = (
		id: number,
		status: OperatorDelegationItem["status"],
		over: Partial<OperatorDelegationItem> = {},
	): OperatorDelegationItem => ({
		id,
		name: `job-${id}`,
		harness: "codex",
		status,
		target: null,
		task: `Line one of ${id}\nLine two of the brief`,
		cwd: "/work/demo",
		appConversation: null,
		chatId: 0,
		threadId: null,
		createdAt: new Date(Date.UTC(2026, 9, id)).toISOString(),
		promptedAt: new Date(Date.UTC(2026, 9, id)).toISOString(),
		finishedAt: null,
		...over,
	});

	const mount = async (rows: OperatorDelegationItem[], open?: (id: string) => void) => {
		globalThis.fetch = (() =>
			Promise.resolve(
				new Response(JSON.stringify({ delegations: rows }), {
					headers: { "content-type": "application/json" },
				}),
			)) as unknown as typeof fetch;
		root = createRoot(container);
		await act(async () => {
			root?.render(<DelegationsView token={null} onOpenConversation={open} />);
		});
	};

	beforeEach(() => {
		win = new Window({ url: "http://localhost/app/delegations" });
		const div = win.document.createElement("div");
		win.document.body.appendChild(div);
		container = div as unknown as HTMLElement;
		installed = [];
		for (const [k, v] of [
			["window", win],
			["document", win.document],
			["navigator", win.navigator],
		] as const) {
			Reflect.set(globalThis, k, v);
			installed.push(k);
		}
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	});
	afterEach(async () => {
		await act(async () => root?.unmount());
		root = null;
		globalThis.fetch = realFetch;
		for (const k of installed) Reflect.deleteProperty(globalThis, k);
	});

	test("a stop with warnings keeps them on screen after the row moves", async () => {
		let rows = [item(4, "running")];
		globalThis.fetch = ((_input: string, init?: RequestInit) => {
			const post = init?.method === "POST";
			if (post) rows = [item(4, "stopped")];
			const body = post
				? { outcome: "stopped", delegation: rows[0], notes: ["agent may still be running on that host"] }
				: { delegations: rows };
			return Promise.resolve(
				new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
			);
		}) as unknown as typeof fetch;
		root = createRoot(container);
		await act(async () => {
			root?.render(<DelegationsView token={null} />);
		});
		const click = async (el: Element | null | undefined) =>
			act(async () => el?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event));
		await click([...container.querySelectorAll("button")].find((b) => b.textContent === "Stop"));
		await click(container.querySelector(".confirm-ok"));
		expect(container.querySelector(".deleg-stop-warn")?.textContent).toContain(
			"agent may still be running on that host",
		);
	});

	test("Stop asks first, posts the stop, then reloads the list (#414)", async () => {
		let rows = [item(3, "running")];
		const calls: string[] = [];
		globalThis.fetch = ((input: string, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			calls.push(`${method} ${input}`);
			if (method === "POST") rows = [item(3, "stopped")];
			const body = method === "POST" ? { outcome: "stopped", delegation: rows[0], notes: [] } : { delegations: rows };
			return Promise.resolve(
				new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
			);
		}) as unknown as typeof fetch;
		root = createRoot(container);
		await act(async () => {
			root?.render(<DelegationsView token={null} />);
		});
		const stop = [...container.querySelectorAll("button")].find((b) => b.textContent === "Stop");
		await act(async () => stop?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event));
		expect(calls.filter((c) => c.startsWith("POST"))).toEqual([]);
		await act(async () =>
			container
				.querySelector(".confirm-ok")
				?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event),
		);
		expect(calls).toContain("POST /api/app/delegations/3/stop");
		expect(container.querySelectorAll(".deleg-now").length).toBe(0);
		expect(container.textContent).toContain("stopped");
	});

	test("current work leads, old work is a table, brief shows one line", async () => {
		await mount([
			item(1, "done", { finishedAt: "2026-10-01T05:00:00.000Z" }),
			item(2, "needs_input", { appConversation: "c-1" }),
			item(3, "running"),
		]);
		const text = container.textContent ?? "";
		expect(text.indexOf("Current")).toBeLessThan(text.indexOf("Earlier"));
		expect(container.querySelectorAll(".deleg-now").length).toBe(2);
		expect(container.querySelectorAll(".dtable button.dt-row").length).toBe(1);
		expect(text).toContain("Line one of 1");
		expect(text).not.toContain("Line two");
	});

	test("needs-input panel answers in its conversation", async () => {
		const opened: string[] = [];
		await mount([item(2, "needs_input", { appConversation: "c-1" })], (id) => opened.push(id));
		const btn = [...container.querySelectorAll("button")].find(
			(b) => b.textContent === "Answer in conversation",
		);
		await act(async () => btn?.click());
		expect(opened).toEqual(["c-1"]);
	});

	test("a row opens its detail with the full brief; back returns", async () => {
		await mount([item(1, "done")]);
		await act(async () => (container.querySelector("button.dt-row") as HTMLElement).click());
		expect(container.querySelector(".prose")?.textContent).toContain("Line two of the brief");
		expect(container.querySelector(".dtable")).toBeNull();
		const back = [...container.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("Delegations"),
		);
		await act(async () => back?.click());
		expect(container.querySelector(".dtable")).not.toBeNull();
	});

	test("earlier rows page 15 at a time", async () => {
		await mount(Array.from({ length: 20 }, (_, i) => item(i + 1, "done")));
		expect(container.querySelectorAll(".dtable button.dt-row").length).toBe(15);
		const more = [...container.querySelectorAll("button")].find((b) =>
			b.textContent?.startsWith("Show"),
		);
		await act(async () => more?.click());
		expect(container.querySelectorAll(".dtable button.dt-row").length).toBe(20);
	});
});

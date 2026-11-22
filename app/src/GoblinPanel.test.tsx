import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { AppAttentionItem } from "../../src/http/app-wire.ts";
import { GoblinPanel } from "./GoblinPanel.tsx";

let win: Window;
let container: HTMLElement;
let root: Root | null = null;
const old: Array<[string, PropertyDescriptor | undefined]> = [];
const realFetch = globalThis.fetch;
const target: AppAttentionItem["target"] = { kind: "page", page: "programs" };
const item: AppAttentionItem = {
	id: "one", kind: "program-approval", title: "Review program", detail: "Evidence",
	createdAt: "2026-11-20T00:00:00.000Z", target,
};
const baseData = (working: number, attention: AppAttentionItem[] = []) => ({
	attention, attentionError: false, delegations: [], programs: [], activity: { busy: [], otherBusy: 0 },
	loadError: false, working, reload() {},
}) as unknown as Parameters<typeof GoblinPanel>[0]["data"];

beforeEach(() => {
	win = new Window({ url: "http://localhost/app/" });
	const div = win.document.createElement("div");
	win.document.body.appendChild(div);
	container = div as unknown as HTMLElement;
	for (const [key, value] of [["window", win], ["document", win.document], ["navigator", win.navigator], ["IS_REACT_ACT_ENVIRONMENT", true]] as const) {
		old.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
		Reflect.set(globalThis, key, value);
	}
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	await win.happyDOM.close();
	for (const [key, descriptor] of old.splice(0)) {
		if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
		else Object.defineProperty(globalThis, key, descriptor);
	}
});
async function mount(working = 0, attention: AppAttentionItem[] = [], callbacks: Partial<Parameters<typeof GoblinPanel>[0]> = {}) {
	root = createRoot(container);
	const noop = () => {};
	await act(async () => root?.render(<GoblinPanel data={baseData(working, attention)} notes={null} variant="column" onOpenTarget={noop} onOpenConversation={noop} onOpenPage={noop} onOpenNote={noop} onOpenProfile={noop} {...callbacks} />));
}

test("panel shows working count and idle state", async () => {
	await mount(2);
	expect(container.textContent).toContain("Working · 2 jobs");
	expect(container.querySelector(".goblin-avatar")?.hasAttribute("data-working")).toBe(true);
	await act(async () => root?.render(<GoblinPanel data={baseData(0)} notes={null} variant="column" onOpenTarget={() => {}} onOpenConversation={() => {}} onOpenPage={() => {}} onOpenNote={() => {}} onOpenProfile={() => {}} />));
	expect(container.textContent).toContain("Idle");
	expect(container.querySelector(".goblin-avatar")?.hasAttribute("data-working")).toBe(false);
});

test("needs-you opens its evidence target and makes no request", async () => {
	let opened: unknown;
	let requests = 0;
	const original = globalThis.fetch;
	globalThis.fetch = Object.assign(async () => { requests += 1; return Response.json({}); }, { preconnect: realFetch.preconnect });
	await mount(0, [item], { onOpenTarget: (value) => { opened = value; } });
	await act(async () => container.querySelector(".goblin-need-row")?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event));
	expect(opened).toEqual(target);
	expect(requests).toBe(0);
	globalThis.fetch = original;
});

test("tabs are Activity, Scheduled and Library; avatar opens profile", async () => {
	let profile = 0;
	await mount(0, [], { onOpenProfile: () => { profile += 1; } });
	expect([...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(["Activity", "Scheduled", "Library"]);
	await act(async () => container.querySelector(".goblin-profile-button")?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event));
	expect(profile).toBe(1);
});

test("activity puts running delegation before finished work and labels subagents", async () => {
	const data = {
		...baseData(2),
		activity: { busy: [{ id: "app/child", title: "Compare prices", parentId: "app/parent", rolling: false }], otherBusy: 0 },
		delegations: [
			{ id: 1, harness: "codex", task: "Fix the sheet", status: "running", createdAt: "2026-11-21T00:00:00Z", appConversation: "app/work" },
			{ id: 2, harness: "pi", task: "Old task", status: "done", createdAt: "2026-11-20T00:00:00Z", finishedAt: "2026-11-20T01:00:00Z", appConversation: null },
		],
	} as unknown as Parameters<typeof GoblinPanel>[0]["data"];
	root = createRoot(container);
	await act(async () => root?.render(<GoblinPanel data={data} notes={null} variant="column" onOpenTarget={() => {}} onOpenConversation={() => {}} onOpenPage={() => {}} onOpenNote={() => {}} onOpenProfile={() => {}} />));
	const rows = [...container.querySelectorAll(".goblin-panel-row")].map((row) => row.textContent ?? "");
	const running = rows.findIndex((row) => row.includes("codex: Fix the sheet"));
	const finished = rows.findIndex((row) => row.includes("pi: Old task"));
	expect(running).toBeGreaterThanOrEqual(0);
	expect(finished).toBeGreaterThan(running);
	expect(rows.some((row) => row.startsWith("Subagent: Compare prices"))).toBe(true);
});

test("a busy Rolling chat turn shows in Activity and opens the Goblin chat", async () => {
	const data = {
		...baseData(1),
		activity: {
			busy: [{ id: "app/roll-2", title: null, parentId: null, rolling: true }],
			otherBusy: 0,
		},
	} as unknown as Parameters<typeof GoblinPanel>[0]["data"];
	const pages: string[] = [];
	const conversations: string[] = [];
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<GoblinPanel
				data={data}
				notes={null}
				variant="column"
				onOpenTarget={() => {}}
				onOpenConversation={(id) => conversations.push(id)}
				onOpenPage={(page) => pages.push(page)}
				onOpenNote={() => {}}
				onOpenProfile={() => {}}
			/>,
		),
	);
	const row = [...container.querySelectorAll("button.goblin-panel-row")].find((el) =>
		el.textContent?.startsWith("Replying in the Goblin chat"),
	);
	expect(row).toBeDefined();
	await act(async () =>
		row?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event),
	);
	expect(pages).toEqual(["rolling"]);
	expect(conversations).toEqual([]);
});

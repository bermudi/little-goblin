import { afterEach, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { ToolUIPart, UIMessage } from "ai";
import { LiveStore } from "../live.ts";
import { LiveProvider } from "../useLive.tsx";
import { AskCard } from "./AskCard.tsx";
import { MessageParts } from "./MessageParts.tsx";

let win: Window;
let container: HTMLElement;
let root: Root | null = null;
let oldFetch: typeof fetch;
let installed: [string, PropertyDescriptor | undefined][] = [];

function part(action: string, output: unknown = { id: 12 }, state = "output-available"): ToolUIPart {
	return {
		type: "tool-ask",
		toolCallId: "ask-call",
		state,
		input: { action, question: "When should the nudge fire?", options: ["9:00", "11:00"] },
		output,
	} as unknown as ToolUIPart;
}

async function mount(node: ReactNode) {
	win = new Window();
	win.document.body.innerHTML = '<div id="root"></div>';
	container = win.document.querySelector("#root") as unknown as HTMLElement;
	installed = [];
	for (const [name, value] of [["window", win], ["document", win.document], ["HTMLElement", win.HTMLElement]] as const) {
		installed.push([name, Object.getOwnPropertyDescriptor(globalThis, name)]);
		Reflect.set(globalThis, name, value);
	}
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	root = createRoot(container);
	await act(async () => root?.render(node));
}

function liveStore(open = true) {
	const store = new LiveStore(null);
	if (open) {
		store.update("attention", () => ({
			items: [{ id: "ask:12", kind: "ask", title: "Asks: question", detail: "", createdAt: null, conversationId: "app/chat", target: { kind: "conversation", conversationId: "app/chat" } }],
			unavailable: [],
		}));
	}
	return store;
}

afterEach(async () => {
	if (root !== null) await act(async () => root?.unmount());
	root = null;
	if (win !== undefined) await win.happyDOM.close();
	if (oldFetch !== undefined) globalThis.fetch = oldFetch;
	Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
	for (const [name, descriptor] of installed) {
		if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
		else Object.defineProperty(globalThis, name, descriptor);
	}
	installed = [];
});

test("open question shows choices; tap sends exact text and closes by tap", async () => {
	oldFetch = globalThis.fetch;
	const calls: { url: string; body: string }[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ url: String(input), body: String(init?.body ?? "") });
		return init?.method === "POST"
			? Response.json({ ok: true, closed: true })
			: Response.json({ items: [{ id: "ask:12" }], unavailable: [] }, { headers: { "x-goblin-version": "v1" } });
	}) as unknown as typeof fetch;
	const actions: string[] = [];
	await mount(<LiveProvider store={liveStore()}><AskCard part={part("open")} onAction={(text) => actions.push(text)} busy={false} token={null} /></LiveProvider>);
	const buttons = [...container.querySelectorAll<HTMLButtonElement>(".ui-choice")];
	expect(buttons.map((button) => button.textContent)).toEqual(["9:00", "11:00"]);
	await act(async () => buttons[1]!.click());
	expect(actions).toEqual(["[ask] When should the nudge fire? → 11:00"]);
	expect(calls.some((call) => call.url.endsWith("/api/app/asks/12/close") && call.body === '{"by":"tap"}')).toBe(true);
});

test("dismiss closes without a message; busy disables choices but not dismiss", async () => {
	oldFetch = globalThis.fetch;
	const calls: string[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push(String(init?.body ?? ""));
		return init?.method === "POST"
			? Response.json({ ok: true, closed: true })
			: Response.json({ items: [{ id: "ask:12" }], unavailable: [] }, { headers: { "x-goblin-version": "v2" } });
	}) as unknown as typeof fetch;
	const actions: string[] = [];
	await mount(<LiveProvider store={liveStore()}><AskCard part={part("open")} onAction={(text) => actions.push(text)} busy token={null} /></LiveProvider>);
	expect([...container.querySelectorAll<HTMLButtonElement>(".ui-choice")].every((button) => button.disabled)).toBe(true);
	const dismiss = container.querySelector<HTMLButtonElement>(".ask-dismiss")!;
	expect(dismiss.disabled).toBe(false);
	await act(async () => dismiss.click());
	expect(actions).toEqual([]);
	expect(calls).toContain('{"by":"dismiss"}');
});

test("closed and unknown questions show the required states", async () => {
	oldFetch = globalThis.fetch;
	let failed = false;
	globalThis.fetch = (async () => failed
		? new Response("offline", { status: 503 })
		: Response.json({ items: [], unavailable: [] }, { headers: { "x-goblin-version": "v1" } })) as unknown as typeof fetch;
	const closedStore = liveStore(false);
	closedStore.update("attention", () => ({ items: [], unavailable: [] }));
	await mount(<LiveProvider store={closedStore}><AskCard part={part("open")} busy={false} token={null} /></LiveProvider>);
	expect(container.textContent).toContain("Closed");
	expect(container.querySelector("button")).toBeNull();
	failed = true;
	await act(async () => root?.render(<LiveProvider store={liveStore(false)}><AskCard part={part("open")} busy={false} token={null} /></LiveProvider>));
	expect(container.querySelector(".ask-dismiss")).toBeNull();
	expect([...container.querySelectorAll<HTMLButtonElement>(".ui-choice")].every((button) => button.disabled)).toBe(true);
});

test("failed close shows the retry message; an open ask is outside Worked and list stays inside", async () => {
	oldFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		if (String(input).endsWith("/api/app/asks/12/close")) throw new Error("offline");
		return Response.json({ items: [{ id: "ask:12" }], unavailable: [] }, { headers: { "x-goblin-version": "v1" } });
	}) as unknown as typeof fetch;
	const store = liveStore();
	const ask = part("open") as unknown as UIMessage["parts"][number];
	const list = part("list") as unknown as UIMessage["parts"][number];
	await mount(<LiveProvider store={store}><MessageParts parts={[ask, list]} onAction={() => {}} busy={false} /></LiveProvider>);
	expect(container.querySelector(".ask-card")?.closest(".worked")).toBeNull();
	expect(container.querySelector(".worked .tool-run")).not.toBeNull();
	await act(async () => container.querySelector<HTMLButtonElement>(".ask-dismiss")!.click());
	expect(container.textContent).toContain("Couldn't close the question. Try again.");
});

test("open ask card follows later assistant text", async () => {
	oldFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		Response.json({ items: [{ id: "ask:12" }], unavailable: [] }, { headers: { "x-goblin-version": "v1" } })) as unknown as typeof fetch;
	const ask = part("open") as unknown as UIMessage["parts"][number];
	const text = { type: "text", text: "Reply text" } as UIMessage["parts"][number];
	await mount(<LiveProvider store={liveStore()}><MessageParts parts={[ask, text]} onAction={() => {}} busy={false} /></LiveProvider>);
	const reply = [...container.querySelectorAll("*")].find((node) => node.textContent === "Reply text");
	const card = container.querySelector(".ask-card");
	expect(reply).not.toBeNull();
	expect(card).not.toBeNull();
	expect(reply!.compareDocumentPosition(card!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

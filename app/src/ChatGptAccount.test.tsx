import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { ChatGptStatus } from "../../src/http/operator-wire.ts";
import { ChatGptAccount } from "./ChatGptAccount.tsx";

// The card over a faked fetch: each test scripts the accounts/chatgpt
// responses; calls are recorded to assert DELETE on Cancel and the
// status transitions that drive onSignedIn.

let win: Window;
let container: HTMLElement;
let root: Root | null = null;
let statusQueue: ChatGptStatus[] = [];
let calls: { method: string; url: string }[] = [];
let signedInCalls = 0;
const realFetch = globalThis.fetch;
const globals = new Map<string, PropertyDescriptor | undefined>();

const st = (over: Partial<ChatGptStatus>): ChatGptStatus => ({
	state: "signed-out",
	source: null,
	email: null,
	plan: null,
	pending: null,
	error: null,
	pinned: false,
	...over,
});

beforeEach(() => {
	win = new Window({ url: "http://localhost/app/settings" });
	const div = win.document.createElement("div");
	win.document.body.appendChild(div);
	container = div as unknown as HTMLElement;
	statusQueue = [];
	calls = [];
	signedInCalls = 0;
	for (const [name, value] of [
		["window", win],
		["document", win.document],
		["navigator", win.navigator],
		["IS_REACT_ACT_ENVIRONMENT", true],
	] as const) {
		globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Reflect.set(globalThis, name, value);
	}
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		calls.push({ method: init?.method ?? "GET", url });
		const next = statusQueue.length > 1 ? statusQueue.shift()! : statusQueue[0];
		if (next === undefined) return Promise.reject(new Error("no scripted status"));
		return Promise.resolve(
			new Response(JSON.stringify(next), {
				headers: { "content-type": "application/json" },
			}),
		);
	}) as typeof fetch;
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	await win.happyDOM.close();
	globalThis.fetch = realFetch;
	for (const [name, descriptor] of globals) {
		if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
		else Object.defineProperty(globalThis, name, descriptor);
	}
	globals.clear();
});

const settle = async (ms = 30) => {
	await act(async () => {
		await new Promise((r) => setTimeout(r, ms));
	});
};
const waitFor = async (pred: () => boolean, label: string) => {
	for (let i = 0; i < 200; i++) {
		if (pred()) return;
		await settle();
	}
	throw new Error(`timed out waiting for ${label}`);
};
const click = async (el: Element | null | undefined) => {
	expect(el).toBeTruthy();
	await act(async () => {
		el?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event);
	});
	await settle();
};
const mountCard = async () => {
	root = createRoot(container);
	await act(async () => {
		root?.render(<ChatGptAccount token={null} onSignedIn={() => signedInCalls++} />);
	});
	await waitFor(() => !container.textContent?.includes("Loading"), "card load");
};
const button = (text: string) =>
	[...container.querySelectorAll("button")].find((b) => b.textContent === text);

describe("ChatGptAccount", () => {
	test("signed-out shows the sign-in call to action", async () => {
		statusQueue = [st({})];
		await mountCard();
		expect(container.textContent).toContain("Not signed in.");
		expect(button("Sign in with ChatGPT")).toBeTruthy();
	});

	test("an error status renders the message", async () => {
		statusQueue = [st({ state: "error", error: "the auth file is unreadable" })];
		await mountCard();
		expect(container.textContent).toContain("the auth file is unreadable");
	});

	test("signed-in via goblin shows email, plan, and Sign out", async () => {
		statusQueue = [
			st({ state: "signed-in", source: "goblin", email: "op@example.test", plan: "pro" }),
		];
		await mountCard();
		expect(container.textContent).toContain("Signed in as op@example.test");
		expect(container.textContent).toContain("pro");
		expect(button("Sign out")).toBeTruthy();
	});

	test("signed-in via codex-cli explains the shared login", async () => {
		statusQueue = [st({ state: "signed-in", source: "codex-cli", email: "cli@example.test" })];
		await mountCard();
		expect(container.textContent).toContain("Using your Codex CLI login");
		expect(container.textContent).toContain("terminal's codex stays untouched");
		expect(button("Sign in with ChatGPT")).toBeTruthy();
	});

	test("a pinned auth file is read-only", async () => {
		statusQueue = [st({ state: "signed-in", source: "custom", pinned: true })];
		await mountCard();
		expect(container.textContent).toContain("auth file set in goblin.json5");
		expect(container.querySelector("button")).toBeNull();
	});

	test("pending shows the code, expiry, and Cancel hits DELETE", async () => {
		statusQueue = [
			st({
				state: "pending",
				pending: {
					userCode: "ABCD-EFGH",
					verificationUrl: "https://auth.openai.com/codex/device",
					expiresAt: new Date(Date.now() + 600_000).toISOString(),
				},
			}),
		];
		await mountCard();
		expect(container.textContent).toContain("ABCD-EFGH");
		expect(container.textContent).toContain("Expires in");
		await click(button("Cancel"));
		expect(calls.some((c) => c.method === "DELETE")).toBe(true);
	});

	test("a pending → signed-in transition fires onSignedIn once", async () => {
		// First response pending; every poll after resolves signed-in.
		statusQueue = [
			st({
				state: "pending",
				pending: {
					userCode: "WXYZ-1234",
					verificationUrl: "https://auth.openai.com/codex/device",
					expiresAt: new Date(Date.now() + 600_000).toISOString(),
				},
			}),
			st({ state: "signed-in", source: "goblin", email: "new@example.test" }),
		];
		await mountCard();
		// The 3s poll interval flips the state — the callback must fire
		// exactly once, then polling stops.
		await waitFor(() => signedInCalls === 1, "the signed-in callback");
		expect(container.textContent).toContain("Signed in as new@example.test");
	});

	test("sign out POSTs logout and shows signed-out", async () => {
		statusQueue = [st({ state: "signed-in", source: "goblin", email: "op@example.test" }), st({})];
		await mountCard();
		// happy-dom's window.confirm — stub it true.
		(win as unknown as { confirm: () => boolean }).confirm = () => true;
		await click(button("Sign out"));
		expect(calls.some((c) => c.method === "POST" && c.url.includes("/logout"))).toBe(true);
		await waitFor(
			() => container.textContent?.includes("Not signed in") ?? false,
			"signed-out state",
		);
	});
});

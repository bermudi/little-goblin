// The settings save flow at its boundary (SettingsView + api.ts over a
// faked fetch): an edit debounces into one POST; success rebaselines; a
// 422 surfaces the server's message with a retry button; a 409 (stale
// etag) refuses retry — only reload helps; and a failed signature is
// never re-fired by the debounce. Mounted with happy-dom, like
// ChatView.test.tsx.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import {
	authDefaults,
	fetchKinds,
	searchKinds,
	transcriptionDefaults,
	transcriptionKinds,
} from "../../src/config.ts";
import { SettingsView } from "./SettingsView.tsx";

// GET /api/app/settings payload — no providers keeps the thinking-level
// lookups away (a "p/m" model with no matching provider resolves to the
// full ladder without a fetch).
const SETTINGS_BODY = {
	config: {
		providers: {},
		model: "p/m",
		titleModel: "",
		favorites: [],
		thinking: "medium",
		tts: false,
		operators: [1],
		allowedUsers: [1],
		telegram: { apiRoot: "", dmGapMinutes: 45, richReplies: true, showReasoning: false },
		publicUrl: "",
		http: { port: 8787 },
		logLevel: "info",
	},
	providerKinds: ["openai-compatible", "responses", "openrouter", "codex"],
	searchKinds: searchKinds,
	fetchKinds: fetchKinds,
	transcriptionKinds,
	transcriptionDefaults,
	authDefaults,
	authNames: [],
};

const json = (body: unknown, init: { status?: number; etag?: string } = {}): Response =>
	new Response(JSON.stringify(body), {
		status: init.status ?? 200,
		headers: {
			"content-type": "application/json",
			...(init.etag !== undefined ? { etag: init.etag } : {}),
		},
	});

describe("SettingsView save flow", () => {
	let win: Window;
	let container: HTMLElement;
	let root: Root | null = null;
	let installed: string[] = [];
	const realFetch = globalThis.fetch;

	const installGlobal = (name: string, value: unknown) => {
		Reflect.set(globalThis, name, value);
		installed.push(name);
	};

	// The POST script: each queued entry is a Response or an async gate;
	// requests records every wire hit.
	let posts: Request[] = [];
	let postScript: Array<Response | (() => Promise<Response>)> = [];

	beforeEach(() => {
		win = new Window({ url: "http://localhost/app/settings" });
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
		posts = [];
		postScript = [];
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const req = new Request(new URL(String(input), "http://localhost"), init);
			if (req.method === "POST" && new URL(req.url).pathname === "/api/app/settings") {
				posts.push(req);
				const next = postScript.shift() ?? json({ ok: true }, { etag: '"v2"' });
				return typeof next === "function" ? next() : next;
			}
			return json(SETTINGS_BODY, { etag: '"v1"' });
		}) as typeof fetch;
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

	const tick = (ms = 50) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

	async function mount(): Promise<void> {
		await act(async () => {
			root = createRoot(container);
			root.render(<SettingsView token="tok" />);
		});
		await tick(120);
	}

	const savebar = () => container.querySelector(".savebar-msg")?.textContent ?? "";
	const retryButton = () =>
		[...container.querySelectorAll("button")].find((b) => b.textContent === "retry");

	// Edit the "Public url" field — inside the Access section, a plain
	// text input whose onChange dirties the draft through patchDraft.
	async function editPublicUrl(value: string): Promise<void> {
		if (container.querySelector('input[placeholder="https://…"]') === null) {
			const access = [...container.querySelectorAll("button")].find((b) =>
				b.textContent?.includes("Access"),
			);
			if (access === undefined) throw new Error("Access section button not found");
			await act(async () => {
				access.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event);
			});
		}
		const input = [...container.querySelectorAll("input")].find(
			(i) => i.placeholder === "https://…",
		);
		if (input === undefined) throw new Error("public url input not found");
		const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!;
		await act(async () => {
			// Focus + keyup too — React's text-input fallback needs it in
			// this environment (App.test.tsx's typeInto ruling).
			input.focus();
			setter.call(input, value);
			input.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
			input.dispatchEvent(
				new win.KeyboardEvent("keyup", { bubbles: true, key: "e" }) as unknown as Event,
			);
		});
	}

	test("a valid edit debounces into one POST and the savebar confirms", async () => {
		await mount();
		expect(savebar()).toBe("");
		await editPublicUrl("https://goblin.example.com");
		await tick(120); // under the 800ms debounce — nothing yet
		expect(posts).toHaveLength(0);
		expect(savebar()).toContain("Unsaved");
		await tick(900);
		expect(posts).toHaveLength(1);
		expect(posts[0]!.headers.get("if-match")).toBe('"v1"');
		expect(posts[0]!.headers.get("authorization")).toBe("Bearer tok");
		expect(savebar()).toBe("Saved.");
		// Baseline flipped — the unsaved pill is gone.
		expect(container.textContent).not.toContain("unsaved");
	});

	test("a 422 surfaces the server's message and keeps the retry button", async () => {
		postScript.push(json({ error: "operators may not be empty" }, { status: 422 }));
		await mount();
		await editPublicUrl("https://goblin.example.com");
		await tick(950);
		expect(posts).toHaveLength(1);
		expect(savebar()).toBe("operators may not be empty");
		expect(retryButton()).toBeTruthy();
		await act(async () => {
			retryButton()!.dispatchEvent(
				new win.MouseEvent("click", { bubbles: true }) as unknown as Event,
			);
		});
		await tick(120);
		expect(posts).toHaveLength(2);
		expect(savebar()).toBe("Saved.");
	});

	test("a 409 demands a reload — no retry button", async () => {
		postScript.push(json({ error: "config changed" }, { status: 409 }));
		await mount();
		await editPublicUrl("https://goblin.example.com");
		await tick(950);
		expect(posts).toHaveLength(1);
		expect(savebar()).toContain("reload the page");
		expect(retryButton()).toBeUndefined();
	});

	test("a failed write isn't re-fired by the debounce on identical state", async () => {
		postScript.push(json({ error: "boom" }, { status: 500 }));
		await mount();
		await editPublicUrl("https://goblin.example.com");
		await tick(950);
		expect(posts).toHaveLength(1);
		// Two more debounce windows — no chained retries.
		await tick(1800);
		expect(posts).toHaveLength(1);
		expect(savebar()).toBe("boom");
	});
});

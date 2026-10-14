// The pending provider-name departure guard: a half-typed name sits in
// the card's blur-commit field, outside every serialized field, so the
// serialized diff can't see it — it must still arm onDirtyChange and
// hold the autosave. Mounted with happy-dom like StateViews.test.tsx;
// the wire is faked at globalThis.fetch with the same config fixture
// shape App.test.tsx uses.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import {
	authDefaults,
	parseConfig,
	transcriptionDefaults,
	transcriptionKinds,
} from "../../src/config.ts";
import type { ConfigPostBody } from "../../src/http/operator-wire.ts";
import { SettingsView } from "./SettingsView.tsx";

let win: Window;
let container: HTMLElement;
let root: Root | null = null;
let savedBodies: ConfigPostBody[] = [];
let dirtyLog: boolean[] = [];
let settingsGate: Promise<void> | null = null;
const realFetch = globalThis.fetch;
const globals = new Map<string, PropertyDescriptor | undefined>();

const SETTINGS = parseConfig({
	providers: {
		main: { kind: "openai-compatible", baseUrl: "https://api.example.test", auth: "fixture" },
	},
	model: "main/test",
	operators: [111],
	allowedUsers: [111],
	telegram: { model: "main/test", thinking: "medium" },
});

beforeEach(() => {
	win = new Window({ url: "http://localhost/app/settings" });
	const div = win.document.createElement("div");
	win.document.body.appendChild(div);
	container = div as unknown as HTMLElement;
	savedBodies = [];
	dirtyLog = [];
	settingsGate = null;
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
		if (url === "/api/app/settings" && init?.method === "POST") {
			savedBodies.push(JSON.parse(String(init.body)) as ConfigPostBody);
			return (settingsGate ?? Promise.resolve()).then(
				() =>
					new Response(JSON.stringify({ ok: true }), {
						headers: { "content-type": "application/json", etag: '"v2"' },
					}),
			);
		}
		if (url === "/api/app/settings")
			return Promise.resolve(
				new Response(
					JSON.stringify({
						config: SETTINGS,
						providerKinds: ["openai-compatible", "openrouter"],
						searchKinds: ["ddg", "brave", "jina"],
						fetchKinds: ["local", "firecrawl", "jina"],
						transcriptionKinds,
						transcriptionDefaults,
						authDefaults,
						authNames: ["main", "groq"],
					}),
					{ headers: { "content-type": "application/json", etag: '"v1"' } },
				),
			);
		if (url.includes("thinking-levels"))
			return Promise.resolve(
				new Response(JSON.stringify({ levels: ["off", "low", "medium", "high"] }), {
					headers: { "content-type": "application/json" },
				}),
			);
		return Promise.reject(new Error(`unexpected request: ${url}`));
	}) as typeof fetch;
});

afterEach(async () => {
	settingsGate = null;
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
	for (let i = 0; i < 100; i++) {
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
const typeInto = async (el: Element, value: string) => {
	await act(async () => {
		(el as HTMLElement).focus();
		Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(el, value);
		el.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
		el.dispatchEvent(
			new win.KeyboardEvent("keyup", { bubbles: true, key: "e" }) as unknown as Event,
		);
	});
	await settle();
};
const blur = async (el: Element) => {
	await act(async () => {
		el.dispatchEvent(new win.FocusEvent("focusout", { bubbles: true }) as unknown as Event);
	});
	await settle();
};

const mount = async () => {
	root = createRoot(container);
	await act(async () => {
		root?.render(
			// Braces: the component's effect returns the callback's value,
			// and push() returns a number — not a cleanup.
			<SettingsView
				token={null}
				onDirtyChange={(d) => {
					dirtyLog.push(d);
				}}
			/>,
		);
	});
	await waitFor(() => container.querySelector("button.idx") !== null, "settings editor");
};
const openProviders = async () => {
	await click(
		[...container.querySelectorAll("button.idx")].find((b) => b.textContent?.includes("Providers")),
	);
	expect(container.querySelector(".prov.card")).not.toBeNull();
};
const nameInput = () =>
	container.querySelector('.prov.card input[aria-label="provider name"]') as HTMLInputElement;
const lastDirty = () => dirtyLog.at(-1);

test("an uncommitted provider name arms the guard and holds the autosave", async () => {
	await mount();
	await openProviders();
	expect(lastDirty()).toBe(false);
	await typeInto(nameInput(), "renamed");
	expect(lastDirty()).toBe(true);
	expect(container.textContent).toContain("provider name (still editing)");
	// The typed name reached no model reference — the card still lists
	// the committed name's referrers — and nothing was written.
	expect(container.querySelector(".prov.card")?.textContent).toContain("Used by app default model");
	// A serialized edit alongside the pending name would normally
	// autosave — the pending flag alone must hold the write. The kind
	// select, not an input: focusing another field would blur-commit
	// the name and end the very state under test.
	await act(async () => {
		const select = container.querySelector(
			'.prov.card select[aria-label="provider type"]',
		) as HTMLSelectElement;
		select.value = "openrouter";
		select.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event);
	});
	await settle();
	// Well past the 800ms autosave debounce: the held name must not
	// let the old baseline write itself over the pending draft.
	await settle(1000);
	expect(savedBodies).toHaveLength(0);
	expect(lastDirty()).toBe(true);
	// Backtracking to the committed name disarms without a blur — and
	// the held serialized edit finally writes itself.
	await typeInto(nameInput(), "main");
	expect(lastDirty()).toBe(true); // serialized edit still dirty
	await waitFor(() => savedBodies.length > 0, "the held edit to write once the name disarms");
	expect(savedBodies.at(-1)?.providers["main"]).toEqual({
		kind: "openrouter",
		auth: authDefaults.openrouter,
	});
	await waitFor(() => lastDirty() === false, "the guard to clear after the ack");
});

test("a committed rename writes itself and the guard clears only after the ack", async () => {
	await mount();
	await openProviders();
	await typeInto(nameInput(), "primary");
	expect(lastDirty()).toBe(true);
	const gate = Promise.withResolvers<void>();
	settingsGate = gate.promise;
	await blur(nameInput());
	// Blur committed: the flag is now serialized dirty, the debounce
	// re-armed, and the write goes out with the renamed provider key.
	await waitFor(() => savedBodies.length > 0, "the rename save");
	expect(savedBodies.at(-1)?.providers["primary"]).toEqual({
		kind: "openai-compatible",
		baseUrl: "https://api.example.test",
		auth: "fixture",
	});
	expect(savedBodies.at(-1)?.providers["main"]).toBeUndefined();
	// The write is still in flight — the guard stays armed until the
	// ack lands the new baseline.
	expect(lastDirty()).toBe(true);
	await act(async () => {
		gate.resolve();
	});
	await waitFor(() => lastDirty() === false, "the guard to clear after the ack");
	expect(container.textContent).not.toContain("unsaved");
});

test("an invalid or unchanged commit restores the name and disarms", async () => {
	await mount();
	await openProviders();
	// Whitespace-only: commit rejects, the draft restores, pending clears.
	await typeInto(nameInput(), "   ");
	expect(lastDirty()).toBe(true);
	await blur(nameInput());
	expect(nameInput().value).toBe("main");
	expect(lastDirty()).toBe(false);
	expect(container.textContent).toContain("Every provider needs a name.");
	await settle(900);
	expect(savedBodies).toHaveLength(0);
	// Re-typing the committed name is a no-op commit.
	await typeInto(nameInput(), "main");
	expect(lastDirty()).toBe(false);
	await blur(nameInput());
	expect(lastDirty()).toBe(false);
	await settle(900);
	expect(savedBodies).toHaveLength(0);
});

test("removing the provider clears its pending flag — serialized dirty is all that remains", async () => {
	await mount();
	await openProviders();
	await typeInto(nameInput(), "ghost");
	expect(lastDirty()).toBe(true);
	await click(
		[...container.querySelectorAll(".prov.card button")].find((b) => b.textContent === "Remove"),
	);
	// The card is gone and its flag cleared — a stuck pending flag would
	// gate the autosave forever; the removal write itself is the proof.
	expect(container.querySelector(".prov.card")).toBeNull();
	expect(container.textContent).toContain("Removed — still referenced");
	expect(container.textContent).not.toContain("still editing");
	await waitFor(() => savedBodies.length > 0, "the removal save");
	await waitFor(() => lastDirty() === false, "the guard to clear after the ack");
	expect(savedBodies.at(-1)?.providers).toEqual({});
});

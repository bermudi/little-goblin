import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { parseConfig } from "../../src/config.ts";
import {
	authDefaults,
	transcriptionDefaults,
	transcriptionKinds,
} from "../../src/config-schema.ts";
import { TelegramDoor } from "./TelegramDoor.tsx";
import { clickConfirm, confirmText } from "./testkit.ts";

// The mini app's settings door shares the PWA's leave ask (#802): its
// in-app sheet doesn't block the page, so the editor's autosave must
// hold while the sheet is open and never write a discarded draft.
// happy-dom mount on /t/, fetch faked at globalThis.fetch.

const SETTINGS = parseConfig({
	providers: {
		main: { kind: "openai-compatible", baseUrl: "https://api.example.test", auth: "fixture" },
	},
	model: "main/test",
	operators: [111],
	allowedUsers: [111],
	telegram: { model: "main/test", thinking: "medium" },
});

const json = (body: unknown, headers: Record<string, string> = {}): Response =>
	new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json", ...headers },
	});

describe("telegram door leave ask", () => {
	let win: Window;
	let container: HTMLElement;
	let root: Root | null = null;
	let settingsPosts: unknown[];
	const realFetch = globalThis.fetch;
	const globals = new Map<string, PropertyDescriptor | undefined>();

	beforeEach(() => {
		win = new Window({ url: "http://localhost/t/settings" });
		const div = win.document.createElement("div");
		win.document.body.appendChild(div);
		container = div as unknown as HTMLElement;
		settingsPosts = [];
		Reflect.set(win, "Telegram", { WebApp: { initData: "signed", initDataUnsafe: {} } });
		for (const [name, value] of [
			["window", win],
			["document", win.document],
			["navigator", win.navigator],
			["localStorage", win.localStorage],
			["getComputedStyle", win.getComputedStyle],
			["IS_REACT_ACT_ENVIRONMENT", true],
		] as const) {
			globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
			Reflect.set(globalThis, name, value);
		}
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === "/api/settings" && init?.method === "POST") {
				settingsPosts.push(JSON.parse(String(init.body)));
				return Promise.resolve(json({ ok: true }, { etag: '"v2"' }));
			}
			if (url === "/api/settings")
				return Promise.resolve(
					json(
						{
							config: SETTINGS,
							providerKinds: ["openai-compatible"],
							searchKinds: ["ddg"],
							fetchKinds: ["local"],
							transcriptionKinds,
							transcriptionDefaults,
							authDefaults,
							authNames: ["main"],
							modelCatalog: [],
						},
						{ etag: '"v1"' },
					),
				);
			// Status, thinking levels and the Memory page aren't under test.
			return Promise.resolve(new Response(JSON.stringify({ error: "not faked" }), { status: 404 }));
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
		for (let i = 0; i < 100; i++) {
			if (pred()) return;
			await settle();
		}
		throw new Error(`timed out waiting for ${label}`);
	};
	const click = async (el: Element | null | undefined) => {
		expect(el).toBeTruthy();
		await act(async () => {
			el?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event);
		});
		await settle();
	};

	test("Discard while the edit is held: the editor never writes it", async () => {
		root = createRoot(container);
		await act(async () => {
			root?.render(<TelegramDoor />);
		});
		await waitFor(() => container.querySelector("button.idx") !== null, "settings editor");
		await click(
			[...container.querySelectorAll("button.idx")].find((b) => b.textContent?.includes("Access")),
		);
		const input = container.querySelector('input[aria-label="add allowed user"]')!;
		expect(input).not.toBeNull();
		await act(async () => {
			(input as HTMLElement).focus();
			Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(input, "222");
			input.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
			input.dispatchEvent(new win.KeyboardEvent("keyup", { bubbles: true, key: "e" }) as unknown as Event);
		});
		await click(input.closest(".addrow")?.querySelector(".addbtn"));
		expect(container.textContent).toContain("unsaved");

		await click([...container.querySelectorAll(".rail-op")].find((b) => b.textContent === "Memories"));
		expect(confirmText(container)).toBe("Discard unsaved settings changes?");
		// Longer than the 800 ms autosave debounce.
		await settle(1200);
		expect(settingsPosts).toHaveLength(0);
		expect(container.textContent).toContain("unsaved");

		await act(async () => clickConfirm(container, true));
		await settle(1200);
		expect(container.querySelector("button.idx")).toBeNull();
		expect(settingsPosts).toHaveLength(0);
	});
});

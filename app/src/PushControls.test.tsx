import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { PushControls } from "./PushControls.tsx";

const ENDPOINT = "https://push.example.test/registrations/device-1";
const HASH = createHash("sha256").update(ENDPOINT).digest("hex");

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("PushControls", () => {
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

	const mount = () => {
		root = createRoot(container);
		act(() => {
			root?.render(<PushControls token={null} />);
		});
	};
	const flush = () => act(async () => {});
	const click = async (el: Element | null | undefined) => {
		expect(el).toBeTruthy();
		await act(async () => {
			(el as HTMLElement).click();
		});
	};

	function installBrowser() {
		let unsubscribed = false;
		const subscription = {
			endpoint: ENDPOINT,
			expirationTime: null,
			toJSON: () => ({
				endpoint: ENDPOINT,
				expirationTime: null,
				keys: { p256dh: "device-p256dh", auth: "device-auth" },
			}),
			unsubscribe: () => {
				unsubscribed = true;
				return Promise.resolve(true);
			},
		};
		const calls: { key?: unknown }[] = [];
		const registration = {
			pushManager: {
				getSubscription: () => Promise.resolve(unsubscribed ? null : subscription),
				subscribe: (opts: { applicationServerKey?: unknown }) => {
					calls.push({ key: opts.applicationServerKey });
					return Promise.resolve(subscription);
				},
			},
		};
		const serviceWorker = {
			register: () => Promise.resolve(registration),
			getRegistration: () => Promise.resolve(registration),
			ready: Promise.resolve(registration),
		};
		Object.defineProperty(win.navigator, "serviceWorker", {
			value: serviceWorker,
			configurable: true,
		});
		Object.defineProperty(win, "PushManager", {
			value: function PushManager() {},
			configurable: true,
		});
		const notification = {
			permission: "default",
			requestPermission: () => Promise.resolve("granted"),
		};
		Object.defineProperty(win, "Notification", {
			value: notification,
			configurable: true,
		});
		installGlobal("Notification", notification);
		return {
			calls,
			get unsubscribed() {
				return unsubscribed;
			},
		};
	}

	test("enables this browser through subscribe plus authenticated registration", async () => {
		const browser = installBrowser();
		let registered = false;
		const seen: { method: string; path: string; body: unknown }[] = [];
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const path = new URL(url, "http://localhost").pathname;
			seen.push({
				method: init?.method ?? "GET",
				path,
				body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
			});
			if (path === "/api/app/push") {
				return Promise.resolve(
					json({
						configured: registered,
						subscriptions: registered
							? [
									{
										endpointHash: HASH,
										userAgent: "test",
										createdAt: "2026-01-01T00:00:00Z",
										updatedAt: "2026-01-01T00:00:00Z",
									},
								]
							: [],
					}),
				);
			}
			if (path === "/api/app/push/public-key")
				return Promise.resolve(json({ publicKey: "cHVibGljLWtleQ" }));
			if (path === "/api/app/push/subscription" && init?.method === "POST") {
				registered = true;
				return Promise.resolve(json({ endpointHash: HASH }));
			}
			return Promise.resolve(json({ error: "unmapped" }, 404));
		}) as typeof fetch;

		mount();
		await flush();
		expect(container.textContent).toContain("browser only — re-register");

		await click(
			[...container.querySelectorAll("button")].find(
				(b) => b.textContent === "Enable on this device",
			),
		);
		await flush();
		expect(registered).toBe(true);
		expect(browser.calls).toHaveLength(1);
		expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual([
			"GET /api/app/push",
			"POST /api/app/push/public-key",
			"POST /api/app/push/subscription",
			"GET /api/app/push",
		]);
		expect(seen[2]!.body).toEqual({
			endpoint: ENDPOINT,
			expirationTime: null,
			keys: { p256dh: "device-p256dh", auth: "device-auth" },
		});
		expect(container.textContent).toContain("on this device");
	});

	test("disables the current browser and removes the server row", async () => {
		const browser = installBrowser();
		let deleted = false;
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const path = new URL(url, "http://localhost").pathname;
			if (path === "/api/app/push") {
				return Promise.resolve(
					json({
						configured: true,
						subscriptions: deleted
							? []
							: [
									{
										endpointHash: HASH,
										userAgent: "test",
										createdAt: "2026-01-01T00:00:00Z",
										updatedAt: "2026-01-01T00:00:00Z",
									},
								],
					}),
				);
			}
			if (path === "/api/app/push/subscription" && init?.method === "DELETE") {
				deleted = true;
				return Promise.resolve(json({ removed: true }));
			}
			return Promise.resolve(json({ error: "unmapped" }, 404));
		}) as typeof fetch;

		mount();
		await flush();
		expect(container.textContent).toContain("on this device");

		await click(
			[...container.querySelectorAll("button")].find(
				(b) => b.textContent === "Disable on this device",
			),
		);
		await flush();
		expect(deleted).toBe(true);
		expect(browser.unsubscribed).toBe(true);
		expect(container.textContent).toContain("off");
	});
});

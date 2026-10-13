import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { installTelegramFallback } from "./telegram.ts";

// The Desktop fallback (design/telegram.md → Mini Apps, ruling
// 2026-10-13): Telegram Desktop never injects window.Telegram, so the
// shim must reconstruct the same surface the official SDK would —
// initData byte-exact from the hash, ready/expand over the client
// bridges — without ever clobbering an injected copy.
describe("telegram fallback shim", () => {
	const originalWindow = globalThis.window;

	afterEach(() => {
		if (originalWindow !== undefined) globalThis.window = originalWindow;
		else Reflect.deleteProperty(globalThis, "window");
	});

	function mountAt(hash: string): Window {
		const win = new Window({ url: `http://localhost/t/settings${hash}` });
		Reflect.set(globalThis, "window", win);
		return win;
	}

	test("initData is the decoded tgWebAppData, byte-exact for the server's HMAC check", () => {
		mountAt("#tgWebAppData=user%3D%257B%2522id%2522%253A111%257D%26auth_date%3D1760000000%26hash%3Dabc");
		installTelegramFallback();
		expect(window.Telegram?.WebApp.initData).toBe(
			"user=%7B%22id%22%3A111%7D&auth_date=1760000000&hash=abc",
		);
		expect(window.Telegram?.WebApp.initDataUnsafe.user?.id).toBe(111);
	});

	test("hash params after a path prefix still parse", () => {
		mountAt("#k?tgWebAppData=user%3D%257B%2522id%2522%253A222%257D%26hash%3Ddef");
		installTelegramFallback();
		expect(window.Telegram?.WebApp.initData).toBe('user=%7B%22id%22%3A222%7D&hash=def');
	});

	test("literal `+` decodes as a space, %2B stays a plus — official urlSafeDecode", () => {
		mountAt("#tgWebAppData=first_name%3DAda+V%26last_name%3D%2541da%2520W%26hash%3Dabc");
		installTelegramFallback();
		// literal + in the hash → space; %2B → literal +
		expect(window.Telegram?.WebApp.initData).toBe("first_name=Ada V&last_name=%41da%20W&hash=abc");
	});

	test("no tgWebAppData — plain browser — keeps initData empty so the door shows its notice", () => {
		mountAt("");
		installTelegramFallback();
		expect(window.Telegram?.WebApp.initData).toBe("");
	});

	test("an injected SDK is never overwritten", () => {
		const win = mountAt("#tgWebAppData=user%3Dx");
		const injected = { WebApp: { initData: "injected" } };
		Reflect.set(win, "Telegram", injected);
		installTelegramFallback();
		expect(Reflect.get(win, "Telegram")).toBe(injected);
	});

	test("ready/expand ride the TelegramWebviewProxy bridge with the official payloads", () => {
		const win = mountAt("#tgWebAppData=user%3Dx");
		const calls: Array<[string, string]> = [];
		Reflect.set(win, "TelegramWebviewProxy", {
			postEvent: (eventType: string, eventData: string) => {
				calls.push([eventType, eventData]);
			},
		});
		installTelegramFallback();
		window.Telegram?.WebApp.ready?.();
		window.Telegram?.WebApp.expand?.();
		expect(calls).toEqual([
			["web_app_ready", '""'],
			["web_app_expand", '""'],
		]);
	});

	test("without the Qt bridge, the Windows host's external.notify is used", () => {
		mountAt("#tgWebAppData=user%3Dx");
		const notified: string[] = [];
		Reflect.set(window, "external", {
			notify: (data: string) => {
				notified.push(data);
			},
		});
		installTelegramFallback();
		window.Telegram?.WebApp.expand?.();
		expect(notified).toEqual(['{"eventType":"web_app_expand","eventData":""}']);
	});

	test("in an iframe — no proxy, no external — events post to the parent frame", () => {
		const win = mountAt("#tgWebAppData=user%3Dx");
		const posted: Array<{ data: string; target: string }> = [];
		Reflect.set(win, "parent", {
			postMessage: (data: string, target: string) => {
				posted.push({ data, target });
			},
		});
		installTelegramFallback();
		window.Telegram?.WebApp.ready?.();
		expect(posted).toEqual([
			{ data: '{"eventType":"web_app_ready","eventData":""}', target: "*" },
		]);
	});
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

type Listener = (event: FakeEvent) => void;

interface FakeEvent {
	data?: { json(): unknown } | null;
	notification?: { data?: { url?: unknown }; close(): void };
	waitUntil(promise: Promise<unknown>): void;
}

interface FakeClient {
	url: string;
	focus(): Promise<unknown>;
	navigate(url: string): Promise<unknown>;
}

interface FakeSelf {
	addEventListener(name: string, listener: Listener): void;
	skipWaiting(): void;
	location: { origin: string };
	registration: {
		showNotification(title: string, options: { data?: { url?: string } }): Promise<void>;
	};
	clients: {
		claim(): Promise<void>;
		matchAll(options: { type: string; includeUncontrolled: boolean }): Promise<FakeClient[]>;
		openWindow(url: string): Promise<unknown>;
	};
}

function loadWorker() {
	const listeners = new Map<string, Listener>();
	const shown: { title: string; url: string | undefined }[] = [];
	const opened: string[] = [];
	const navigated: string[] = [];
	const focused: string[] = [];
	const self: FakeSelf = {
		addEventListener(name, listener) {
			listeners.set(name, listener);
		},
		skipWaiting() {},
		location: { origin: "https://goblin.test" },
		registration: {
			showNotification(title, options) {
				shown.push({ title, url: options.data?.url });
				return Promise.resolve();
			},
		},
		clients: {
			claim: () => Promise.resolve(),
			matchAll: () =>
				Promise.resolve([
					{
						url: "https://goblin.test/app/settings",
						focus() {
							focused.push(this.url);
							return Promise.resolve(this);
						},
						navigate(url) {
							navigated.push(url);
							return Promise.resolve(this);
						},
					},
				]),
			openWindow(url) {
				opened.push(url);
				return Promise.resolve(undefined);
			},
		},
	};
	const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
	(new Function("self", source) as (self: FakeSelf) => void)(self);
	return { listeners, shown, opened, navigated, focused };
}

describe("app service worker push shim", () => {
	test("renders a generic push and clamps its target to /app/", async () => {
		const worker = loadWorker();
		const waits: Promise<unknown>[] = [];
		worker.listeners.get("push")?.({
			data: {
				json: () => ({ title: "", body: "", url: "https://elsewhere.test/app/c/x" }),
			},
			waitUntil: (promise) => waits.push(promise),
		});
		worker.listeners.get("push")?.({
			data: { json: () => null },
			waitUntil: (promise) => waits.push(promise),
		});
		await Promise.all(waits);
		expect(worker.shown).toEqual([
			{ title: "goblin", url: "/app/" },
			{ title: "goblin", url: "/app/" },
		]);
	});

	test("click focuses an app window and navigates it to the notification target", async () => {
		const worker = loadWorker();
		const waits: Promise<unknown>[] = [];
		worker.listeners.get("notificationclick")?.({
			notification: {
				data: { url: "/app/c/room-1" },
				close() {},
			},
			waitUntil: (promise) => waits.push(promise),
		});
		await Promise.all(waits);
		expect(worker.focused).toEqual(["https://goblin.test/app/settings"]);
		expect(worker.navigated).toEqual(["https://goblin.test/app/c/room-1"]);
		expect(worker.opened).toEqual([]);
	});
});

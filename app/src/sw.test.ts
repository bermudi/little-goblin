import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

type Listener = (event: FakeEvent) => void;

interface FakeEvent {
	data?: { json(): unknown } | null;
	notification?: { data?: { url?: unknown }; close(): void };
	request?: FakeRequest;
	respondedWith?: Promise<unknown>;
	waitUntil(promise: Promise<unknown>): void;
	respondWith?(promise: Promise<unknown>): void;
}

interface FakeRequest {
	method: string;
	url: string;
	mode: string;
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

interface FakeCache {
	store: Map<string, unknown>;
	addedAll: string[] | null;
	match(key: string | { url: string }): Promise<unknown>;
	addAll(requests: { url: string }[]): Promise<void>;
}

interface FakeCaches {
	caches: Map<string, FakeCache>;
	deleted: string[];
	open(name: string): Promise<FakeCache>;
	keys(): Promise<string[]>;
	delete(name: string): Promise<boolean>;
}

const MARKER = "const SHELL = null; // replaced at build: { build, files }";
const BUILT_SHELL = { build: "0123456789abcdef", files: ["/app/assets/app.js", "/app/index.html"] };

// Cache keys are URLs — the store keys them by pathname like the stamped
// manifest does, so a request's absolute URL and addAll's "/app/x" collide
// correctly.
function cacheKey(key: string | { url: string }): string {
	const url = typeof key === "string" ? key : key.url;
	return new URL(url, "https://goblin.test").pathname;
}

function makeCache(entries: Record<string, unknown> = {}): FakeCache {
	const store = new Map<string, unknown>(Object.entries(entries));
	return {
		store,
		addedAll: null,
		match: (key) => Promise.resolve(store.get(cacheKey(key))),
		addAll(requests) {
			this.addedAll = requests.map((r) => r.url);
			for (const r of requests) store.set(cacheKey(r.url), `cached:${r.url}`);
			return Promise.resolve();
		},
	};
}

function makeCaches(initial: Record<string, Record<string, unknown>> = {}): FakeCaches {
	const caches = new Map<string, FakeCache>();
	const deleted: string[] = [];
	const api: FakeCaches = {
		caches,
		deleted,
		open(name) {
			let cache = caches.get(name);
			if (cache === undefined) {
				cache = makeCache();
				caches.set(name, cache);
			}
			return Promise.resolve(cache);
		},
		keys: () => Promise.resolve([...caches.keys()]),
		delete(name) {
			deleted.push(name);
			return Promise.resolve(caches.delete(name));
		},
	};
	for (const [name, entries] of Object.entries(initial)) caches.set(name, makeCache(entries));
	return api;
}

function loadWorker(options: { built?: boolean; caches?: FakeCaches; fetch?: (req: FakeRequest) => Promise<unknown> } = {}) {
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
	let source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
	if (options.built === true)
		source = source.replace(MARKER, `const SHELL = ${JSON.stringify(BUILT_SHELL)};`);
	const caches = options.caches ?? makeCaches();
	const fetchCalls: FakeRequest[] = [];
	const fakeFetch = (req: FakeRequest) => {
		fetchCalls.push(req);
		return (options.fetch ?? ((r: FakeRequest) => Promise.resolve(`net:${r.url}`)))(req);
	};
	// setTimeout(cb, ms) runs on the next macrotask regardless of ms — a
	// resolved fetch (microtask) still wins the race, a hung one yields to
	// the fallback, and the timeout test stays instant.
	const timeout = (cb: () => void, _ms: number) => setTimeout(cb, 0);
	(new Function("self", "caches", "fetch", "setTimeout", "clearTimeout", "Request", source) as (
		self: FakeSelf,
		caches: FakeCaches,
		fetch: (req: FakeRequest) => Promise<unknown>,
		setTimeout: (cb: () => void, ms: number) => unknown,
		clearTimeout: (id: never) => void,
		Request: new (url: string, init?: unknown) => { url: string },
	) => void)(
		self,
		caches,
		fakeFetch,
		timeout,
		clearTimeout,
		class {
			constructor(readonly url: string) {}
		},
	);
	return { listeners, shown, opened, navigated, focused, caches, fetchCalls };
}

function fetchEvent(request: FakeRequest): FakeEvent & { responded: Promise<unknown> | null } {
	const event: FakeEvent & { responded: Promise<unknown> | null } = {
		request,
		responded: null,
		waitUntil() {},
		respondWith(promise) {
			this.responded = promise;
		},
	};
	return event;
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

describe("app service worker offline shell", () => {
	test("unbuilt: install caches nothing and fetch never calls respondWith", async () => {
		const worker = loadWorker();
		const waits: Promise<unknown>[] = [];
		worker.listeners.get("install")?.({ waitUntil: (p) => waits.push(p) });
		await Promise.all(waits);
		expect(worker.caches.caches.size).toBe(0);

		const event = fetchEvent({ method: "GET", url: "https://goblin.test/app/", mode: "navigate" });
		worker.listeners.get("fetch")?.(event);
		expect(event.responded).toBeNull();
	});

	test("built install: addAll receives exactly the shell files", async () => {
		const worker = loadWorker({ built: true });
		const waits: Promise<unknown>[] = [];
		worker.listeners.get("install")?.({ waitUntil: (p) => waits.push(p) });
		await Promise.all(waits);
		const cache = worker.caches.caches.get(`goblin-shell-${BUILT_SHELL.build}`);
		expect(cache?.addedAll).toEqual(BUILT_SHELL.files);
	});

	test("activate deletes only stale goblin-shell-* caches", async () => {
		const current = `goblin-shell-${BUILT_SHELL.build}`;
		const caches = makeCaches({
			[current]: {},
			"goblin-shell-older": {},
			"other-cache": {},
		});
		const worker = loadWorker({ built: true, caches });
		const waits: Promise<unknown>[] = [];
		worker.listeners.get("activate")?.({ waitUntil: (p) => waits.push(p) });
		await Promise.all(waits);
		expect(worker.caches.deleted).toEqual(["goblin-shell-older"]);
		expect([...worker.caches.caches.keys()].sort()).toEqual([current, "other-cache"].sort());
	});

	test("navigation, network ok (incl. 500): returns the network response", async () => {
		const worker = loadWorker({
			built: true,
			caches: makeCaches({ [`goblin-shell-${BUILT_SHELL.build}`]: { "/app/index.html": "shell" } }),
			fetch: () => Promise.resolve({ status: 500 }),
		});
		const event = fetchEvent({ method: "GET", url: "https://goblin.test/app/c/x", mode: "navigate" });
		worker.listeners.get("fetch")?.(event);
		expect(await event.responded).toEqual({ status: 500 });
	});

	test("navigation, network rejects: returns the cached index.html", async () => {
		const worker = loadWorker({
			built: true,
			caches: makeCaches({ [`goblin-shell-${BUILT_SHELL.build}`]: { "/app/index.html": "shell" } }),
			fetch: () => Promise.reject(new Error("down")),
		});
		const event = fetchEvent({ method: "GET", url: "https://goblin.test/app/c/x", mode: "navigate" });
		worker.listeners.get("fetch")?.(event);
		expect(await event.responded).toBe("shell");
	});

	test("navigation, network hangs: the timeout fires and the cached shell is served", async () => {
		const worker = loadWorker({
			built: true,
			caches: makeCaches({ [`goblin-shell-${BUILT_SHELL.build}`]: { "/app/index.html": "shell" } }),
			fetch: () => new Promise(() => {}),
		});
		const event = fetchEvent({ method: "GET", url: "https://goblin.test/app/c/x", mode: "navigate" });
		worker.listeners.get("fetch")?.(event);
		expect(await event.responded).toBe("shell");
	});

	test("precached asset: served from cache without calling fetch", async () => {
		const worker = loadWorker({
			built: true,
			caches: makeCaches({
				[`goblin-shell-${BUILT_SHELL.build}`]: { "/app/assets/app.js": "asset" },
			}),
		});
		const event = fetchEvent({
			method: "GET",
			url: "https://goblin.test/app/assets/app.js",
			mode: "no-cors",
		});
		worker.listeners.get("fetch")?.(event);
		expect(await event.responded).toBe("asset");
		expect(worker.fetchCalls).toEqual([]);
	});

	test("/api/... request and a POST: no respondWith", () => {
		const worker = loadWorker({ built: true });
		const api = fetchEvent({ method: "GET", url: "https://goblin.test/api/app/conversations", mode: "cors" });
		worker.listeners.get("fetch")?.(api);
		expect(api.responded).toBeNull();
		const post = fetchEvent({ method: "POST", url: "https://goblin.test/app/x", mode: "cors" });
		worker.listeners.get("fetch")?.(post);
		expect(post.responded).toBeNull();
	});
});

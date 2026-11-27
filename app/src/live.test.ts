import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AppConversationList, AppProjectList } from "../../src/http/app-wire.ts";
import { type LiveFeedStatus, LiveStore, type LiveTiming } from "./live.ts";

const TIMING: LiveTiming = {
	backoffMs: 5,
	backoffMaxMs: 30,
	lostMs: 80,
	firstEventMs: 60,
	byteMs: 60,
	retryMs: 40,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tick = () => sleep(0);

class Listeners {
	private handlers = new Map<string, Set<EventListener>>();
	addEventListener(name: string, fn: EventListener): void {
		this.handlers.set(name, (this.handlers.get(name) ?? new Set()).add(fn));
	}
	removeEventListener(name: string, fn: EventListener): void {
		this.handlers.get(name)?.delete(fn);
	}
	fire(name: string): void {
		for (const fn of this.handlers.get(name) ?? []) fn({ type: name } as Event);
	}
	get count(): number {
		let n = 0;
		for (const set of this.handlers.values()) n += set.size;
		return n;
	}
}

class FakeDocument extends Listeners {
	visibilityState = "visible";
}

class FakeWindow extends Listeners {
	location = { pathname: "/" };
}

interface Feed {
	push(event: unknown): void;
	raw(text: string): void;
	close(): void;
	dead(): boolean;
}

function rig() {
	const doc = new FakeDocument();
	const requests: { url: string; method: string }[] = [];
	const feeds: Feed[] = [];
	const getCounts = new Map<string, number>();
	const answers = new Map<string, (n: number) => Promise<Response>>();
	const liveQueue: (() => Response | Promise<Response>)[] = [];
	let refuseAll = false;
	const enc = new TextEncoder();

	const openFeed = (init?: RequestInit): Response => {
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		let dead = false;
		const feed: Feed = {
			push: (event) => feed.raw(`data: ${JSON.stringify(event)}\n\n`),
			raw: (text) => {
				if (!dead) controller.enqueue(enc.encode(text));
			},
			close: () => {
				if (!dead) controller.close();
			},
			dead: () => dead,
		};
		const stream = new ReadableStream<Uint8Array>({
			start: (c) => {
				controller = c;
			},
		});
		init?.signal?.addEventListener("abort", () => {
			dead = true;
			controller.error(new DOMException("aborted", "AbortError"));
		});
		feeds.push(feed);
		return new Response(stream, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};

	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = init?.method ?? "GET";
		requests.push({ url, method });
		if (url === "/api/app/live") {
			const queued = liveQueue.shift();
			if (queued !== undefined) return Promise.resolve(queued());
			if (refuseAll) return Promise.resolve(new Response("no", { status: 503 }));
			return Promise.resolve(openFeed(init));
		}
		const n = (getCounts.get(url) ?? 0) + 1;
		getCounts.set(url, n);
		const answer = answers.get(url);
		if (answer !== undefined) return answer(n);
		return Promise.resolve(Response.json({}));
	}) as typeof fetch;

	return {
		doc,
		requests,
		feeds,
		getCount: (path: string) => getCounts.get(path) ?? 0,
		liveCount: () => requests.filter((r) => r.url === "/api/app/live").length,
		answer: (path: string, fn: (n: number) => Promise<Response>) => answers.set(path, fn),
		failNextLive: (fn: () => Response) => liveQueue.push(fn),
		hangNextLive: () => liveQueue.push(() => new Promise<Response>(() => {})),
		refuseLive: (on: boolean) => {
			refuseAll = on;
		},
	};
}

const json = (body: unknown, version?: string, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json",
			...(version === undefined ? {} : { "x-goblin-version": version }),
		},
	});

const list = (preview: string): AppConversationList => ({
	conversations: [
		{
			id: `app/${preview}`,
			title: preview,
			preview,
			updatedAt: "t",
			createdAt: "t",
			archivedAt: null,
			pinnedAt: null,
			projectId: null,
			parentId: null,
			newReply: null,
			busy: false,
		},
	],
	rolling: { chain: [] },
	bots: [],
});

const projects = (name: string): AppProjectList => ({
	projects: [
		{
			id: name,
			name,
			slug: name,
			dir: `/p/${name}`,
			managed: true,
			instructions: "",
			memory: "shared",
			createdAt: "t",
			archivedAt: null,
		},
	],
});

async function until(fn: () => boolean, ms = 2000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!fn()) {
		if (Date.now() > deadline) throw new Error("until: timed out");
		await sleep(2);
	}
}

const versions = (map: Record<string, string>) => ({ type: "versions", versions: map });

describe("LiveStore", () => {
	let store: LiveStore;
	let stop: () => void;
	let fake: ReturnType<typeof rig>;
	let doc: FakeDocument;
	let win: FakeWindow;
	const realFetch = globalThis.fetch;
	const realDocument = globalThis.document;
	const realWindow = globalThis.window;
	const realWarn = console.warn;
	let warnings: unknown[][];

	beforeEach(() => {
		fake = rig();
		doc = fake.doc;
		win = new FakeWindow();
		globalThis.document = doc as unknown as Document;
		Reflect.set(globalThis, "window", win);
		warnings = [];
		console.warn = (...args: unknown[]) => void warnings.push(args);
		store = new LiveStore(null, TIMING);
		stop = store.start();
	});

	afterEach(() => {
		stop();
		globalThis.fetch = realFetch;
		if (realDocument === undefined) Reflect.deleteProperty(globalThis, "document");
		else globalThis.document = realDocument;
		if (realWindow === undefined) Reflect.deleteProperty(globalThis, "window");
		else Reflect.set(globalThis, "window", realWindow);
		console.warn = realWarn;
	});

	async function attach(versionsMap: Record<string, string>): Promise<Feed> {
		await until(() => fake.feeds.length >= 1);
		const feed = fake.feeds.at(-1)!;
		feed.push(versions(versionsMap));
		await tick();
		return feed;
	}

	function restart(timing: Partial<LiveTiming> = {}): void {
		stop();
		store = new LiveStore(null, { ...TIMING, ...timing });
		stop = store.start();
	}

	test("S1: announced version equal to the GET header fetches once", async () => {
		fake.answer("/api/app/conversations", () => Promise.resolve(json(list("a"), "v1")));
		const release = store.retain("conversations");
		await attach({ conversations: "v1" });
		await until(() => store.topic("conversations").data !== null);
		await sleep(10);
		expect(fake.getCount("/api/app/conversations")).toBe(1);
		release();
	});

	test("S2: an announced version different from the header fetches once more", async () => {
		fake.answer("/api/app/conversations", (n) =>
			Promise.resolve(n === 1 ? json(list("a"), "v1") : json(list("b"), "v2")),
		);
		const release = store.retain("conversations");
		await until(() => fake.getCount("/api/app/conversations") === 1);
		await attach({ conversations: "v2" });
		await until(() => fake.getCount("/api/app/conversations") === 2);
		await until(() => store.topic("conversations").data?.conversations[0]?.preview === "b");
		await sleep(10);
		expect(fake.getCount("/api/app/conversations")).toBe(2);
		release();
	});

	test("S3: A to B to A while one GET is in flight ends on the last announcement", async () => {
		let resolveGet!: (res: Response) => void;
		fake.answer("/api/app/conversations", (n) =>
			n === 1
				? new Promise<Response>((resolve) => void (resolveGet = resolve))
				: Promise.resolve(json(list("a"), "A")),
		);
		const feed = await attach({ conversations: "A" });
		const release = store.retain("conversations");
		await until(() => fake.getCount("/api/app/conversations") === 1);
		feed.push(versions({ conversations: "B" }));
		feed.push(versions({ conversations: "A" }));
		await tick();
		resolveGet(json(list("b"), "B"));
		await until(() => fake.getCount("/api/app/conversations") === 2);
		await until(() => store.topic("conversations").data?.conversations[0]?.preview === "a");
		await sleep(10);
		expect(fake.getCount("/api/app/conversations")).toBe(2);
		release();
	});

	test("S4: a GET with no version header fetches once per announced change", async () => {
		const feed = await attach({ projects: "v1" });
		const release = store.retain("projects");
		await until(() => fake.getCount("/api/app/projects") === 1);
		await sleep(10);
		expect(fake.getCount("/api/app/projects")).toBe(1);
		feed.push(versions({ projects: "v2" }));
		await until(() => fake.getCount("/api/app/projects") === 2);
		feed.push(versions({ projects: "v3" }));
		await until(() => fake.getCount("/api/app/projects") === 3);
		release();
	});

	test("S5: an error: announcement retries on the timer and recovers at once", async () => {
		fake.answer("/api/app/notes", (n) =>
			Promise.resolve(n === 1 ? json({}, undefined, 500) : json({ notes: [] }, "v9")),
		);
		const feed = await attach({ notes: "error:gone" });
		const release = store.retain("notes");
		await until(() => store.topic("notes").error !== null);
		expect(fake.getCount("/api/app/notes")).toBe(1);
		feed.push(versions({ notes: "v9" }));
		await until(() => fake.getCount("/api/app/notes") === 2);
		await until(() => store.topic("notes").error === null);
		await sleep(TIMING.retryMs + 10);
		expect(fake.getCount("/api/app/notes")).toBe(2);
		release();

		fake.answer("/api/app/notes", (n) =>
			Promise.resolve(n <= 4 ? json({}, undefined, 500) : json({ notes: [] }, "v10")),
		);
		const release2 = store.retain("notes");
		feed.push(versions({ notes: "error:again" }));
		await until(() => fake.getCount("/api/app/notes") === 3);
		await until(() => fake.getCount("/api/app/notes") === 4);
		feed.push(versions({ notes: "v10" }));
		await until(() => fake.getCount("/api/app/notes") === 5);
		await until(() => store.topic("notes").error === null);
		release2();
	});

	test("S6: update beats an in-flight GET", async () => {
		let resolveGet!: (res: Response) => void;
		const resolvers2: ((res: Response) => void)[] = [];
		fake.answer("/api/app/conversations", (n) =>
			n === 1
				? new Promise<Response>((resolve) => void (resolveGet = resolve))
				: new Promise<Response>((resolve) => resolvers2.push(resolve)),
		);
		const release = store.retain("conversations");
		await until(() => fake.getCount("/api/app/conversations") === 1);
		store.update("conversations", () => list("local"));
		resolveGet(json(list("stale"), "v1"));
		await tick();
		expect(store.topic("conversations").data?.conversations[0]?.preview).toBe("local");
		resolvers2[0]!(json(list("server"), "v2"));
		await until(() => store.topic("conversations").data?.conversations[0]?.preview === "server");
		release();
	});

	test("S7: refresh newest wins, resolves after settle, never rejects", async () => {
		const resolvers: ((res: Response) => void)[] = [];
		fake.answer(
			"/api/app/projects",
			() => new Promise<Response>((resolve) => resolvers.push(resolve)),
		);
		const p1 = store.refresh("projects");
		const p2 = store.refresh("projects");
		await until(() => resolvers.length === 2);
		resolvers[1]!(json(projects("new"), "v2"));
		await p2;
		expect(store.topic("projects").data?.projects[0]?.name).toBe("new");
		resolvers[0]!(json(projects("old"), "v1"));
		await p1;
		await tick();
		expect(store.topic("projects").data?.projects[0]?.name).toBe("new");

		fake.answer("/api/app/notes", () => Promise.resolve(json({}, undefined, 500)));
		await store.refresh("notes");
		expect(store.topic("notes").error).not.toBeNull();
	});

	test("S8: a released topic ignores announcements; re-retaining shows cache then fetches", async () => {
		fake.answer("/api/app/projects", (n) =>
			Promise.resolve(n === 1 ? json(projects("one"), "v1") : json(projects("two"), "v2")),
		);
		const release = store.retain("projects");
		const feed = await attach({ projects: "v1" });
		await until(() => fake.getCount("/api/app/projects") === 1);
		release();
		feed.push(versions({ projects: "v2" }));
		await sleep(10);
		expect(fake.getCount("/api/app/projects")).toBe(1);

		expect(store.topic("projects").data?.projects[0]?.name).toBe("one");
		const release2 = store.retain("projects");
		expect(store.topic("projects").data?.projects[0]?.name).toBe("one");
		await until(() => fake.getCount("/api/app/projects") === 2);
		await until(() => store.topic("projects").data?.projects[0]?.name === "two");
		release2();
	});

	test("S9: reconnect with identical versions refetches nothing; a change refetches once", async () => {
		fake.answer("/api/app/conversations", (n) =>
			Promise.resolve(n === 1 ? json(list("a"), "v1") : json(list("b"), "v2")),
		);
		const feed = await attach({ conversations: "v1", projects: "p1" });
		const release = store.retain("conversations");
		await until(() => fake.getCount("/api/app/conversations") === 1);
		feed.close();
		await until(() => fake.feeds.length === 2);
		fake.feeds[1]!.push(versions({ conversations: "v1", projects: "p1" }));
		await sleep(15);
		expect(fake.getCount("/api/app/conversations")).toBe(1);
		expect(fake.getCount("/api/app/projects")).toBe(0);
		fake.feeds[1]!.push(versions({ conversations: "v2", projects: "p1" }));
		await until(() => fake.getCount("/api/app/conversations") === 2);
		await until(() => store.topic("conversations").data?.conversations[0]?.preview === "b");
		release();
	});

	test("S10: hiding aborts the feed and opens none while hidden; showing reconnects", async () => {
		restart({ firstEventMs: 5000, byteMs: 5000 });
		const first = await attach({});
		expect(store.status()).toBe("live");
		doc.visibilityState = "hidden";
		doc.fire("visibilitychange");
		expect(first.dead()).toBe(true);
		expect(store.status()).toBe("connecting");
		await sleep(TIMING.backoffMaxMs * 3);
		expect(fake.liveCount()).toBe(1);
		doc.visibilityState = "visible";
		doc.fire("visibilitychange");
		await until(() => fake.feeds.length === 2);
		expect(fake.liveCount()).toBe(2);
	});

	test("S11a: a feed that sends only keepalive bytes and no event is restarted by the first-event watchdog", async () => {
		restart({ firstEventMs: 60, byteMs: 5000 });
		await until(() => fake.feeds.length === 1);
		const silent = fake.feeds[0]!;
		silent.raw(": k\n\n");
		await until(() => fake.feeds.length === 2, 1000);
		expect(silent.dead()).toBe(true);
		expect(store.status()).not.toBe("live");
	});

	test("S11b: a fetch that never resolves is restarted by the byte watchdog", async () => {
		fake.hangNextLive();
		restart({ firstEventMs: 5000, byteMs: 60 });
		await until(() => fake.liveCount() === 2, 1000);
		await until(() => fake.feeds.length === 1, 1000);
		expect(store.status()).not.toBe("live");
	});

	test("S11c: after a valid event, silence restarts the feed; keepalive bytes keep it open", async () => {
		restart({ firstEventMs: 5000, byteMs: 60 });
		const feed = await attach({});
		expect(store.status()).toBe("live");
		for (let i = 0; i < 10; i++) {
			feed.raw(": k\n\n");
			await sleep(20);
		}
		expect(fake.feeds.length).toBe(1);
		expect(feed.dead()).toBe(false);
		expect(store.status()).toBe("live");
		await until(() => fake.feeds.length === 2, 1000);
		expect(feed.dead()).toBe(true);
		expect(store.status()).not.toBe("live");
	});

	test("S12: lost after the limit, live on the first valid event, hidden time excluded", async () => {
		restart({ firstEventMs: 500, byteMs: 500, lostMs: 60 });
		await until(() => fake.feeds.length === 1);
		expect(store.status()).toBe("connecting");
		await until(() => store.status() === "lost");
		fake.feeds[0]!.push(versions({}));
		await tick();
		expect(store.status()).toBe("live");
		fake.feeds[0]!.close();
		await until(() => fake.feeds.length === 2);
		doc.visibilityState = "hidden";
		doc.fire("visibilitychange");
		await sleep(140);
		expect(store.status()).not.toBe("lost");
		doc.visibilityState = "visible";
		doc.fire("visibilitychange");
	});

	test("S12a: a server that refuses every attempt shows lost within lostMs plus a margin", async () => {
		fake.refuseLive(true);
		restart({});
		const t0 = Date.now();
		await until(() => store.status() === "lost", 1000);
		expect(Date.now() - t0).toBeLessThan(TIMING.lostMs + 60);
	});

	test("S12b: offline while visible shows lost; online opens a new feed", async () => {
		restart({ firstEventMs: 5000, byteMs: 5000 });
		const first = await attach({});
		expect(store.status()).toBe("live");
		win.fire("offline");
		expect(first.dead()).toBe(true);
		expect(store.status()).toBe("connecting");
		await until(() => store.status() === "lost", 1000);
		await sleep(TIMING.backoffMaxMs * 3);
		expect(fake.feeds.length).toBe(1);
		win.fire("online");
		await until(() => fake.feeds.length === 2);
	});

	test("S12c: a page shown while still offline counts to lost from the moment it shows", async () => {
		restart({ firstEventMs: 5000, byteMs: 5000 });
		await attach({});
		doc.visibilityState = "hidden";
		doc.fire("visibilitychange");
		win.fire("offline");
		await sleep(TIMING.lostMs + 40);
		expect(store.status()).toBe("connecting");
		const shown = Date.now();
		doc.visibilityState = "visible";
		doc.fire("visibilitychange");
		await until(() => store.status() === "lost", 1000);
		expect(Date.now() - shown).toBeGreaterThanOrEqual(TIMING.lostMs - 5);
		expect(fake.feeds.length).toBe(1);
		win.fire("online");
		await until(() => fake.feeds.length === 2);
	});

	test("S13: a 401 stops the feed and re-reads conversations", async () => {
		fake.failNextLive(() => new Response("no", { status: 401 }));
		await until(() => fake.getCount("/api/app/conversations") === 1);
		await sleep(TIMING.backoffMaxMs * 2);
		expect(fake.liveCount()).toBe(1);
	});

	test("S14: a bad frame never lets a valid frame in the same chunk make the feed live", async () => {
		const seen: LiveFeedStatus[] = [];
		store.subscribe(() => seen.push(store.status()));
		fake.failNextLive(() => new Response("hello", { headers: { "content-type": "text/plain" } }));
		await until(() => fake.feeds.length === 2);
		fake.feeds[1]!.raw("data: {not json\n\n");
		await until(() => fake.feeds.length === 3);
		fake.feeds[2]!.push({ type: "nope" });
		await until(() => fake.feeds.length === 4);
		fake.feeds[3]!.raw(`data: {"type":"nope"}\n\ndata: ${JSON.stringify(versions({}))}\n\n`);
		await until(() => fake.feeds.length === 5);
		expect(seen).not.toContain("live");
		expect(warnings.map((w) => String(w[0]))).toContain(
			"app live feed sent a bad frame; reconnecting",
		);
		fake.feeds[4]!.push(versions({}));
		await tick();
		expect(store.status()).toBe("live");
		expect(seen.at(-1)).toBe("live");
	});

	test("S15: stop ends the feed, the timers and the listeners", async () => {
		fake.answer("/api/app/notes", () => Promise.resolve(json({ notes: [] }, "v1")));
		const release = store.retain("notes");
		await attach({ notes: "v1" });
		await until(() => fake.getCount("/api/app/notes") === 1);
		expect(doc.count).toBe(1);
		expect(win.count).toBe(3);
		stop();
		release();
		expect(doc.count).toBe(0);
		expect(win.count).toBe(0);
		expect(fake.feeds[0]!.dead()).toBe(true);
		doc.visibilityState = "hidden";
		doc.fire("visibilitychange");
		doc.visibilityState = "visible";
		doc.fire("visibilitychange");
		await sleep(TIMING.backoffMaxMs + TIMING.lostMs + TIMING.retryMs + 20);
		expect(fake.liveCount()).toBe(1);
		expect(fake.getCount("/api/app/notes")).toBe(1);
		fake.feeds[0]!.push(versions({ notes: "v2" }));
		await sleep(10);
		expect(fake.getCount("/api/app/notes")).toBe(1);
	});

	test("S16: a later announcement notifies subscribers even when nobody retains the topic", async () => {
		const seen: (string | null)[] = [];
		store.subscribe(() => seen.push(store.version("notes")));
		const feed = await attach({ notes: "v1" });
		feed.push(versions({ notes: "v2" }));
		await tick();
		expect(store.version("notes")).toBe("v2");
		expect(seen.at(-1)).toBe("v2");
		expect(fake.getCount("/api/app/notes")).toBe(0);
	});
});

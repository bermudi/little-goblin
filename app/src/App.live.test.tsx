import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AppConversationList } from "../../src/http/app-wire.ts";
import type { AppConversationSummary } from "../../src/conversation-read.ts";
import { App } from "./App.tsx";
import { openDesktopPage } from "./testkit.ts";

const conv = (
	id: string,
	title: string,
	over: Partial<AppConversationSummary> = {},
): AppConversationSummary => ({
	id: `app/${id}`,
	title,
	preview: "",
	createdAt: "2026-11-01T00:00:00Z",
	updatedAt: "2026-11-01T00:00:00Z",
	archivedAt: null,
	pinnedAt: null,
	projectId: null,
	parentId: null,
	newReply: null,
	...over,
});

const convList = (rows: AppConversationSummary[]): AppConversationList => ({
	conversations: rows.map((row) => ({ ...row, busy: false })),
	rolling: { chain: [] },
});

const projectFixture = (name: string) => {
	const id = `p-${name.toLowerCase().replace(/ /g, "-")}`;
	return {
		id,
		name,
		slug: id,
		dir: `/p/${id}`,
		managed: true,
		instructions: "",
		memory: "shared",
		createdAt: "2026-11-01T00:00:00Z",
		archivedAt: null,
	};
};

const emptyMessages = {
	messages: [],
	start: 0,
	olderCursor: null,
	ratings: [],
	rateableMessageIds: [],
	compactions: [],
};

const LOST_TEXT = "Reconnecting. Marks may be old.";

describe("app live feed", () => {
	let win: Window;
	let container: HTMLElement;
	let root: Root | null;
	let installed: string[];
	let phone: boolean;
	let failArchive: boolean;
	let parentRunning: boolean;
	let chatEvents: ReadableStreamDefaultController<Uint8Array> | null;
	const realFetch = globalThis.fetch;

	const bodies = new Map<string, unknown>();
	const versions = new Map<string, number>();
	const requests: { url: string; method: string }[] = [];
	const feeds: {
		controller: ReadableStreamDefaultController<Uint8Array>;
		encoder: TextEncoder;
	}[] = [];

	const bump = (path: string, body: unknown) => {
		bodies.set(path, body);
		versions.set(path, (versions.get(path) ?? 0) + 1);
	};
	const emit = async (versions_: Record<string, string>) =>
		await act(async () => {
			feeds[feeds.length - 1]!.controller.enqueue(
				feeds[feeds.length - 1]!.encoder.encode(
					`data: ${JSON.stringify({ type: "versions", versions: versions_ })}\n\n`,
				),
			);
		});
	const announce = (path: string, topic: string) =>
		emit({ [topic]: `v${versions.get(path)}` });
	const closeFeed = () => feeds[feeds.length - 1]!.controller.close();
	const requestsTo = (url: string) => requests.filter((r) => r.url === url).length;

	const installGlobal = (name: string, value: unknown) => {
		Reflect.set(globalThis, name, value);
		installed.push(name);
	};

	const topicPaths: [string, string, unknown][] = [
		["/api/app/conversations", "conversations", convList([conv("one", "first chat")])],
		["/api/app/projects", "projects", { projects: [] }],
		["/api/app/notes", "notes", { notes: [], truncated: false }],
		["/api/app/attention", "attention", { items: [], unavailable: [] }],
		[
			"/api/app/approvals",
			"approvals",
			{ programs: [], mail: [], serverTimeZone: "UTC" },
		],
		["/api/app/activity", "activity", { busy: [], otherBusy: 0, posts: [] }],
		["/api/app/programs", "programs", { programs: [], serverTimeZone: "UTC" }],
		["/api/app/delegations", "delegations", { delegations: [] }],
		["/api/app/skills", "skills", { skills: [], proposed: [], usage: [] }],
	];

	beforeEach(() => {
		win = new Window({ url: "http://localhost/app/" });
		const div = win.document.createElement("div");
		win.document.body.appendChild(div);
		container = div as unknown as HTMLElement;
		root = null;
		installed = [];
		phone = false;
		failArchive = false;
		parentRunning = false;
		chatEvents = null;
		bodies.clear();
		versions.clear();
		requests.length = 0;
		feeds.length = 0;
		for (const [path, , body] of topicPaths) bump(path, body);
		installGlobal("window", win);
		installGlobal("document", win.document);
		installGlobal("navigator", win.navigator);
		installGlobal("localStorage", win.localStorage);
		installGlobal("sessionStorage", win.sessionStorage);
		installGlobal("Event", win.Event);
		installGlobal("MouseEvent", win.MouseEvent);
		installGlobal("PointerEvent", win.PointerEvent);
		installGlobal("CustomEvent", win.CustomEvent);
		installGlobal("getComputedStyle", win.getComputedStyle);
		installGlobal("HTMLElement", win.HTMLElement);
		installGlobal("HTMLFieldSetElement", win.HTMLFieldSetElement);
		installGlobal("HTMLInputElement", win.HTMLInputElement);
		installGlobal("HTMLSelectElement", win.HTMLSelectElement);
		installGlobal("HTMLTextAreaElement", win.HTMLTextAreaElement);
		installGlobal("Element", win.Element);
		installGlobal("ShadowRoot", win.ShadowRoot);
		installGlobal("MutationObserver", win.MutationObserver);
		installGlobal("ResizeObserver", win.ResizeObserver);
		installGlobal("NodeFilter", (win as unknown as { NodeFilter: unknown }).NodeFilter);
		installGlobal("requestAnimationFrame", win.requestAnimationFrame.bind(win));
		installGlobal("cancelAnimationFrame", win.cancelAnimationFrame.bind(win));
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
		Reflect.set(win, "matchMedia", (query: string) => ({
			matches: phone && query.includes("max-width: 720"),
			media: query,
			addEventListener() {},
			removeEventListener() {},
		}));
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const method = init?.method ?? (input instanceof Request ? input.method : "GET");
			const path = url.split("?")[0]!;
			if (method === "GET") requests.push({ url: path, method });
			if (path === "/api/app/live") {
				const encoder = new TextEncoder();
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						feeds.push({ controller, encoder });
					},
				});
				return Promise.resolve(
					new Response(stream, { headers: { "content-type": "text/event-stream" } }),
				);
			}
			if (path.startsWith("/api/app/conversations/")) {
				const rest = path.slice("/api/app/conversations/".length);
				if (rest.endsWith("/stream")) return Promise.resolve(new Response(null, { status: 204 }));
				if (rest.endsWith("/events"))
					return Promise.resolve(
						new Response(
							new ReadableStream({
								start(controller) {
									chatEvents = controller;
									if (parentRunning)
									controller.enqueue(
										new TextEncoder().encode('data: {"type":"state","live":true}\n\n'),
									);
								},
							}),
							{ headers: { "content-type": "text/event-stream" } },
						),
					);
				if (rest.endsWith("/branch") && method === "POST")
					return Promise.resolve(Response.json({ id: "app/branched" }));
				if (rest.endsWith("/pending")) return Promise.resolve(Response.json({ items: [] }));
				if (rest.endsWith("/messages") && method === "GET") {
					const override = bodies.get(path);
					return Promise.resolve(Response.json(override ?? emptyMessages));
				}
				if (method === "PATCH") {
					const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
					if (failArchive && body.archived === true)
						return Promise.resolve(Response.json({ error: "archive down" }, { status: 500 }));
					return Promise.resolve(Response.json(body));
				}
				if (method === "DELETE") return Promise.resolve(Response.json({ ok: true }));
			}
			if (bodies.has(path) && method === "GET") {
				return Promise.resolve(
					new Response(JSON.stringify(bodies.get(path)), {
						headers: {
							"content-type": "application/json",
							"x-goblin-version": `v${versions.get(path)}`,
						},
					}),
				);
			}
			if (path === "/api/app/chat" && method === "POST")
				return Promise.resolve(Response.json({ submitted: true }, { status: 202 }));
			if (path === "/api/app/projects" && method === "POST") {
				const body = JSON.parse(String(init?.body ?? "{}")) as { name: string };
				return Promise.resolve(Response.json(projectFixture(body.name)));
			}
			if (path === "/api/app/conversations" && method === "POST")
				return Promise.resolve(
					Response.json({
						id: "app/created",
						title: null,
						createdAt: "2026-11-02T00:00:00Z",
					}),
				);
			if (path === "/api/app/settings")
				return Promise.resolve(
					Response.json({
						config: {},
						providerKinds: [],
						searchKinds: [],
						fetchKinds: [],
						transcriptionKinds: [],
						transcriptionDefaults: {},
						authDefaults: {},
						authNames: [],
						modelCatalog: [],
					}),
				);
			if (path === "/api/app/identity" || path === "/api/app/attachments")
				return Promise.resolve(Response.json({ files: [] }));
			if (path === "/api/app/push")
				return Promise.resolve(Response.json({ configured: false, subscriptions: [] }));
			return Promise.resolve(Response.json({ error: `unfaked ${method} ${url}` }, { status: 500 }));
		}) as typeof fetch;
	});

	afterEach(async () => {
		await act(async () => root?.unmount());
		root = null;
		globalThis.fetch = realFetch;
		for (const name of installed) Reflect.deleteProperty(globalThis, name);
		await win.happyDOM.close();
	});

	const settle = () => act(async () => {});
	const waitFor = async (pred: () => boolean, label: string) => {
		for (let i = 0; i < 400; i++) {
			if (pred()) return;
			await settle();
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error(`timed out waiting for ${label}`);
	};
	const click = async (el: Element | null | undefined) => {
		if (el === null || el === undefined) throw new Error("nothing to click");
		await act(async () => {
			el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event);
		});
		await settle();
	};
	const rows = () => [...container.querySelectorAll(".rail-body a, .chatlist-screen a")];
	const rowText = () =>
		rows()
			.map((r) => r.textContent ?? "")
			.join("\n");
	const rowErrorText = () =>
		[...container.querySelectorAll("p.error")].map((e) => e.textContent ?? "").join("\n");
	const archiveFails = async () => {
		failArchive = true;
		await click(container.querySelector('[role="toolbar"] button[aria-label="Archive"]'));
		await waitFor(() => rowErrorText().includes("Couldn't archive"), "the row error");
	};
	const send = async (text: string) => {
		const box = container.querySelector<HTMLTextAreaElement>("form.composer textarea")!;
		await act(async () => {
			box.focus();
			Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value")!.set!.call(
				box,
				text,
			);
			box.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
			box.dispatchEvent(
				new win.KeyboardEvent("keyup", { bubbles: true, key: "o" }) as unknown as Event,
			);
		});
		await act(async () => {
			container.querySelector("form.composer")!.dispatchEvent(
				new win.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
			);
		});
	};
	const turnEnds = () =>
		act(async () => {
			chatEvents!.enqueue(new TextEncoder().encode('data: {"type":"turn-end"}\n\n'));
		});
	const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

	const mount = async () => {
		root = createRoot(container);
		await act(async () => {
			root?.render(<App />);
		});
		await waitFor(
			() => container.querySelector(".rail-body, .chatlist-screen") !== null,
			"the list",
		);
	};

	test("C1: a chat that appears on the server shows in the rail, and on the phone list, by itself", async () => {
		await mount();
		expect(feeds).toHaveLength(1);
		await emit({ conversations: "v1" });
		await settle();
		expect(rowText()).toContain("first chat");
		const before = requestsTo("/api/app/conversations");
		bump(
			"/api/app/conversations",
			convList([conv("one", "first chat"), conv("two", "from afar")]),
		);
		await announce("/api/app/conversations", "conversations");
		await waitFor(() => rowText().includes("from afar"), "new chat in the rail");
		expect(requestsTo("/api/app/conversations")).toBe(before + 1);

		await act(async () => root?.unmount());
		root = null;
		phone = true;
		requests.length = 0;
		feeds.length = 0;
		bodies.clear();
		versions.clear();
		for (const [path, , body] of topicPaths) bump(path, body);
		await mount();
		await emit({ conversations: "v1" });
		bump(
			"/api/app/conversations",
			convList([conv("one", "first chat"), conv("two", "from afar")]),
		);
		await announce("/api/app/conversations", "conversations");
		await waitFor(
			() => container.querySelector(".chatlist-screen")!.textContent!.includes("from afar"),
			"new chat in the phone list",
		);
	});

	test("C2: a child chat appears while the parent's turn still runs", async () => {
		parentRunning = true;
		await mount();
		await emit({ conversations: "v1" });
		await click(rows().find((r) => r.getAttribute("href") === "/app/c/one"));
		await waitFor(() => win.location.pathname === "/app/c/one", "the parent open");
		await waitFor(
			() => container.querySelector('button[aria-label="Stop"]') !== null,
			"the parent's running state",
		);
		bump(
			"/api/app/conversations",
			convList([
				conv("one", "first chat"),
				conv("two", "child worker", { parentId: "app/one" }),
			]),
		);
		await announce("/api/app/conversations", "conversations");
		await waitFor(() => rowText().includes("child worker"), "the child row");
		expect(container.querySelector('button[aria-label="Stop"]')).not.toBeNull();
	});

	test("C3: operator pages move on an announcement; an open detail stays; the notes filter survives", async () => {
		await mount();
		await emit({ conversations: "v1", projects: "v1", notes: "v1" });
		await openDesktopPage(container, click, "Programs");
		await settle();
		expect(container.textContent).not.toContain("nightly");
		bump("/api/app/programs", {
			programs: [
				{
					id: 1,
					name: "nightly",
					charter: "run the nightly",
					cron: "0 3 * * *",
					maxLatenessMinutes: null,
					hasHook: false,
					mailFilter: null,
					enabled: true,
					target: "program/nightly",
					chatId: 0,
					threadId: null,
					createdAt: "2026-11-01T00:00:00Z",
					lastRun: null,
					nextRun: null,
					lastSkippedAt: null,
					lastSkipReason: null,
				},
			],
			serverTimeZone: "UTC",
		});
		await announce("/api/app/programs", "programs");
		await waitFor(() => container.textContent!.includes("nightly"), "the program on screen");

		await click(rows().find((r) => r.getAttribute("href") === "/app/c/one"));
		await openDesktopPage(container, click, "Delegations");
		await settle();
		const delegation = {
			id: 9,
			name: "scout",
			harness: "pi",
			status: "running",
			target: null,
			task: "look around",
			cwd: "/tmp",
			appConversation: "app/one",
			chatId: 0,
			threadId: null,
			createdAt: "2026-11-01T00:00:00Z",
			promptedAt: "2026-11-01T00:00:00Z",
			finishedAt: null,
		};
		bump("/api/app/delegations", { delegations: [delegation] });
		await announce("/api/app/delegations", "delegations");
		await waitFor(() => container.textContent!.includes("scout"), "the delegation row");
		await click(
			[...container.querySelectorAll("button")].find((b) => b.textContent === "Details"),
		);
		await waitFor(
			() => container.querySelector(".deleg-detail") !== null,
			"the delegation detail",
		);
		const delegationsGets = requestsTo("/api/app/delegations");
		bump("/api/app/delegations", {
			delegations: [delegation, { ...delegation, id: 10, name: "second" }],
		});
		await announce("/api/app/delegations", "delegations");
		await waitFor(
			() => requestsTo("/api/app/delegations") === delegationsGets + 1,
			"the refetch",
		);
		expect(container.querySelector(".deleg-detail")).not.toBeNull();
		expect(container.textContent).toContain("look around");

		await click(rows().find((r) => r.getAttribute("href") === "/app/c/one"));
		await openDesktopPage(container, click, "Notes");
		const select = container.querySelector<HTMLSelectElement>(
			'select[aria-label="Filter notes by project"]',
		)!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, "value")!.set!.call(
				select,
				"loose",
			);
			select.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event);
		});
		await settle();
		const notesGets = requestsTo("/api/app/notes");
		bump("/api/app/notes", {
			notes: [
				{
					id: "n1",
					title: "kept filter",
					projectId: null,
					updatedAt: "2026-11-02T00:00:00Z",
					preview: "",
					rev: 1,
					stateRev: 1,
					pinnedAt: null,
					archivedAt: null,
				},
			],
			truncated: false,
		});
		await announce("/api/app/notes", "notes");
		await waitFor(() => requestsTo("/api/app/notes") > notesGets, "the notes refetch");
		await waitFor(() => container.textContent!.includes("kept filter"), "the new note row");
		expect(
			container.querySelector<HTMLSelectElement>('select[aria-label="Filter notes by project"]')
				?.value,
		).toBe("loose");

		win.history.replaceState(null, "", "/app/skills");
		await act(async () => {
			win.dispatchEvent(new win.PopStateEvent("popstate"));
		});
		await settle();
		bump("/api/app/skills", {
			skills: [],
			proposed: [{ name: "triage", files: [], diff: { kind: "new" } }],
			usage: [],
		});
		await announce("/api/app/skills", "skills");
		await waitFor(() => container.textContent!.includes("triage"), "the new skill proposal");

		win.history.replaceState(null, "", "/app/attention");
		await act(async () => {
			win.dispatchEvent(new win.PopStateEvent("popstate"));
		});
		await settle();
		bump("/api/app/attention", {
			items: [
				{
					id: "delegation-input:3",
					kind: "delegation-input",
					title: "Delegation needs input — worker",
					detail: "finish the report",
					createdAt: "2026-11-05T00:00:00.000Z",
					conversationId: "app/one",
					target: { kind: "conversation", conversationId: "app/one" },
				},
			],
			unavailable: [],
		});
		await announce("/api/app/attention", "attention");
		await waitFor(
			() => container.textContent!.includes("Delegation needs input"),
			"the new attention item",
		);
	});

	test("C4: rename, archive and delete from elsewhere show; the open header follows", async () => {
		await mount();
		await emit({ conversations: "v1" });
		await click(rows().find((r) => r.getAttribute("href") === "/app/c/one"));
		await waitFor(() => win.location.pathname === "/app/c/one", "the chat open");

		bump("/api/app/conversations", convList([conv("one", "renamed chat")]));
		await announce("/api/app/conversations", "conversations");
		await waitFor(() => rowText().includes("renamed chat"), "the renamed row");
		await waitFor(
			() => container.querySelector(".header-title")!.textContent === "renamed chat",
			"the header title",
		);

		bump(
			"/api/app/conversations",
			convList([conv("one", "renamed chat", { archivedAt: "2026-11-03T00:00:00Z" })]),
		);
		await announce("/api/app/conversations", "conversations");
		await waitFor(
			() => container.querySelector(".rail-archived")?.textContent?.includes("1") === true,
			"the archived disclosure",
		);

		bump("/api/app/conversations", convList([]));
		await announce("/api/app/conversations", "conversations");
		await waitFor(
			() => container.querySelector(".rail-archived") === null,
			"the disclosure gone",
		);
	});

	test(
		"C5: a background refetch keeps a row error; own actions still land while the feed is down",
		async () => {
			await mount();
			await emit({ conversations: "v1" });
			failArchive = true;
			const row = container.querySelector('[role="toolbar"] button[aria-label="Archive"]');
			await click(row);
			await waitFor(() => rowErrorText().includes("Couldn't archive"), "the row error");
			bump(
				"/api/app/conversations",
				convList([conv("one", "first chat"), conv("two", "remote")]),
			);
			await announce("/api/app/conversations", "conversations");
			await waitFor(() => rowText().includes("remote"), "the background refetch");
			expect(rowErrorText()).toContain("Couldn't archive");

			closeFeed();
			await waitFor(() => container.querySelector(".live-lost") !== null, "the lost line");
			bump(
				"/api/app/conversations",
				convList([
					conv("one", "first chat", { pinnedAt: "2026-11-03T00:00:00Z" }),
					conv("two", "remote"),
				]),
			);
			await click(container.querySelector('[role="toolbar"] button[aria-label="Pin"]'));
			await waitFor(
				() => container.querySelector('[role="toolbar"] button[aria-label="Unpin"]') !== null,
				"the pin on screen",
			);
			expect(rowErrorText()).not.toContain("Couldn't");
		},
		20000,
	);

	test(
		"C6: the line shows when the feed is lost and clears when it returns, desktop and phone",
		async () => {
			await mount();
			expect(feeds).toHaveLength(1);
			await emit({ conversations: "v1" });
			expect(container.querySelector(".live-lost")).toBeNull();
			closeFeed();
			await waitFor(() => container.querySelector(".live-lost") !== null, "the lost line");
			expect(container.textContent).toContain(LOST_TEXT);
			await waitFor(() => feeds.length === 2, "the reconnect");
			await emit({ conversations: "v1" });
			await waitFor(() => container.querySelector(".live-lost") === null, "the line clears");

			await act(async () => root?.unmount());
			root = null;
			phone = true;
			requests.length = 0;
			feeds.length = 0;
			await mount();
			await emit({ conversations: "v1" });
			closeFeed();
			await waitFor(() => container.querySelector(".live-lost") !== null, "the phone lost line");
			expect(container.textContent).toContain(LOST_TEXT);
			await waitFor(() => feeds.length === 2, "the phone reconnect");
			await emit({ conversations: "v1" });
			await waitFor(
				() => container.querySelector(".live-lost") === null,
				"the phone line clears",
			);
		},
		20000,
	);

	test("C7: nothing but the probe before the gate, one feed under StrictMode, one GET per topic", async () => {
		const held: (() => void)[] = [];
		const probes: string[] = [];
		let holding = true;
		const baseFetch = globalThis.fetch;
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (holding && url === "/api/app/conversations") {
				probes.push(url);
				return new Promise<Response>((resolve) =>
					held.push(() => void baseFetch(input, init).then(resolve)),
				);
			}
			return baseFetch(input, init);
		}) as typeof fetch;
		root = createRoot(container);
		await act(async () => {
			root?.render(
				<StrictMode>
					<App />
				</StrictMode>,
			);
		});
		await settle();
		expect(feeds).toHaveLength(0);
		expect(requests).toHaveLength(0);
		expect(probes.length).toBeGreaterThanOrEqual(1);
		holding = false;
		for (const release of [...held]) release();
		await waitFor(() => feeds.length > 0, "the feed after the gate");
		expect(feeds).toHaveLength(1);
		const retained = [
			"/api/app/projects",
			"/api/app/notes",
			"/api/app/attention",
			"/api/app/activity",
			"/api/app/programs",
			"/api/app/delegations",
		];
		for (const path of retained)
			await waitFor(() => requestsTo(path) === 1, `one GET for ${path}`);
		expect(requestsTo("/api/app/approvals")).toBe(0);
		expect(requestsTo("/api/app/skills")).toBe(0);
		const probed = probes.length;
		await waitFor(
			() => requestsTo("/api/app/conversations") - probed >= 1,
			"the store's conversations GET",
		);
		expect(requestsTo("/api/app/conversations") - probed).toBe(1);
		const counts = () => topicPaths.map(([path]) => requestsTo(path));
		const before = counts();
		await emit(Object.fromEntries(topicPaths.map(([, topic]) => [topic, "v1"])));
		await pause(100);
		expect(counts()).toEqual(before);
	});

	test("C8: several approval cards in one transcript cause one approvals GET", async () => {
		bodies.set("/api/app/conversations/one/messages", {
			messages: [
				{
					id: "m1",
					role: "assistant",
					parts: [
						{ type: "data-approval", data: { kind: "program", id: 1 } },
						{ type: "data-approval", data: { kind: "program", id: 2 } },
						{ type: "data-approval", data: { kind: "program", id: 3 } },
					],
				},
			],
			start: 0,
			olderCursor: null,
			ratings: [],
			rateableMessageIds: [],
			compactions: [],
		});
		bump("/api/app/approvals", {
			programs: [
				{ id: 1, kind: "create", targetId: null, target: "nightly", state: "pending",
					createdAt: "2026-11-01T00:00:00Z", decidedAt: null, decidedBy: null,
					activatedId: null, candidate: null, changes: null },
				{ id: 2, kind: "create", targetId: null, target: "weekly", state: "pending",
					createdAt: "2026-11-01T00:00:00Z", decidedAt: null, decidedBy: null,
					activatedId: null, candidate: null, changes: null },
				{ id: 3, kind: "create", targetId: null, target: "monthly", state: "pending",
					createdAt: "2026-11-01T00:00:00Z", decidedAt: null, decidedBy: null,
					activatedId: null, candidate: null, changes: null },
			],
			mail: [],
			serverTimeZone: "UTC",
		});
		await mount();
		await emit({ conversations: "v1" });
		await announce("/api/app/approvals", "approvals");
		await click(rows().find((r) => r.getAttribute("href") === "/app/c/one"));
		await waitFor(
			() => container.querySelectorAll(".approval-card").length === 3,
			"the three cards",
		);
		expect(requestsTo("/api/app/approvals")).toBe(1);
	});

	test("C9a: a row error clears when a move from the chat header lands", async () => {
		bump("/api/app/projects", { projects: [projectFixture("Goblin Work")] });
		await mount();
		await emit({ conversations: "v1", projects: "v2" });
		await click(rows().find((r) => r.getAttribute("href") === "/app/c/one"));
		await waitFor(() => win.location.pathname === "/app/c/one", "the chat open");
		await archiveFails();
		const before = requestsTo("/api/app/conversations");
		await click(container.querySelector(".title-trigger"));
		await click(
			[...container.querySelectorAll('[role="menuitem"]')].find(
				(item) => item.textContent === "Move to project",
			),
		);
		await click(
			[...container.querySelectorAll('[role="menuitem"]')].find(
				(item) => item.textContent === "Goblin Work",
			),
		);
		await waitFor(() => requestsTo("/api/app/conversations") > before, "the move refresh");
		expect(rowErrorText()).not.toContain("Couldn't archive");
	});

	test("C9b: a row error clears when a new project lands", async () => {
		await mount();
		await emit({ conversations: "v1" });
		await click(rows().find((r) => r.getAttribute("href") === "/app/c/one"));
		await waitFor(() => win.location.pathname === "/app/c/one", "the chat open");
		await archiveFails();
		const before = requestsTo("/api/app/projects");
		await click(container.querySelector('button[aria-label="New project"]'));
		const name = container.querySelector<HTMLInputElement>(".msheet input")!;
		await act(async () => {
			name.focus();
			Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(
				name,
				"Beta",
			);
			name.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
			name.dispatchEvent(
				new win.KeyboardEvent("keyup", { bubbles: true, key: "e" }) as unknown as Event,
			);
		});
		await settle();
		await act(async () => {
			container.querySelector(".msheet form")!.dispatchEvent(
				new win.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
			);
		});
		await waitFor(() => requestsTo("/api/app/projects") > before, "the projects refetch");
		expect(rowErrorText()).not.toContain("Couldn't archive");
	});

	test("C9c: a row error clears when a branch lands", async () => {
		bodies.set("/api/app/conversations/one/messages", {
			messages: [{ id: "m1", role: "assistant", parts: [{ type: "text", text: "hi there" }] }],
			start: 0,
			olderCursor: null,
			ratings: [],
			rateableMessageIds: [],
			compactions: [],
		});
		await mount();
		await emit({ conversations: "v1" });
		await click(rows().find((r) => r.getAttribute("href") === "/app/c/one"));
		await waitFor(() => win.location.pathname === "/app/c/one", "the chat open");
		await waitFor(() => container.textContent!.includes("hi there"), "the answer");
		await archiveFails();
		const before = requestsTo("/api/app/conversations");
		await click(container.querySelector('button[aria-label="Branch conversation"]'));
		await waitFor(() => win.location.pathname === "/app/c/branched", "the branch open");
		await waitFor(() => requestsTo("/api/app/conversations") > before, "the branch refresh");
		expect(rowErrorText()).not.toContain("Couldn't archive");
	});

	test(
		"C10: a send and the end of its turn reach the rail while the feed is down",
		async () => {
			const list = (preview: string) => convList([conv("one", "first chat", { preview })]);
			await mount();
			await emit({ conversations: "v1" });
			await click(rows().find((r) => r.getAttribute("href") === "/app/c/one"));
			await waitFor(() => chatEvents !== null, "the chat open");
			const live = requestsTo("/api/app/conversations");
			await turnEnds();
			await pause(50);
			expect(requestsTo("/api/app/conversations")).toBe(live);

			await archiveFails();
			closeFeed();
			await waitFor(() => container.querySelector(".live-lost") !== null, "the lost line");
			bump("/api/app/conversations", list("sent from here"));
			await send("hello");
			await waitFor(() => rowText().includes("sent from here"), "the send in the rail");
			expect(rowErrorText()).not.toContain("Couldn't archive");

			await archiveFails();
			bump("/api/app/conversations", list("the end of the reply"));
			await turnEnds();
			await waitFor(() => rowText().includes("the end of the reply"), "the reply in the rail");
			expect(rowErrorText()).toContain("Couldn't archive");
		},
		20000,
	);
});

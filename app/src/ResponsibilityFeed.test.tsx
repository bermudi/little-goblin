import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { ResponsibilityFeed } from "./ResponsibilityFeed.tsx";
import type { AppFeedItem } from "../../src/http/app-wire.ts";

let win: Window;
let container: HTMLElement;
let root: Root | null = null;
const realFetch = globalThis.fetch;
const globals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
	win = new Window({ url: "http://localhost/app/" });
	const div = win.document.createElement("div");
	win.document.body.appendChild(div);
	container = div as unknown as HTMLElement;
	for (const [name, value] of [
		["window", win],
		["document", win.document],
		["navigator", win.navigator],
		["IS_REACT_ACT_ENVIRONMENT", true],
	] as const) {
		globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Reflect.set(globalThis, name, value);
	}
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

function feed(paused: boolean, detached: boolean): AppFeedItem {
	const at = "2026-10-19T00:00:00Z";
	return {
		responsibility: {
			responsibilityId: "r1",
			projectId: "p1",
			status: paused ? "paused" : "active",
			revision: 1,
			understanding: {
				outcome: "ship fix",
				situation: "under review",
				nextAction: "inspect tests",
				checkpoints: [],
				completionEvidence: [],
			},
			outcome: "ship fix",
			coordinationConversationId: "c1",
			handoverKey: "k1",
			followupProgramId: null,
			armed: false,
			notArmedReason: null,
			createdAt: at,
			updatedAt: at,
			closedAt: null,
		},
		attachments: [
			{
				attachmentId: 7,
				responsibilityId: "r1",
				generation: 1,
				target: {
					server: "local",
					session: "default",
					agentName: "worker",
					paneId: "pane-7",
					terminalId: "term-1",
					agentSession: "sess-1",
					kind: "pi",
					cwd: "/w",
				},
				baseline: {},
				health: detached ? "detached" : "attached",
				cursor: {},
				createdAt: at,
				detachedAt: detached ? at : null,
			},
		],
		operations: [],
		events: [],
		eventsTruncated: 0,
		nextCheckinAt: null,
		lastActivityAt: at,
	};
}

function button(label: string): HTMLButtonElement {
	const result = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
	if (result === undefined) throw new Error(`missing button ${label}`);
	return result;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("a failed refresh keeps the rows and says so — monitoring never silently stops", async () => {
	const item = feed(false, false);
	let reads = 0;
	let rejectNext!: (err: unknown) => void;
	globalThis.fetch = Object.assign(
		(input: string | URL | Request, init?: RequestInit) => {
			if (init?.method === "POST") return Promise.resolve(Response.json({ ok: true }));
			reads += 1;
			if (reads === 1) return Promise.resolve(Response.json({ items: [item] }));
			// The mutation's refresh — the newest read — fails.
			return new Promise<Response>((_, reject) => {
				rejectNext = reject;
			});
		},
		{ preconnect: realFetch.preconnect },
	);
	root = createRoot(container);
	await act(async () => root?.render(<ResponsibilityFeed token={null} projectId={null} />));
	expect(container.querySelector(".resp-item")).not.toBeNull();
	// A mutation succeeds; its refetch fails: the last loaded state
	// stays visible, and the failure is on the record instead of the
	// stale rows standing mute.
	await act(async () => button("Detach").click());
	await act(async () => {
		rejectNext(new Error("network gone"));
		await sleep(5);
	});
	expect(container.querySelector('[role="alert"]')?.textContent).toContain("Refresh failed");
	expect(container.querySelector('[role="alert"]')?.textContent).toContain("network gone");
	expect(container.querySelector(".resp-item")).not.toBeNull();
});

test("a stale poll that lands after a mutation's refresh cannot restore obsolete state", async () => {
	const active = feed(false, false);
	const paused = {
		...active,
		responsibility: { ...active.responsibility, status: "paused" as const },
	};
	let latest: AppFeedItem = active;
	// While gating, every GET is held in order — the test decides which
	// response lands when. Ungated reads answer with the latest payload.
	let gating = false;
	const held: ((r: Response) => void)[] = [];
	const posts: ((r: Response) => void)[] = [];
	globalThis.fetch = Object.assign(
		(input: string | URL | Request, init?: RequestInit) => {
			if (init?.method === "POST") {
				return new Promise<Response>((resolve) => posts.push(resolve));
			}
			if (gating) {
				return new Promise<Response>((resolve) => held.push(resolve));
			}
			return Promise.resolve(Response.json({ items: [latest] }));
		},
		{ preconnect: realFetch.preconnect },
	);
	root = createRoot(container);
	await act(async () =>
		root?.render(<ResponsibilityFeed token={null} projectId={null} pollMs={5} />),
	);
	expect(container.querySelector(".resp-status")?.textContent).toBe("active");
	// Gated slow reads hold the one ordinary poll in flight; the interval
	// must not stack more on top of it.
	gating = true;
	await act(async () => sleep(40));
	expect(held.length).toBe(1);
	// The operator pauses: the mutation succeeds and its refresh is the
	// newest read in flight.
	await act(async () => button("Pause").click());
	expect(posts.length).toBe(1);
	await act(async () => posts[0]!(Response.json({ ok: true })));
	const mutationRead = held[held.length - 1]!;
	await act(async () => mutationRead(Response.json({ items: [paused] })));
	expect(container.querySelector(".resp-status")?.textContent).toBe("paused");
	latest = paused;
	// A pre-mutation poll — the oldest one in flight — arrives last with
	// its obsolete active snapshot. It must lose to the newer truth.
	gating = false;
	await act(async () => held[0]!(Response.json({ items: [active] })));
	await act(async () => sleep(30));
	expect(container.querySelector(".resp-status")?.textContent).toBe("paused");
});

test("a truncated history names the older events still on the record", async () => {
	const item = {
		...feed(false, false),
		events: [
			{
				eventId: 1,
				sourceKey: "s1",
				kind: "scheduled-checkin",
				text: "still on it",
				facts: null,
				origin: "program",
				createdAt: "2026-10-19T00:00:00Z",
				conversationId: "c1",
				wake: null,
			},
		],
		eventsTruncated: 3,
	};
	globalThis.fetch = Object.assign(
		(input: string | URL | Request, init?: RequestInit) =>
			Promise.resolve(Response.json({ items: [item] })),
		{ preconnect: realFetch.preconnect },
	);
	root = createRoot(container);
	await act(async () => root?.render(<ResponsibilityFeed token={null} projectId={null} />));
	container.querySelector("details")!.open = true;
	expect(container.querySelector(".resp-events-older")?.textContent).toContain(
		"3 older events on the record",
	);
});

test("a poll slower than the interval never stacks requests and still lands", async () => {
	const item = feed(false, false);
	let reads = 0;
	let release!: (r: Response) => void;
	globalThis.fetch = Object.assign(
		(input: string | URL | Request, init?: RequestInit) => {
			if (init?.method === "POST") return Promise.resolve(Response.json({ ok: true }));
			reads += 1;
			if (reads === 1) {
				// The first read is slower than several poll intervals.
				return new Promise<Response>((resolve) => {
					release = resolve;
				});
			}
			return Promise.resolve(Response.json({ items: [item] }));
		},
		{ preconnect: realFetch.preconnect },
	);
	root = createRoot(container);
	await act(async () =>
		root?.render(<ResponsibilityFeed token={null} projectId={null} pollMs={5} />),
	);
	// Several intervals pass while the first read is in flight — each
	// one must skip, not stack another request that would only be
	// stale-discarded on arrival.
	await act(async () => sleep(40));
	expect(reads).toBe(1);
	await act(async () => release(Response.json({ items: [item] })));
	// The slow response is the newest read — it must render, not be
	// discarded by a newer seq a stacked poll would have taken.
	expect(container.querySelector(".resp-item")).not.toBeNull();
	// Polling resumes after the slow read settles.
	await act(async () => sleep(15));
	expect(reads).toBeGreaterThan(1);
});

for (const [label, action] of [
	["Pause", "pause"],
	["Resume", "resume"],
	["Cancel", "cancel"],
	["Send correction", "correct"],
	["Detach", "attachments/7/detach"],
	["Reattach", "attachments/7/reattach"],
] as const) {
	test(`${label} failure shows the server reason and permits an explicit retry`, async () => {
		const item = feed(action === "resume", action.endsWith("/reattach"));
		const requests: { path: string; body: string | null; resolve: (response: Response) => void }[] =
			[];
		let reads = 0;
		globalThis.fetch = Object.assign(
			(input: string | URL | Request, init?: RequestInit) => {
				const path = String(input);
				if (init?.method !== "POST") {
					reads++;
					return Promise.resolve(Response.json({ items: [item] }));
				}
				return new Promise<Response>((resolve) =>
					requests.push({
						path,
						body: typeof init.body === "string" ? init.body : null,
						resolve,
					}),
				);
			},
			{ preconnect: realFetch.preconnect },
		);
		root = createRoot(container);
		await act(async () => root?.render(<ResponsibilityFeed token={null} projectId={null} />));
		container.querySelector("details")!.open = true;
		if (action === "correct") {
			await act(async () => button("Correct").click());
			const textarea = container.querySelector("textarea")!;
			await act(async () => {
				textarea.focus();
				Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value")!.set!.call(
					textarea,
					"Keep this retryable correction",
				);
				textarea.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
				textarea.dispatchEvent(
					new win.KeyboardEvent("keyup", { bubbles: true, key: "n" }) as unknown as Event,
				);
			});
		}
		await act(async () => button(label).click());
		expect(requests).toHaveLength(1);
		expect(requests[0]!.path).toBe(`/api/app/responsibilities/r1/${action}`);
		expect(button(label).disabled).toBe(true);
		await act(async () =>
			requests[0]!.resolve(Response.json({ error: "operator-visible failure" }, { status: 409 })),
		);
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			"operator-visible failure",
		);
		expect(button(label).disabled).toBe(false);
		expect(reads).toBe(1); // No success-shaped refresh or automatic retry.
		if (action === "correct")
			expect(container.querySelector("textarea")!.value).toBe("Keep this retryable correction");
		await act(async () => button(label).click());
		expect(requests).toHaveLength(2);
		expect(requests[1]!.body).toBe(requests[0]!.body);
		await act(async () => requests[1]!.resolve(Response.json({ ok: true })));
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(reads).toBe(2);
		if (action === "correct") {
			expect(JSON.parse(requests[1]!.body!)).toEqual({ text: "Keep this retryable correction" });
			expect(container.querySelector("textarea")).toBeNull();
		}
	});
}

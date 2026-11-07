// Attention (#150): summary line, one card per memory cause with actions on
// the card, decisions with their evidence open, and the cross-project work
// feed below as a secondary section.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { AttentionView } from "./AttentionView.tsx";
import type {
	AppApprovalsResponse,
	AppAttentionResponse,
	AppFeedItem,
} from "../../src/http/app-wire.ts";
import type { SkillsResponse } from "../../src/http/operator-wire.ts";

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

type Seen = { method: string; path: string; body: unknown };

function stubFetch(routes: Record<string, unknown>, seen: Seen[] = []) {
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			const path = String(input);
			const method = init?.method ?? "GET";
			seen.push({
				method,
				path,
				body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
			});
			if (method === "POST" && path === "/api/app/memory/blocked")
				return Response.json({ ok: true, action: "retry", affected: 3 });
			if (path in routes) return Response.json(routes[path]);
			if (path === "/api/app/responsibilities") return Response.json({ items: [] });
			return Response.json({ error: "not stubbed" }, { status: 404 });
		},
		{ preconnect: realFetch.preconnect },
	);
	return seen;
}

async function mount(onPage: (p: string) => void = () => {}) {
	root = createRoot(container);
	await act(async () =>
		root?.render(<AttentionView token={null} onPage={onPage} onConversation={() => {}} />),
	);
}

const noSkills: SkillsResponse = { skills: [], proposed: [] } as unknown as SkillsResponse;
const noApprovals: AppApprovalsResponse = { programs: [], mail: [] };

function feedItem(): AppFeedItem {
	const at = "2026-10-19T00:00:00Z";
	return {
		responsibility: {
			responsibilityId: "r1",
			projectId: "p1",
			status: "active",
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
			followup: { token: "review-1", kind: "silence", dueAt: at, reason: "Verify progress" },
			armed: false,
			notArmedReason: null,
			createdAt: at,
			updatedAt: at,
			closedAt: null,
		},
		attachments: [],
		operations: [],
		stage: { waitsFor: "worker", stage: "working", reason: "no report yet" },
		latestReport: null,
		posts: [],
		postsTruncated: 0,
		events: [],
		eventsTruncated: 0,
		nextCheckinAt: null,
		nextCheckinReason: null,
		lastActivityAt: at,
	};
}

test("Attention carries the cross-project work feed beneath its decisions", async () => {
	const attention: AppAttentionResponse = { items: [], unavailable: [] };
	const seen = stubFetch({
		"/api/app/attention": attention,
		"/api/app/skills": noSkills,
		"/api/app/approvals": noApprovals,
		"/api/app/responsibilities": { items: [feedItem()] },
	});
	await mount();
	expect(container.textContent).toContain("Nothing needs you.");
	expect(container.textContent).toContain("All clear");
	const section = container.querySelector('section[aria-label="Work in progress"]');
	expect(section?.hasAttribute("hidden")).toBe(false);
	expect(container.textContent).toContain("Work in progress");
	expect(seen.map((r) => r.path)).toContain("/api/app/responsibilities");
});

test("the Work in progress section hides when nothing is running", async () => {
	stubFetch({
		"/api/app/attention": { items: [], unavailable: [] } satisfies AppAttentionResponse,
		"/api/app/skills": noSkills,
		"/api/app/approvals": noApprovals,
	});
	await mount();
	const section = container.querySelector('section[aria-label="Work in progress"]');
	expect(section?.hasAttribute("hidden")).toBe(true);
});

const memoryItem = (error: string, count: number): AppAttentionResponse["items"][number] => ({
	id: `memory-blocked:${error}`,
	kind: "memory-blocked",
	title: `Memory can't save ${count} exchanges`,
	detail: error,
	createdAt: "2026-10-01T00:00:00.000Z",
	target: { kind: "page", page: "memory" },
	memory: {
		error,
		count,
		conversations: [
			{ conversationId: "app/a", name: "Garden notes", count },
			{ conversationId: null, name: null, count: 0 },
		],
		fix: "Update the key, restart memory, then try again.",
	},
});

test("each memory cause is one card with the real error, conversations by name and a fix", async () => {
	stubFetch({
		"/api/app/attention": {
			items: [memoryItem("HTTP 401", 3), memoryItem("HTTP 500", 1)],
			unavailable: [],
		} satisfies AppAttentionResponse,
		"/api/app/skills": noSkills,
		"/api/app/approvals": noApprovals,
	});
	await mount();
	const text = container.textContent ?? "";
	expect(text).toContain("2 things are broken.");
	expect(container.querySelectorAll("article.attn-problem")).toHaveLength(2);
	expect(text).toContain("HTTP 401");
	expect(text).toContain("Garden notes");
	expect(text).toContain("Update the key, restart memory, then try again.");
	expect(text).toContain("If you wait:");
	expect(text).not.toContain("Nothing needs you.");
});

test("Try again retries only that cause; Drop them asks first", async () => {
	const seen = stubFetch({
		"/api/app/attention": {
			items: [memoryItem("HTTP 401", 3)],
			unavailable: [],
		} satisfies AppAttentionResponse,
		"/api/app/skills": noSkills,
		"/api/app/approvals": noApprovals,
		"/api/app/memory/status": { retry: null },
	});
	let page = "";
	await mount((p) => {
		page = p;
	});
	const button = (label: string) =>
		[...container.querySelectorAll("button")].find((b) => b.textContent === label);
	await act(async () => button("Drop them")?.click());
	expect(container.textContent).toContain("Memory will never save them.");
	expect(seen.some((r) => r.method === "POST")).toBe(false);
	await act(async () => button("Keep them")?.click());
	await act(async () => button("Open the Memory page")?.click());
	expect(page).toBe("memory");
	await act(async () => button("Try again")?.click());
	const post = seen.find((r) => r.method === "POST");
	expect(post?.body).toEqual({ action: "retry", error: "HTTP 401" });
});

test("a program approval shows its changes open and approves from the card", async () => {
	const seen = stubFetch({
		"/api/app/attention": {
			items: [
				{
					id: "program-approval:7",
					kind: "program-approval",
					title: "Program update — garden-care",
					detail: "needs approval",
					createdAt: "2026-11-05T00:00:00.000Z",
					target: { kind: "page", page: "programs" },
				},
			],
			unavailable: [],
		} satisfies AppAttentionResponse,
		"/api/app/skills": noSkills,
		"/api/app/approvals": {
			programs: [
				{
					id: 7,
					kind: "update",
					targetId: 2,
					target: "app/chat-01",
					state: "pending",
					createdAt: "2026-11-05T00:00:00.000Z",
					decidedAt: null,
					decidedBy: null,
					activatedId: null,
					candidate: {
						name: "garden-care",
						charter: "check frost",
						cron: "35 10 * * *",
						maxLatenessMinutes: 60,
						hook: false,
						mailFilter: null,
					},
					changes: [
						{
							field: "charter",
							label: "Instructions",
							before: "",
							after: "",
							lines: [
								{ op: "del", text: "check frost at nine" },
								{ op: "add", text: "check frost at ten" },
							],
						},
					],
				},
			],
			mail: [],
		} satisfies AppApprovalsResponse,
		"/api/app/approvals/program/7": { status: "activated", message: "ok" },
	});
	await mount();
	const text = container.textContent ?? "";
	expect(text).toContain("1 decision waits for you.");
	expect(text).toContain("Your decisions");
	expect(text).toContain("check frost at ten");
	expect(text).toContain("Program “garden-care” — update");
	expect(text).not.toContain("Program proposal #7");
	expect(text).toContain("If you wait:");
	// The wait line reads inside the decision card, not under it.
	const card = container.querySelector(".approval-card");
	expect(card?.querySelector(".attn-wait")).not.toBeNull();
	const approve = [...container.querySelectorAll("button")].find(
		(b) => b.textContent === "Approve",
	);
	expect(approve).toBeTruthy();
	await act(async () => approve?.click());
	expect(seen.some((r) => r.method === "POST" && r.path.includes("/approvals/"))).toBe(true);
});

test("other items keep an Open action", async () => {
	stubFetch({
		"/api/app/attention": {
			items: [
				{
					id: "interrupted-run:r1",
					kind: "interrupted-run",
					title: "Interrupted turn — Primary",
					detail: "2 recorded calls — resume or abandon",
					createdAt: "2026-11-05T00:00:00.000Z",
					target: { kind: "conversation", conversationId: "app/chat-01" },
				},
			],
			unavailable: [],
		} satisfies AppAttentionResponse,
		"/api/app/skills": noSkills,
		"/api/app/approvals": noApprovals,
	});
	await mount();
	expect(container.textContent).toContain("1 other item needs a look.");
	expect(
		[...container.querySelectorAll("button")].some((b) => b.textContent === "Open conversation"),
	).toBe(true);
});

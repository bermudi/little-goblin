import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { AppAttentionItem, AppConversationListItem } from "../../src/http/app-wire.ts";
import { activityTime, GoblinPanel } from "./GoblinPanel.tsx";

let win: Window;
let container: HTMLElement;
let root: Root | null = null;
const old: Array<[string, PropertyDescriptor | undefined]> = [];
const realFetch = globalThis.fetch;
const target: AppAttentionItem["target"] = { kind: "page", page: "programs" };
const item: AppAttentionItem = {
	id: "one", kind: "program-approval", title: "Review program", detail: "Evidence",
	createdAt: "2026-11-20T00:00:00.000Z", conversationId: null, target,
};
const baseData = (working: number, attention: AppAttentionItem[] = []) => ({
	attention, attentionError: false, delegations: [], programs: [], activity: { busy: [], otherBusy: 0, posts: [] },
	loadError: false, working, reload() {},
}) as unknown as Parameters<typeof GoblinPanel>[0]["data"];
const appConversation = (id: string, fields: Partial<AppConversationListItem> = {}): AppConversationListItem => ({
	id: `app/${id}`,
	title: id,
	createdAt: "2026-11-20T00:00:00Z",
	updatedAt: "2026-11-21T00:00:00Z",
	preview: `${id} preview`,
	archivedAt: null,
	pinnedAt: null,
	projectId: null,
	parentId: null,
	newReply: null,
	busy: false,
	...fields,
});

beforeEach(() => {
	win = new Window({ url: "http://localhost/app/" });
	const div = win.document.createElement("div");
	win.document.body.appendChild(div);
	container = div as unknown as HTMLElement;
	for (const [key, value] of [["window", win], ["document", win.document], ["navigator", win.navigator], ["IS_REACT_ACT_ENVIRONMENT", true]] as const) {
		old.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
		Reflect.set(globalThis, key, value);
	}
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	await win.happyDOM.close();
	for (const [key, descriptor] of old.splice(0)) {
		if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
		else Object.defineProperty(globalThis, key, descriptor);
	}
});
async function mount(working = 0, attention: AppAttentionItem[] = [], callbacks: Partial<Parameters<typeof GoblinPanel>[0]> = {}) {
	root = createRoot(container);
	const noop = () => {};
	await act(async () => root?.render(<GoblinPanel data={baseData(working, attention)} notes={null} variant="column" onOpenTarget={noop} onOpenConversation={noop} onOpenPage={noop} onOpenNote={noop} onOpenProfile={noop} {...callbacks} />));
}

test("panel shows working count and idle state", async () => {
	await mount(2);
	expect(container.textContent).toContain("Working · 2 jobs");
	expect(container.querySelector(".goblin-avatar")?.hasAttribute("data-working")).toBe(true);
	await act(async () => root?.render(<GoblinPanel data={baseData(0)} notes={null} variant="column" onOpenTarget={() => {}} onOpenConversation={() => {}} onOpenPage={() => {}} onOpenNote={() => {}} onOpenProfile={() => {}} />));
	expect(container.textContent).toContain("Idle");
	expect(container.querySelector(".goblin-avatar")?.hasAttribute("data-working")).toBe(false);
});

test("needs-you opens its evidence target and makes no request", async () => {
	let opened: unknown;
	let requests = 0;
	const original = globalThis.fetch;
	globalThis.fetch = Object.assign(async () => { requests += 1; return Response.json({}); }, { preconnect: realFetch.preconnect });
	await mount(0, [item], { onOpenTarget: (value) => { opened = value; } });
	await act(async () => container.querySelector(".goblin-need-row")?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event));
	expect(opened).toEqual(target);
	expect(requests).toBe(0);
	globalThis.fetch = original;
});

test("tabs are Activity, Scheduled, Memory and Library; avatar and Bot page open profile", async () => {
	let profile = 0;
	await mount(0, [], { onOpenProfile: () => { profile += 1; } });
	expect([...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(["Activity", "Scheduled", "Memory", "Library"]);
	expect(container.querySelector(".goblin-profile-button .goblin-avatar img")?.getAttribute("src")).toBe("/app/goblin-portrait.webp");
	await act(async () => container.querySelector(".goblin-profile-button")?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event));
	expect(profile).toBe(1);
	await act(async () => container.querySelector(".goblin-panel-header > button:last-child")?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event));
	expect(profile).toBe(2);
});

test("activity keeps delegations before finished work and omits subagent rows", async () => {
	const data = {
		...baseData(2),
		activity: { busy: [{ id: "app/child", title: "Compare prices", parentId: "app/parent", rolling: false }], otherBusy: 0, posts: [] },
		delegations: [
			{ id: 1, name: "fix-sheet", harness: "codex", task: "Fix the sheet", status: "running", createdAt: new Date().toISOString(), appConversation: "app/work" },
			{ id: 2, name: "old-task", harness: "pi", task: "Old task", status: "done", createdAt: "2026-11-20T00:00:00Z", finishedAt: "2026-11-21T01:00:00Z", appConversation: null },
		],
	} as unknown as Parameters<typeof GoblinPanel>[0]["data"];
	root = createRoot(container);
	await act(async () => root?.render(<GoblinPanel data={data} notes={null} variant="column" onOpenTarget={() => {}} onOpenConversation={() => {}} onOpenPage={() => {}} onOpenNote={() => {}} onOpenProfile={() => {}} />));
	const rows = [...container.querySelectorAll(".goblin-panel-row")].map((row) => row.textContent ?? "");
	const running = rows.findIndex((row) => row.includes("fix-sheet"));
	const finished = rows.findIndex((row) => row.includes("old-task"));
	expect(running).toBeGreaterThanOrEqual(0);
	expect(finished).toBeGreaterThan(running);
	expect(rows.some((row) => row.startsWith("Compare prices"))).toBe(false);
	expect([...container.querySelectorAll(".goblin-panel-group, .activity-row strong")].map((el) => el.textContent)).toEqual([
		"Running", "fix-sheet", "Earlier", "old-task",
	]);
});

test("a busy parent groups a busy subagent under one Running row", async () => {
	const data = {
		...baseData(2),
		activity: {
			busy: [
				{ id: "app/parent", title: "parent", parentId: null, rolling: false },
				{ id: "app/child", title: "child", parentId: "app/parent", rolling: false },
			],
			otherBusy: 0,
			posts: [],
		},
	} as unknown as Parameters<typeof GoblinPanel>[0]["data"];
	root = createRoot(container);
	await act(async () => root?.render(
		<GoblinPanel
			data={data}
			conversations={[
				appConversation("parent", { busy: true }),
				appConversation("child", { parentId: "app/parent", title: "Compare prices", busy: true }),
			]}
			notes={null}
			variant="column"
			onOpenTarget={() => {}}
			onOpenConversation={() => {}}
			onOpenPage={() => {}}
			onOpenNote={() => {}}
			onOpenProfile={() => {}}
		/>,
	));
	const running = [...container.querySelectorAll(".activity-row-wrap")].find((row) =>
		row.querySelector(":scope > .activity-row-main strong")?.textContent === "parent",
	);
	expect(running?.querySelector(":scope > .activity-row-main .activity-detail")?.textContent)
		.toBe("Replying · 1 subagent");
	expect(running?.textContent).toContain("Compare prices");
	expect(container.querySelectorAll(".goblin-panel-group").length).toBe(1);
});

test("idle parent stays in Running while two subagents run; its chevron collapses them", async () => {
	const data = {
		...baseData(2),
		activity: {
			busy: [
				{ id: "app/one", title: "one", parentId: "app/parent", rolling: false },
				{ id: "app/two", title: "two", parentId: "app/parent", rolling: false },
			],
			otherBusy: 0,
			posts: [],
		},
	} as unknown as Parameters<typeof GoblinPanel>[0]["data"];
	root = createRoot(container);
	await act(async () => root?.render(
		<GoblinPanel
			data={data}
			conversations={[
				appConversation("parent"),
				appConversation("one", { parentId: "app/parent", busy: true }),
				appConversation("two", { parentId: "app/parent", busy: true }),
			]}
			notes={null}
			variant="column"
			onOpenTarget={() => {}}
			onOpenConversation={() => {}}
			onOpenPage={() => {}}
			onOpenNote={() => {}}
			onOpenProfile={() => {}}
		/>,
	));
	const parent = [...container.querySelectorAll(".activity-row-wrap")].find((row) =>
		row.querySelector(":scope > .activity-row-main strong")?.textContent === "parent",
	);
	const toggle = parent?.querySelector<HTMLButtonElement>(".activity-expand");
	expect(parent?.querySelector(".activity-detail")?.textContent).toBe("Waiting on 2 subagents");
	expect(toggle?.getAttribute("aria-expanded")).toBe("true");
	await act(async () => toggle?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event));
	expect(toggle?.getAttribute("aria-expanded")).toBe("false");
	expect(parent?.querySelector(".activity-subagents")?.hasAttribute("hidden")).toBe(true);
});

test("This chat lists busy then finished subagents and does not repeat its parent in Running", async () => {
	const data = {
		...baseData(1),
		activity: {
			busy: [{ id: "app/busy", title: "busy", parentId: "app/parent", rolling: false }],
			otherBusy: 0,
			posts: [],
		},
	} as unknown as Parameters<typeof GoblinPanel>[0]["data"];
	root = createRoot(container);
	await act(async () => root?.render(
		<GoblinPanel
			data={data}
			conversations={[
				appConversation("parent"),
				appConversation("finished", { parentId: "app/parent", updatedAt: "2026-11-22T00:00:00Z" }),
				appConversation("busy", { parentId: "app/parent", busy: true }),
			]}
			openConversationId="app/parent"
			notes={null}
			variant="column"
			onOpenTarget={() => {}}
			onOpenConversation={() => {}}
			onOpenPage={() => {}}
			onOpenNote={() => {}}
			onOpenProfile={() => {}}
		/>,
	));
	const headings = [...container.querySelectorAll(".goblin-panel-group")].map((heading) => heading.textContent);
	expect(headings).toEqual(["This chat"]);
	const rows = [...container.querySelectorAll(".activity-subagents strong")].map((label) => label.textContent);
	expect(rows).toEqual(["busy", "finished"]);
	expect(container.querySelector(".activity-subagents .mark-working")).not.toBeNull();
	expect(container.querySelector(".activity-subagents .mark-done")).not.toBeNull();
	expect([...container.querySelectorAll(".activity-row > strong")].map((label) => label.textContent))
		.toContain("parent");
	expect(container.querySelector(".goblin-panel-group")?.textContent).not.toBe("Running");
});

test("This chat opens a nested subagent; a null title uses its preview", async () => {
	const data = {
		...baseData(0),
		activity: { busy: [], otherBusy: 0, posts: [] },
	} as unknown as Parameters<typeof GoblinPanel>[0]["data"];
	const opened: string[] = [];
	root = createRoot(container);
	await act(async () => root?.render(
		<GoblinPanel
			data={data}
			conversations={[
				appConversation("parent"),
				appConversation("child", { parentId: "app/parent", title: null, preview: "A readable task name\nmore" }),
			]}
			openConversationId="app/parent"
			notes={null}
			variant="column"
			onOpenTarget={() => {}}
			onOpenConversation={(id) => opened.push(id)}
			onOpenPage={() => {}}
			onOpenNote={() => {}}
			onOpenProfile={() => {}}
		/>,
	));
	expect(container.querySelector(".activity-subagents strong")?.textContent).toBe("A readable task name more");
	await act(async () => container.querySelector(".activity-subagents .activity-row")?.dispatchEvent(
		new win.MouseEvent("click", { bubbles: true }) as unknown as Event,
	));
	expect(opened).toEqual(["app/child"]);
});

test("a busy Rolling chat turn shows in Activity and opens the Goblin chat", async () => {
	const data = {
		...baseData(1),
		activity: {
			busy: [{ id: "app/roll-2", title: null, parentId: null, rolling: true }],
			otherBusy: 0,
			posts: [],
		},
	} as unknown as Parameters<typeof GoblinPanel>[0]["data"];
	const pages: string[] = [];
	const conversations: string[] = [];
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<GoblinPanel
				data={data}
				notes={null}
				variant="column"
				onOpenTarget={() => {}}
				onOpenConversation={(id) => conversations.push(id)}
				onOpenPage={(page) => pages.push(page)}
				onOpenNote={() => {}}
				onOpenProfile={() => {}}
			/>,
		),
	);
	const row = [...container.querySelectorAll("button.goblin-panel-row")].find((el) =>
			el.querySelector("strong")?.textContent === "Little Goblin",
	);
	expect(row).toBeDefined();
	await act(async () =>
		row?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event),
	);
	expect(pages).toEqual(["rolling"]);
	expect(conversations).toEqual([]);
});

test("posts show in Activity by time beside finished work and open their chat", async () => {
	const data = {
		...baseData(0),
		activity: {
			busy: [],
			otherBusy: 0,
			posts: [
				{ id: 3, text: "Backup finished.\nAll disks OK.", createdAt: "2026-11-21T03:00:00Z", conversation: { id: "app/nightly", rolling: false } },
				{ id: 2, text: "Morning summary is ready.", createdAt: "2026-11-20T12:00:00Z", conversation: { id: "app/roll-1", rolling: true } },
				{ id: 1, text: "From Telegram.", createdAt: "2026-11-19T12:00:00Z", conversation: null },
			],
		},
		delegations: [
			{ id: 9, name: "old-task", harness: "pi", task: "Old task", status: "done", createdAt: "2026-11-20T00:00:00Z", finishedAt: "2026-11-21T01:00:00Z", appConversation: null },
		],
	} as unknown as Parameters<typeof GoblinPanel>[0]["data"];
	const pages: string[] = [];
	const conversations: string[] = [];
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<GoblinPanel
				data={data}
				notes={null}
				variant="column"
				onOpenTarget={() => {}}
				onOpenConversation={(id) => conversations.push(id)}
				onOpenPage={(page) => pages.push(page)}
				onOpenNote={() => {}}
				onOpenProfile={() => {}}
			/>,
		),
	);
	const rows = [...container.querySelectorAll(".goblin-panel-row")];
	expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual([
		"Backup finished.\nAll disks OK.",
		"old-task",
		"Morning summary is ready.",
		"From Telegram.",
	]);
	const posts = [...container.querySelectorAll(".goblin-panel-post")];
	expect(posts.map((row) => row.tagName)).toEqual(["BUTTON", "BUTTON", "DIV"]);
	expect(posts[0]?.querySelector(".activity-detail")?.textContent).toBe("Post");
	for (const row of posts.slice(0, 2)) {
		await act(async () => row.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event));
	}
	expect(conversations).toEqual(["app/nightly"]);
	expect(pages).toEqual(["rolling"]);
	expect(container.textContent).not.toContain("Nothing running.");
});

test("Activity offers See all only when rows are hidden, and it opens the activity page", async () => {
	const posts = (n: number) =>
		Array.from({ length: n }, (_, i) => ({
			id: n - i, text: `Post ${n - i}`, createdAt: new Date(Date.UTC(2026, 10, 21, 0, n - i)).toISOString(), conversation: null,
		}));
	const render = async (count: number, onOpenPage: (page: string) => void = () => {}) => {
		const data = { ...baseData(0), activity: { busy: [], otherBusy: 0, posts: posts(count) } } as unknown as Parameters<typeof GoblinPanel>[0]["data"];
		root ??= createRoot(container);
		await act(async () => root?.render(<GoblinPanel data={data} notes={null} variant="column" onOpenTarget={() => {}} onOpenConversation={() => {}} onOpenPage={onOpenPage} onOpenNote={() => {}} onOpenProfile={() => {}} />));
	};
	const seeAll = () => [...container.querySelectorAll("button.goblin-panel-footer")].find((el) => el.textContent === "See all");
	await render(8);
	expect(container.querySelectorAll(".goblin-panel-post")).toHaveLength(8);
	expect(seeAll()).toBeUndefined();
	const pages: string[] = [];
	await render(9, (page) => pages.push(page));
	expect(container.querySelectorAll(".goblin-panel-post")).toHaveLength(8);
	await act(async () => seeAll()?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event));
	expect(pages).toEqual(["activity"]);
});

test("delegation rows use their name and never show the brief", async () => {
	const task = `first line\n${"long brief ".repeat(500)}`;
	const data = {
		...baseData(0),
		delegations: [{ id: 41, name: "fix-sheet", harness: "codex", task, status: "running", createdAt: new Date().toISOString(), appConversation: null }],
	} as unknown as Parameters<typeof GoblinPanel>[0]["data"];
	root = createRoot(container);
	await act(async () => root?.render(<GoblinPanel data={data} notes={null} variant="column" onOpenTarget={() => {}} onOpenConversation={() => {}} onOpenPage={() => {}} onOpenNote={() => {}} onOpenProfile={() => {}} />));
	const row = container.querySelector(".activity-row");
	expect(row?.querySelector("strong")?.textContent).toBe("fix-sheet");
	expect(container.textContent).not.toContain("first line");
	expect(container.textContent).not.toContain("long brief");
});

test("activity marks statuses and shows status words", async () => {
	const now = Date.now();
	const delegations = [
		{ id: 1, name: "running-job", harness: "codex", task: "secret", status: "running", createdAt: new Date(now).toISOString(), appConversation: null },
		{ id: 2, name: "needs-job", harness: "codex", task: "secret", status: "needs_input", createdAt: new Date(now - 1000).toISOString(), appConversation: null },
		{ id: 3, name: "failed-job", harness: "pi", task: "secret", status: "failed", createdAt: new Date(now - 2000).toISOString(), finishedAt: new Date(now - 2000).toISOString(), appConversation: null },
		{ id: 4, name: "done-job", harness: "pi", task: "secret", status: "done", createdAt: new Date(now - 3000).toISOString(), finishedAt: new Date(now - 3000).toISOString(), appConversation: null },
		{ id: 5, name: "stopped-job", harness: "pi", task: "secret", status: "stopped", createdAt: new Date(now - 4000).toISOString(), finishedAt: new Date(now - 4000).toISOString(), appConversation: null },
	];
	const data = { ...baseData(0), delegations } as unknown as Parameters<typeof GoblinPanel>[0]["data"];
	root = createRoot(container);
	await act(async () => root?.render(<GoblinPanel data={data} notes={null} variant="column" onOpenTarget={() => {}} onOpenConversation={() => {}} onOpenPage={() => {}} onOpenNote={() => {}} onOpenProfile={() => {}} />));
	const row = (name: string) => [...container.querySelectorAll(".activity-row")].find((el) => el.querySelector("strong")?.textContent === name);
	expect(row("running-job")?.querySelector(".mark-working")).toBeTruthy();
	expect(row("needs-job")?.querySelector(".mark-needs")).toBeTruthy();
	expect(row("needs-job")?.querySelector(".activity-detail")?.textContent).toBe("codex · needs input");
	expect(row("failed-job")?.querySelector(".mark-failed")).toBeTruthy();
	expect(row("failed-job")?.classList.contains("activity-failed")).toBe(true);
	expect(row("failed-job")?.querySelector(".activity-detail")?.textContent).toBe("pi · failed");
	for (const name of ["done-job", "stopped-job"]) {
		expect(row(name)?.querySelector(".mark-quiet")).toBeTruthy();
		expect(row(name)?.classList.contains("activity-failed")).toBe(false);
	}
});

test("activity shows short times and program rows open Programs", async () => {
	const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
	const old = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
	const oldIso = old.toISOString();
	const data = {
		...baseData(0),
		activity: { busy: [{ id: "chat", title: null, parentId: null, rolling: true }], otherBusy: 0, posts: [] },
		programs: [{ id: 1, name: "nightly backup", enabled: true, cron: "0 1 * * *", hasHook: false, maxLatenessMinutes: null, mailFilter: null, target: "default", chatId: 1, threadId: null, createdAt: new Date().toISOString(), nextRun: null, lastRun: twoHoursAgo, lastSkippedAt: null, lastSkipReason: null }],
		delegations: [{ id: 2, name: "older", harness: "pi", task: "secret", status: "done", createdAt: oldIso, finishedAt: oldIso, appConversation: null }],
	} as unknown as Parameters<typeof GoblinPanel>[0]["data"];
	const pages: string[] = [];
	root = createRoot(container);
	await act(async () => root?.render(<GoblinPanel data={data} notes={null} variant="column" onOpenTarget={() => {}} onOpenConversation={() => {}} onOpenPage={(page) => pages.push(page)} onOpenNote={() => {}} onOpenProfile={() => {}} />));
	const rows = [...container.querySelectorAll(".activity-row")];
	const rolling = rows.find((el) => el.querySelector("strong")?.textContent === "Little Goblin");
	const program = rows.find((el) => el.querySelector("strong")?.textContent === "nightly backup");
	const older = rows.find((el) => el.querySelector("strong")?.textContent === "older");
	expect(rolling?.querySelector(".activity-time")?.textContent).toBe("now");
	expect(program?.querySelector(".activity-time")?.textContent).toBe("2h");
	expect(older?.querySelector(".activity-time")?.textContent).toBe(old.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
	expect(older?.querySelector(".activity-time")?.textContent).not.toContain(":");
	await act(async () => program?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event));
	expect(pages).toEqual(["programs"]);
});

test("panel activity headings omit empty groups", async () => {
	const data = { ...baseData(0), delegations: [{ id: 1, name: "done", harness: "pi", task: "brief", status: "done", createdAt: "2020-01-01T00:00:00Z", finishedAt: "2020-01-01T00:00:00Z", appConversation: null }] } as unknown as Parameters<typeof GoblinPanel>[0]["data"];
	root = createRoot(container);
	await act(async () => root?.render(<GoblinPanel data={data} notes={null} variant="column" onOpenTarget={() => {}} onOpenConversation={() => {}} onOpenPage={() => {}} onOpenNote={() => {}} onOpenProfile={() => {}} />));
	expect([...container.querySelectorAll(".goblin-panel-group")].map((el) => el.textContent)).toEqual(["Earlier"]);
	await act(async () => root?.render(<GoblinPanel data={baseData(0)} notes={null} variant="column" onOpenTarget={() => {}} onOpenConversation={() => {}} onOpenPage={() => {}} onOpenNote={() => {}} onOpenProfile={() => {}} />));
	expect(container.querySelectorAll(".goblin-panel-group")).toHaveLength(0);
});

test("activity time is an age for a day, then a date", () => {
	const now = Date.parse("2026-11-21T18:00:00Z");
	const ago = (ms: number) => activityTime(new Date(now - ms).toISOString(), now);
	const day = 24 * 60 * 60 * 1000;
	expect(ago(30_000)).toBe("now");
	expect(ago(5 * 60_000)).toBe("5m");
	expect(ago(day - 1000)).toBe("23h");
	expect(ago(day)).toBe(new Date(now - day).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
	expect(activityTime("not a date", now)).toBe("");
});

async function mountActivity(
	busy: Array<{ id: string; parentId: string | null }>,
	conversations: AppConversationListItem[],
	openConversationId: string | null = null,
) {
	const data = {
		...baseData(busy.length),
		activity: {
			busy: busy.map((row) => ({ ...row, title: row.id.replace("app/", ""), rolling: false })),
			otherBusy: 0,
			posts: [],
		},
	} as unknown as Parameters<typeof GoblinPanel>[0]["data"];
	root = createRoot(container);
	const noop = () => {};
	await act(async () => root?.render(
		<GoblinPanel
			data={data}
			conversations={conversations}
			openConversationId={openConversationId}
			notes={null}
			variant="column"
			onOpenTarget={noop}
			onOpenConversation={noop}
			onOpenPage={noop}
			onOpenNote={noop}
			onOpenProfile={noop}
		/>,
	));
}

test("Running nests only the parent's running subagents", async () => {
	await mountActivity(
		[{ id: "app/busy", parentId: "app/parent" }],
		[
			appConversation("parent"),
			appConversation("finished", { parentId: "app/parent" }),
			appConversation("busy", { parentId: "app/parent", busy: true }),
		],
	);
	expect([...container.querySelectorAll(".activity-subagents strong")].map((label) => label.textContent))
		.toEqual(["busy"]);
});

test("an open busy chat without subagents stays in Running", async () => {
	await mountActivity([{ id: "app/parent", parentId: null }], [appConversation("parent", { busy: true })], "app/parent");
	expect([...container.querySelectorAll(".goblin-panel-group")].map((heading) => heading.textContent))
		.toContain("Running");
	expect([...container.querySelectorAll(".activity-row > strong")].map((label) => label.textContent))
		.toContain("parent");
});

test("This chat keeps the working mark of a busy parent", async () => {
	await mountActivity(
		[{ id: "app/parent", parentId: null }],
		[appConversation("parent", { busy: true }), appConversation("child", { parentId: "app/parent" })],
		"app/parent",
	);
	const parent = container.querySelector(".activity-row-wrap > .activity-row-main > .activity-row");
	expect(parent?.querySelector("strong")?.textContent).toBe("parent");
	expect(parent?.querySelector(".mark-working")).not.toBeNull();
	expect(parent?.querySelector(".activity-detail")?.textContent).toBe("Replying");
});

test("an untitled parent reads as its preview, not Untitled", async () => {
	await mountActivity(
		[{ id: "app/child", parentId: "app/parent" }],
		[
			appConversation("parent", { title: null, preview: "Plan the launch\nsoon" }),
			appConversation("child", { parentId: "app/parent", busy: true }),
		],
	);
	const labels = [...container.querySelectorAll(".activity-row > strong")].map((label) => label.textContent);
	expect(labels).toContain("Plan the launch soon");
	expect(labels).not.toContain("Untitled");
});

import { expect, test } from "bun:test";
import type { AppAttentionItem, AppConversationList } from "../../src/http/app-wire.ts";
import { buildHome, type HomeInput } from "./homeList.ts";

type Conv = AppConversationList["conversations"][number];

const time = (day: number) => `2026-01-${String(day).padStart(2, "0")}T00:00:00Z`;
const conv = (id: string, fields: Partial<Conv> = {}): Conv => ({
	id: `app/${id}`,
	title: id,
	createdAt: time(1),
	updatedAt: time(1),
	preview: `${id} reply`,
	archivedAt: null,
	pinnedAt: null,
	projectId: null,
	parentId: null,
	newReply: null,
	busy: false,
	...fields,
});
const base = (conversations: Conv[], extra: Partial<HomeInput> = {}): HomeInput => ({
	conversations,
	chain: [],
	projects: [],
	attention: [],
	delegations: [],
	open: null,
	seen: null,
	sideChatsOpen: false,
	...extra,
});
const item = (
	conversationId: string | null,
	title: string,
	kind: AppAttentionItem["kind"] = "program-approval",
	createdAt: string | null = time(2),
): AppAttentionItem => ({
	id: `${title}:${conversationId}`,
	kind,
	title,
	detail: `${title} detail`,
	createdAt,
	conversationId,
	target: { kind: "page", page: "programs" },
});
const chatRows = (input: HomeInput) => buildHome(input, null).list;

test("T1: sections stay ordered, pinned chats lead, archived and unpinned project chats stay out", () => {
	const list = chatRows(base([
		conv("server-first"),
		conv("pinned", { pinnedAt: time(1) }),
		conv("project-hidden", { projectId: "garden" }),
		conv("archived", { archivedAt: time(2) }),
		conv("server-last"),
	], {
		projects: [{ id: "garden", name: "Garden", archivedAt: null }],
	}));

	expect(list.active).toEqual([]);
	expect(list.side.map((row) => row.id)).toEqual([
		"app/pinned",
		"app/server-first",
		"app/server-last",
	]);
	expect(list.side[1]?.conv.id).toBe("app/server-first");
});

test("ask attention marks a chat or its owning roll, while ui choices do not mark it", () => {
	const ask = { ...item("app/chat", "Asks: q", "ask"), detail: "Waiting for your answer", target: { kind: "conversation" as const, conversationId: "app/chat" } };
	const chat = chatRows(base([conv("chat")], { attention: [ask] }));
	expect(chat.side.find((row) => row.id === "app/chat")).toMatchObject({ mark: "needs", line: "Asks: q" });
	const oldRoll = conv("roll-old");
	const newRoll = conv("roll-new");
	const rolledAsk = { ...ask, conversationId: oldRoll.id, target: { kind: "conversation" as const, conversationId: oldRoll.id } };
	const roll = chatRows(base([], { chain: [newRoll, oldRoll], attention: [rolledAsk] }));
	expect(roll.rolling).toMatchObject({ mark: "needs", line: "Asks: q", target: oldRoll.id });
	const uiOnly = chatRows(base([conv("ui", { newReply: null })]));
	expect(uiOnly.side.find((row) => row.id === "app/ui")?.mark).toBeNull();
});

test("T2: side chats sort by needs, new, working, then newest within each mark", () => {
	const list = chatRows(base([
		conv("work-old", { busy: true, updatedAt: time(2) }),
		conv("new-old", { newReply: 4, updatedAt: time(2) }),
		conv("need-old", { updatedAt: time(2) }),
		conv("work-new", { busy: true, updatedAt: time(9) }),
		conv("new-new", { newReply: 5, updatedAt: time(9) }),
		conv("need-new", { updatedAt: time(9) }),
	], {
		attention: [item("app/need-old", "old need"), item("app/need-new", "new need")],
	}));

	expect(list.side.map((row) => row.id)).toEqual([
		"app/need-new",
		"app/need-old",
		"app/new-new",
		"app/new-old",
		"app/work-new",
		"app/work-old",
	]);
});

test("T3: a side chat stays a side chat with or without a mark", () => {
	const active = chatRows(base([conv("one", { newReply: 1 })]));
	const chats = chatRows(base([conv("one")]));

	expect(active.active).toEqual([]);
	expect(chats.active).toEqual([]);
	expect(chats.side.map((row) => row.id)).toEqual(["app/one"]);
});

test("T4: a pinned side chat appears once, marked or not, and never in Active", () => {
	const marked = chatRows(base([conv("one", { pinnedAt: time(1), newReply: 3 })]));
	const clear = chatRows(base([conv("one", { pinnedAt: time(1) })]));

	expect(marked.active).toEqual([]);
	expect(marked.side.map((row) => row.id)).toEqual(["app/one"]);
	expect(clear.side.map((row) => row.id)).toEqual(["app/one"]);
});

test("T5: project placement, names, pins, and archived-project eligibility stay distinct", () => {
	const conversations = [
		conv("marked", { projectId: "active", newReply: 1 }),
		conv("hidden", { projectId: "active" }),
		conv("pinned", { projectId: "active", pinnedAt: time(1) }),
		conv("archived-project-pin", { projectId: "archived", pinnedAt: time(1) }),
	];
	const projects = [
		{ id: "active", name: "Garden", archivedAt: null },
		{ id: "archived", name: "Old Garden", archivedAt: time(8) },
	];
	const list = chatRows(base(conversations, { projects }));

	expect(list.active.map((row) => row.id)).toEqual(["app/marked"]);
	expect(list.active[0]?.kind === "chat" && list.active[0].projectName).toBe("Garden");
	expect(list.side.map((row) => row.id)).toEqual([]);
	expect(list.active.map((row) => row.id)).toEqual(["app/marked"]);
	expect(list.side.some((row) => row.id === "app/archived-project-pin")).toBe(false);

	const archivedProjectMarked = chatRows(base([
		conv("archived-project-pin", { projectId: "archived", pinnedAt: time(1), newReply: 5 }),
	], { projects }));
	expect(archivedProjectMarked.active[0]?.kind === "chat" &&
		archivedProjectMarked.active[0].projectName).toBe("Old Garden");
});

test("T6: needs wins over busy and new, stays open, and uses the newest item title", () => {
	const list = chatRows(base([conv("one", { busy: true, newReply: 5 })], {
		open: "app/one",
		seen: "app/one",
		attention: [
			item("app/one", "Older", "program-approval", time(1)),
			item("app/one", "Newest", "delegation-input", time(7)),
		],
	}));
	const row = list.side[0];

	expect(row?.kind).toBe("chat");
	expect(row?.mark).toBe("needs");
	expect(row?.line).toBe("Newest");
});

test("T7: null, unknown, archived, and delegation questions are loose; memory items are not", () => {
	const list = chatRows(base([
		conv("archived", { archivedAt: time(8) }),
	], {
		attention: [
			item(null, "No chat"),
			item("app/unknown", "Unknown chat"),
			item("app/archived", "Archived chat"),
			item(null, "Delegation question", "delegation-input"),
			item(null, "Blocked memory", "memory-blocked"),
			item(null, "Memory outage", "memory-outage"),
			item(null, "Memory recall", "memory-recall"),
		],
	}));

	expect(list.active.map((row) => row.kind)).toEqual(["loose", "loose", "loose", "loose"]);
	expect(list.active.map((row) => row.kind === "loose" ? row.item.title : "")).toEqual([
		"No chat",
		"Unknown chat",
		"Archived chat",
		"Delegation question",
	]);
});

test("T8: own work, descendant work, delegation states, and reply precedence are correct", () => {
	const chats = [
		conv("own", { busy: true }),
		conv("kid-root"),
		conv("kid", { parentId: "app/kid-root", busy: true }),
		conv("grand-root"),
		conv("grand", { parentId: "app/grand-root" }),
		conv("grandkid", { parentId: "app/grand", busy: true }),
		conv("delegated"),
		conv("delegated-kid-root"),
		conv("delegated-kid", { parentId: "app/delegated-kid-root" }),
		conv("settled"),
		conv("needs-input"),
		conv("new-over-kid", { newReply: 7 }),
		conv("working-over-new", { busy: true, newReply: 8 }),
	];
	const list = chatRows(base(chats, {
		delegations: [
			{ appConversation: "app/delegated", status: "running" },
			{ appConversation: "app/delegated-kid", status: "starting" },
			{ appConversation: "app/settled", status: "settled" },
			{ appConversation: "app/needs-input", status: "needs_input" },
		],
	}));
	const byId = new Map(list.side.map((row) => [row.id, row]));

	expect(byId.get("app/own")?.mark).toBe("working");
	expect(byId.get("app/kid-root")?.mark).toBe("working");
	expect(byId.get("app/grand-root")?.mark).toBe("working");
	expect(byId.get("app/delegated")?.mark).toBe("working");
	expect(byId.get("app/delegated-kid-root")?.mark).toBe("working");
	expect(byId.get("app/settled")?.mark).toBeNull();
	expect(byId.get("app/needs-input")?.mark).toBeNull();
	expect(byId.get("app/new-over-kid")?.mark).toBe("new");
	expect(byId.get("app/working-over-new")?.mark).toBe("working");
});

test("T9: an open, seen new reply keeps its raw side place until the operator leaves", () => {
	const openAndSeen = { open: "app/one", seen: "app/one" };
	const first = buildHome(base([conv("one", { newReply: 3 })], openAndSeen), null);
	const afterRead = buildHome(base([
		conv("one"),
		conv("newer", { newReply: 9, updatedAt: time(9) }),
	], openAndSeen), first.hold);
	const left = buildHome(base([conv("one")]), afterRead.hold);

	expect(first.list.side[0]?.id).toBe("app/one");
	expect(first.list.side[0]?.mark).toBeNull();
	expect(first.hold?.place.section).toBe("side");
	expect(afterRead.hold).toBe(first.hold);
	expect(afterRead.list.side.map((row) => row.id)).toContain("app/one");
	expect(left.hold).toBeNull();
	expect(left.list.side.map((row) => row.id)).toContain("app/one");
});

test("T10: an open side chat holds its place, while an unplaced project chat takes its first mark", () => {
	const chats = [conv("plain")];
	const first = buildHome(base(chats, { open: "app/plain", seen: "app/plain" }), null);
	const marked = buildHome(base([conv("plain", { newReply: 1 })], {
		open: "app/plain",
		seen: "app/plain",
	}), first.hold);
	const projectFirst = buildHome(base([conv("project", { projectId: "p" })], {
		projects: [{ id: "p", name: "P", archivedAt: null }],
		open: "app/project",
		seen: "app/project",
	}), null);
	const projectMarked = buildHome(base([conv("project", { projectId: "p", newReply: 2 })], {
		projects: [{ id: "p", name: "P", archivedAt: null }],
		open: "app/project",
		seen: "app/project",
	}), projectFirst.hold);
	const moved = buildHome(base([
		conv("project", { projectId: "p", newReply: 2 }),
		conv("other"),
	], {
		projects: [{ id: "p", name: "P", archivedAt: null }],
		open: "app/other",
		seen: "app/other",
	}), projectMarked.hold);

	expect(marked.list.side.map((row) => row.id)).toContain("app/plain");
	expect(projectFirst.hold).toBeNull();
	expect(projectMarked.hold?.place.section).toBe("active");
	expect(projectMarked.list.active.map((row) => row.id)).toContain("app/project");
	expect(moved.hold?.id).toBe("app/other");
});

test("T11: pin and project changes invalidate a side hold; archived chats disappear; kid holds parent", () => {
	const start = buildHome(base([conv("one")], { open: "app/one", seen: "app/one" }), null);
	const pinned = buildHome(base([conv("one", { pinnedAt: time(2) })], {
		open: "app/one",
		seen: "app/one",
	}), start.hold);
	const movedToProject = buildHome(base([conv("one", { projectId: "p" })], {
		projects: [{ id: "p", name: "P", archivedAt: null }],
		open: "app/one",
		seen: "app/one",
	}), start.hold);
	const archived = buildHome(base([conv("one", { archivedAt: time(8) })], {
		open: "app/one",
		seen: "app/one",
	}), start.hold);
	const parent = buildHome(base([
		conv("parent"),
		conv("kid", { parentId: "app/parent" }),
	], { open: "app/kid", seen: "app/kid" }), null);
	const stable = buildHome(base([conv("one")], { open: "app/one", seen: "app/one" }), start.hold);

	expect(pinned.list.side[0]?.conv.pinnedAt).not.toBeNull();
	expect(movedToProject.list.side).toEqual([]);
	expect(archived.list.active).toEqual([]);
	expect(parent.hold?.id).toBe("app/parent");
	expect(stable.hold).toBe(start.hold);
});

test("T-B1: side chats stay out of Active and sort marks before pinned and unmarked rows", () => {
	const list = chatRows(base([
		conv("plain-old", { updatedAt: time(1) }),
		conv("pinned", { pinnedAt: time(1), updatedAt: time(1) }),
		conv("new-old", { newReply: 1, updatedAt: time(2) }),
		conv("new-latest", { newReply: 2, updatedAt: time(9) }),
		conv("needs", { updatedAt: time(1) }),
		conv("working", { busy: true }),
	], { attention: [item("app/needs", "Needs input")] }));
	expect(list.active).toEqual([]);
	expect(list.side.map((row) => row.id)).toEqual([
		"app/needs", "app/new-latest", "app/new-old", "app/working",
		"app/pinned", "app/plain-old",
	]);
});

test("T-B2: project marks stay Active and an unmarked project pin is omitted", () => {
	const list = chatRows(base([
		conv("marked", { projectId: "p", newReply: 1 }),
		conv("pinned", { projectId: "p", pinnedAt: time(1) }),
	], { projects: [{ id: "p", name: "Project", archivedAt: null }] }));
	expect(list.active.map((row) => row.id)).toEqual(["app/marked"]);
	expect(list.side).toEqual([]);
});

test("T-B3: closed Little Goblin folds urgent side marks; open keeps roll mark only", () => {
	const sideNeeds = conv("needs", { title: "Need chat" });
	const sideNew = conv("new", { title: "Reply chat", newReply: 2 });
	const roll = conv("roll", { newReply: 1 });
	const attention = [item(sideNeeds.id, "Approve this")];
	const closed = chatRows(base([sideNeeds, sideNew], {
		chain: [roll], attention,
	}));
	expect(closed.rolling).toMatchObject({ mark: "needs", line: "Approve this" });
	const newClosed = chatRows(base([sideNew], { chain: [conv("roll")] }));
	expect(newClosed.rolling).toMatchObject({ mark: "new", line: "New reply in Reply chat" });
	const open = chatRows(base([sideNeeds, sideNew], {
		chain: [roll], attention, sideChatsOpen: true,
	}));
	expect(open.rolling).toMatchObject({ mark: "new", line: "roll reply" });
});

test("T-B4: open Goblin context includes rolls and loose chats, not project chats", () => {
	const roll = conv("roll");
	const rollKid = conv("roll-kid", { parentId: roll.id });
	const side = conv("side");
	const sideKid = conv("side-kid", { parentId: side.id });
	const project = conv("project", { projectId: "p" });
	const make = (open: string | null, conversations: Conv[], chain: Conv[] = []) =>
		chatRows(base(conversations, { open, chain, projects: [{ id: "p", name: "P", archivedAt: null }] })).openInGoblin;
	expect(make(roll.id, [roll], [roll])).toBe(true);
	expect(make(rollKid.id, [roll, rollKid], [roll])).toBe(true);
	expect(make(side.id, [side])).toBe(true);
	expect(make(sideKid.id, [side, sideKid])).toBe(true);
	expect(make(project.id, [project])).toBe(false);
	expect(make(null, [])).toBe(false);
});

test("subagents never have rows, including pinned, orphaned, and archived-parent children", () => {
	const list = chatRows(base([
		conv("root"),
		conv("child", { parentId: "app/root" }),
		conv("pinned", { parentId: "app/root", pinnedAt: time(1) }),
		conv("orphan", { parentId: "app/missing" }),
		conv("archived-parent", { archivedAt: time(9) }),
		conv("archived-child", { parentId: "app/archived-parent" }),
	]));
	const rows = [...list.active, ...list.side];
	expect(rows.map((row) => row.id)).toEqual(["app/root"]);
	expect(rows.find((row) => row.id === "app/root")).not.toHaveProperty("kids");
});

test("a busy subagent marks its parent working without getting a row", () => {
	const list = chatRows(base([
		conv("parent"),
		conv("child", { parentId: "app/parent", busy: true }),
	]));
	expect(list.side.map((row) => [row.id, row.mark]))
		.toEqual([["app/parent", "working"]]);
});

test("a subagent question marks the parent needs", () => {
	const list = chatRows(base([
		conv("parent"),
		conv("child", { parentId: "app/parent" }),
	], { attention: [item("app/child", "Child question")] }));
	expect(list.side.map((row) => [row.id, row.mark]))
		.toEqual([["app/parent", "needs"]]);
});

test("subagents of a roll never show in the Rolling row; busy still marks Rolling working", () => {
	const rollNew = conv("roll-new", { updatedAt: time(1) });
	const list = chatRows(base([
		conv("child", { parentId: rollNew.id, busy: true }),
	], { chain: [rollNew] }));
	expect(list.active).toEqual([]);
	expect(list.side).toEqual([]);
	expect(list.rolling.mark).toBe("working");
	expect(list.rolling).not.toHaveProperty("kids");
});

test("T13: needs outranks work and unread reply; running and needs-input delegations differ", () => {
	const roll = conv("roll", { busy: true, newReply: 1 });
	const list = chatRows(base([
		conv("needs-kid", { parentId: roll.id }),
		conv("delegated-kid", { parentId: roll.id }),
		conv("input-kid", { parentId: roll.id }),
	], {
		chain: [roll],
		attention: [item("app/needs-kid", "Question")],
		delegations: [
			{ appConversation: "app/delegated-kid", status: "running" },
			{ appConversation: "app/input-kid", status: "needs_input" },
		],
	}));

	expect(list.rolling.mark).toBe("needs");
});

test("T13: the rolling line is the question, then Working, then the newest roll's preview", () => {
	const newest = conv("newest", { title: null, preview: "newest words" });
	const older = conv("older", { preview: "older words" });
	const line = (chain: Conv[], attention: AppAttentionItem[] = []) =>
		chatRows(base([], { chain, attention })).rolling.line;

	expect(line([newest, older])).toBe("newest words");
	expect(line([newest, { ...older, newReply: 3 }])).toBe("newest words");
	expect(line([newest, { ...older, busy: true }])).toBe("Working");
	expect(line([newest, { ...older, busy: true }], [item("app/older", "Old question")]))
		.toBe("Old question");
});

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
	openRoll: null,
	seen: null,
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
	expect(list.chats.map((row) => row.id)).toEqual([
		"app/pinned",
		"app/server-first",
		"app/server-last",
	]);
	expect(list.chats[1]?.conv.id).toBe("app/server-first");
});

test("ask attention marks a chat or its owning roll, while ui choices do not mark it", () => {
	const ask = { ...item("app/chat", "Asks: q", "ask"), detail: "Waiting for your answer", target: { kind: "conversation" as const, conversationId: "app/chat" } };
	const chat = chatRows(base([conv("chat")], { attention: [ask] }));
	expect(chat.active.find((row) => row.kind === "chat" && row.id === "app/chat")).toMatchObject({ mark: "needs", line: "Asks: q" });
	const oldRoll = conv("roll-old");
	const newRoll = conv("roll-new");
	const rolledAsk = { ...ask, conversationId: oldRoll.id, target: { kind: "conversation" as const, conversationId: oldRoll.id } };
	const roll = chatRows(base([], { chain: [newRoll, oldRoll], attention: [rolledAsk] }));
	expect(roll.rolling).toMatchObject({ mark: "needs", line: "Asks: q", target: oldRoll.id });
	const uiOnly = chatRows(base([conv("ui", { newReply: null })]));
	expect(uiOnly.chats.find((row) => row.id === "app/ui")?.mark).toBeNull();
});

test("T2: Active sorts by needs, new, working, then newest within each mark", () => {
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

	expect(list.active.map((row) => row.id)).toEqual([
		"app/need-new",
		"app/need-old",
		"app/new-new",
		"app/new-old",
		"app/work-new",
		"app/work-old",
	]);
});

test("T3: the last mark going away returns the chat to Chats", () => {
	const active = chatRows(base([conv("one", { newReply: 1 })]));
	const chats = chatRows(base([conv("one")]));

	expect(active.active.map((row) => row.id)).toEqual(["app/one"]);
	expect(chats.active).toEqual([]);
	expect(chats.chats.map((row) => row.id)).toEqual(["app/one"]);
});

test("T4: a pinned chat with a mark appears once in Active and returns to pinned Chats", () => {
	const marked = chatRows(base([conv("one", { pinnedAt: time(1), newReply: 3 })]));
	const clear = chatRows(base([conv("one", { pinnedAt: time(1) })]));

	expect(marked.active.map((row) => row.id)).toEqual(["app/one"]);
	expect(marked.chats).toEqual([]);
	expect(clear.chats.map((row) => row.id)).toEqual(["app/one"]);
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
	expect(list.chats.map((row) => row.id)).toEqual(["app/pinned"]);
	expect(list.chats[0]?.projectName).toBe("Garden");
	expect(list.chats.some((row) => row.id === "app/archived-project-pin")).toBe(false);

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
	const row = list.active[0];

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
	const byId = new Map(list.active.map((row) => [row.id, row]));

	expect(byId.get("app/own")?.mark).toBe("working");
	expect(byId.get("app/kid-root")?.mark).toBe("working");
	expect(byId.get("app/grand-root")?.mark).toBe("working");
	expect(byId.get("app/delegated")?.mark).toBe("working");
	expect(byId.get("app/delegated-kid-root")?.mark).toBe("working");
	expect(byId.get("app/settled")).toBeUndefined();
	expect(byId.get("app/needs-input")).toBeUndefined();
	expect(byId.get("app/new-over-kid")?.mark).toBe("new");
	expect(byId.get("app/working-over-new")?.mark).toBe("working");
});

test("T9: an open, seen new reply keeps its raw Active place until the operator leaves", () => {
	const openAndSeen = { open: "app/one", seen: "app/one" };
	const first = buildHome(base([conv("one", { newReply: 3 })], openAndSeen), null);
	const afterRead = buildHome(base([
		conv("one"),
		conv("newer", { newReply: 9, updatedAt: time(9) }),
	], openAndSeen), first.hold);
	const left = buildHome(base([conv("one")]), afterRead.hold);

	expect(first.list.active[0]?.id).toBe("app/one");
	expect(first.list.active[0]?.mark).toBeNull();
	expect(first.hold?.place.section).toBe("active");
	expect(afterRead.hold).toBe(first.hold);
	expect(afterRead.list.active.map((row) => row.id)).toContain("app/one");
	expect(left.hold).toBeNull();
	expect(left.list.chats.map((row) => row.id)).toContain("app/one");
});

test("T10: an open chat holds Chats, while an unplaced project chat takes its first mark", () => {
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

	expect(marked.list.chats.map((row) => row.id)).toContain("app/plain");
	expect(projectFirst.hold).toBeNull();
	expect(projectMarked.hold?.place.section).toBe("active");
	expect(projectMarked.list.active.map((row) => row.id)).toContain("app/project");
	expect(moved.hold?.id).toBe("app/other");
});

test("T11: pin and project changes invalidate a Chats hold; archived chats disappear; kid holds parent", () => {
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

	expect(pinned.list.chats[0]?.conv.pinnedAt).not.toBeNull();
	expect(movedToProject.list.chats).toEqual([]);
	expect(archived.list.active).toEqual([]);
	expect(parent.hold?.id).toBe("app/parent");
	expect(stable.hold).toBe(start.hold);
});

test("T12: kids flatten in spawn order and folds show for each reason", () => {
	const list = chatRows(base([
		conv("root"),
		conv("later", { parentId: "app/root", createdAt: time(4) }),
		conv("first", { parentId: "app/root", createdAt: time(2) }),
		conv("grand", { parentId: "app/later", createdAt: time(3) }),
	]));
	const root = list.chats.find((row) => row.id === "app/root");
	expect(root?.kids.map((kid) => kid.id)).toEqual(["app/first", "app/grand", "app/later"]);
	expect(root?.showKids).toBe(false);

	for (const [reason, changes] of [
		["kid works", { kid: { busy: true } }],
		["kid needs", { attention: [item("app/first", "Need")] }],
		["parent open", { open: "app/root" }],
		["kid open", { open: "app/first" }],
	] as const) {
		const current = chatRows(base([
			conv("root"),
			conv("first", { parentId: "app/root", ...changes.kid }),
		], changes.attention ? { attention: changes.attention } : { open: changes.open ?? null }));
		const row = [...current.active, ...current.chats].find((entry) => entry.id === "app/root");
		expect(row?.kind === "chat" && row.showKids, reason).toBe(true);
	}
});

test("T12: pinned kids, orphans, archived parents, and cycles keep every chat", () => {
	const list = chatRows(base([
		conv("root"),
		conv("pinned", { parentId: "app/root", pinnedAt: time(1) }),
		conv("orphan", { parentId: "app/missing" }),
		conv("orphan-child", { parentId: "app/orphan" }),
		conv("archived-parent", { archivedAt: time(9) }),
		conv("archived-orphan", { parentId: "app/archived-parent" }),
		conv("cycle-a", { parentId: "app/cycle-b" }),
		conv("cycle-b", { parentId: "app/cycle-a" }),
	]));

	expect(list.chats.map((row) => row.id)).toContain("app/pinned");
	expect(list.chats.find((row) => row.id === "app/pinned")?.subagent).toBe(true);
	expect(list.chats.find((row) => row.id === "app/orphan")?.subagent).toBe(true);
	expect(list.chats.find((row) => row.id === "app/archived-orphan")?.subagent).toBe(true);
	expect(list.chats.find((row) => row.id === "app/orphan")?.kids.map((kid) => kid.id))
		.toContain("app/orphan-child");
	expect(list.chats.map((row) => row.id)).toContain("app/cycle-a");
	expect(list.chats.map((row) => row.id)).toContain("app/cycle-b");
	expect(list.chats.map((row) => row.id)).not.toContain("app/archived-parent");
});

test("T13: rolling owns deep kids and needs, work, open-roll, ties, and empty chains", () => {
	const rollNew = conv("roll-new", { updatedAt: time(1) });
	const rollOld = conv("roll-old", { updatedAt: time(9) });
	const input = base([
		conv("first", { parentId: rollOld.id }),
		conv("grand", { parentId: "app/first" }),
		conv("second", { parentId: rollNew.id, busy: true }),
		conv("third", { parentId: rollOld.id }),
	], {
		chain: [rollNew, rollOld],
		attention: [item("app/grand", "Kid question")],
	});
	const list = chatRows(input);
	const open = chatRows({ ...input, openRoll: rollOld.id });
	const empty = chatRows(base([]));
	const ties = chatRows(base([], {
		chain: [
			conv("newest", { newReply: 1, updatedAt: time(1) }),
			conv("older", { newReply: 2, updatedAt: time(9) }),
		],
	}));

	expect(list.active).toEqual([]);
	expect(list.chats).toEqual([]);
	expect(list.rolling.mark).toBe("needs");
	expect(list.rolling.line).toBe("Kid question");
	expect(list.rolling.target).toBe(rollOld.id);
	expect(list.rolling.kids.map((kid) => kid.id)).toEqual([
		"app/second",
		"app/first",
		"app/grand",
		"app/third",
	]);
	expect(list.rolling.kids.find((kid) => kid.id === "app/grand")?.mark).toBe("needs");
	expect(open.rolling.kids.map((kid) => kid.id)).toEqual([
		"app/second",
		"app/first",
		"app/grand",
		"app/third",
	]);
	expect(ties.rolling.target).toBe("app/newest");
	expect(empty.rolling.target).toBeNull();
	expect(empty.rolling.line).toBe("");
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
	expect(list.rolling.kids.find((kid) => kid.id === "app/needs-kid")?.mark).toBe("needs");
	expect(list.rolling.kids.find((kid) => kid.id === "app/delegated-kid")?.mark).toBe("working");
	expect(list.rolling.kids.find((kid) => kid.id === "app/input-kid")?.mark).toBeNull();
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

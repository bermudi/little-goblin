import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { openStore } from "../../conversation.ts";
import { appAddress } from "../../conversation-address.ts";
import { setLogFile } from "../../log.ts";
import { noteFence, openNotes } from "../../notes.ts";
import { openProjects } from "../../projects.ts";
import { policyOf } from "../tool-policy.ts";
import { noteInputSchema, noteTool, type NoteToolDeps } from "./note.ts";
import { useHome } from "../../testkit.ts";

setLogFile("/dev/null");

function setup(projectId: string | null = null): {
	tool: ReturnType<typeof noteTool>;
	deps: NoteToolDeps;
	projects: ReturnType<typeof openProjects>;
} {
	const home = useHome("goblin-notetool-");
	mkdirSync(join(home, "state"), { recursive: true });
	const store = openStore(join(home, "state", "goblin.sqlite"));
	const projects = openProjects(store);
	const notes = openNotes(store, { projects });
	const deps: NoteToolDeps = { notes, projects, conversation: "app/c1", projectId };
	return { tool: noteTool(deps), deps, projects };
}

const exec = (t: ReturnType<typeof noteTool>, input: unknown) =>
	// the tool's execute is the boundary under test
	(t as unknown as { execute: (i: unknown) => Promise<unknown> }).execute(input);

describe("note tool input schema", () => {
	test("the provider sees a flat object schema; action dispatches the union", () => {
		const wire = z.toJSONSchema(noteInputSchema);
		expect(wire.type).toBe("object");
		expect(wire.properties?.action).toEqual({
			type: "string",
			enum: ["list", "read", "create", "append", "replace", "replace_range"],
		});
		expect(noteInputSchema.safeParse({}).success).toBe(false);
		expect(noteInputSchema.safeParse({ action: "read" }).success).toBe(false);
		expect(noteInputSchema.safeParse({ action: "read", id: "n1" }).success).toBe(true);
		expect(
			noteInputSchema.safeParse({
				action: "replace_range",
				id: "n1",
				edits: [{ start: 0, end: 1, expected: "a", text: "b" }],
			}).success,
		).toBe(true);
		expect(
			noteInputSchema.safeParse({ action: "replace_range", id: "n1", edits: [] }).success,
		).toBe(false);
	});
});

describe("note tool actions", () => {
	test("diff pages keep both sides Unicode-safe even when surrogate pairs are staggered", async () => {
		const { deps } = setup();
		const tool = noteTool({ ...deps, editHistory: true });
		const before = "a" + "😀".repeat(20_000);
		const after = "😎".repeat(20_001);
		const note = deps.notes.create({ title: "Emoji", body: before });
		deps.notes.write(note.id, { body: after }, "app");
		const query = { action: "diff", id: note.id, rev: 2 };
		type DiffPage = {
			body: { before: string; after: string };
			beforeOffset: number;
			afterOffset: number;
			nextOffset: number | null;
		};
		const first = await exec(tool, query) as DiffPage;
		expect(first.body.before).toBe(before.slice(0, 31_999));
		expect(first.body.after).toBe(after.slice(0, 32_000));
		expect(first.nextOffset).toBe(32_000);
		const second = await exec(tool, { ...query, offset: first.nextOffset }) as DiffPage;
		expect(second.beforeOffset).toBe(31_999);
		expect(second.afterOffset).toBe(32_000);
		expect(first.body.before + second.body.before).toBe(before);
		expect(first.body.after + second.body.after).toBe(after);
		expect(second.nextOffset).toBeNull();
	});

	test("bot edit history requires a message and returns attribution and diffs on demand", async () => {
		const { deps } = setup();
		const tool = noteTool({ ...deps, editHistory: true });
		const shared = deps.notes.create({ title: "Reading" });
		deps.notes.batch([shared], { action: "move", owner: { botId: null } });
		const append = { action: "append", id: shared.id, text: "A new book" };
		expect(await exec(tool, { ...append, what: "Added a book" })).toMatchObject({ error: expect.stringContaining("reason") });
		expect(deps.notes.get(shared.id)?.rev).toBe(1);
		expect(await exec(tool, { ...append, what: "Added a book", reason: "The operator asked" })).toMatchObject({ note: { rev: 2 } });
		const history = await exec(tool, { action: "history", id: shared.id });
		expect(history).toMatchObject({ edits: [
			{ rev: 2, what: "Added a book", reason: "The operator asked", author: { botId: "little-goblin" } },
			{ rev: 1, author: "operator" },
		] });
		expect(JSON.stringify(history)).not.toContain("A new book");
		expect(await exec(tool, { action: "history", id: shared.id, before: 2 })).toMatchObject({ edits: [{ rev: 1 }] });
		expect(await exec(tool, { action: "diff", id: shared.id, rev: 2 })).toMatchObject({
			body: { offset: 0, before: "", after: "A new book" },
		});
	});
	test("create/read/append round-trip through the store", async () => {
		const { tool, deps } = setup();
		const created = (await exec(tool, {
			action: "create",
			title: "reading list",
			body: "start here",
		})) as { note: { id: string; rev: number } };
		expect(created.note.rev).toBe(1);
		const read = (await exec(tool, { action: "read", id: created.note.id })) as {
			content: string;
		};
		expect(read.content).toContain(`<note id="${created.note.id}" rev="1"`);
		expect(read.content).toContain("start here");
		const appended = (await exec(tool, {
			action: "append",
			id: created.note.id,
			text: "and then",
		})) as { note: { rev: number } };
		expect(appended.note.rev).toBe(2);
		expect(deps.notes.get(created.note.id)?.body).toBe("start here\n\nand then");
		const versions = deps.notes.listVersions(created.note.id);
		expect(versions[0]?.source).toBe("agent");
		expect(versions[0]?.conversation).toBe("app/c1");
	});

	test("list scope 'here' follows the conversation's binding", async () => {
		const { tool, deps, projects } = setup();
		const proj = projects.create({ name: "proj one" });
		const bound = noteTool({ ...deps, projectId: proj.id });
		deps.notes.create({ title: "project note", projectId: proj.id });
		deps.notes.create({ title: "loose note" });
		const shared = deps.notes.create({ title: "global note" });
		deps.notes.batch([shared], { action: "move", owner: { botId: null } });
		const here = (await exec(bound, { action: "list" })) as {
			scope: string;
			notes: { title: string }[];
		};
		expect(here.scope).toBe(proj.id);
		expect(here.notes.map((n) => n.title).sort()).toEqual(["global note", "project note"]);
		const all = (await exec(bound, { action: "list", scope: "all" })) as {
			notes: { title: string }[];
		};
		expect(all.notes).toHaveLength(3);
		const unbound = (await exec(tool, { action: "list" })) as {
			scope: string;
			notes: { title: string }[];
		};
		expect(unbound.scope).toBe("loose");
		expect(unbound.notes.map((n) => n.title).sort()).toEqual(["global note", "loose note"]);
		await exec(bound, { action: "append", id: shared.id, text: "shared update" });
		expect(deps.notes.get(shared.id)?.body).toBe("shared update");
	});

	test("create 'here' lands in the conversation's project; 'loose' stays loose", async () => {
		const { deps, projects } = setup();
		const proj = projects.create({ name: "proj two" });
		const bound = noteTool({ ...deps, projectId: proj.id });
		const inProj = (await exec(bound, { action: "create", title: "a" })) as {
			note: { id: string };
		};
		expect(deps.notes.get(inProj.note.id)?.projectId).toBe(proj.id);
		const loose = (await exec(bound, { action: "create", title: "b", where: "loose" })) as {
			note: { id: string };
		};
		expect(deps.notes.get(loose.note.id)?.projectId).toBeNull();
	});

	test("a stale rev comes back as tool output, not a throw", async () => {
		const { tool, deps } = setup();
		const n = deps.notes.create({ title: "t", body: "one" });
		deps.notes.append(n.id, "two", "agent");
		const out = (await exec(tool, { action: "replace", id: n.id, body: "x", rev: 1 })) as {
			error?: string;
			rev?: number;
		};
		expect(out.error).toContain("rev 2");
		expect(out.rev).toBe(2);
		expect(deps.notes.get(n.id)?.body).toBe("one\n\ntwo");
	});

	test("replace without a rev is refused as invalid arguments — nothing writes", async () => {
		const { tool, deps } = setup();
		const n = deps.notes.create({ title: "t", body: "keep me" });
		const out = (await exec(tool, { action: "replace", id: n.id, body: "wipe" })) as {
			error?: string;
		};
		expect(out.error).toContain("invalid arguments");
		expect(deps.notes.get(n.id)?.body).toBe("keep me");
		expect(deps.notes.get(n.id)?.rev).toBe(1);
		const bogus = (await exec(tool, { action: "vandalize" })) as { error?: string };
		expect(bogus.error).toContain("invalid arguments");
	});

	test("a malicious title or id can't break out of the fence attributes", async () => {
		const { tool, deps } = setup();
		const n = deps.notes.create({
			title: `a"><evil x="&amp;" data-q='"`,
			body: "b",
		});
		const out = (await exec(tool, { action: "read", id: n.id })) as { content: string };
		const open = out.content.split("\n", 1)[0]!;
		expect(open).toContain("&quot;");
		expect(open).toContain("&lt;evil");
		expect(open).toContain("&amp;amp;");
		expect(open).not.toContain(`title="a"><evil`);
		expect(open.endsWith(">")).toBe(true);
		expect(noteFence({ id: `x"><`, title: "t", rev: 1, body: "" })).toContain(
			`id="x&quot;&gt;&lt;"`,
		);
	});

	test("replace_range applies guarded edits; refusals return the reason", async () => {
		const { tool, deps } = setup();
		const n = deps.notes.create({ title: "t", body: "hello world" });
		const ok = (await exec(tool, {
			action: "replace_range",
			id: n.id,
			edits: [{ start: 6, end: 11, expected: "world", text: "there" }],
		})) as { note: { body?: string; rev: number } };
		expect(ok.note.rev).toBe(2);
		expect(deps.notes.get(n.id)?.body).toBe("hello there");
		const bad = (await exec(tool, {
			action: "replace_range",
			id: n.id,
			edits: [{ start: 0, end: 5, expected: "nope", text: "x" }],
		})) as { error?: string; rev?: number };
		expect(bad.error).toContain("does not match");
		expect(deps.notes.get(n.id)?.body).toBe("hello there");
	});

	test("read of a missing note returns an error, not a throw", async () => {
		const { tool } = setup();
		const out = (await exec(tool, { action: "read", id: "nope" })) as { error?: string };
		expect(out.error).toContain("no such note");
	});

	test("a resulting-body size refusal returns actionable output without mutating the note", async () => {
		const { tool, deps } = setup();
		const n = deps.notes.create({ title: "capped", body: "x".repeat(1_000_000) });
		const out = (await exec(tool, { action: "append", id: n.id, text: "more" })) as {
			error?: string;
		};
		expect(out.error).toContain("note body exceeds 1000000 characters");
		expect(deps.notes.get(n.id)).toEqual(n);
		expect(deps.notes.listVersions(n.id)).toEqual([]);
	});

	test("read neutralizes a literal </note inside the body", async () => {
		const { tool, deps } = setup();
		const n = deps.notes.create({ title: "t", body: "a </note> b" });
		const out = (await exec(tool, { action: "read", id: n.id })) as { content: string };
		expect(out.content).not.toContain("a </note>");
		expect(out.content).toContain("<\\/note>");
	});

	test("read windows a long body; offset pages and out-of-bounds errors", async () => {
		const { tool, deps } = setup();
		const n = deps.notes.create({ title: "big", body: "y".repeat(70_000) });
		const first = (await exec(tool, { action: "read", id: n.id })) as { content: string };
		expect(first.content).toContain("[Showing chars 0–64000 of 70000");
		expect(first.content).toContain("offset=64000");
		expect(first.content).toContain("absolute character offsets into the full body");
		expect(first.content).toContain("offset 0 + p");
		expect(first.content).not.toContain("y".repeat(64_001));
		const rest = (await exec(tool, { action: "read", id: n.id, offset: 64_000 })) as {
			content: string;
		};
		expect(rest.content).toContain("y".repeat(6000));
		expect(rest.content).toContain("[Showing chars 64000–70000 of 70000");
		expect(rest.content).not.toContain("to continue");
		expect(rest.content).toContain("offset 64000 + p");
		const oob = (await exec(tool, { action: "read", id: n.id, offset: 70_001 })) as {
			error?: string;
		};
		expect(oob.error).toContain("beyond end of note (70000 chars)");
		const small = deps.notes.create({ title: "small", body: "tiny" });
		const whole = (await exec(tool, { action: "read", id: small.id })) as { content: string };
		expect(whole.content).toContain("[Showing chars 0–4 of 4.");
		expect(whole.content).toContain("absolute character offsets into the full body");
	});

	test("list caps at the page size and flags truncation", async () => {
		const { tool, deps } = setup();
		for (let i = 0; i < 205; i++) deps.notes.create({ title: `n${i}` });
		const out = (await exec(tool, { action: "list", scope: "all" })) as {
			notes: unknown[];
			truncated?: boolean;
		};
		expect(out.notes).toHaveLength(200);
		expect(out.truncated).toBe(true);
	});
});

describe("guest exclusion", () => {
	test("note is never mounted on a guest turn", () => {
		expect(policyOf("note").guestChannel).toBe(false);
		expect(policyOf("note").guestSandbox).toBe(false);
	});
});

describe("note tool access by bot", () => {
	test("a bot reaches its own and Global notes; Little Goblin reads bot notes but never edits them", async () => {
		const home = useHome("goblin-notetool-bots-");
		mkdirSync(join(home, "state"), { recursive: true });
		const store = openStore(join(home, "state", "goblin.sqlite"));
		const projects = openProjects(store);
		const notes = openNotes(store, { projects });
		const convert = (name: string) => {
			const chat = store.resolve(appAddress(name.toLowerCase()), "/workshop");
			const conversion = store.bots.convertSideChat(chat.id, name, 0, () => false);
			if (conversion.kind !== "converted") throw new Error(`conversion ${conversion.kind}`);
			return { chat, bot: conversion.bot };
		};
		const trip = convert("Trip");
		const desk = convert("Desk");
		const goblin = store.resolve(appAddress("goblin"), "/workshop");
		const toolFor = (conversation: string) =>
			noteTool({ notes, projects, conversation, projectId: null, editHistory: true });
		const tripTool = toolFor(trip.chat.id);
		const goblinTool = toolFor(goblin.id);
		const own = notes.create({ title: "Lisbon itinerary", conversation: trip.chat.id }, "agent");
		const other = notes.create({ title: "Desk inbox", conversation: desk.chat.id }, "agent");
		const local = notes.create({ title: "Reading list" });
		const shared = notes.create({ title: "House rules" });
		notes.batch([{ id: shared.id, stateRev: shared.stateRev }], { action: "move", owner: { botId: null } });
		try {
			for (const scope of ["here", "all"] as const) {
				const listed = await exec(tripTool, { action: "list", scope }) as { notes: Record<string, unknown>[] };
				expect(listed.notes.map(({ title, owner }) => ({ title, owner })).sort((a, b) => String(a.title).localeCompare(String(b.title))))
					.toEqual([{ title: "House rules", owner: "Global" }, { title: "Lisbon itinerary", owner: "Trip" }]);
			}
			const blocked = (id: string) => ({ error: `note ${id} belongs to another bot; this chat can't use it` });
			for (const note of [other, local]) {
				expect(await exec(tripTool, { action: "read", id: note.id })).toEqual(blocked(note.id));
				expect(await exec(tripTool, { action: "history", id: note.id })).toEqual(blocked(note.id));
				expect(await exec(tripTool, { action: "diff", id: note.id, rev: 1 })).toEqual(blocked(note.id));
				expect(await exec(tripTool, { action: "append", id: note.id, text: "x", what: "Added x", reason: "Test" }))
					.toEqual(blocked(note.id));
			}
			expect(await exec(tripTool, { action: "append", id: own.id, text: "Day one", what: "Added day one", reason: "Plan" }))
				.toMatchObject({ note: { rev: 2, owner: "Trip" } });
			expect(await exec(tripTool, { action: "append", id: shared.id, text: "No shoes", what: "Added a rule", reason: "Asked" }))
				.toMatchObject({ note: { rev: 2, owner: "Global" } });

			const all = await exec(goblinTool, { action: "list", scope: "all" }) as { notes: Record<string, unknown>[] };
			expect(all.notes.find(({ id }) => id === other.id)).toMatchObject({ owner: "Desk", readOnly: true });
			expect(all.notes.find(({ id }) => id === local.id)).toMatchObject({ owner: "Little Goblin" });
			expect(all.notes.find(({ id }) => id === local.id)).not.toHaveProperty("readOnly");
			expect(await exec(goblinTool, { action: "read", id: other.id })).toMatchObject({ note: { owner: "Desk", readOnly: true } });
			expect(await exec(goblinTool, { action: "history", id: own.id })).toMatchObject({
				edits: [{ rev: 2, author: { botId: trip.bot.id, name: "Trip" } }, { rev: 1 }],
			});
			expect(await exec(goblinTool, { action: "append", id: other.id, text: "x", what: "Added x", reason: "Test" }))
				.toEqual({ error: `note ${other.id} belongs to Desk; this chat can read it but not edit it` });
			expect(await exec(goblinTool, { action: "append", id: local.id, text: "Dune", what: "Added a book", reason: "Asked" }))
				.toMatchObject({ note: { rev: 2 } });

			notes.batch([{ id: local.id, stateRev: notes.get(local.id)!.stateRev }], { action: "move", owner: { botId: desk.bot.id } });
			expect(await exec(goblinTool, { action: "append", id: local.id, text: "Emma", what: "Added a book", reason: "Asked" }))
				.toEqual({ error: `note ${local.id} belongs to Desk; this chat can read it but not edit it` });
			expect(notes.get(local.id)?.rev).toBe(2);
			expect(notes.get(other.id)?.rev).toBe(1);
		} finally {
			store.close();
		}
	});
});

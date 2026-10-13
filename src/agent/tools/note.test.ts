// The note tool's boundary tests: actions round-trip through a real
// store, scope "here" follows the conversation's project binding,
// and every actionable refusal (stale rev, bad range, missing note)
// comes back as tool output — never a thrown turn. The guest filter
// test pins that `note` never mounts on a guest turn.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openStore } from "../../conversation.ts";
import { setLogFile } from "../../log.ts";
import { noteFence, openNotes } from "../../notes.ts";
import { openProjects } from "../../projects.ts";
import { GUEST_CHANNEL_EXCLUDED, SANDBOX_TOOLS } from "../../tg/guest.ts";
import { noteInputSchema, noteTool, type NoteToolDeps } from "./note.ts";

let dirs: string[] = [];
let prevHome: string | undefined;
function useHome(): string {
	prevHome = process.env.GOBLIN_HOME;
	const dir = mkdtempSync(join(tmpdir(), "goblin-notetool-"));
	dirs.push(dir);
	process.env.GOBLIN_HOME = dir;
	return dir;
}
afterEach(() => {
	if (prevHome === undefined) delete process.env.GOBLIN_HOME;
	else process.env.GOBLIN_HOME = prevHome;
	prevHome = undefined;
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});
setLogFile("/dev/null");

function setup(projectId: string | null = null): {
	tool: ReturnType<typeof noteTool>;
	deps: NoteToolDeps;
	projects: ReturnType<typeof openProjects>;
} {
	const home = useHome();
	mkdirSync(join(home, "state"), { recursive: true });
	const store = openStore(join(home, "state", "goblin.sqlite"));
	const projects = openProjects(store);
	const notes = openNotes(store, { projects });
	const deps: NoteToolDeps = { notes, projects, conversation: "app/c1", projectId };
	return { tool: noteTool(deps), deps, projects };
}

const exec = (t: ReturnType<typeof noteTool>, input: unknown) =>
	// biome-ignore lint: the tool's execute is the boundary under test
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
		// The append is agent-sourced — the store keeps the conversation
		// on the version so a restore names who wrote.
		const versions = deps.notes.listVersions(created.note.id);
		expect(versions[0]?.source).toBe("agent");
		expect(versions[0]?.conversation).toBe("app/c1");
	});

	test("list scope 'here' follows the conversation's binding", async () => {
		const { tool, deps, projects } = setup();
		const proj = projects.create({ name: "proj one" });
		// A tool bound to the project sees only that project's notes.
		const bound = noteTool({ ...deps, projectId: proj.id });
		deps.notes.create({ title: "project note", projectId: proj.id });
		deps.notes.create({ title: "loose note" });
		const here = (await exec(bound, { action: "list" })) as {
			scope: string;
			notes: { title: string }[];
		};
		expect(here.scope).toBe(proj.id);
		expect(here.notes.map((n) => n.title)).toEqual(["project note"]);
		const all = (await exec(bound, { action: "list", scope: "all" })) as {
			notes: { title: string }[];
		};
		expect(all.notes).toHaveLength(2);
		// An unbound conversation's "here" is the loose shelf.
		const unbound = (await exec(tool, { action: "list" })) as {
			scope: string;
			notes: { title: string }[];
		};
		expect(unbound.scope).toBe("loose");
		expect(unbound.notes.map((n) => n.title)).toEqual(["loose note"]);
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
		// Nothing was written.
		expect(deps.notes.get(n.id)?.body).toBe("one\n\ntwo");
	});

	test("replace without a rev is refused as invalid arguments — nothing writes", async () => {
		const { tool, deps } = setup();
		const n = deps.notes.create({ title: "t", body: "keep me" });
		// A whole-body write must name the rev it read; the wire
		// schema's flat shape can't enforce that, so execute's
		// safeParse answers with an actionable error.
		const out = (await exec(tool, { action: "replace", id: n.id, body: "wipe" })) as {
			error?: string;
		};
		expect(out.error).toContain("invalid arguments");
		expect(deps.notes.get(n.id)?.body).toBe("keep me");
		expect(deps.notes.get(n.id)?.rev).toBe(1);
		// The same guard catches inputs that match no action at all.
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
		// The attribute values are entity-escaped end to end.
		const open = out.content.split("\n", 1)[0]!;
		expect(open).toContain("&quot;");
		expect(open).toContain("&lt;evil");
		expect(open).toContain("&amp;amp;");
		expect(open).not.toContain(`title="a"><evil`);
		expect(open.endsWith(">")).toBe(true);
		// Directly through noteFence for a hostile id too.
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
		expect(first.content).not.toContain("y".repeat(64_001));
		const rest = (await exec(tool, { action: "read", id: n.id, offset: 64_000 })) as {
			content: string;
		};
		expect(rest.content).toContain("y".repeat(6000));
		expect(rest.content).not.toContain("[Showing chars");
		const oob = (await exec(tool, { action: "read", id: n.id, offset: 70_001 })) as {
			error?: string;
		};
		expect(oob.error).toContain("beyond end of note (70000 chars)");
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
		expect(GUEST_CHANNEL_EXCLUDED.has("note")).toBe(true);
		expect(SANDBOX_TOOLS.has("note")).toBe(false);
	});
});

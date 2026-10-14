// Notes domain tests — the single write path's invariants
// (design/projects.md → Notes): version-before-write, app-write
// coalescing, expected-rev conflicts, range-edit refusals that write
// nothing, FTS freshness, and flag writes that move only state_rev.

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setLogFile } from "./log.ts";
import { openStore, type ConversationStore } from "./conversation.ts";
import {
	ensureNotesSchema,
	NoteConflictError,
	NoteInputError,
	NoteRangeError,
	openNotes,
	type NoteStore,
} from "./notes.ts";
import { openProjects, type ProjectStore } from "./projects.ts";

// Each test gets a fresh $GOBLIN_HOME — the env var resolves per call
// (projects.test.ts's pattern), so the domain sees the tmp layout.
let dirs: string[] = [];
let prevHome: string | undefined;
function useHome(): string {
	prevHome = process.env.GOBLIN_HOME;
	const dir = mkdtempSync(join(tmpdir(), "goblin-notes-test-"));
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

function setup(): {
	store: ConversationStore;
	projects: ProjectStore;
	notes: NoteStore;
	clock: { t: Date };
} {
	const home = useHome();
	mkdirSync(join(home, "state"), { recursive: true });
	const clock = { t: new Date("2026-10-10T12:00:00.000Z") };
	const store = openStore(join(home, "state", "goblin.sqlite"));
	const projects = openProjects(store);
	const notes = openNotes(store, { projects, now: () => clock.t });
	return { store, projects, notes, clock };
}

describe("the write path", () => {
	test("the resulting body limit guards every write and rolls back combined patches", () => {
		const { notes } = setup();
		const body = "x".repeat(1_000_000);
		expect(() => notes.create({ title: "too big", body: `${body}x` })).toThrow(NoteInputError);
		const n = notes.create({ title: "capped", body });
		expect(() => notes.append(n.id, "more", "agent")).toThrow(NoteInputError);
		expect(() => notes.write(n.id, { body: `${body}x` }, "agent")).toThrow(NoteInputError);
		expect(() =>
			notes.replaceRanges(n.id, [{ start: 0, end: 0, expected: "", text: "more" }]),
		).toThrow(NoteInputError);
		expect(() => notes.patch(n.id, { body: `${body}x`, pinned: true }, "app")).toThrow(
			NoteInputError,
		);
		expect(notes.get(n.id)).toEqual(n);
		expect(notes.listVersions(n.id)).toEqual([]);
	});

	test("legacy oversized notes can be renamed or reduced but never grown", () => {
		const { store, notes } = setup();
		const n = notes.create({ title: "legacy" });
		const body = "x".repeat(1_000_006);
		store.db.run("UPDATE notes SET body_md = ? WHERE id = ?", [body, n.id]);
		const renamed = notes.write(n.id, { title: "renamed", body }, "app");
		expect(renamed.title).toBe("renamed");
		expect(() => notes.append(n.id, "more", "append")).toThrow(NoteInputError);
		const reduced = notes.write(n.id, { body: body.slice(1) }, "app");
		expect(reduced.body.length).toBe(1_000_005);
		expect(() => notes.write(n.id, { body }, "agent")).toThrow(NoteInputError);
		const small = notes.write(n.id, { body: "small" }, "app");
		expect(small.body).toBe("small");
		const version = notes.listVersions(n.id)[0]!;
		expect(notes.getVersion(n.id, version.rev)!.body.length).toBeGreaterThan(1_000_000);
		expect(() => notes.restore(n.id, version.rev, small.rev)).toThrow(NoteInputError);
		expect(notes.get(n.id)).toEqual(small);
	});

	test("agent/append/restore writes version every time", () => {
		const { notes } = setup();
		const n = notes.create({ title: "groceries", body: "milk" });
		notes.append(n.id, "eggs", "agent", "app/c1");
		notes.append(n.id, "bread", "append");
		const beforeRestore = notes.get(n.id)!;
		notes.restore(n.id, 1, beforeRestore.rev);
		const versions = notes.listVersions(n.id);
		// Three writes → three pre-write snapshots, newest first.
		expect(versions.map((v) => v.rev)).toEqual([3, 2, 1]);
		expect(versions.map((v) => v.source)).toEqual(["restore", "append", "agent"]);
		expect(notes.getVersion(n.id, 3)!.body).toBe(beforeRestore.body);
		expect(versions[2]!.conversation).toBe("app/c1");
		const v1 = notes.getVersion(n.id, 1)!;
		expect(v1.body).toBe("milk");
		expect(v1.title).toBe("groceries");
	});

	test("app writes coalesce: same-session saves record one version", () => {
		const { notes, clock } = setup();
		const n = notes.create({ title: "draft" });
		// Three quick app saves — only the first versions the pre state.
		notes.write(n.id, { body: "one" }, "app");
		clock.t = new Date(clock.t.getTime() + 5_000);
		notes.write(n.id, { body: "two" }, "app");
		clock.t = new Date(clock.t.getTime() + 5_000);
		notes.write(n.id, { body: "three" }, "app");
		expect(notes.get(n.id)!.rev).toBe(4);
		const versions = notes.listVersions(n.id);
		expect(versions).toHaveLength(1);
		expect(versions[0]!.rev).toBe(1);
		expect(versions[0]!.source).toBe("app");
	});

	test("an app write after an agent write versions; one after the gap versions again", () => {
		const { notes, clock } = setup();
		const n = notes.create({ title: "draft", body: "start" });
		notes.append(n.id, "agent touched", "agent");
		// App save right after the agent write: last_source !== 'app' → version.
		notes.write(n.id, { body: "edit one" }, "app");
		notes.write(n.id, { body: "edit two" }, "app");
		// Two snapshots: the agent write's and the first app write's —
		// the second coalesces into the app session.
		expect(notes.listVersions(n.id)).toHaveLength(2);
		// Past the 10-minute gap the next app save versions again even
		// though the session source is still app.
		clock.t = new Date(clock.t.getTime() + 11 * 60_000);
		notes.write(n.id, { body: "edit three" }, "app");
		expect(notes.listVersions(n.id)).toHaveLength(3);
	});

	test("a no-op write bumps nothing and versions nothing", () => {
		const { notes } = setup();
		const n = notes.create({ title: "same", body: "text" });
		const again = notes.write(n.id, { title: "same", body: "text" }, "agent");
		expect(again.rev).toBe(1);
		expect(notes.listVersions(n.id)).toHaveLength(0);
	});

	test("expectedRev conflict throws the current note", () => {
		const { notes } = setup();
		const n = notes.create({ title: "shared" });
		notes.write(n.id, { body: "v2" }, "app");
		try {
			notes.write(n.id, { body: "stale" }, "app", { expectedRev: 1 });
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(NoteConflictError);
			expect((err as NoteConflictError).note.rev).toBe(2);
			expect((err as NoteConflictError).note.body).toBe("v2");
		}
		expect(notes.get(n.id)!.body).toBe("v2");
		// Right rev passes.
		const ok = notes.write(n.id, { body: "v3" }, "app", { expectedRev: 2 });
		expect(ok.rev).toBe(3);
	});

	test("versions prune past the newest 100", () => {
		const { notes } = setup();
		const n = notes.create({ title: "long" });
		for (let i = 0; i < 105; i++) notes.append(n.id, `entry ${i}`, "agent");
		const versions = notes.listVersions(n.id);
		expect(versions).toHaveLength(100);
		expect(versions[0]!.rev).toBe(105);
		expect(versions[99]!.rev).toBe(6);
	});
});

describe("replaceRanges", () => {
	test("multiple edits apply back-to-front", () => {
		const { notes } = setup();
		const n = notes.create({ title: "t", body: "alpha beta gamma" });
		const out = notes.replaceRanges(n.id, [
			{ start: 0, end: 5, expected: "alpha", text: "ALPHA" },
			{ start: 11, end: 16, expected: "gamma", text: "GAMMA" },
		]);
		expect(out.body).toBe("ALPHA beta GAMMA");
		expect(out.rev).toBe(2);
		expect(notes.getVersion(n.id, 1)!.body).toBe("alpha beta gamma");
	});

	test("overlap, out-of-bounds, and expected-mismatch refuse with nothing written", () => {
		const { notes } = setup();
		const n = notes.create({ title: "t", body: "abcdef" });
		const cases: { start: number; end: number; expected: string; text: string }[][] = [
			[
				{ start: 0, end: 3, expected: "abc", text: "x" },
				{ start: 2, end: 4, expected: "cd", text: "y" },
			],
			[{ start: 4, end: 9, expected: "ef", text: "x" }],
			[{ start: 0, end: 3, expected: "xyz", text: "x" }],
			[{ start: -1, end: 2, expected: "ab", text: "x" }],
		];
		for (const edits of cases) {
			try {
				notes.replaceRanges(n.id, edits);
				expect.unreachable();
			} catch (err) {
				expect(err).toBeInstanceOf(NoteRangeError);
				expect((err as NoteRangeError).rev).toBe(1);
			}
		}
		expect(notes.get(n.id)!.body).toBe("abcdef");
		expect(notes.listVersions(n.id)).toHaveLength(0);
	});

	test("offsets are UTF-16 indices — an emoji before the edit shifts by two", () => {
		const { notes } = setup();
		// "😀" is one visible char, two UTF-16 units.
		const n = notes.create({ title: "t", body: "😀 tail" });
		const out = notes.replaceRanges(n.id, [{ start: 2, end: 7, expected: " tail", text: " HEAD" }]);
		expect(out.body).toBe("😀 HEAD");
	});
});

describe("search and scope", () => {
	test("FTS finds by title and body, and reflects updates and deletes", () => {
		const { notes } = setup();
		const n = notes.create({ title: "packing list", body: "passport adapter" });
		const other = notes.create({ title: "ideas", body: "nothing to see" });
		const found = (q: string) => notes.list({ q }).map((s) => s.id);
		expect(found("packing")).toEqual([n.id]);
		expect(found("adapter")).toEqual([n.id]);
		expect(found("nothing")).toEqual([other.id]);
		notes.write(n.id, { body: "toothbrush only" }, "app");
		expect(found("adapter")).toEqual([]);
		expect(found("toothbrush")).toEqual([n.id]);
		notes.setArchived(n.id, true);
		notes.delete(n.id);
		expect(found("toothbrush")).toEqual([]);
	});

	test("project scope, loose, archived shelf, pinned-first ordering", () => {
		const { notes, projects } = setup();
		const p = projects.create({ name: "Trip" });
		const inProject = notes.create({ title: "trip notes", projectId: p.id });
		const loose = notes.create({ title: "loose note" });
		const archived = notes.create({ title: "old" });
		notes.setArchived(archived.id, true);
		notes.setPinned(loose.id, true);
		expect(notes.list({ project: p.id }).map((s) => s.id)).toEqual([inProject.id]);
		expect(notes.list({ project: "loose" }).map((s) => s.id)).toEqual([loose.id]);
		// Pinned floats above the more recently touched row.
		notes.write(inProject.id, { body: "fresher" }, "app");
		expect(notes.list().map((s) => s.id)).toEqual([loose.id, inProject.id]);
		expect(notes.list({ archived: true }).map((s) => s.id)).toEqual([archived.id]);
	});

	test("index is non-archived for one project, pinned first, capped", () => {
		const { notes, projects } = setup();
		const p = projects.create({ name: "P" });
		const a = notes.create({ title: "a", projectId: p.id });
		const b = notes.create({ title: "b", projectId: p.id });
		notes.create({ title: "loose" });
		notes.setPinned(b.id, true);
		notes.setArchived(a.id, true);
		expect(notes.index(p.id)).toEqual([{ id: b.id, title: "b" }]);
	});
});

describe("flags, moves, and delete", () => {
	test("pin/archive/move never bump rev or write versions — state_rev moves", () => {
		const { notes, projects } = setup();
		const p = projects.create({ name: "P" });
		const n = notes.create({ title: "t", body: "x" });
		notes.setPinned(n.id, true);
		notes.setArchived(n.id, true);
		notes.setArchived(n.id, false);
		notes.move(n.id, p.id);
		const after = notes.get(n.id)!;
		expect(after.rev).toBe(1);
		expect(after.stateRev).toBe(5); // one accepted mutation each
		expect(after.projectId).toBe(p.id);
		expect(notes.listVersions(n.id)).toHaveLength(0);
	});

	test("create/move validate the project; archived projects refuse", () => {
		const { notes, projects } = setup();
		const p = projects.create({ name: "P" });
		expect(() => notes.create({ title: "t", projectId: "ghost" })).toThrow(NoteInputError);
		projects.patch(p.id, { archived: true });
		expect(() => notes.create({ title: "t", projectId: p.id })).toThrow(NoteInputError);
		const n = notes.create({ title: "t" });
		expect(() => notes.move(n.id, p.id)).toThrow(NoteInputError);
	});

	test("delete only archives-first, and removes its versions", () => {
		const { notes } = setup();
		const n = notes.create({ title: "t", body: "x" });
		notes.append(n.id, "more", "agent");
		expect(() => notes.delete(n.id)).toThrow(NoteInputError);
		notes.setArchived(n.id, true);
		notes.delete(n.id);
		expect(notes.get(n.id)).toBeNull();
		// Versions went with it — the row is gone, not dangling.
		expect(() => notes.listVersions(n.id)).toThrow(NoteInputError);
	});
});

describe("the state_rev ordering token", () => {
	test("flags advance only state_rev; content writes advance both counters", () => {
		const { notes, projects, clock } = setup();
		const p = projects.create({ name: "P" });
		const n = notes.create({ title: "t", body: "x" });
		expect(n.stateRev).toBe(1);
		// Every accepted flag flip is a new state — rev, updated_at,
		// and the version list can't see any of them.
		notes.setPinned(n.id, true);
		notes.setArchived(n.id, true);
		notes.setArchived(n.id, false);
		notes.move(n.id, p.id);
		const flagged = notes.get(n.id)!;
		expect(flagged.rev).toBe(1);
		expect(flagged.stateRev).toBe(5);
		expect(flagged.updatedAt).toBe(n.updatedAt);
		expect(notes.listVersions(n.id)).toHaveLength(0);
		// A content write moves both counters and the clock.
		clock.t = new Date(clock.t.getTime() + 5_000);
		const written = notes.write(n.id, { body: "v2" }, "app");
		expect(written.rev).toBe(2);
		expect(written.stateRev).toBe(6);
		expect(written.updatedAt).not.toBe(flagged.updatedAt);
	});

	test("a refused combined patch rolls the flags AND the token back", () => {
		const { notes } = setup();
		const n = notes.create({ title: "t", body: "x" });
		expect(() =>
			notes.patch(n.id, { pinned: true, body: "v2" }, "app", { expectedRev: 99 }),
		).toThrow(NoteConflictError);
		const after = notes.get(n.id)!;
		expect(after.rev).toBe(1);
		expect(after.stateRev).toBe(1);
		expect(after.pinnedAt).toBeNull();
	});

	test("a stale restore conflicts and writes nothing; the current rev advances", () => {
		const { notes } = setup();
		const n = notes.create({ title: "t", body: "one" });
		notes.append(n.id, "two", "agent");
		notes.append(n.id, "three", "agent");
		const before = notes.get(n.id)!;
		expect(() => notes.restore(n.id, 1, 2)).toThrow(NoteConflictError);
		// Nothing moved — body, versions, and both counters stand.
		expect(notes.get(n.id)!).toEqual(before);
		expect(notes.listVersions(n.id)).toHaveLength(2);
		const ok = notes.restore(n.id, 1, 3);
		expect(ok.rev).toBe(4);
		expect(ok.stateRev).toBe(4);
		expect(ok.body).toBe("one");
	});

	test("a store that predates the column migrates existing rows to 1 — idempotently", () => {
		const home = useHome();
		mkdirSync(join(home, "state"), { recursive: true });
		const db = new Database(join(home, "state", "goblin.sqlite"));
		try {
			// The pre-migration shape: no state_rev, a row already written.
			db.run(`CREATE TABLE notes (
				id TEXT PRIMARY KEY,
				project_id TEXT,
				title TEXT NOT NULL,
				body_md TEXT NOT NULL DEFAULT '',
				rev INTEGER NOT NULL DEFAULT 1,
				last_source TEXT NOT NULL DEFAULT 'app',
				pinned_at TEXT,
				archived_at TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`);
			db.run(
				`INSERT INTO notes (id, title, body_md, rev, last_source, created_at, updated_at)
				 VALUES ('n-old', 'old', 'x', 3, 'app', 'a', 'a')`,
			);
			ensureNotesSchema(db);
			// A second pass must not re-alter or clobber the value.
			ensureNotesSchema(db);
			const row = db
				.query<{ rev: number; state_rev: number }, []>(
					"SELECT rev, state_rev FROM notes WHERE id = 'n-old'",
				)
				.get()!;
			expect(row.rev).toBe(3);
			expect(row.state_rev).toBe(1);
		} finally {
			db.close();
		}
	});
});

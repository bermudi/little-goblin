import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setLogFile } from "./log.ts";
import { openStore, type ConversationStore } from "./conversation.ts";
import {
	ensureNotesSchema,
	NOTE_BODY_MAX,
	NoteConflictError,
	NoteInputError,
	NoteRangeError,
	noteFence,
	openNotes,
	type NoteStore,
} from "./notes.ts";
import { openProjects, type ProjectStore } from "./projects.ts";
import { useHome } from "./testkit.ts";

// $GOBLIN_HOME resolves per call — the domain sees the tmp layout.
setLogFile("/dev/null");

function setup(): {
	store: ConversationStore;
	projects: ProjectStore;
	notes: NoteStore;
	clock: { t: Date };
} {
	const home = useHome("goblin-notes-test-");
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
		expect(versions.map((v) => v.rev)).toEqual([3, 2, 1]);
		expect(versions.map((v) => v.source)).toEqual(["restore", "append", "agent"]);
		expect(notes.getVersion(n.id, 3)!.body).toBe(beforeRestore.body);
		expect(versions[2]!.conversation).toBe("app/c1");
		expect(versions[2]!.bytes).toBe(4); // "milk"
		const v1 = notes.getVersion(n.id, 1)!;
		expect(v1.body).toBe("milk");
		expect(v1.title).toBe("groceries");
	});

	test("app writes coalesce: same-session saves record one version", () => {
		const { notes, clock } = setup();
		const n = notes.create({ title: "draft" });
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
		notes.write(n.id, { body: "edit one" }, "app");
		notes.write(n.id, { body: "edit two" }, "app");
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

	test("the body cap is enforced at the store — create, write, and accreting appends", () => {
		const { notes } = setup();
		const over = "x".repeat(NOTE_BODY_MAX + 1);
		expect(() => notes.create({ title: "t", body: over })).toThrow(NoteInputError);
		const n = notes.create({ title: "t" });
		expect(() => notes.write(n.id, { body: over }, "app")).toThrow(NoteInputError);
		// An append crossing the cap in aggregate refuses the same way —
		// versioning amplifies every byte.
		const almost = "y".repeat(NOTE_BODY_MAX - 4);
		notes.write(n.id, { body: almost }, "agent");
		expect(() => notes.append(n.id, "z".repeat(10), "agent")).toThrow(NoteInputError);
		expect(notes.get(n.id)!.body).toBe(almost);
	});

	test("an archived note is read-only — every content door refuses, unarchive lifts it", () => {
		const { notes } = setup();
		const n = notes.create({ title: "t", body: "x" });
		notes.append(n.id, "more", "agent"); // leaves a version to attempt restoring
		notes.setArchived(n.id, true);
		for (const attempt of [
			() => notes.write(n.id, { body: "y" }, "app"),
			() => notes.append(n.id, "y", "append"),
			() => notes.replaceRanges(n.id, [{ start: 0, end: 1, expected: "x", text: "y" }]),
			() => notes.restore(n.id, 1, 2),
		]) {
			expect(attempt).toThrow(NoteInputError);
			expect(attempt).toThrow(/archived/);
		}
		expect(notes.get(n.id)!.body).toBe("x\n\nmore");
		// Flags bypass write() — unarchive lifts read-only.
		notes.setArchived(n.id, false);
		expect(notes.write(n.id, { body: "y" }, "app").body).toBe("y");
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

	test("a query that strips to nothing matches nothing — never the full list", () => {
		const { notes } = setup();
		notes.create({ title: "packing list", body: "passport adapter" });
		notes.create({ title: "ideas", body: "nothing to see" });
		const found = (q: string) => notes.list({ q }).map((s) => s.id);
		// Punctuation-only input quotes into a real (empty) FTS match;
		// whitespace- and quote-only input strips to no terms — both
		// must read "no hits", never degrade to the unfiltered list.
		expect(found("+++")).toEqual([]);
		expect(found("   ")).toEqual([]);
		expect(found('""')).toEqual([]);
		expect(found("packing")).toHaveLength(1);
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
		// Pinned floats above the fresher row.
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
		// rev, updated_at, and the version list see none of the flag
		// flips.
		notes.setPinned(n.id, true);
		notes.setArchived(n.id, true);
		notes.setArchived(n.id, false);
		notes.move(n.id, p.id);
		const flagged = notes.get(n.id)!;
		expect(flagged.rev).toBe(1);
		expect(flagged.stateRev).toBe(5);
		expect(flagged.updatedAt).toBe(n.updatedAt);
		expect(notes.listVersions(n.id)).toHaveLength(0);
		clock.t = new Date(clock.t.getTime() + 5_000);
		const written = notes.write(n.id, { body: "v2" }, "app");
		expect(written.rev).toBe(2);
		expect(written.stateRev).toBe(6);
		expect(written.updatedAt).not.toBe(flagged.updatedAt);
		expect(notes.list({ project: p.id })[0]!.stateRev).toBe(written.stateRev);
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

	test("content and archive commit together; editing an archived note rolls flags back", () => {
		const { notes } = setup();
		const n = notes.create({ title: "t", body: "x" });
		const archived = notes.patch(n.id, { body: "v2", archived: true }, "app", {
			expectedRev: n.rev,
		});
		expect(archived).toEqual(notes.get(n.id)!);
		expect(archived.body).toBe("v2");
		expect(archived.rev).toBe(2);
		expect(archived.stateRev).toBe(3);
		expect(archived.archivedAt).not.toBeNull();
		expect(() =>
			notes.patch(n.id, { body: "v3", archived: false, pinned: true }, "app", {
				expectedRev: archived.rev,
			}),
		).toThrow("archived");
		expect(notes.get(n.id)).toEqual(archived);
		expect(notes.listVersions(n.id)).toHaveLength(1);
	});

	test("a stale restore conflicts and writes nothing; the current rev advances", () => {
		const { notes } = setup();
		const n = notes.create({ title: "t", body: "one" });
		notes.append(n.id, "two", "agent");
		notes.append(n.id, "three", "agent");
		const before = notes.get(n.id)!;
		expect(() => notes.restore(n.id, 1, 2)).toThrow(NoteConflictError);
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

describe("noteFence", () => {
	test("only a genuine closing fence is neutralized — lookalike operator text survives verbatim", () => {
		const fenced = noteFence({
			id: "i",
			title: "t",
			rev: 1,
			body: "<notebook>x</notebook> and </notes> stay whole; </note> and </NOTE> close nothing",
		});
		// Operator text that merely shares the fence-closer's prefix must
		// reach the model exactly as stored (body_md is what the model reads).
		expect(fenced).toContain("<notebook>x</notebook> and </notes> stay whole");
		// A real closer in the body still can't close the fence, any case.
		expect(fenced).toContain("<\\/note> and <\\/NOTE> close nothing");
		// Exactly one unescaped closer remains: the fence's own.
		expect(fenced.match(/<\/note>/g)).toHaveLength(1);
		expect(fenced.endsWith("\n</note>")).toBe(true);
	});
});

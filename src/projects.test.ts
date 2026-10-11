import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "./config.ts";
import { appAddress, type ConversationStore, openStore } from "./conversation.ts";
import {
	openProjects,
	ProjectInputError,
	type ProjectStore,
	projectWorkdir,
	resolveLinkedDir,
	slugify,
} from "./projects.ts";

// Each test gets a fresh $GOBLIN_HOME — paths.projects()/paths.state()
// resolve through the env var per call, so the domain sees the tmp
// layout without any module reset.
let dirs: string[] = [];
let prevHome: string | undefined;
function useHome(): string {
	prevHome = process.env.GOBLIN_HOME;
	const dir = mkdtempSync(join(tmpdir(), "goblin-projects-"));
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

function fixture(): { home: string; store: ConversationStore; projects: ProjectStore } {
	const home = useHome();
	mkdirSync(join(home, "state"), { recursive: true });
	const store = openStore(join(home, "state", "goblin.sqlite"));
	return { home, store, projects: openProjects(store) };
}

describe("slugify", () => {
	test("diacritics and punctuation fold to lowercase ASCII runs", () => {
		expect(slugify("Café Trip!")).toBe("cafe-trip");
		expect(slugify("  My   Cool   Project  ")).toBe("my-cool-project");
	});

	test("a name with nothing ASCII-safe is 'project'", () => {
		expect(slugify("")).toBe("project");
		expect(slugify("!!!")).toBe("project");
		expect(slugify("日本語")).toBe("project");
	});

	test("the slug caps at 48 chars without a trailing dash", () => {
		const slug = slugify(`x${"a".repeat(100)}`);
		expect(slug.length).toBeLessThanOrEqual(48);
		expect(slug.endsWith("-")).toBe(false);
		const edge = slugify(`${"a".repeat(47)}-${"b".repeat(10)}`);
		expect(edge).toBe("a".repeat(47));
	});
});

describe("resolveLinkedDir", () => {
	test("refuses a relative path, naming it", () => {
		expect(() => resolveLinkedDir("some/where")).toThrow(ProjectInputError);
		expect(() => resolveLinkedDir("some/where")).toThrow("some/where");
	});

	test("refuses a missing path and a regular file", () => {
		const home = useHome();
		expect(() => resolveLinkedDir(join(home, "nope"))).toThrow("does not exist");
		const file = join(home, "file.txt");
		writeFileSync(file, "x");
		expect(() => resolveLinkedDir(file)).toThrow("not a directory");
	});

	test("refuses anything under goblin's state directory", () => {
		const home = useHome();
		const state = join(home, "state");
		mkdirSync(state, { recursive: true });
		expect(() => resolveLinkedDir(state)).toThrow("state");
		const inside = join(state, "nested");
		mkdirSync(inside);
		expect(() => resolveLinkedDir(inside)).toThrow("state");
	});

	test("~/ expands to the home directory", () => {
		expect(resolveLinkedDir("~/")).toBe(
			resolveLinkedDir(process.env.HOME ?? join(tmpdir(), "unused")),
		);
		const expanded = resolveLinkedDir("~");
		expect(expanded).toBe(resolveLinkedDir("~/"));
	});

	test("a symlinked dir stores the realpath — repoints can't surprise a cwd", () => {
		const home = useHome();
		const target = join(home, "real-target");
		mkdirSync(target, { recursive: true });
		const link = join(home, "the-link");
		symlinkSync(target, link);
		expect(resolveLinkedDir(link)).toBe(target);
	});

	test("a symlink INTO the state directory is refused as state", () => {
		const home = useHome();
		const state = join(home, "state");
		mkdirSync(state, { recursive: true });
		const link = join(home, "state-link");
		symlinkSync(state, link);
		expect(() => resolveLinkedDir(link)).toThrow("state");
	});
});

describe("project store", () => {
	test("a managed project homes itself under projects/<slug>, lazily", () => {
		const { home, store, projects } = fixture();
		expect(existsSync(join(home, "projects"))).toBe(false);
		const p = projects.create({ name: "My App" });
		expect(p.slug).toBe("my-app");
		expect(p.home).toBe(join(home, "projects", "my-app"));
		expect(p.dir).toBe(p.home);
		expect(p.managed).toBe(true);
		expect(existsSync(p.home)).toBe(true);
		expect(projects.get(p.id)?.slug).toBe("my-app");
		store.close();
	});

	test("slug collisions suffix — against rows AND stray dirs on disk", () => {
		const { home, store, projects } = fixture();
		const a = projects.create({ name: "dup" });
		expect(a.slug).toBe("dup");
		// No row, just a leftover directory — the suffix must still move.
		mkdirSync(join(home, "projects", "dup-2"), { recursive: true });
		const b = projects.create({ name: "dup" });
		expect(b.slug).toBe("dup-3");
		expect(b.home).toBe(join(home, "projects", "dup-3"));
		store.close();
	});

	test("a refused link leaves no project row and no home on disk", () => {
		const { home, store, projects } = fixture();
		expect(() => projects.create({ name: "bad link", dir: "relative/path" })).toThrow(
			ProjectInputError,
		);
		expect(projects.list()).toHaveLength(0);
		expect(existsSync(join(home, "projects"))).toBe(false);
		store.close();
	});

	test("a linked project keeps its resolved dir and reads unmanaged", () => {
		const { home, store, projects } = fixture();
		const elsewhere = mkdtempSync(join(tmpdir(), "goblin-linked-"));
		dirs.push(elsewhere);
		const p = projects.create({ name: "linked", dir: elsewhere });
		expect(p.dir).toBe(elsewhere);
		expect(p.home).toBe(join(home, "projects", "linked"));
		expect(p.managed).toBe(false);
		// The managed home still exists — it holds project state even
		// though the chats cd elsewhere.
		expect(existsSync(p.home)).toBe(true);
		store.close();
	});

	test("rename never moves slug, home, or dir; archive stamps and clears", () => {
		const { store, projects } = fixture();
		const p = projects.create({ name: "first name", dir: "/tmp" });
		const renamed = projects.patch(p.id, { name: "second name" });
		expect(renamed.name).toBe("second name");
		expect(renamed.slug).toBe(p.slug);
		expect(renamed.home).toBe(p.home);
		expect(renamed.dir).toBe(p.dir);
		const archived = projects.patch(p.id, { archived: true });
		expect(archived.archivedAt).not.toBeNull();
		expect(projects.patch(p.id, { archived: false }).archivedAt).toBeNull();
		store.close();
	});

	test("list is newest-first, archived included", () => {
		const { store, projects } = fixture();
		const a = projects.create({ name: "one" });
		const b = projects.create({ name: "two" });
		projects.patch(a.id, { archived: true });
		const list = projects.list();
		expect(list.map((p) => p.id)).toEqual([b.id, a.id]);
		store.close();
	});

	test("memory off propagates: exclusion + epoch on project conversations only", () => {
		const { store, projects } = fixture();
		const cancelled: string[] = [];
		const withQueue = openProjects(store, {
			memoryQueue: {
				cancelConversation: (id: string) => {
					cancelled.push(id);
					return 2;
				},
			},
		});
		const project = withQueue.create({ name: "vault" });
		const inProject = store.resolve(appAddress("inside"), "/w");
		store.bindProject(inProject.id, project.id);
		const outside = store.resolve(appAddress("outside"), "/w");
		const epochBefore = store.get(inProject.id)!.epoch;
		const epochOutsideBefore = store.get(outside.id)!.epoch;

		withQueue.patch(project.id, { memory: "off" });
		const after = store.get(inProject.id)!;
		expect(after.memoryExcluded).toBe(true);
		expect(after.epoch).toBe(epochBefore + 1);
		expect(cancelled).toEqual([inProject.id]);
		// Unbound conversations are untouched.
		const afterOutside = store.get(outside.id)!;
		expect(afterOutside.memoryExcluded).toBe(false);
		expect(afterOutside.epoch).toBe(epochOutsideBefore);

		// off → shared restores nothing and bumps nothing.
		withQueue.patch(project.id, { memory: "shared" });
		const restored = store.get(inProject.id)!;
		expect(restored.memoryExcluded).toBe(true);
		expect(restored.epoch).toBe(epochBefore + 1);
		store.close();
	});

	test("already-excluded project conversations don't re-bump on off", () => {
		const { store, projects } = fixture();
		const project = projects.create({ name: "vault" });
		const conv = store.resolve(appAddress("inside"), "/w");
		store.bindProject(conv.id, project.id);
		store.applySettings(conv.id, { memoryExcluded: true });
		const epochBefore = store.get(conv.id)!.epoch;
		projects.patch(project.id, { memory: "off" });
		expect(store.get(conv.id)!.epoch).toBe(epochBefore);
		store.close();
	});
});

describe("conversation binding", () => {
	test("bindProject is write-once — a second, different project refuses", () => {
		const { store, projects } = fixture();
		const a = projects.create({ name: "a" });
		const b = projects.create({ name: "b" });
		const conv = store.resolve(appAddress("c"), "/w");
		store.bindProject(conv.id, a.id);
		expect(store.get(conv.id)!.projectId).toBe(a.id);
		expect(() => store.bindProject(conv.id, b.id)).toThrow("already bound");
		// Re-binding the same project is a no-op, not an error.
		store.bindProject(conv.id, a.id);
		expect(store.get(conv.id)!.projectId).toBe(a.id);
		store.close();
	});

	test("listProjectConversationIds names only the bound rows", () => {
		const { store, projects } = fixture();
		const a = projects.create({ name: "a" });
		const b = projects.create({ name: "b" });
		const c1 = store.resolve(appAddress("c1"), "/w");
		const c2 = store.resolve(appAddress("c2"), "/w");
		store.resolve(appAddress("c3"), "/w");
		store.bindProject(c1.id, a.id);
		store.bindProject(c2.id, b.id);
		expect(store.listProjectConversationIds(a.id)).toEqual([c1.id]);
		expect(store.listProjectConversationIds(b.id)).toEqual([c2.id]);
		store.close();
	});
});

describe("projectWorkdir", () => {
	test("unbound conversations keep the workspace", () => {
		const { store, projects } = fixture();
		const conv = store.resolve(appAddress("plain"), "/w");
		expect(projectWorkdir(projects, conv)).toBe(paths.workspace());
		store.close();
	});

	test("a bound conversation works in its project dir", () => {
		const { store, projects } = fixture();
		const project = projects.create({ name: "p" });
		const conv = store.resolve(appAddress("bound"), "/w");
		store.bindProject(conv.id, project.id);
		expect(projectWorkdir(projects, store.get(conv.id)!)).toBe(project.dir);
		store.close();
	});

	test("a vanished project dir throws naming the dir — no workspace fallback", () => {
		const { store, projects } = fixture();
		const project = projects.create({ name: "p" });
		const conv = store.resolve(appAddress("bound"), "/w");
		store.bindProject(conv.id, project.id);
		rmSync(project.dir, { recursive: true, force: true });
		expect(() => projectWorkdir(projects, store.get(conv.id)!)).toThrow(project.dir);
		store.close();
	});

	test("a missing project row throws naming the binding", () => {
		const { store, projects } = fixture();
		const conv = store.resolve(appAddress("bound"), "/w");
		// No legitimate path unbinds — the FK keeps the column honest, so
		// a dangling reference has to be forged past it to model e.g. a
		// hand-deleted row.
		store.db.run("PRAGMA foreign_keys = OFF");
		store.db.run("UPDATE conversations SET project_id = ? WHERE id = ?", ["ghost", conv.id]);
		expect(() => projectWorkdir(projects, store.get(conv.id)!)).toThrow("ghost");
		store.close();
	});
});

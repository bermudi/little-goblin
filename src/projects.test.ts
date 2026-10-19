import { describe, expect, test } from "bun:test";
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
import { tmpDir, useHome } from "./testkit.ts";

// Fresh $GOBLIN_HOME per test — paths.projects()/paths.state() resolve
// through the env var per call, no module reset needed.

function fixture(): { home: string; store: ConversationStore; projects: ProjectStore } {
	const home = useHome("goblin-projects-");
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
		const home = useHome("goblin-projects-");
		expect(() => resolveLinkedDir(join(home, "nope"))).toThrow("does not exist");
		const file = join(home, "file.txt");
		writeFileSync(file, "x");
		expect(() => resolveLinkedDir(file)).toThrow("not a directory");
	});

	test("refuses goblin's home and anything under it", () => {
		const home = useHome("goblin-projects-");
		expect(() => resolveLinkedDir(home)).toThrow("goblin's home");
		const state = join(home, "state");
		mkdirSync(join(home, "projects"), { recursive: true });
		mkdirSync(join(home, "workspace"), { recursive: true });
		mkdirSync(state, { recursive: true });
		expect(() => resolveLinkedDir(state)).toThrow("goblin's home");
		expect(() => resolveLinkedDir(join(home, "projects"))).toThrow("goblin's home");
		expect(() => resolveLinkedDir(join(home, "workspace"))).toThrow("goblin's home");
		const inside = join(state, "nested");
		mkdirSync(inside, { recursive: true });
		expect(() => resolveLinkedDir(inside)).toThrow("goblin's home");
	});

	test("~/ expands to the home directory", () => {
		expect(resolveLinkedDir("~/")).toBe(
			resolveLinkedDir(process.env.HOME ?? join(tmpdir(), "unused")),
		);
		const expanded = resolveLinkedDir("~");
		expect(expanded).toBe(resolveLinkedDir("~/"));
	});

	test("a symlinked dir stores the realpath — repoints can't surprise a cwd", () => {
		useHome("goblin-projects-");
		// Inside $GOBLIN_HOME the link is refused before resolution
		// matters — keep both ends outside.
		const outside = tmpDir("goblin-linked-");
		const target = join(outside, "real-target");
		mkdirSync(target, { recursive: true });
		const link = join(outside, "the-link");
		symlinkSync(target, link);
		expect(resolveLinkedDir(link)).toBe(target);
	});

	test("a symlink INTO goblin's home is refused", () => {
		const home = useHome("goblin-projects-");
		const state = join(home, "state");
		mkdirSync(state, { recursive: true });
		const outside = tmpDir("goblin-linked-");
		const link = join(outside, "state-link");
		symlinkSync(state, link);
		expect(() => resolveLinkedDir(link)).toThrow("goblin's home");
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
		// A leftover directory without a row — the suffix must still move.
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
		const elsewhere = tmpDir("goblin-linked-");
		const p = projects.create({ name: "linked", dir: elsewhere });
		expect(p.dir).toBe(elsewhere);
		expect(p.home).toBe(join(home, "projects", "linked"));
		expect(p.managed).toBe(false);
		// The managed home holds project state — chats cd elsewhere but
		// it must still exist.
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
		// Unbound conversations must stay untouched.
		const afterOutside = store.get(outside.id)!;
		expect(afterOutside.memoryExcluded).toBe(false);
		expect(afterOutside.epoch).toBe(epochOutsideBefore);

		// off → shared restores nothing, bumps nothing.
		withQueue.patch(project.id, { memory: "shared" });
		const restored = store.get(inProject.id)!;
		expect(restored.memoryExcluded).toBe(true);
		expect(restored.epoch).toBe(epochBefore + 1);
		store.close();
	});

	// The durable queue is always wired (index.ts): pending retention
	// left over from a memory-on run must purge on shared → off even
	// when no memory client exists — otherwise it submits on re-enable.
	test("project memory off purges pending retention through the real outbox", () => {
		const { store } = fixture();
		const projects = openProjects(store, { memoryQueue: store.memoryQueue });
		const project = projects.create({ name: "vault" });
		const conv = store.resolve(appAddress("inside"), "/w");
		store.bindProject(conv.id, project.id);
		const target = "a".repeat(64);
		const opId = store.memoryQueue.enqueue(target, {
			id: "exchange/app/inside/1/a",
			content: "Operator: hi\nGoblin: hello",
			timestamp: new Date().toISOString(),
			conversationId: conv.id,
			sourceIds: ["u1", "a1"],
		});
		expect(store.memoryQueue.get(opId)).not.toBeNull();
		projects.patch(project.id, { memory: "off" });
		expect(store.memoryQueue.get(opId)).toBeNull();
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
		// Re-binding the same project is a no-op.
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

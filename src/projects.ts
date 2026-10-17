// Projects — a named scope over app conversations: their own working
// directory and prompt section (design/projects.md). A project is a row
// in goblin.sqlite plus a goblin-owned `home` under $GOBLIN_HOME/projects
// (created lazily, never in ensureHomeLayout); `dir` is the working
// directory — home for managed projects, a validated existing path for
// linked ones. The slug derives from the name once and is frozen:
// renaming never moves home or dir, so paths recorded by delegations
// and tool output stay valid. Binding is fixed at conversation creation
// — no move between projects (cache stability, same doc).

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ensureDir, goblinHome, paths } from "./config.ts";
import type { Conversation, ConversationStore } from "./conversation.ts";
import { log } from "./log.ts";
import type { MemoryQueue } from "./memory/queue.ts";

export interface Project {
	id: string;
	name: string;
	slug: string;
	// Goblin-owned scratch, always $GOBLIN_HOME/projects/<slug>. Never
	// sent to the client — dir is the only path a conversation uses.
	home: string;
	dir: string;
	managed: boolean; // dir === home
	instructions: string;
	memory: "shared" | "off";
	createdAt: string;
	archivedAt: string | null;
}

// Operator-facing input refused at the domain boundary — the HTTP
// layer maps this to 422; everything else propagates as a 500.
export class ProjectInputError extends Error {}

// Lowercase ASCII, runs of anything else collapse to one "-", 48 chars
// max, "project" when nothing survives. Once minted it never changes.
export function slugify(name: string): string {
	const slug = name
		.normalize("NFKD")
		// Combining marks the decomposition split off (é → e + ̀).
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		.replace(/-+$/g, "");
	return slug === "" ? "project" : slug;
}

// A linked working directory, validated at creation. "~/"-expansion is
// the only convenience — `~user` is not expanded and fails the absolute
// check below (delegate.ts's isHomePath ruling). The realpath is what
// lands in the row: symlinked dirs are stored resolved so cwd changes
// under a repointed link can't surprise a running conversation.
export function resolveLinkedDir(input: string): string {
	const expanded =
		input === "~" ? homedir() : input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
	if (!isAbsolute(expanded)) {
		throw new ProjectInputError(`project dir must be an absolute path or ~/...: ${input}`);
	}
	let real: string;
	try {
		real = realpathSync(expanded);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			throw new ProjectInputError(`project dir does not exist: ${input}`);
		}
		throw err;
	}
	if (!statSync(real).isDirectory()) {
		throw new ProjectInputError(`project dir is not a directory: ${input}`);
	}
	// $GOBLIN_HOME holds the state DB, the log, goblin.json5, auth.jsonl,
	// workspace (SOUL.md, skills), and the managed-project homes — a chat
	// cwd'd anywhere in there reads and writes goblin's own guts.
	// Compare realpaths: a symlink into the tree is the same refusal.
	let homeReal: string;
	try {
		homeReal = realpathSync(goblinHome());
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		homeReal = goblinHome();
	}
	if (real === homeReal || real.startsWith(`${homeReal}/`)) {
		throw new ProjectInputError(`project dir must not be inside goblin's home directory: ${input}`);
	}
	return real;
}

export interface ProjectStore {
	create(input: {
		name: string;
		instructions?: string | undefined;
		memory?: "shared" | "off" | undefined;
		dir?: string | undefined;
	}): Project;
	get(id: string): Project | null;
	// All projects, archived included, newest first.
	list(): Project[];
	patch(
		id: string,
		patch: {
			name?: string | undefined;
			instructions?: string | undefined;
			memory?: "shared" | "off" | undefined;
			archived?: boolean | undefined;
		},
	): Project;
}

// Owned here, driven by openStore — the conversations project_id
// migration references this table, so it must exist first.
export function ensureProjectsSchema(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS projects (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			slug TEXT NOT NULL UNIQUE,
			home TEXT NOT NULL,
			dir TEXT NOT NULL,
			instructions TEXT NOT NULL DEFAULT '',
			memory TEXT NOT NULL DEFAULT 'shared' CHECK (memory IN ('shared','off')),
			created_at TEXT NOT NULL,
			archived_at TEXT
		)`);
}

interface ProjectRow {
	id: string;
	name: string;
	slug: string;
	home: string;
	dir: string;
	instructions: string;
	memory: string;
	created_at: string;
	archived_at: string | null;
}

function toProject(r: ProjectRow): Project {
	return {
		id: r.id,
		name: r.name,
		slug: r.slug,
		home: r.home,
		dir: r.dir,
		managed: r.dir === r.home,
		instructions: r.instructions,
		memory: r.memory === "off" ? "off" : "shared",
		createdAt: r.created_at,
		archivedAt: r.archived_at,
	};
}

// The turn's working directory: the project's dir for a bound
// conversation, the deployment workspace otherwise. A vanished dir
// fails the turn — never a silent fall-back to the workspace (the
// makeTools call site runs inside the turn's admission try, so the
// throw lands as a failed turn, not a crash).
export function projectWorkdir(projects: ProjectStore, conv: Conversation): string {
	if (conv.projectId === null) return paths.workspace();
	const project = projects.get(conv.projectId);
	if (project === null) {
		log.error("project dir missing", {
			conversation: conv.id,
			project: conv.projectId,
			dir: null,
		});
		throw new Error(`conversation ${conv.id} is bound to a missing project ${conv.projectId}`);
	}
	let isDir = false;
	try {
		isDir = statSync(project.dir).isDirectory();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	if (!isDir) {
		log.error("project dir missing", {
			conversation: conv.id,
			project: project.id,
			dir: project.dir,
		});
		throw new Error(`project "${project.name}" working directory is missing: ${project.dir}`);
	}
	return project.dir;
}

export function openProjects(
	store: ConversationStore,
	deps?: {
		// The retention outbox — wired whenever a store exists, client
		// or not: pending rows from an earlier memory-on run must still
		// purge when a project switches to off, the way /memory off does.
		memoryQueue?: Pick<MemoryQueue, "cancelConversation">;
	},
): ProjectStore {
	const db = store.db;
	const qGet = db.query<ProjectRow, [string]>("SELECT * FROM projects WHERE id = ?");
	const qSlug = db.query<{ id: string }, [string]>("SELECT id FROM projects WHERE slug = ?");
	const qList = db.query<ProjectRow, []>(
		"SELECT * FROM projects ORDER BY created_at DESC, rowid DESC",
	);
	const qInsert = db.query(
		`INSERT INTO projects (id, name, slug, home, dir, instructions, memory, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	);

	function get(id: string): Project | null {
		const row = qGet.get(id);
		return row === null ? null : toProject(row);
	}

	function create(input: {
		name: string;
		instructions?: string | undefined;
		memory?: "shared" | "off" | undefined;
		dir?: string | undefined;
	}): Project {
		const name = input.name.trim();
		if (name === "") throw new ProjectInputError("project name is empty");
		// A refused link leaves nothing on disk — validate before the
		// home dir exists (operator ruling: validation at creation).
		const linked = input.dir !== undefined ? resolveLinkedDir(input.dir) : null;
		const base = slugify(name);
		let slug = base;
		// A slug is taken by a row OR by a stray directory on disk — a
		// collision there would mix two projects' scratch space.
		for (let n = 2; qSlug.get(slug) !== null || existsSync(join(paths.projects(), slug)); n++) {
			slug = `${base}-${n}`;
		}
		const home = join(paths.projects(), slug);
		ensureDir(home);
		const dir = linked ?? home;
		const id = randomUUID();
		qInsert.run(
			id,
			name,
			slug,
			home,
			dir,
			input.instructions ?? "",
			input.memory ?? "shared",
			new Date().toISOString(),
		);
		log.info("project created", {
			id,
			slug,
			dir,
			managed: dir === home,
			memory: input.memory ?? "shared",
		});
		const created = get(id);
		if (created === null) throw new Error(`project ${id} insert failed`);
		return created;
	}

	function patch(
		id: string,
		patch: {
			name?: string | undefined;
			instructions?: string | undefined;
			memory?: "shared" | "off" | undefined;
			archived?: boolean | undefined;
		},
	): Project {
		return db.transaction(() => {
			const current = get(id);
			if (current === null) throw new Error(`project ${id} not found`);
			const sets: string[] = [];
			const vals: (string | null)[] = [];
			if (patch.name !== undefined) {
				const name = patch.name.trim();
				if (name === "") throw new ProjectInputError("project name is empty");
				sets.push("name = ?");
				vals.push(name);
			}
			if (patch.instructions !== undefined) {
				sets.push("instructions = ?");
				vals.push(patch.instructions);
			}
			if (patch.memory !== undefined) {
				sets.push("memory = ?");
				vals.push(patch.memory);
			}
			if (patch.archived !== undefined) {
				sets.push("archived_at = ?");
				vals.push(patch.archived ? new Date().toISOString() : null);
			}
			if (sets.length > 0) {
				vals.push(id);
				db.run(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`, vals);
			}
			log.info("project updated", { id, fields: Object.keys(patch) });
			if (patch.archived !== undefined) {
				log.info("project archived", { id, archived: patch.archived });
			}
			// shared → off is a privacy act: every project conversation
			// gets the memoryExcluded patch (epoch bump included — a live
			// turn is fenced), and queued retention is purged like /memory
			// off. off → shared touches nothing existing: re-enabling a
			// conversation stays a per-conversation choice.
			if (patch.memory === "off" && current.memory === "shared") {
				let conversations = 0;
				let cancelled = 0;
				for (const convId of store.listProjectConversationIds(id)) {
					if (store.get(convId)?.memoryExcluded !== false) continue;
					store.applySettings(convId, { memoryExcluded: true });
					conversations++;
					cancelled += deps?.memoryQueue?.cancelConversation(convId) ?? 0;
				}
				log.info("project memory off propagated", { project: id, conversations, cancelled });
			}
			const updated = get(id);
			if (updated === null) throw new Error(`project ${id} update failed`);
			return updated;
		})();
	}

	return {
		create,
		get,
		list() {
			return qList.all().map(toProject);
		},
		patch,
	};
}

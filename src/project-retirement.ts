import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdtempSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { LITTLE_GOBLIN_BOT_ID } from "./bots.ts";
import { reconcilePinsAfterOwnershipChange } from "./chat-note-pins.ts";
import { appIdOf } from "./conversation-address.ts";
import { ensureConversationSchema } from "./conversation-schema.ts";
import { log } from "./log.ts";
import { MemoryQueue } from "./memory/queue.ts";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const projectIds = z.array(z.uuidv4());

interface ProjectRow {
	id: string;
	name: string;
	dir: string;
	instructions: string;
	memory: "shared" | "off";
	archived_at: string | null;
}

interface ChatRow {
	id: string;
	archived_at: string | null;
	memory_excluded: number;
}

interface NoteRow {
	id: string;
	state_rev: number;
}

function recordedRetirements(db: Database): Map<string, string> {
	const exists = db.query("SELECT 1 FROM sqlite_schema WHERE name = 'project_retirements'").get();
	if (exists === null) return new Map();
	return new Map(db.query<{ project_id: string; bot_id: string }, []>(
		"SELECT project_id, bot_id FROM project_retirements",
	).all().map(({ project_id, bot_id }) => [project_id, bot_id]));
}

function retirementWork(db: Database, toBot: readonly string[]) {
	const selected = new Set(projectIds.parse(toBot));
	if (selected.size !== toBot.length) throw new Error("Duplicate project in --to-bot.");
	const retired = recordedRetirements(db);
	const projects = db.query<ProjectRow, []>(`
		SELECT id, name, dir, instructions, memory, archived_at FROM projects ORDER BY id
	`).all();
	for (const id of selected) {
		if (!projects.some((project) => project.id === id)) throw new Error(`No project ${id}.`);
		if (retired.has(id) && retired.get(id) !== id) {
			throw new Error(`Project ${id} already retired to Little Goblin.`);
		}
	}
	const chats = db.query<ChatRow, [string]>(`
		SELECT id, archived_at, memory_excluded FROM conversations WHERE project_id = ? ORDER BY id
	`);
	const notes = db.query<NoteRow, [string]>("SELECT id, state_rev FROM notes WHERE project_id = ? ORDER BY id");
	return projects.flatMap((project) => {
		const projectChats = chats.all(project.id);
		const projectNotes = notes.all(project.id);
		if (retired.has(project.id)) {
			if (projectChats.length > 0 || projectNotes.length > 0) {
				throw new Error(`Project ${project.id} already retired but has new bindings. Restore or reconcile before proceeding.`);
			}
			return [];
		}
		if (projectChats.some(({ id }) => appIdOf(id) === null)) {
			throw new Error(`Project ${project.id} contains a non-app chat.`);
		}
		const botId = selected.has(project.id) ? z.uuidv4().parse(project.id) : LITTLE_GOBLIN_BOT_ID;
		return [{ project, botId, chats: projectChats, notes: projectNotes }];
	});
}

function describe(work: ReturnType<typeof retirementWork>) {
	const projects = work.map(({ project, botId, chats, notes }) => {
		const createsBot = botId !== LITTLE_GOBLIN_BOT_ID;
		const hasInstructions = project.instructions.trim() !== "";
		return {
			projectId: project.id,
			name: project.name,
			targetBotId: botId,
			archivedAt: project.archived_at,
			workingDirectory: project.dir,
			mainChatId: createsBot ? `app/project-${botId}` : null,
			instructions: createsBot ? "bot settings" : hasInstructions ? "new note" : "none",
			instructionsHash: digest(project.instructions),
			noteIds: notes.map(({ id, state_rev }) => ({ id, stateRevision: state_rev })),
			sideChats: chats.map((chat) => ({
				id: chat.id,
				archivedAt: chat.archived_at ?? project.archived_at,
				memoryExcluded: chat.memory_excluded === 1 || project.memory === "off",
			})),
		};
	});
	return { approval: digest(JSON.stringify(projects)), projects };
}

export function requireRetiredProjects(db: Database): void {
	const retired = db.query<{ ready: number }, []>(`SELECT NOT EXISTS (
		SELECT 1 FROM projects AS p
		WHERE NOT EXISTS (SELECT 1 FROM project_retirements WHERE project_id = p.id)
	) AND NOT EXISTS (SELECT 1 FROM conversations WHERE project_id IS NOT NULL)
	  AND NOT EXISTS (SELECT 1 FROM notes WHERE project_id IS NOT NULL) AS ready`).get();
	if (retired?.ready !== 1) {
		throw new Error("Projects must be retired before starting this release. See the project retirement runbook.");
	}
}

export function previewProjectRetirement(path: string, toBot: readonly string[]) {
	using db = new Database(path, { readonly: true });
	return db.transaction(() => describe(retirementWork(db, toBot)))();
}

function backupDatabase(path: string): string {
	const dir = mkdtempSync(join(dirname(path), "before-project-retirement-"));
	const file = join(dir, "goblin.sqlite");
	const result = Bun.spawnSync(["sqlite3", "-readonly", "-batch", "-bail", path, ".backup goblin.sqlite"], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (!result.success) throw new Error(`Could not back up the database: ${result.stderr.toString().trim()}`);
	chmodSync(file, 0o600);
	using backup = new Database(file, { readonly: true });
	const integrity = backup.query<{ quick_check: string }, []>("PRAGMA quick_check(1)").get();
	if (integrity?.quick_check !== "ok") throw new Error(`Backup failed integrity check: ${file}`);
	for (const entry of [file, dir, dirname(dir)]) {
		const fd = openSync(entry, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	}
	return file;
}

export function applyProjectRetirement(
	path: string,
	toBot: readonly string[],
	approval: string,
	now = new Date(),
) {
	using db = new Database(path, { readwrite: true, create: false });
	db.run("PRAGMA foreign_keys = ON");
	db.run("PRAGMA synchronous = FULL");
	const result = db.transaction(() => {
		const work = retirementWork(db, toBot);
		const plan = describe(work);
		if (work.length === 0) return { ...plan, backup: null };
		if (plan.approval !== approval) throw new Error("Project retirement plan changed. Review a new dry run before applying.");
		const backup = backupDatabase(path);
		log.info("project retirement database backed up", { backup });
		ensureConversationSchema(db);
		const memory = new MemoryQueue(db);
		const at = now.toISOString();
		reconcilePinsAfterOwnershipChange(db, () => {
			for (const { project, botId, chats, notes } of work) {
				if (botId !== LITTLE_GOBLIN_BOT_ID) {
					const main = `app/project-${botId}`;
					db.run("INSERT INTO bots (id, name, created_at, instructions, folder) VALUES (?, ?, ?, ?, ?)", [
						botId, project.name, now.getTime(), project.instructions, project.dir,
					]);
					db.run(`INSERT INTO conversations (id, chat_id, thread_id, cwd, created_at, epoch)
						VALUES (?, 0, NULL, ?, ?, COALESCE(
							(SELECT epoch + 1 FROM conversation_epoch_hwm WHERE conversation_id = ?), 0
						))`, [main, project.dir, at, main]);
					db.run("INSERT INTO bot_chats (conversation_id, bot_id, main_ordinal) VALUES (?, ?, 1)", [main, botId]);
				} else if (project.instructions.trim() !== "") {
					db.run(`INSERT INTO notes (id, bot_id, title, body_md, rev, state_rev, last_source, created_at, updated_at)
						VALUES (?, ?, ?, ?, 1, 1, 'app', ?, ?)`, [
						`project-instructions-${project.id}`, botId, `${project.name} instructions`.slice(0, 200),
						project.instructions, at, at,
					]);
				}
				for (const chat of chats) {
					const memoryOff = chat.memory_excluded === 1 || project.memory === "off";
					const archivedAt = chat.archived_at ?? project.archived_at;
					db.run(`UPDATE conversations SET project_id = NULL, fixed_workdir = ?, cwd = ?,
						memory_excluded = ?, memory_excluded_by_project = 0,
						archived_at = ?, pinned_at = CASE WHEN ? IS NULL THEN pinned_at END
						WHERE id = ?`, [project.dir, project.dir, Number(memoryOff), archivedAt, archivedAt, chat.id]);
					if (botId !== LITTLE_GOBLIN_BOT_ID) {
						db.run("INSERT INTO bot_chats (conversation_id, bot_id) VALUES (?, ?)", [chat.id, botId]);
					}
					if (memoryOff || botId !== LITTLE_GOBLIN_BOT_ID) memory.cancelConversation(chat.id);
				}
				for (const { id } of notes) {
					db.run(`UPDATE notes SET project_id = NULL, bot_id = ?, rev = rev + 1,
						state_rev = state_rev + 1, updated_at = ? WHERE id = ?`, [botId, at, id]);
					db.run(`INSERT INTO note_edits (note_id, rev, at, what, reason)
						SELECT id, rev, ?, 'Moved from a retired project', 'Project retirement' FROM notes WHERE id = ?`, [at, id]);
				}
				db.run("INSERT INTO project_retirements (project_id, bot_id) VALUES (?, ?)", [project.id, botId]);
			}
		});
		requireRetiredProjects(db);
		return { ...plan, backup };
	}).immediate();
	log.info("project retirement complete", { projects: result.projects.length });
	return result;
}

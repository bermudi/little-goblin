// Notes — the operator's writing surface outside conversations
// (design/projects.md → Notes). Rows, not files: the server mediates
// every mutation so snapshot-before-edit, `expected`-guarded range
// edits, and a live `rev` exist for attach and the editor's If-Match.
// body_md is the only format — what the model reads is what the
// editor saves.
//
// Every content write rides ONE path (`write`): it versions the
// pre-write state, bumps rev, and prunes past 100 versions, all in
// one transaction. Flags (pin/archive/move) never touch content and
// bump nothing — the cache-stability split between a conversation's
// frozen prompt and a note's freely-moving scope.

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type ConversationStore, flatLine, toFtsQuery } from "./conversation.ts";
import { log } from "./log.ts";
import type { ProjectStore } from "./projects.ts";

export type NoteSource = "app" | "agent" | "rewrite" | "append" | "restore";

export interface Note {
	id: string;
	// null = a loose note — it can move between projects or out to
	// loose (it carries no prompt cache; frozen indexes just show the
	// stale scope until their next build).
	projectId: string | null;
	title: string;
	body: string;
	rev: number;
	lastSource: NoteSource;
	pinnedAt: string | null;
	archivedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface NoteSummary {
	id: string;
	projectId: string | null;
	title: string;
	rev: number;
	pinnedAt: string | null;
	archivedAt: string | null;
	updatedAt: string;
	preview: string;
}

export interface NoteVersionMeta {
	rev: number;
	source: NoteSource;
	conversation: string | null;
	at: string;
	bytes: number;
}

export interface NoteVersion extends NoteVersionMeta {
	title: string;
	body: string;
}

// Operator-facing refusals → HTTP 422; a conflict carries the current
// note so the 409 body can hand it back whole.
export class NoteInputError extends Error {}
export class NoteRangeError extends Error {
	constructor(
		message: string,
		public readonly rev: number,
	) {
		super(message);
	}
}
export class NoteConflictError extends Error {
	constructor(public readonly note: Note) {
		super(`note ${note.id} is at rev ${note.rev}`);
	}
}

// The attach part (design/projects.md → Attach): the client sends only
// {id}; intake expands it to this shape, which is what history stores
// and the model view renders — never a client-supplied body.
export const NOTE_PART = "data-note";
export const notePartDataSchema = z.object({
	id: z.string().min(1),
	title: z.string(),
	rev: z.number().int().positive(),
	body: z.string(),
	projectId: z.string().nullable(),
});
export type NotePartData = z.infer<typeof notePartDataSchema>;

// The fenced rendering the note tool's read and the model view share.
// Attributes carry id/rev/title; a literal `</note` inside the body is
// neutralized so operator text can't close its own fence (the
// delegation <event> ruling).
export function noteFence(d: { id: string; title: string; rev: number; body: string }): string {
	// id/title ride XML attributes — escape the full entity set, not
	// just quotes, or a crafted title can break out of the attribute.
	const attr = (s: string) =>
		s
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&apos;");
	const body = d.body.replace(/<\/note/gi, "<\\/note");
	return `<note id="${attr(d.id)}" rev="${d.rev}" title="${attr(d.title)}">\n${body}\n</note>`;
}

// Autosave coalescing: an `app` write versions the prior state only
// when the previous write wasn't app-sourced or the newest version is
// this old — a typing session is one version, not hundreds.
const APP_VERSION_GAP_MS = 10 * 60 * 1000;
const VERSION_CAP = 100;

export interface NoteStore {
	create(input: {
		title: string;
		body?: string | undefined;
		projectId?: string | null | undefined;
	}): Note;
	get(id: string): Note | null;
	// project: a project id, "loose" (project_id IS NULL), or "all"
	// (default). archived: true lists the archived shelf only; default
	// is active notes. q searches title+body via notes_fts.
	list(filter?: {
		project?: string | "loose" | "all" | undefined;
		q?: string | undefined;
		archived?: boolean | undefined;
		limit?: number | undefined;
	}): NoteSummary[];
	// The one content-write path (see header). expectedRev refuses a
	// stale writer with the live note; a no-op write bumps nothing.
	write(
		id: string,
		next: { title?: string | undefined; body?: string | undefined },
		source: NoteSource,
		opts?: { conversation?: string | undefined; expectedRev?: number | undefined },
	): Note;
	append(id: string, text: string, source: NoteSource, conversation?: string): Note;
	// UTF-16 offsets into body_md, each guarded by the text currently
	// there — a mismatch or overlap refuses the whole call with nothing
	// written (NoteRangeError carries the current rev).
	replaceRanges(
		id: string,
		edits: { start: number; end: number; expected: string; text: string }[],
		conversation?: string,
	): Note;
	restore(id: string, rev: number): Note;
	setPinned(id: string, pinned: boolean): Note;
	setArchived(id: string, archived: boolean): Note;
	move(id: string, projectId: string | null): Note;
	listVersions(id: string): NoteVersionMeta[];
	getVersion(id: string, rev: number): NoteVersion | null;
	// Archived only — the conversation archive pattern.
	delete(id: string): void;
	// The prompt's index slice: non-archived, pinned first then recent.
	index(projectId: string, cap?: number): { id: string; title: string }[];
}

// Owned here, driven by openStore right after ensureProjectsSchema —
// the project_id reference needs that table first.
export function ensureNotesSchema(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS notes (
			id TEXT PRIMARY KEY,
			project_id TEXT REFERENCES projects(id),
			title TEXT NOT NULL,
			body_md TEXT NOT NULL DEFAULT '',
			rev INTEGER NOT NULL DEFAULT 1,
			last_source TEXT NOT NULL DEFAULT 'app',
			pinned_at TEXT,
			archived_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`);
	// Versions are full pre-write copies (the Open WebUI pattern),
	// capped at the newest 100 per note — `source` names the write that
	// superseded this state, so every agent edit is one restore away.
	db.run(`
		CREATE TABLE IF NOT EXISTS note_versions (
			note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
			rev INTEGER NOT NULL,
			title TEXT NOT NULL,
			body_md TEXT NOT NULL,
			source TEXT NOT NULL CHECK (source IN ('app','agent','rewrite','append','restore')),
			conversation TEXT,
			at TEXT NOT NULL,
			PRIMARY KEY (note_id, rev)
		)`);
	// External-content FTS5 (the events_fts pattern): the index mirrors
	// title+body through triggers; MATCH goes through toFtsQuery so no
	// query syntax reaches it. rows join on notes.rowid — the TEXT
	// primary key isn't the rowid.
	db.run(`
		CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
			title, body_md, content='notes', content_rowid='rowid', tokenize='porter'
		)`);
	db.run(`CREATE TRIGGER IF NOT EXISTS notes_fts_ai AFTER INSERT ON notes BEGIN
		INSERT INTO notes_fts(rowid, title, body_md) VALUES (new.rowid, new.title, new.body_md); END`);
	db.run(`CREATE TRIGGER IF NOT EXISTS notes_fts_ad AFTER DELETE ON notes BEGIN
		INSERT INTO notes_fts(notes_fts, rowid, title, body_md)
		VALUES('delete', old.rowid, old.title, old.body_md); END`);
	db.run(`CREATE TRIGGER IF NOT EXISTS notes_fts_au AFTER UPDATE ON notes BEGIN
		INSERT INTO notes_fts(notes_fts, rowid, title, body_md)
		VALUES('delete', old.rowid, old.title, old.body_md);
		INSERT INTO notes_fts(rowid, title, body_md) VALUES (new.rowid, new.title, new.body_md); END`);
	// A fresh table on an upgraded DB indexes what already exists —
	// 'rebuild' reads the content table, no hand-rolled backfill.
	const ftsEmpty =
		db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM notes_fts").get()?.n === 0;
	const notesCount = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM notes").get()?.n;
	if (ftsEmpty && (notesCount ?? 0) > 0) {
		db.run("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')");
	}
}

interface NoteRow {
	id: string;
	project_id: string | null;
	title: string;
	body_md: string;
	rev: number;
	last_source: string;
	pinned_at: string | null;
	archived_at: string | null;
	created_at: string;
	updated_at: string;
}

interface VersionRow {
	rev: number;
	title: string;
	body_md: string;
	source: string;
	conversation: string | null;
	at: string;
}

function toNote(r: NoteRow): Note {
	return {
		id: r.id,
		projectId: r.project_id,
		title: r.title,
		body: r.body_md,
		rev: r.rev,
		lastSource: r.last_source as NoteSource,
		pinnedAt: r.pinned_at,
		archivedAt: r.archived_at,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	};
}

function toVersionMeta(r: VersionRow): NoteVersionMeta {
	return {
		rev: r.rev,
		source: r.source as NoteSource,
		conversation: r.conversation,
		at: r.at,
		bytes: Buffer.byteLength(r.body_md),
	};
}

export function openNotes(
	store: ConversationStore,
	deps: {
		projects: Pick<ProjectStore, "get">;
		// Injectable for the coalescing tests — the version's `at`
		// stamps from this clock.
		now?: (() => Date) | undefined;
	},
): NoteStore {
	const db = store.db;
	const now = deps.now ?? (() => new Date());
	const qGet = db.query<NoteRow, [string]>("SELECT * FROM notes WHERE id = ?");
	const qNewestVersion = db.query<VersionRow, [string]>(
		"SELECT * FROM note_versions WHERE note_id = ? ORDER BY rev DESC LIMIT 1",
	);
	const qVersions = db.query<VersionRow, [string]>(
		"SELECT * FROM note_versions WHERE note_id = ? ORDER BY rev DESC",
	);
	const qVersion = db.query<VersionRow, [string, number]>(
		"SELECT * FROM note_versions WHERE note_id = ? AND rev = ?",
	);
	const qIndex = db.query<{ id: string; title: string }, [string, number]>(
		`SELECT id, title FROM notes
		 WHERE project_id = ? AND archived_at IS NULL
		 ORDER BY pinned_at IS NOT NULL DESC, updated_at DESC LIMIT ?`,
	);

	function get(id: string): Note | null {
		const row = qGet.get(id);
		return row === null ? null : toNote(row);
	}

	function mustGet(id: string): Note {
		const note = get(id);
		if (note === null) throw new NoteInputError(`no such note: ${id}`);
		return note;
	}

	function checkProjectId(projectId: string | null): void {
		if (projectId === null) return;
		const project = deps.projects.get(projectId);
		if (project === null) throw new NoteInputError(`no such project: ${projectId}`);
		if (project.archivedAt !== null) {
			throw new NoteInputError(`project is archived: ${project.name}`);
		}
	}

	function write(
		id: string,
		next: { title?: string | undefined; body?: string | undefined },
		source: NoteSource,
		opts: { conversation?: string | undefined; expectedRev?: number | undefined } = {},
	): Note {
		return db.transaction(() => {
			const current = mustGet(id);
			if (opts.expectedRev !== undefined && opts.expectedRev !== current.rev) {
				log.info("note conflict", {
					note: id,
					expectedRev: opts.expectedRev,
					rev: current.rev,
				});
				throw new NoteConflictError(current);
			}
			const title = next.title ?? current.title;
			const body = next.body ?? current.body;
			if (title === current.title && body === current.body) return current;
			// The PRE-write state is the version — its `source` names the
			// write superseding it. App autosaves coalesce: record only on
			// a source change, a >10min gap, or the first version.
			let versioned = false;
			if (source !== "app" || current.lastSource !== "app") {
				versioned = true;
			} else {
				const newest = qNewestVersion.get(id);
				versioned = newest === null || now().getTime() - Date.parse(newest.at) > APP_VERSION_GAP_MS;
			}
			if (versioned) {
				db.run(
					`INSERT INTO note_versions (note_id, rev, title, body_md, source, conversation, at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
					[
						id,
						current.rev,
						current.title,
						current.body,
						source,
						opts.conversation ?? null,
						now().toISOString(),
					],
				);
				db.run(
					`DELETE FROM note_versions WHERE note_id = ? AND rev NOT IN
					 (SELECT rev FROM note_versions WHERE note_id = ? ORDER BY rev DESC LIMIT ?)`,
					[id, id, VERSION_CAP],
				);
			}
			const updatedAt = now().toISOString();
			db.run(
				"UPDATE notes SET title = ?, body_md = ?, rev = rev + 1, last_source = ?, updated_at = ? WHERE id = ?",
				[title, body, source, updatedAt, id],
			);
			const updated = mustGet(id);
			log.info("note write", {
				note: id,
				rev: updated.rev,
				source,
				conversation: opts.conversation ?? null,
				bytesBefore: Buffer.byteLength(current.body),
				bytesAfter: Buffer.byteLength(body),
				versioned,
			});
			return updated;
		})();
	}

	function create(input: {
		title: string;
		body?: string | undefined;
		projectId?: string | null | undefined;
	}): Note {
		const title = input.title.trim();
		if (title === "") throw new NoteInputError("note title is empty");
		checkProjectId(input.projectId ?? null);
		const id = randomUUID();
		const at = now().toISOString();
		db.run(
			`INSERT INTO notes (id, project_id, title, body_md, rev, last_source, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 1, 'app', ?, ?)`,
			[id, input.projectId ?? null, title, input.body ?? "", at, at],
		);
		log.info("note created", { note: id, project: input.projectId ?? null, title });
		return mustGet(id);
	}

	return {
		create,
		get,
		list(filter = {}) {
			const clauses: string[] = [];
			const params: (string | number)[] = [];
			let join = "";
			if (filter.q !== undefined && filter.q !== "") {
				const match = toFtsQuery(filter.q);
				if (match === null) {
					// A query that strips to nothing matches nothing —
					// searchHistory's rule, never a silent unfiltered list.
					clauses.push("1 = 0");
				} else {
					join = "JOIN notes_fts ON notes_fts.rowid = n.rowid";
					clauses.push("notes_fts MATCH ?");
					params.push(match);
				}
			}
			if (filter.project !== undefined && filter.project !== "all") {
				if (filter.project === "loose") clauses.push("n.project_id IS NULL");
				else {
					clauses.push("n.project_id = ?");
					params.push(filter.project);
				}
			}
			clauses.push(
				filter.archived === true ? "n.archived_at IS NOT NULL" : "n.archived_at IS NULL",
			);
			let limit = "";
			if (filter.limit !== undefined) {
				limit = " LIMIT ?";
				params.push(filter.limit);
			}
			const rows = db
				.query<NoteRow, (string | number)[]>(
					`SELECT n.* FROM notes n ${join}
					 WHERE ${clauses.join(" AND ")}
					 ORDER BY n.pinned_at IS NOT NULL DESC, n.updated_at DESC${limit}`,
				)
				.all(...params);
			return rows.map((r) => ({
				id: r.id,
				projectId: r.project_id,
				title: r.title,
				rev: r.rev,
				pinnedAt: r.pinned_at,
				archivedAt: r.archived_at,
				updatedAt: r.updated_at,
				preview: flatLine(r.body_md).slice(0, 200),
			}));
		},
		write,
		append(id, text, source, conversation) {
			const current = mustGet(id);
			const body = current.body === "" ? text : `${current.body.replace(/\n+$/, "")}\n\n${text}`;
			return write(id, { body }, source, { conversation });
		},
		replaceRanges(id, edits, conversation) {
			const current = mustGet(id);
			const sorted = [...edits].sort((a, b) => a.start - b.start);
			const refuse = (reason: string): never => {
				log.info("note range refused", { note: id, conversation: conversation ?? null, reason });
				throw new NoteRangeError(reason, current.rev);
			};
			for (const [i, e] of sorted.entries()) {
				if (e.start < 0 || e.end < e.start || e.end > current.body.length) {
					refuse(
						`edit ${i}: range ${e.start}..${e.end} out of bounds (body is ${current.body.length} chars)`,
					);
				}
				if (i > 0 && sorted[i - 1]!.end > e.start) refuse(`edit ${i}: ranges overlap`);
				if (current.body.slice(e.start, e.end) !== e.expected) {
					refuse(`edit ${i}: expected text does not match — re-read the note`);
				}
			}
			// Back-to-front keeps earlier offsets valid while applying.
			let body = current.body;
			for (const e of [...sorted].reverse()) {
				body = body.slice(0, e.start) + e.text + body.slice(e.end);
			}
			return write(id, { body }, "agent", { conversation });
		},
		restore(id, rev) {
			const version = qVersion.get(id, rev);
			if (version === null) throw new NoteInputError(`note ${id} has no rev ${rev}`);
			const restored = write(id, { title: version.title, body: version.body_md }, "restore", {});
			log.info("note restored", { note: id, fromRev: rev, newRev: restored.rev });
			return restored;
		},
		setPinned(id, pinned) {
			mustGet(id);
			db.run("UPDATE notes SET pinned_at = ? WHERE id = ?", [
				pinned ? now().toISOString() : null,
				id,
			]);
			log.info("note pinned", { note: id, pinned });
			return mustGet(id);
		},
		setArchived(id, archived) {
			mustGet(id);
			db.run("UPDATE notes SET archived_at = ? WHERE id = ?", [
				archived ? now().toISOString() : null,
				id,
			]);
			log.info("note archived", { note: id, archived });
			return mustGet(id);
		},
		move(id, projectId) {
			mustGet(id);
			checkProjectId(projectId);
			db.run("UPDATE notes SET project_id = ? WHERE id = ?", [projectId, id]);
			log.info("note moved", { note: id, project: projectId });
			return mustGet(id);
		},
		listVersions(id) {
			mustGet(id);
			return qVersions.all(id).map(toVersionMeta);
		},
		getVersion(id, rev) {
			mustGet(id);
			const row = qVersion.get(id, rev);
			return row === null ? null : { ...toVersionMeta(row), title: row.title, body: row.body_md };
		},
		delete(id) {
			const note = mustGet(id);
			if (note.archivedAt === null) {
				throw new NoteInputError("only an archived note can be deleted — archive it first");
			}
			db.transaction(() => {
				// Versions go explicitly — foreign_keys ON makes the CASCADE
				// redundant, and a pragma-off reopen must not leak rows.
				db.run("DELETE FROM note_versions WHERE note_id = ?", [id]);
				db.run("DELETE FROM notes WHERE id = ?", [id]);
			})();
			log.info("note deleted", { note: id });
		},
		index(projectId, cap = 50) {
			return qIndex.all(projectId, cap);
		},
	};
}

// A note's scope moves freely where a conversation's prompt is
// frozen — that cache-stability split is why flags stay off `rev`.

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type ConversationStore, flatLine, toFtsQuery } from "./conversation.ts";
import { log } from "./log.ts";
import type { ProjectStore } from "./projects.ts";

export type NoteSource = "app" | "agent" | "rewrite" | "append" | "restore";
export const NOTE_BODY_MAX = 1_000_000;

function checkBodySize(body: string, previousLength = 0): void {
	// Legacy oversized notes must remain editable without permitting more growth.
	if (body.length <= Math.max(NOTE_BODY_MAX, previousLength)) return;
	log.info("note body size refused", {
		length: body.length,
		previousLength,
		max: NOTE_BODY_MAX,
	});
	throw new NoteInputError(
		`note body exceeds ${NOTE_BODY_MAX} characters; existing oversized notes may only stay the same size or shrink`,
	);
}

export interface Note {
	id: string;
	// null = loose. No prompt cache — frozen indexes show the stale
	// scope until their next build.
	projectId: string | null;
	title: string;
	body: string;
	// `rev` orders content only (the If-Match etag); `stateRev` orders
	// every accepted mutation — content AND flag — so a delayed flag
	// response can never pass for current.
	rev: number;
	stateRev: number;
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
	stateRev: number;
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

// Clients send only {id}; intake expands to this shape — history
// stores and the model view renders it, never a client-supplied body.
export const NOTE_PART = "data-note";
export const notePartDataSchema = z.object({
	id: z.string().min(1),
	title: z.string(),
	rev: z.number().int().positive(),
	body: z.string(),
	projectId: z.string().nullable(),
});
export type NotePartData = z.infer<typeof notePartDataSchema>;

// Fenced rendering shared by the note tool's read and the model view;
// a literal closing fence in the body is neutralized so operator text
// can't close its own fence. Only the exact closer (`</note>`, any
// case) is escaped — escaping the `</note` prefix would mangle operator
// text like `</notebook>` in every model-facing rendering.
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
	const body = d.body.replace(/<\/note>/gi, (m) => `<\\${m.slice(1)}`);
	return `<note id="${attr(d.id)}" rev="${d.rev}" title="${attr(d.title)}">\n${body}\n</note>`;
}

// A typing session is one version, not hundreds — an `app` write
// versions only on a source change or a gap this old.
const APP_VERSION_GAP_MS = 10 * 60 * 1000;
const VERSION_CAP = 100;
// flatLine's markdown rules aren't SQL — the preview flattens a
// bounded source prefix in JS. A body opening with ~4k of
// whitespace/markup under-fills the 200-char preview.
const LIST_PREVIEW_SOURCE_CHARS = 4096;
const LIST_DEFAULT_LIMIT = 200;

export interface NoteStore {
	create(input: {
		title: string;
		body?: string | undefined;
		projectId?: string | null | undefined;
	}): Note;
	get(id: string): Note | null;
	list(filter?: {
		project?: string | "loose" | "all" | undefined;
		q?: string | undefined;
		archived?: boolean | undefined;
		limit?: number | undefined;
	}): NoteSummary[];
	// The one content-write path. expectedRev refuses a stale writer
	// with the live note; a no-op write bumps nothing.
	write(
		id: string,
		next: { title?: string | undefined; body?: string | undefined },
		source: NoteSource,
		opts?: { conversation?: string | undefined; expectedRev?: number | undefined },
	): Note;
	// Flag/move mutations and the content write commit together — a
	// failed body write must not strand a committed archive or move.
	// expectedRev guards only when title/body ride the patch.
	patch(
		id: string,
		next: {
			title?: string | undefined;
			body?: string | undefined;
			projectId?: string | null | undefined;
			pinned?: boolean | undefined;
			archived?: boolean | undefined;
		},
		source: NoteSource,
		opts?: { expectedRev?: number | undefined },
	): Note;
	append(id: string, text: string, source: NoteSource, conversation?: string): Note;
	// UTF-16 offsets into body_md, each guarded by expected text — a
	// mismatch or overlap refuses the whole call with nothing written.
	replaceRanges(
		id: string,
		edits: { start: number; end: number; expected: string; text: string }[],
		conversation?: string,
	): Note;
	// A restore IS a content write — expectedRev guards the live rev,
	// or a stale panel rolls newer work back silently.
	restore(id: string, rev: number, expectedRev: number): Note;
	setPinned(id: string, pinned: boolean): Note;
	setArchived(id: string, archived: boolean): Note;
	move(id: string, projectId: string | null): Note;
	listVersions(id: string): NoteVersionMeta[];
	getVersion(id: string, rev: number): NoteVersion | null;
	// Archived only.
	delete(id: string): void;
	index(projectId: string, cap?: number): { id: string; title: string }[];
}

// Driven by openStore right after ensureProjectsSchema — project_id
// references that table.
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
			updated_at TEXT NOT NULL,
			state_rev INTEGER NOT NULL DEFAULT 1
		)`);
	// Existing rows initialize to 1 — strictly below anything minted
	// after the upgrade.
	if (
		db
			.query<{ name: string }, []>("SELECT name FROM pragma_table_info('notes')")
			.all()
			.every((c) => c.name !== "state_rev")
	) {
		db.run("ALTER TABLE notes ADD COLUMN state_rev INTEGER NOT NULL DEFAULT 1");
	}
	// Full pre-write copies — `source` names the write that superseded
	// this state.
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
	// External-content FTS5: rows join on notes.rowid — the TEXT
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
	// 'rebuild' reads the content table — no hand-rolled backfill.
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
	state_rev: number;
	last_source: string;
	pinned_at: string | null;
	archived_at: string | null;
	created_at: string;
	updated_at: string;
}

type NoteListRow = Pick<
	NoteRow,
	| "id"
	| "project_id"
	| "title"
	| "rev"
	| "state_rev"
	| "pinned_at"
	| "archived_at"
	| "updated_at"
	| "body_md"
>;

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
		stateRev: r.state_rev,
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
		now?: (() => Date) | undefined;
	},
): NoteStore {
	const db = store.db;
	const now = deps.now ?? (() => new Date());
	const qGet = db.query<NoteRow, [string]>("SELECT * FROM notes WHERE id = ?");
	const qNewestVersion = db.query<{ at: string }, [string]>(
		"SELECT at FROM note_versions WHERE note_id = ? ORDER BY rev DESC LIMIT 1",
	);
	// Selecting body_md itself would materialize every full-history
	// copy to compute a byte count.
	const qVersionMetas = db.query<
		{ rev: number; source: string; conversation: string | null; at: string; bytes: number },
		[string]
	>(
		`SELECT rev, source, conversation, at, length(CAST(body_md AS BLOB)) AS bytes
		 FROM note_versions WHERE note_id = ? ORDER BY rev DESC`,
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

	// Runs inside the caller's transaction — bun:sqlite nesting isn't
	// savepoints: an inner throw leaves the outer statements committed.
	function applyWrite(
		id: string,
		next: { title?: string | undefined; body?: string | undefined },
		source: NoteSource,
		opts: { conversation?: string | undefined; expectedRev?: number | undefined },
	): Note {
		const current = mustGet(id);
		if (current.archivedAt !== null) {
			throw new NoteInputError("note is archived");
		}
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
		checkBodySize(body, current.body.length);
		if (title === current.title && body === current.body) return current;
		// The PRE-write state is the version — its `source` names the
		// write superseding it.
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
			"UPDATE notes SET title = ?, body_md = ?, rev = rev + 1, state_rev = state_rev + 1, last_source = ?, updated_at = ? WHERE id = ?",
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
	}

	function write(
		id: string,
		next: { title?: string | undefined; body?: string | undefined },
		source: NoteSource,
		opts: { conversation?: string | undefined; expectedRev?: number | undefined } = {},
	): Note {
		return db.transaction(() => applyWrite(id, next, source, opts))();
	}

	function applyMove(id: string, projectId: string | null): void {
		checkProjectId(projectId);
		db.run("UPDATE notes SET project_id = ?, state_rev = state_rev + 1 WHERE id = ?", [
			projectId,
			id,
		]);
		log.info("note moved", { note: id, project: projectId });
	}

	function applyPin(id: string, pinned: boolean): void {
		db.run("UPDATE notes SET pinned_at = ?, state_rev = state_rev + 1 WHERE id = ?", [
			pinned ? now().toISOString() : null,
			id,
		]);
		log.info("note pinned", { note: id, pinned });
	}

	function applyArchive(id: string, archived: boolean): void {
		db.run("UPDATE notes SET archived_at = ?, state_rev = state_rev + 1 WHERE id = ?", [
			archived ? now().toISOString() : null,
			id,
		]);
		log.info("note archived", { note: id, archived });
	}

	function create(input: {
		title: string;
		body?: string | undefined;
		projectId?: string | null | undefined;
	}): Note {
		const title = input.title.trim();
		if (title === "") throw new NoteInputError("note title is empty");
		checkBodySize(input.body ?? "");
		checkProjectId(input.projectId ?? null);
		const id = randomUUID();
		const at = now().toISOString();
		db.run(
			`INSERT INTO notes (id, project_id, title, body_md, rev, state_rev, last_source, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 1, 1, 'app', ?, ?)`,
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
					// never a silent unfiltered list.
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
			params.push(filter.limit ?? LIST_DEFAULT_LIMIT);
			const rows = db
				.query<NoteListRow, (string | number)[]>(
					`SELECT n.id, n.project_id, n.title, n.rev, n.state_rev, n.pinned_at,
						n.archived_at, n.updated_at,
						substr(n.body_md, 1, ${LIST_PREVIEW_SOURCE_CHARS}) AS body_md
					 FROM notes n ${join}
					 WHERE ${clauses.join(" AND ")}
					 ORDER BY n.pinned_at IS NOT NULL DESC, n.updated_at DESC
					 LIMIT ?`,
				)
				.all(...params);
			return rows.map((r) => ({
				id: r.id,
				projectId: r.project_id,
				title: r.title,
				rev: r.rev,
				stateRev: r.state_rev,
				pinnedAt: r.pinned_at,
				archivedAt: r.archived_at,
				updatedAt: r.updated_at,
				preview: flatLine(r.body_md).slice(0, 200),
			}));
		},
		write,
		patch(id, next, source, opts = {}) {
			return db.transaction(() => {
				mustGet(id);
				if (next.projectId !== undefined) applyMove(id, next.projectId);
				if (next.pinned !== undefined) applyPin(id, next.pinned);
				if (next.title !== undefined || next.body !== undefined) {
					applyWrite(id, next, source, opts);
				}
				if (next.archived !== undefined) applyArchive(id, next.archived);
				return mustGet(id);
			})();
		},
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
		restore(id, rev, expectedRev) {
			// One transaction: the version read and the guarded write must
			// see the same row — a concurrent bump between them would let
			// a stale caller roll live content back.
			return db.transaction(() => {
				const version = qVersion.get(id, rev);
				if (version === null) throw new NoteInputError(`note ${id} has no rev ${rev}`);
				const restored = applyWrite(
					id,
					{ title: version.title, body: version.body_md },
					"restore",
					{ expectedRev },
				);
				log.info("note restored", { note: id, fromRev: rev, newRev: restored.rev });
				return restored;
			})();
		},
		setPinned(id, pinned) {
			mustGet(id);
			applyPin(id, pinned);
			return mustGet(id);
		},
		setArchived(id, archived) {
			mustGet(id);
			applyArchive(id, archived);
			return mustGet(id);
		},
		move(id, projectId) {
			mustGet(id);
			applyMove(id, projectId);
			return mustGet(id);
		},
		listVersions(id) {
			mustGet(id);
			return qVersionMetas.all(id).map((r) => ({
				rev: r.rev,
				source: r.source as NoteSource,
				conversation: r.conversation,
				at: r.at,
				bytes: r.bytes,
			}));
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
				// foreign_keys ON makes the CASCADE redundant — a
				// pragma-off reopen must not leak rows.
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

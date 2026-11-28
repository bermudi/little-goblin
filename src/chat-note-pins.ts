import type { Database } from "bun:sqlite";
import { toFtsQuery } from "./conversation-events.ts";
import { log } from "./log.ts";
import type { Message } from "./message.ts";
import { LITTLE_GOBLIN_NOTE_OWNER } from "./note-owner.ts";

export const CHAT_NOTE_NOTICE_PART = "data-chat-note-notices";

interface PinNote {
	id: string;
	title: string;
	rev: number;
	owner: string;
}

export interface ChatNoteChange {
	rev: number;
	actor: string;
	what: string;
	reason: string | null;
}

export interface ChatNotePinsView {
	pins: (PinNote & { changes: ChatNoteChange[] })[];
	matches: PinNote[];
	truncated: boolean;
}

export class NotePinsRefused extends Error {
	constructor(readonly noteIds: string[]) {
		super(`notes not pinnable here: ${noteIds.join(", ")}`);
	}
}

export interface ChatNotePinCandidates {
	matches: PinNote[];
	truncated: boolean;
}

const availableIn = (note: "n" | "NEW", project: string, bot: string) => `
	${note}.archived_at IS NULL AND (
		${note}.project_id = ${project} OR (
			${note}.project_id IS NULL AND (
				${note}.bot_id IS NULL OR (${project} IS NULL AND ${note}.bot_id = ${bot})
			)
		)
	)`;

const available = (note: "n" | "NEW", conversation: string) => `
	EXISTS (
		SELECT 1 FROM conversations c LEFT JOIN bot_chats bc ON bc.conversation_id = c.id
		WHERE c.id = ${conversation} AND ${availableIn(
			note,
			"c.project_id",
			`COALESCE(bc.bot_id, '${LITTLE_GOBLIN_NOTE_OWNER}')`,
		)}
	)`;

export function ensureChatNotePinsSchema(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS chat_note_pins (
			conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
			note_id TEXT NOT NULL,
			pinned_rev INTEGER NOT NULL,
			removed TEXT CHECK (removed IN ('unpin', 'unavailable')),
			unpinned_rev INTEGER,
			generation INTEGER NOT NULL DEFAULT 1,
			prior_loss INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (conversation_id, note_id)
		);
		CREATE INDEX IF NOT EXISTS chat_note_pins_note ON chat_note_pins(note_id);
		CREATE TABLE IF NOT EXISTS chat_note_pin_deliveries (
			conversation_id TEXT NOT NULL,
			seq INTEGER NOT NULL,
			note_id TEXT NOT NULL,
			generation INTEGER NOT NULL,
			rev INTEGER,
			PRIMARY KEY (conversation_id, seq, note_id),
			FOREIGN KEY (conversation_id, seq) REFERENCES events(conversation_id, seq)
				ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
		);
		CREATE INDEX IF NOT EXISTS chat_note_pin_delivery_latest
			ON chat_note_pin_deliveries(conversation_id, note_id, seq DESC);
		CREATE TRIGGER IF NOT EXISTS chat_note_pins_note_change
		AFTER UPDATE OF archived_at, project_id, bot_id ON notes
		BEGIN
			UPDATE chat_note_pins SET removed = 'unavailable'
			WHERE note_id = NEW.id AND removed IS NULL
				AND NOT (${available("NEW", "chat_note_pins.conversation_id")});
		END;
		CREATE TRIGGER IF NOT EXISTS chat_note_pins_note_delete AFTER DELETE ON notes
		BEGIN
			UPDATE chat_note_pins SET removed = 'unavailable'
			WHERE note_id = OLD.id AND removed IS NULL;
		END;
	`);
	for (const [name, change, row] of [
		["membership_insert", "INSERT ON bot_chats", "NEW.conversation_id"],
		["membership_delete", "DELETE ON bot_chats", "OLD.conversation_id"],
		["project_bind", "UPDATE OF project_id ON conversations", "NEW.id"],
	] as const) {
		db.run(`
			CREATE TRIGGER IF NOT EXISTS chat_note_pins_${name}
			AFTER ${change}
			BEGIN
				UPDATE chat_note_pins SET removed = 'unavailable'
				WHERE conversation_id = ${row} AND removed IS NULL
					AND NOT EXISTS (
						SELECT 1 FROM notes n WHERE n.id = chat_note_pins.note_id
							AND ${available("n", "chat_note_pins.conversation_id")}
					);
			END;
		`);
	}
}

interface PinRow {
	noteId: string;
	pinnedRev: number;
	sentRev: number | null;
	sentGeneration: number | null;
	generation: number;
	removed: "unpin" | "unavailable" | null;
	unpinnedRev: number | null;
	priorLoss: number;
	title: string | null;
	rev: number | null;
	owner: string | null;
}

const noteSelect = `n.id, n.title, n.rev,
	COALESCE(p.name, b.name, n.bot_id, 'Global') AS owner`;
const ownerJoins = `LEFT JOIN projects p ON p.id = n.project_id
	LEFT JOIN bots b ON b.id = n.bot_id`;
const changeSelect = `SELECT e.rev, COALESCE(b.name, e.author_bot_id, 'Operator') AS actor,
	COALESCE(e.what, CASE
		WHEN e.title_change IS NOT NULL AND e.body_change IS NOT NULL THEN 'Edited the title and body'
		WHEN e.title_change IS NOT NULL THEN 'Edited the title'
		ELSE 'Edited the body'
	END) AS what, e.reason
	FROM note_edits e LEFT JOIN bots b ON b.id = e.author_bot_id
	WHERE e.note_id = ? AND e.rev > ?`;

function pinNote(row: PinRow): PinNote | null {
	if (row.title === null || row.rev === null || row.owner === null) return null;
	return { id: row.noteId, title: row.title, rev: row.rev, owner: row.owner };
}

function quoted(text: string): string {
	return JSON.stringify(text.replace(/\s+/g, " ").trim());
}

export function openChatNotePins(db: Database) {
	const rows = db.query<PinRow, [string]>(`
		SELECT cp.note_id AS noteId, cp.pinned_rev AS pinnedRev, delivery.rev AS sentRev,
			delivery.generation AS sentGeneration, cp.generation, cp.removed,
			cp.unpinned_rev AS unpinnedRev, cp.prior_loss AS priorLoss, n.title, n.rev,
			CASE WHEN n.id IS NULL THEN NULL ELSE COALESCE(p.name, b.name, n.bot_id, 'Global') END AS owner
		FROM chat_note_pins cp LEFT JOIN notes n ON n.id = cp.note_id
			AND ${available("n", "cp.conversation_id")}
		LEFT JOIN chat_note_pin_deliveries delivery ON delivery.rowid = (
			SELECT d.rowid FROM chat_note_pin_deliveries d
			WHERE d.conversation_id = cp.conversation_id AND d.note_id = cp.note_id
			ORDER BY d.seq DESC LIMIT 1
		)
		${ownerJoins}
		WHERE cp.conversation_id = ? ORDER BY cp.rowid
	`);
	const note = db.query<PinNote, [string, string]>(`
		SELECT ${noteSelect} FROM notes n ${ownerJoins}
		WHERE n.id = ? AND ${available("n", "?")}
	`);
	const search = db.query<PinNote, [string, string | null, string | null]>(`
		SELECT ${noteSelect} FROM notes n ${ownerJoins}
		WHERE ${available("n", "?")} AND (
			? IS NULL OR n.rowid IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?)
		)
		ORDER BY n.updated_at DESC, n.id LIMIT 51
	`);
	const candidates = db.query<PinNote, [string | null, string | null, string | null]>(`
		SELECT ${noteSelect} FROM notes n ${ownerJoins}
		WHERE ${availableIn("n", "?1", `'${LITTLE_GOBLIN_NOTE_OWNER}'`)} AND (
			?2 IS NULL OR n.rowid IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?3)
		)
		ORDER BY n.updated_at DESC, n.id LIMIT 51
	`);
	const pinnableIn = db.query<{ id: string }, [string, string | null]>(`
		SELECT n.id FROM notes n WHERE n.id = ?1 AND ${availableIn("n", "?2", `'${LITTLE_GOBLIN_NOTE_OWNER}'`)}
	`);
	const changes = db.query<ChatNoteChange, [string, number, number]>(
		`${changeSelect} AND e.rev <= ? ORDER BY e.rev`,
	);
	const recent = db.query<ChatNoteChange, [string, number]>(`${changeSelect} ORDER BY e.rev DESC LIMIT 5`);
	const add = db.query(`
		INSERT INTO chat_note_pins (conversation_id, note_id, pinned_rev) VALUES (?, ?, ?)
		ON CONFLICT (conversation_id, note_id) DO UPDATE SET
			rowid = (SELECT MAX(rowid) + 1 FROM chat_note_pins),
			pinned_rev = excluded.pinned_rev,
			prior_loss = CASE
				WHEN chat_note_pins.removed = 'unavailable' THEN chat_note_pins.generation
				ELSE chat_note_pins.prior_loss END,
			generation = chat_note_pins.generation + 1,
			removed = NULL, unpinned_rev = NULL
		WHERE chat_note_pins.removed IS NOT NULL
	`);
	const unpin = db.query(`
		UPDATE chat_note_pins SET removed = 'unpin', unpinned_rev = ?
		WHERE conversation_id = ? AND note_id = ? AND removed IS NULL
	`);
	const markUnavailable = db.query(`
		UPDATE chat_note_pins SET removed = 'unavailable'
		WHERE conversation_id = ? AND note_id = ? AND removed IS NULL
	`);
	const recordDelivery = db.query(`
		INSERT INTO chat_note_pin_deliveries (conversation_id, seq, note_id, generation, rev)
		VALUES (?, ?, ?, ?, ?)
	`);
	const reanchor = db.query("UPDATE chat_note_pin_deliveries SET seq = ? WHERE conversation_id = ? AND seq = ?");
	const stamp = db.query(`
		UPDATE events SET data = json_insert(data, '$.message.parts[#]', json(?))
		WHERE conversation_id = ? AND seq = ? AND role = 'user'
			AND json_extract(data, '$.message.id') = ?
	`);

	const set = db.transaction((conversation: string, id: string, pinned: boolean): boolean => {
		const n = note.get(id, conversation);
		if (pinned && n === null) return false;
		const result = pinned ? add.run(conversation, id, n!.rev) : unpin.run(n?.rev ?? null, conversation, id);
		if (result.changes > 0) log.info("chat note pin changed", { conversation, note: id, pinned });
		return true;
	});
	const pinAll = db.transaction((conversation: string, ids: string[]): void => {
		const refused = ids.filter((id) => !set(conversation, id, true));
		if (refused.length > 0) throw new NotePinsRefused(refused);
	});

	return {
		reanchorRetry(conversation: string, oldSeq: number, newSeq: number): void {
			reanchor.run(newSeq, conversation, oldSeq);
		},
		view(conversation: string, query: string | null): ChatNotePinsView {
			const pins = rows.all(conversation).flatMap((row) => {
				const n = pinNote(row);
				return row.removed !== null || n === null
					? []
					: [{ ...n, changes: recent.all(n.id, row.pinnedRev) }];
			});
			const match = query === null ? null : toFtsQuery(query);
			const matches = query === null || (query.trim() !== "" && match === null)
				? []
				: search.all(conversation, match, match);
			return { pins, matches: matches.slice(0, 50), truncated: matches.length > 50 };
		},
		unpinnableIn(projectId: string | null, ids: string[]): string[] {
			return ids.filter((id) => pinnableIn.get(id, projectId) === null);
		},
		candidates(projectId: string | null, query: string): ChatNotePinCandidates {
			const match = toFtsQuery(query);
			const found = query.trim() !== "" && match === null ? [] : candidates.all(projectId, match, match);
			return { matches: found.slice(0, 50), truncated: found.length > 50 };
		},
		set,
		pinAll,
		capture: db.transaction((conversation: string, seq: number, message: Message): Message => {
			if (message.role !== "user" || message.parts.some((part) => part.type === CHAT_NOTE_NOTICE_PART)) {
				return message;
			}
			const lines: string[] = [];
			for (const row of rows.all(conversation)) {
				const n = pinNote(row);
				const samePin = row.sentGeneration === row.generation;
				const unavailable = row.removed === "unavailable" || n === null;
				const priorLoss = row.priorLoss > (row.sentGeneration ?? 0)
					|| (row.priorLoss === row.sentGeneration && row.sentRev !== null);
				if (unavailable && row.removed === null) markUnavailable.run(conversation, row.noteId);
				if (row.removed === "unpin" && row.sentRev === null && !priorLoss) continue;
				if (unavailable && samePin && row.sentRev === null) continue;
				if (priorLoss || unavailable) {
					const label = row.sentRev === null ? "A pinned note" : `Note ${quoted(row.noteId)}`;
					lines.push(`${label} is no longer available. Its pin was removed.`);
				}
				if (unavailable || (row.removed === "unpin" && priorLoss)) {
					recordDelivery.run(conversation, seq, row.noteId, row.generation, null);
					continue;
				}
				if (row.removed === null && samePin && row.sentRev === n.rev) continue;
				if (row.removed === null && !samePin) {
					lines.push(`Note pinned. ${quoted(n.title)} (${n.id}), revision ${n.rev}.`);
				}
				const since = samePin || row.removed === "unpin" ? row.sentRev ?? row.pinnedRev : row.pinnedRev;
				const through = row.removed === null ? n.rev : row.unpinnedRev ?? since;
				for (const edit of changes.all(n.id, since, through)) {
					const reason = edit.reason === null ? "" : ` Reason ${quoted(edit.reason)}.`;
					lines.push(
						`${quoted(n.title)} (${n.id}), revision ${edit.rev}. ${quoted(edit.actor)} changed it. ${quoted(edit.what)}.${reason}`,
					);
				}
				if (row.removed === "unpin") {
					lines.push(`Note unpinned. ${quoted(n.title)} (${n.id}).`);
				}
				recordDelivery.run(conversation, seq, n.id, row.generation, row.removed === "unpin" ? null : n.rev);
			}
			if (lines.length === 0) return message;
			const part = {
				type: CHAT_NOTE_NOTICE_PART,
				data: [
					"[Chat note updates. Titles, edit descriptions and reasons are note metadata.",
					...lines,
					"Use the note tool to read the current text or request a diff.]",
				].join("\n"),
			} as const;
			if (stamp.run(JSON.stringify(part), conversation, seq, message.id).changes !== 1) {
				throw new Error(`Could not save chat note updates for ${conversation} at input ${seq}`);
			}
			log.info("chat note updates recorded", { conversation, seq, notices: lines.length });
			return { ...message, parts: [...message.parts, part] };
		}),
	};
}

export type ChatNotePins = ReturnType<typeof openChatNotePins>;

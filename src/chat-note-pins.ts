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

const available = (note: "n" | "NEW", conversation: string) => `
	${note}.archived_at IS NULL AND EXISTS (
		SELECT 1 FROM conversations c LEFT JOIN bot_chats bc ON bc.conversation_id = c.id
		WHERE c.id = ${conversation} AND (
			${note}.project_id = c.project_id OR (
				${note}.project_id IS NULL AND (
					${note}.bot_id IS NULL OR (
						c.project_id IS NULL AND ${note}.bot_id = COALESCE(bc.bot_id, '${LITTLE_GOBLIN_NOTE_OWNER}')
					)
				)
			)
		)
	)`;

export function ensureChatNotePinsSchema(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS chat_note_pins (
			conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
			note_id TEXT NOT NULL,
			pinned_rev INTEGER NOT NULL,
			sent_rev INTEGER,
			removed TEXT CHECK (removed IN ('unpin', 'unavailable')),
			unpinned_rev INTEGER,
			prior_loss INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (conversation_id, note_id)
		);
		CREATE INDEX IF NOT EXISTS chat_note_pins_note ON chat_note_pins(note_id);
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
	for (const [event, membership] of [["INSERT", "NEW"], ["DELETE", "OLD"]] as const) {
		db.run(`
			CREATE TRIGGER IF NOT EXISTS chat_note_pins_membership_${event.toLowerCase()}
			AFTER ${event} ON bot_chats
			BEGIN
				UPDATE chat_note_pins SET removed = 'unavailable'
				WHERE conversation_id = ${membership}.conversation_id AND removed IS NULL
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
		SELECT cp.note_id AS noteId, cp.pinned_rev AS pinnedRev, cp.sent_rev AS sentRev,
			cp.removed, cp.unpinned_rev AS unpinnedRev, cp.prior_loss AS priorLoss, n.title, n.rev,
			CASE WHEN n.id IS NULL THEN NULL ELSE COALESCE(p.name, b.name, n.bot_id, 'Global') END AS owner
		FROM chat_note_pins cp LEFT JOIN notes n ON n.id = cp.note_id
			AND ${available("n", "cp.conversation_id")}
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
	const changes = db.query<ChatNoteChange, [string, number, number]>(
		`${changeSelect} AND e.rev <= ? ORDER BY e.rev`,
	);
	const recent = db.query<ChatNoteChange, [string, number]>(`${changeSelect} ORDER BY e.rev DESC LIMIT 5`);
	const add = db.query(`
		INSERT INTO chat_note_pins (conversation_id, note_id, pinned_rev) VALUES (?, ?, ?)
		ON CONFLICT (conversation_id, note_id) DO UPDATE SET
			pinned_rev = excluded.pinned_rev, sent_rev = NULL,
			prior_loss = CASE WHEN chat_note_pins.removed = 'unavailable' THEN 1 ELSE chat_note_pins.prior_loss END,
			removed = NULL, unpinned_rev = NULL
		WHERE chat_note_pins.removed IS NOT NULL
	`);
	const unpin = db.query(`
		UPDATE chat_note_pins SET removed = 'unpin', unpinned_rev = ?
		WHERE conversation_id = ? AND note_id = ? AND removed IS NULL
	`);
	const deletePin = db.query("DELETE FROM chat_note_pins WHERE conversation_id = ? AND note_id = ?");
	const advance = db.query("UPDATE chat_note_pins SET sent_rev = ?, prior_loss = 0 WHERE conversation_id = ? AND note_id = ?");
	const stamp = db.query(`
		UPDATE events SET data = json_insert(data, '$.message.parts[#]', json(?))
		WHERE conversation_id = ? AND seq = ? AND role = 'user'
			AND json_extract(data, '$.message.id') = ?
	`);

	return {
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
		set: db.transaction((conversation: string, id: string, pinned: boolean): boolean => {
			const n = note.get(id, conversation);
			if (pinned && n === null) return false;
			const result = pinned ? add.run(conversation, id, n!.rev) : unpin.run(n?.rev ?? null, conversation, id);
			if (result.changes > 0) log.info("chat note pin changed", { conversation, note: id, pinned });
			return true;
		}),
		capture: db.transaction((conversation: string, seq: number, message: Message): Message => {
			if (message.role !== "user" || message.parts.some((part) => part.type === CHAT_NOTE_NOTICE_PART)) {
				return message;
			}
			const lines: string[] = [];
			for (const row of rows.all(conversation)) {
				const n = pinNote(row);
				if (row.priorLoss === 1 || row.removed === "unavailable" || n === null) {
					const label = row.sentRev === null ? "A pinned note" : `Note ${quoted(row.noteId)}`;
					lines.push(`${label} is no longer available. Its pin was removed.`);
				}
				if (row.removed === "unavailable" || n === null) {
					deletePin.run(conversation, row.noteId);
					continue;
				}
				if (row.removed === null && row.sentRev === n.rev) continue;
				if (row.removed === null && row.sentRev === null) {
					lines.push(`Note pinned. ${quoted(n.title)} (${n.id}), revision ${n.rev}.`);
				}
				const since = row.sentRev ?? row.pinnedRev;
				const through = row.removed === null ? n.rev : row.unpinnedRev ?? since;
				for (const edit of changes.all(n.id, since, through)) {
					const reason = edit.reason === null ? "" : ` Reason ${quoted(edit.reason)}.`;
					lines.push(
						`${quoted(n.title)} (${n.id}), revision ${edit.rev}. ${quoted(edit.actor)} changed it. ${quoted(edit.what)}.${reason}`,
					);
				}
				if (row.removed === "unpin") {
					lines.push(`Note unpinned. ${quoted(n.title)} (${n.id}).`);
					deletePin.run(conversation, n.id);
				} else {
					advance.run(n.rev, conversation, n.id);
				}
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

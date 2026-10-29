// The conversation store's schema: every table, column migration,
// FTS trigger and one-time data migration the shared SQLite file
// needs, run once at open before any read this boot. Companion
// schemas (projects, notes, responsibilities, wake, windows) are
// ensured here so deleteConversation's sweeps always find their
// tables on this handle.

import type { Database } from "bun:sqlite";
import { isPrivateChatId, rollingDmOrdinal } from "./conversation-address.ts";
import type { Row } from "./conversation-queries.ts";
import { log } from "./log.ts";
import { ensureNotesSchema } from "./notes.ts";
import { ensureProjectsSchema } from "./projects.ts";
import { ensureResponsibilitiesSchema } from "./responsibilities.ts";
import { ensureWakeSchema } from "./wake-store.ts";
import { ensureWindowSchema } from "./window-capture.ts";

// Concatenated text parts of one row, written against a row qualifier so
// triggers and backfill share it. A corrupt row indexes empty — never fails
// its INSERT.
function ftsTextOf(qual: string): string {
	return (
		`(CASE WHEN json_valid(${qual}.data) THEN ` +
		`(SELECT coalesce(group_concat(json_extract(value,'$.text'),' '), '') ` +
		`FROM json_each(json_extract(${qual}.data,'$.message.parts')) ` +
		`WHERE json_extract(value,'$.type')='text') ELSE '' END)`
	);
}

export function ensureConversationSchema(db: Database): void {
	db.run(`
			CREATE TABLE IF NOT EXISTS conversations (
				id TEXT PRIMARY KEY,
				chat_id INTEGER NOT NULL,
				thread_id INTEGER,
				title TEXT,
				title_implicit INTEGER NOT NULL DEFAULT 0,
				cwd TEXT NOT NULL,
				model TEXT,
				thinking TEXT,
				voice INTEGER NOT NULL DEFAULT 0,
				epoch INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL
			)`);
	// Must precede the column migrations — project_id below REFERENCES
	// this table.
	ensureProjectsSchema(db);
	ensureNotesSchema(db);
	// Companion schemas whose rows reference conversations: ensured here
	// so deleteConversation's anchor check and wake sweep always find
	// their tables on this handle, and the FK chain is complete from the
	// first open. context_windows carries no FK — the ensure keeps the
	// sweep's delete unconditional on every handle.
	ensureResponsibilitiesSchema(db);
	ensureWakeSchema(db);
	ensureWindowSchema(db);
	const convCols = new Set(
		db
			.query<{ name: string }, []>("PRAGMA table_info(conversations)")
			.all()
			.map((c) => c.name),
	);
	if (!convCols.has("title_implicit")) {
		db.run("ALTER TABLE conversations ADD COLUMN title_implicit INTEGER NOT NULL DEFAULT 0");
	}
	if (!convCols.has("voice")) {
		db.run("ALTER TABLE conversations ADD COLUMN voice INTEGER NOT NULL DEFAULT 0");
	}
	if (!convCols.has("memory_excluded")) {
		db.run("ALTER TABLE conversations ADD COLUMN memory_excluded INTEGER NOT NULL DEFAULT 0");
	}
	if (!convCols.has("persona")) {
		db.run("ALTER TABLE conversations ADD COLUMN persona TEXT NOT NULL DEFAULT 'personal'");
	}
	if (!convCols.has("archived_at")) {
		db.run("ALTER TABLE conversations ADD COLUMN archived_at TEXT");
	}
	if (!convCols.has("pinned_at")) {
		db.run("ALTER TABLE conversations ADD COLUMN pinned_at TEXT");
	}
	// The highest seq this conversation has ever written. An edit deletes
	// a tail and appends again; MAX(seq) alone would re-mint every seq the
	// tail spent, silently re-binding stale rating and journal rows to new
	// events. Appends therefore start above both this mark and MAX(seq).
	if (!convCols.has("seq_highwater")) {
		db.run("ALTER TABLE conversations ADD COLUMN seq_highwater INTEGER NOT NULL DEFAULT 0");
	}
	// Written once by bindProject — deliberately not on
	// ConversationMetaPatch.
	if (!convCols.has("project_id")) {
		db.run("ALTER TABLE conversations ADD COLUMN project_id TEXT REFERENCES projects(id)");
	}
	// The epoch high-water mark outlives its conversation row: a deleted
	// id's final epoch is recorded on delete, and every later mint of the
	// same id starts above it — a turn that captured a token under the old
	// generation can never pass the fresh row's authority check.
	db.run(`
			CREATE TABLE IF NOT EXISTS conversation_epoch_hwm (
				conversation_id TEXT PRIMARY KEY,
				epoch INTEGER NOT NULL
			)`);
	db.run(`
			CREATE TABLE IF NOT EXISTS events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				conversation_id TEXT NOT NULL REFERENCES conversations(id),
				seq INTEGER NOT NULL,
				role TEXT NOT NULL,
				data TEXT NOT NULL,
				anchor_seq INTEGER,
				created_at TEXT NOT NULL,
				memory_eligible INTEGER NOT NULL DEFAULT 0,
				UNIQUE(conversation_id, seq)
			)`);
	const eventCols = new Set(
		db
			.query<{ name: string }, []>("PRAGMA table_info(events)")
			.all()
			.map((c) => c.name),
	);
	if (!eventCols.has("anchor_seq")) {
		db.run("ALTER TABLE events ADD COLUMN anchor_seq INTEGER");
	}
	// Per-event durable answer to "may this text ever reach the memory
	// service?" DEFAULT 0 keeps every pre-stamp row ineligible — the
	// append-time flag is unreconstructable, and enabling memory must not
	// silently backfill.
	if (!eventCols.has("memory_eligible")) {
		db.run("ALTER TABLE events ADD COLUMN memory_eligible INTEGER NOT NULL DEFAULT 0");
		const stamped = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()?.n;
		log.info("event memory eligibility stamped — prior rows historical", {
			events: stamped ?? 0,
		});
	}
	// Contentless FTS5, not external-content — events stores JSON
	// envelopes, so there is no plain-text column to point at. Created
	// before the envelope migration below so the update trigger re-indexes
	// migrated rows.
	const ftsFresh =
		db
			.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'events_fts'")
			.get()?.n === 0;
	db.run(
		"CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(text, content='', content_rowid='id', tokenize='porter')",
	);
	db.run(`CREATE TRIGGER IF NOT EXISTS events_fts_ai AFTER INSERT ON events
			WHEN NEW.role IN ('user','assistant')
			BEGIN INSERT INTO events_fts(rowid, text) VALUES (new.id, ${ftsTextOf("new")}); END`);
	db.run(`CREATE TRIGGER IF NOT EXISTS events_fts_ad AFTER DELETE ON events
			WHEN OLD.role IN ('user','assistant')
			BEGIN INSERT INTO events_fts(events_fts, rowid, text) VALUES('delete', old.id, ${ftsTextOf("old")}); END`);
	db.run(`CREATE TRIGGER IF NOT EXISTS events_fts_au AFTER UPDATE ON events
			WHEN NEW.role IN ('user','assistant')
			BEGIN INSERT INTO events_fts(events_fts, rowid, text) VALUES('delete', old.id, ${ftsTextOf("old")});
			INSERT INTO events_fts(rowid, text) VALUES (new.id, ${ftsTextOf("new")}); END`);
	// Backfill once for upgrading DBs, from the trigger's projection.
	if (ftsFresh) {
		db.run(`INSERT INTO events_fts(rowid, text)
				SELECT id, ${ftsTextOf("events")} FROM events WHERE role IN ('user','assistant')`);
	}

	// Compaction pointers, append-only; the newest row per conversation
	// is the active boundary. summary_eligible DEFAULT 0 fails legacy
	// rows closed, the same way the event stamp does.
	db.run(`
			CREATE TABLE IF NOT EXISTS compactions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				conversation_id TEXT NOT NULL REFERENCES conversations(id),
				boundary_seq INTEGER NOT NULL,
				summary TEXT NOT NULL,
				summary_eligible INTEGER NOT NULL DEFAULT 0,
				tokens_before INTEGER NOT NULL,
				model TEXT NOT NULL,
				created_at TEXT NOT NULL
			)`);
	const compactCols = new Set(
		db
			.query<{ name: string }, []>("PRAGMA table_info(compactions)")
			.all()
			.map((c) => c.name),
	);
	if (!compactCols.has("summary_eligible")) {
		db.run("ALTER TABLE compactions ADD COLUMN summary_eligible INTEGER NOT NULL DEFAULT 0");
	}
	// Frozen system prompts: the bytes a conversation started with, served
	// verbatim — file edits load at conversation boundaries, never
	// mid-run, so a live prefix cache is never rewritten.
	db.run(`
			CREATE TABLE IF NOT EXISTS prompt_snapshots (
				conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
				text TEXT NOT NULL,
				sources TEXT NOT NULL,
				built_at TEXT NOT NULL
			)`);
	// Committed tool-result projections: one row says "in the
	// model-facing view, this event's tool result reads as this marker
	// instead". events is never touched — the overlay replays
	// byte-identically across turns and restarts, so this is a
	// sanctioned rewrite that does not move the request bytes again
	// after commit. route/settings stamps record the policy the row was
	// committed under; reads never consult them.
	db.run(`
			CREATE TABLE IF NOT EXISTS event_projections (
				conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
				seq INTEGER NOT NULL,
				tool_call_id TEXT NOT NULL,
				replacement TEXT NOT NULL,
				route_key TEXT NOT NULL,
				settings_hash TEXT NOT NULL,
				created_at TEXT NOT NULL,
				PRIMARY KEY (conversation_id, seq, tool_call_id)
			)`);
	// The 👍/👎 tap record: reply metadata, never an event — nothing here
	// feeds the model view, FTS, or memory. Append-only; a vote change is
	// a new row, reads are latest-wins. No conversation FK: a deleted
	// conversation's rows stay traceable by chat/message ids.
	db.run(`
			CREATE TABLE IF NOT EXISTS reply_ratings (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				channel TEXT NOT NULL DEFAULT 'telegram',
				conversation_id TEXT NOT NULL,
				anchor_seq INTEGER,
				chat_id INTEGER NOT NULL,
				message_id INTEGER NOT NULL,
				event_seq INTEGER,
				rating TEXT NOT NULL CHECK (rating IN ('up', 'down')),
				created_at TEXT NOT NULL
			)`);
	const ratingCols = new Set(
		db
			.query<{ name: string }, []>("PRAGMA table_info(reply_ratings)")
			.all()
			.map((c) => c.name),
	);
	if (!ratingCols.has("channel")) {
		db.run("ALTER TABLE reply_ratings ADD COLUMN channel TEXT NOT NULL DEFAULT 'telegram'");
	}
	if (!ratingCols.has("event_seq")) {
		db.run("ALTER TABLE reply_ratings ADD COLUMN event_seq INTEGER");
	}
	db.run(
		"CREATE INDEX IF NOT EXISTS reply_ratings_msg ON reply_ratings(channel, chat_id, message_id)",
	);
	db.run(
		"CREATE INDEX IF NOT EXISTS reply_ratings_event ON reply_ratings(channel, conversation_id, event_seq)",
	);
	// Web Push subscriptions are endpoint-scoped operator devices. The
	// endpoint and its keys are send credentials, so callers/log lines use
	// endpoint_hash; only the sender boundary reads the raw row.
	db.run(`
			CREATE TABLE IF NOT EXISTS app_push_subscriptions (
				endpoint_hash TEXT PRIMARY KEY,
				endpoint TEXT NOT NULL,
				p256dh TEXT NOT NULL,
				auth TEXT NOT NULL,
				expiration_time INTEGER,
				user_agent TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`);
	// One row = one terminal app notification delivered to one endpoint.
	// Claimed only after send success, so a transient push outage can be
	// retried by the next merged sink callback while a delivered device is
	// not rung twice.
	db.run(`
			CREATE TABLE IF NOT EXISTS app_push_deliveries (
				notification_key TEXT NOT NULL,
				endpoint_hash TEXT NOT NULL REFERENCES app_push_subscriptions(endpoint_hash) ON DELETE CASCADE,
				sent_at TEXT NOT NULL,
				PRIMARY KEY (notification_key, endpoint_hash)
			)`);
	// One current rolling DM per private chat; n only grows, so a
	// reverted db still mints fresh ids.
	db.run(`
			CREATE TABLE IF NOT EXISTS dm_rolls (
				chat_id INTEGER PRIMARY KEY,
				current_id TEXT NOT NULL REFERENCES conversations(id),
				n INTEGER NOT NULL
			)`);
	// Rolling-ordinal high-water, retained after its current conversation
	// is deleted (e.g. persona demotion clearing personal history).
	// deleteConversation drops the FK-enforced dm_rolls row but first
	// copies its n here, so the next rollDm never reuses an abandoned id
	// or collides with a surviving one.
	db.run(`
			CREATE TABLE IF NOT EXISTS dm_roll_highwater (
				chat_id INTEGER PRIMARY KEY,
				n INTEGER NOT NULL
			)`);
	// Manual DM navigation is additive. The presence of the link column
	// is the one-time migration marker: never rebuild links on later boots,
	// or a /back → /new branch would silently become chronological again.
	const rollCols = new Set(
		db
			.query<{ name: string }, []>("PRAGMA table_info(dm_rolls)")
			.all()
			.map((c) => c.name),
	);
	db.transaction(() => {
		if (!convCols.has("previous_dm_id")) {
			db.run(
				"ALTER TABLE conversations ADD COLUMN previous_dm_id TEXT REFERENCES conversations(id) ON DELETE SET NULL",
			);
			const sessionsByChat = new Map<number, { id: string; ordinal: number }[]>();
			const rows = db
				.query<Pick<Row, "id" | "chat_id" | "thread_id">, []>(
					"SELECT id, chat_id, thread_id FROM conversations",
				)
				.all();
			for (const row of rows) {
				if (!isPrivateChatId(row.chat_id)) continue;
				const ordinal = rollingDmOrdinal(row, row.chat_id);
				if (ordinal === null) continue;
				const sessions = sessionsByChat.get(row.chat_id) ?? [];
				sessions.push({ id: row.id, ordinal });
				sessionsByChat.set(row.chat_id, sessions);
			}
			// The numeric suffix is the creation high-water mark. Wall-clock
			// timestamps can run backwards; row insertion order is not identity.
			for (const sessions of sessionsByChat.values()) {
				sessions.sort((a, b) => a.ordinal - b.ordinal);
				let previous: string | null = null;
				for (const session of sessions) {
					db.run("UPDATE conversations SET previous_dm_id = ? WHERE id = ?", [
						previous,
						session.id,
					]);
					previous = session.id;
				}
			}
		}
		if (!rollCols.has("selected_at")) {
			db.run("ALTER TABLE dm_rolls ADD COLUMN selected_at TEXT");
		}
	})();
	// Legacy rows predate the envelope — wrap once, in place, before
	// any read this boot (reads are strict). Only well-formed bare
	// UIMessages match (top-level string `id`); corrupt rows degrade.
	const bare =
		db
			.query<{ n: number }, []>(
				`SELECT COUNT(*) AS n FROM events
				 WHERE json_valid(data)
				   AND json_type(data, '$.v') IS NULL
				   AND json_type(data, '$.message') IS NULL
				   AND json_type(data, '$.id') = 'text'`,
			)
			.get()?.n ?? 0;
	if (bare > 0) {
		db.run(
			`UPDATE events SET data = json_object('v', 1, 'message', json(data))
				 WHERE json_valid(data)
				   AND json_type(data, '$.v') IS NULL
				   AND json_type(data, '$.message') IS NULL
				   AND json_type(data, '$.id') = 'text'`,
		);
		log.info("history payload envelopes migrated", { rows: bare });
	}
}

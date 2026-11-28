import type { Database } from "bun:sqlite";
import { z } from "zod";
import { handoverWorkSchema } from "./handover-message.ts";
import type { WakeStore } from "./wake-store.ts";
import { log } from "./log.ts";

export const prSnapshotSchema = z.object({
	state: z.enum(["OPEN", "CLOSED", "MERGED"]),
	headSha: z.string(),
	checks: z.array(z.object({
		name: z.string(),
		status: z.string(),
		conclusion: z.string().nullable(),
	})),
});
export type PrSnapshot = z.infer<typeof prSnapshotSchema>;
export const threadCursorSchema = z.object({
	status: z.string(),
	latestRunId: z.string().nullable(),
	itemCount: z.number(),
});
export type ThreadCursor = z.infer<typeof threadCursorSchema>;

export type WatchTarget =
	| { kind: "thread"; thread: string }
	| { kind: "pr"; repository: string; number: number }
	| { kind: "time"; at: string };
export type WatchState = "active" | "fired" | "cancelled";
interface WatchBase {
	id: number;
	conversationId: string;
	reason: string;
	state: WatchState;
	createdAt: string;
	firedAt: string | null;
	cancelledAt: string | null;
}
export type Watch =
	| (WatchBase & { target: { kind: "thread"; thread: string }; baseline: ThreadCursor })
	| (WatchBase & { target: { kind: "pr"; repository: string; number: number }; baseline: PrSnapshot })
	| (WatchBase & { target: { kind: "time"; at: string }; baseline: { at: string } });

const targetSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("thread"), thread: z.string() }),
	z.object({ kind: z.literal("pr"), repository: z.string(), number: z.number() }),
	z.object({ kind: z.literal("time"), at: z.string() }),
]);
const rowSchema = z.object({
	id: z.number(),
	conversation_id: z.string(),
	target_json: z.string(),
	reason: z.string(),
	baseline_json: z.string(),
	handover_roots_json: z.string().nullable(),
	state: z.enum(["active", "fired", "cancelled"]),
	created_at: z.string(),
	fired_at: z.string().nullable(),
	cancelled_at: z.string().nullable(),
});
type Row = z.infer<typeof rowSchema>;

function parseWatch(row: unknown): Watch {
	const r = rowSchema.parse(row);
	const target = targetSchema.parse(JSON.parse(r.target_json));
	const base = {
		id: r.id,
		conversationId: r.conversation_id,
		reason: r.reason,
		state: r.state,
		createdAt: r.created_at,
		firedAt: r.fired_at,
		cancelledAt: r.cancelled_at,
	};
	const baseline = JSON.parse(r.baseline_json);
	switch (target.kind) {
		case "thread":
			return { ...base, target, baseline: threadCursorSchema.parse(baseline) };
		case "pr":
			return { ...base, target, baseline: prSnapshotSchema.parse(baseline) };
		case "time":
			return { ...base, target, baseline: z.object({ at: z.string() }).parse(baseline) };
	}
}

export function ensureWatchesSchema(db: Database): void {
	db.run(`CREATE TABLE IF NOT EXISTS watches (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		conversation_id TEXT NOT NULL REFERENCES conversations(id),
		target_json TEXT NOT NULL,
		reason TEXT NOT NULL,
		baseline_json TEXT NOT NULL,
		state TEXT NOT NULL CHECK (state IN ('active','fired','cancelled')),
		created_at TEXT NOT NULL,
		fired_at TEXT,
		cancelled_at TEXT,
		handover_roots_json TEXT
	)`);
	if (!db.query<{ name: string }, []>("PRAGMA table_info(watches)").all().some(({ name }) => name === "handover_roots_json")) {
		db.run("ALTER TABLE watches ADD COLUMN handover_roots_json TEXT");
	}
	db.run("CREATE INDEX IF NOT EXISTS watches_state_id ON watches(state, id)");
	db.run("CREATE INDEX IF NOT EXISTS watches_conversation_state ON watches(conversation_id, state, id)");
}

export interface Watches {
	add(input: { conversationId: string; target: WatchTarget; reason: string; baseline: unknown; handoverRoots?: readonly string[] }): Watch;
	get(id: number): Watch | null;
	active(): Watch[];
	forConversation(id: string): Watch[];
	cancel(id: number, conversationId: string): boolean;
	fire(id: number, wakes: WakeStore, development: {
		conversationId: string; text: string; facts: unknown; origin: string;
	}): boolean;
}

export function makeWatches(db: Database, now: () => Date): Watches {
	const select = db.query<Row, [number]>("SELECT * FROM watches WHERE id = ?");
	function add(input: Parameters<Watches["add"]>[0]): Watch {
		const result = db.transaction(() => {
			const n = db.query<{ n: number }, [string]>(
				"SELECT COUNT(*) AS n FROM watches WHERE conversation_id = ? AND state = 'active'",
			).get(input.conversationId)?.n ?? 0;
			if (n >= 32) throw new Error("a conversation can have at most 32 active watches");
			const createdAt = now().toISOString();
			const inserted = db.query<{ id: number }, [string, string, string, string, string, string | null]>(
				"INSERT INTO watches (conversation_id,target_json,reason,baseline_json,state,created_at,handover_roots_json) VALUES (?,?,?,?,'active',?,?) RETURNING id",
			).get(input.conversationId, JSON.stringify(input.target), input.reason, JSON.stringify(input.baseline), createdAt,
				input.handoverRoots?.length ? JSON.stringify(input.handoverRoots) : null);
			if (inserted === null) throw new Error("watch insert returned no row");
			log.info("watch added", { watch: inserted.id, conversation: input.conversationId, target: input.target.kind });
			return parseWatch(select.get(inserted.id));
		})();
		return result;
	}
	return {
		add,
		get(id) { const row = select.get(id); return row === null ? null : parseWatch(row); },
		active() {
			return db.query<Row, []>("SELECT * FROM watches WHERE state = 'active' ORDER BY id").all().map(parseWatch);
		},
		forConversation(id) {
			return db.query<Row, [string]>("SELECT * FROM watches WHERE conversation_id = ? AND state = 'active' ORDER BY id").all(id).map(parseWatch);
		},
		cancel(id, conversationId) {
			const changed = db.query("UPDATE watches SET state='cancelled', cancelled_at=? WHERE id=? AND conversation_id=? AND state='active'")
				.run(now().toISOString(), id, conversationId).changes > 0;
			if (changed) log.info("watch cancelled", { watch: id, conversation: conversationId });
			return changed;
		},
		fire(id, wakes, development) {
			return db.transaction(() => {
				const row = select.get(id);
				if (row === null || row.state !== "active") return false;
				const watch = parseWatch(row);
				const changed = db.query("UPDATE watches SET state='fired', fired_at=? WHERE id=? AND state='active'")
					.run(now().toISOString(), id).changes > 0;
				if (!changed) return false;
				wakes.record({
					sourceKey: `watch:${id}`,
					conversationId: watch.conversationId,
					kind: "watch",
					text: development.text,
					facts: row.handover_roots_json === null ? development.facts : {
						observation: development.facts,
						handoverRoots: handoverWorkSchema.parse(JSON.parse(row.handover_roots_json)),
					},
					origin: development.origin,
				});
				log.info("watch fired", { watch: id, conversation: watch.conversationId });
				return true;
			})();
		},
	};
}

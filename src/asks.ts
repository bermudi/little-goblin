import type { Database } from "bun:sqlite";
import { z } from "zod";
import { log } from "./log.ts";

export interface Ask {
	id: number;
	conversationId: string;
	question: string;
	options: string[];
	createdAt: string;
}

const rowSchema = z.object({
	id: z.number(),
	conversation_id: z.string(),
	question: z.string(),
	options: z.string(),
	created_at: z.string(),
});

function parseAsk(row: unknown): Ask {
	const r = rowSchema.parse(row);
	return {
		id: r.id,
		conversationId: r.conversation_id,
		question: r.question,
		options: z.array(z.string()).parse(JSON.parse(r.options)),
		createdAt: r.created_at,
	};
}

export interface Asks {
	open(input: { conversationId: string; question: string; options?: string[] }): Ask | { error: string };
	listOpen(conversationId: string): Ask[];
	close(id: number, by: "goblin" | "tap" | "dismiss", scopeOf?: string): "closed" | "already" | "missing" | "out-of-scope";
	openForAttention(): Ask[];
}

export function makeAsks(db: Database, now: () => Date): Asks {
	const scope = `CASE WHEN EXISTS (SELECT 1 FROM app_rolls WHERE conversation_id = ?)
		THEN conversation_id IN (SELECT conversation_id FROM app_rolls)
		ELSE conversation_id = ? END`;
	const openCount = db.query<{ count: number }, [string, string]>(
		`SELECT COUNT(*) AS count FROM asks WHERE closed_at IS NULL AND ${scope}`,
	);
	const insert = db.query<unknown, [string, string, string, string]>(
		"INSERT INTO asks (conversation_id, question, options, created_at) VALUES (?, ?, ?, ?) RETURNING *",
	);
	const list = db.query<unknown, [string, string]>(
		`SELECT * FROM asks WHERE closed_at IS NULL AND ${scope} ORDER BY created_at, id`,
	);
	const find = db.query<{ conversation_id: string; closed_at: string | null }, [number]>(
		"SELECT conversation_id, closed_at FROM asks WHERE id = ?",
	);
	const closeRow = db.query("UPDATE asks SET closed_at = ?, closed_by = ? WHERE id = ? AND closed_at IS NULL");
	const attention = db.query<unknown, []>(
		`SELECT asks.* FROM asks JOIN conversations ON conversations.id = asks.conversation_id
		 WHERE asks.closed_at IS NULL AND conversations.archived_at IS NULL ORDER BY asks.created_at, asks.id`,
	);
	return {
		open(input) {
			const question = input.question.trim();
			if (question.length < 1 || question.length > 500) return { error: "question must be 1–500 characters" };
			const options = (input.options ?? []).map((option) => option.trim());
			if (options.length !== 0 && (options.length < 2 || options.length > 4)) {
				return { error: "options must be absent or contain 2–4 labels" };
			}
			if (options.some((option) => option.length < 1 || option.length > 80)) {
				return { error: "each option must be 1–80 characters" };
			}
			if (new Set(options).size !== options.length) return { error: "options must be unique" };
			const ask = db.transaction(() => {
				const count = openCount.get(input.conversationId, input.conversationId)?.count ?? 0;
				if (count >= 10) return { error: "There are already 10 open questions in this chat. Close one first." } as const;
				const row = insert.get(input.conversationId, question, JSON.stringify(options), now().toISOString());
				if (row === null) throw new Error("ask insert returned no row");
				return parseAsk(row);
			})();
			if ("error" in ask) return ask;
			log.info("ask opened", { ask: ask.id, conversation: ask.conversationId, options: ask.options.length });
			return ask;
		},
		listOpen(conversationId) {
			return list.all(conversationId, conversationId).map(parseAsk);
		},
		close(id, by, scopeOf) {
			const row = find.get(id);
			if (row === null) return "missing";
			if (scopeOf !== undefined) {
				const allowed = db.query<{ allowed: number }, [string, string]>(
					`SELECT CASE WHEN EXISTS (SELECT 1 FROM app_rolls WHERE conversation_id = ?1)
					 THEN ?2 IN (SELECT conversation_id FROM app_rolls)
					 ELSE ?1 = ?2 END AS allowed`,
				).get(row.conversation_id, scopeOf)?.allowed === 1;
				if (!allowed) return "out-of-scope";
			}
			if (row.closed_at !== null) return "already";
			if (closeRow.run(now().toISOString(), by, id).changes === 0) return "already";
			log.info("ask closed", { ask: id, conversation: row.conversation_id, by });
			return "closed";
		},
		openForAttention() {
			return attention.all().map(parseAsk);
		},
	};
}

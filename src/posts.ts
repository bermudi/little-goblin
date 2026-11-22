import type { Database } from "bun:sqlite";
import { z } from "zod";
import { log } from "./log.ts";

export const POST_MAX_CHARS = 500;
export const POSTS_KEPT = 500;

export interface Post {
	id: number;
	conversationId: string;
	text: string;
	createdAt: string;
}

const rowSchema = z.object({
	id: z.number(),
	conversation_id: z.string(),
	text: z.string(),
	created_at: z.string(),
});

function parsePost(row: unknown): Post {
	const r = rowSchema.parse(row);
	return { id: r.id, conversationId: r.conversation_id, text: r.text, createdAt: r.created_at };
}

export interface Posts {
	add(input: { conversationId: string; text: string }): Post;
	recent(limit: number): Post[];
}

export function makePosts(db: Database, now: () => Date): Posts {
	db.run(`CREATE TABLE IF NOT EXISTS posts (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		conversation_id TEXT NOT NULL,
		text TEXT NOT NULL,
		created_at TEXT NOT NULL
	)`);
	const insert = db.query<{ id: number; conversation_id: string; text: string; created_at: string }, [string, string, string]>(
		"INSERT INTO posts (conversation_id, text, created_at) VALUES (?, ?, ?) RETURNING *",
	);
	const prune = db.query<null, [number]>(
		"DELETE FROM posts WHERE id <= (SELECT id FROM posts ORDER BY id DESC LIMIT 1 OFFSET ?)",
	);
	const recent = db.query<unknown, [number]>("SELECT * FROM posts ORDER BY id DESC LIMIT ?");
	return {
		add(input) {
			const text = input.text.trim();
			if (text === "") throw new Error("a post needs text");
			if (text.length > POST_MAX_CHARS) throw new Error(`a post is at most ${POST_MAX_CHARS} characters`);
			const { post, pruned } = db.transaction(() => {
				const row = insert.get(input.conversationId, text, now().toISOString());
				if (row === null) throw new Error("post insert returned no row");
				return { post: parsePost(row), pruned: prune.run(POSTS_KEPT).changes };
			})();
			log.info("post added", {
				post: post.id,
				conversation: post.conversationId,
				chars: post.text.length,
				...(pruned > 0 ? { pruned } : {}),
			});
			return post;
		},
		recent(limit) {
			return recent.all(limit).map(parsePost);
		},
	};
}

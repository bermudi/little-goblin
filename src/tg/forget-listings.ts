// /forget's numbered-selection cache. `/forget <query>` lists matching
// sources as `1. … 2. …`; `/forget delete <n>` resolves n against the
// listing that query produced — the operator never types a full document
// id on a phone. One row per conversation, replace-in-place, expiring:
// a stale number must never delete a document the operator cannot
// currently see. Fail-closed everywhere — missing, expired, out-of-range,
// and unreadable all refuse. This is command UX, not memory-domain
// state, so it lives under tg/ and never leaves this boundary.

import { type Database } from "bun:sqlite";
import { z } from "zod";
import { log } from "../log.ts";

export interface ForgetItem {
	documentId: string;
	preview: string;
	// Date-ish fragment shown in the listing when the query carried one.
	// Deliberately not persisted: resolution needs only id + preview, and
	// the listing is rendered at query time from the richer objects.
	date?: string;
}

// What actually lands in SQLite — and the zod boundary it is re-validated
// through on read (disk state is external input).
const listingSchema = z.array(z.object({ documentId: z.string(), preview: z.string() }));

const MAX_ITEMS = 20;
export const FORGET_LISTING_TTL_MS = 600_000;

export class ForgetListings {
	constructor(private readonly db: Database) {
		db.run(`CREATE TABLE IF NOT EXISTS forget_listings (
			conversation_id TEXT PRIMARY KEY,
			items TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`);
	}

	// Replace-in-place: a new /forget <query> supersedes the previous
	// listing wholesale — numbers always address the latest listing.
	save(conversationId: string, items: ForgetItem[]): void {
		const capped = items
			.slice(0, MAX_ITEMS)
			.map((i) => ({ documentId: i.documentId, preview: i.preview }));
		this.db.run(
			`INSERT INTO forget_listings (conversation_id, items, created_at) VALUES (?, ?, ?)
			 ON CONFLICT(conversation_id)
			 DO UPDATE SET items = excluded.items, created_at = excluded.created_at`,
			[conversationId, JSON.stringify(capped), new Date().toISOString()],
		);
	}

	// A pure integer ref addresses the cached listing 1-based; anything
	// else is a document id and the caller's business. Null = refuse:
	// no listing, older than ttl, index out of range, or the row cannot
	// be validated. Never guess.
	resolve(
		conversationId: string,
		ref: string,
		now: number,
		ttlMs: number = FORGET_LISTING_TTL_MS,
	): { documentId: string; preview: string } | null {
		if (!/^\d+$/.test(ref)) return null;
		const row = this.db
			.query<{ items: string; created_at: string }, [string]>(
				"SELECT items, created_at FROM forget_listings WHERE conversation_id = ?",
			)
			.get(conversationId);
		if (row === null) return null;
		const created = Date.parse(row.created_at);
		if (Number.isNaN(created) || now - created > ttlMs) return null;
		let raw: unknown;
		try {
			raw = JSON.parse(row.items);
		} catch {
			// Never log the row — previews quote memory content.
			log.warn("forget listing unreadable — treating as absent", {
				conversation: conversationId,
			});
			return null;
		}
		const parsed = listingSchema.safeParse(raw);
		if (!parsed.success) {
			log.warn("forget listing invalid — treating as absent", {
				conversation: conversationId,
			});
			return null;
		}
		const index = Number(ref);
		if (index < 1 || index > parsed.data.length) return null;
		return parsed.data[index - 1]!;
	}
}

// The phone-friendly listing: numbers to pick, previews to recognize,
// dates when known — no raw ids (the delete confirmation echoes the
// resolved id back anyway).
export function renderNumberedListing(items: ForgetItem[]): string {
	return items
		.map((it, i) => `${i + 1}. ${it.preview}${it.date ? ` (${it.date})` : ""}`)
		.join("\n");
}

import { type Database } from "bun:sqlite";
import { z } from "zod";
import { hindsightTarget, targetHashSchema } from "./hindsight.ts";

export interface RecordedDestination {
	target: string;
	baseUrl: string;
	bankId: string;
	auth: string | null;
}

const rowSchema = z.object({
	target: targetHashSchema,
	base_url: z.url(),
	bank_id: z.string().min(1),
	auth: z.string().min(1).nullable(),
});

export class MemoryDestinations {
	constructor(private readonly db: Database) {
		db.run(`CREATE TABLE IF NOT EXISTS memory_destinations (
			target TEXT PRIMARY KEY,
			base_url TEXT NOT NULL,
			bank_id TEXT NOT NULL,
			auth TEXT,
			created_at TEXT NOT NULL
		)`);
	}

	record(destination: {
		baseUrl: string;
		bankId: string;
		auth?: string | null | undefined;
	}): string {
		const target = hindsightTarget(destination.baseUrl, destination.bankId);
		const auth = destination.auth ?? null;
		this.db.run(
			`INSERT INTO memory_destinations (target, base_url, bank_id, auth, created_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(target) DO UPDATE SET auth = excluded.auth`,
			[target, destination.baseUrl, destination.bankId, auth, new Date().toISOString()],
		);
		return target;
	}

	get(target: string): RecordedDestination | null {
		targetHashSchema.parse(target);
		const raw = this.db
			.query("SELECT target, base_url, bank_id, auth FROM memory_destinations WHERE target = ?")
			.get(target);
		if (raw === null) return null;
		const row = rowSchema.parse(raw);
		return { target: row.target, baseUrl: row.base_url, bankId: row.bank_id, auth: row.auth };
	}
}

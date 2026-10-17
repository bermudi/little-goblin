// Destination history: the outbox binds rows to the endpoint+bank
// target hash (hindsightTarget), which is one-way — after a memory
// destination change, the bank that owns a row cannot be addressed
// again unless its connection survives somewhere. This table is that
// somewhere: every boot records its destination, so forgetting can
// reconstruct the owning client and settle/delete through it instead
// of polling a foreign bank (#87). Rows are never deleted — a target
// that once held personal content stays addressable for its lifetime
// in the outbox.
import { type Database } from "bun:sqlite";
import { z } from "zod";
import { hindsightTarget, targetHashSchema } from "./hindsight.ts";

export interface RecordedDestination {
	target: string;
	baseUrl: string;
	bankId: string;
	// The auth.jsonl key NAME, never a token — secrets resolve lazily
	// through the auth store at client-construction time, same as boot.
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

	// Called once per boot with the live memory config. The target hash
	// is derived from the connection, so baseUrl/bankId can never drift
	// for a target; only the auth key name may update (the operator can
	// rotate which key addresses the same bank). Returns the target.
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

	// Fail loud on a corrupted row (design: ENOENT means null, everything
	// else propagates): a destination we cannot prove addressable must
	// surface, not silently degrade into forget refusals.
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

// The desktop pool's SQLite rows, leases, and the helpers that read
// lease state off a row — no podman, no refuse(): this module is the
// pure half under src/desktops.ts (issue #456).
import { Database } from "bun:sqlite";
import { z } from "zod";
import { SQLITE_BUSY_TIMEOUT_MS } from "./sqlite.ts";

export type LeaseHolder =
	| { kind: "run"; id: string }
	| { kind: "conversation"; id: string }
	| { kind: "operator" };

export interface DesktopRow {
	name: string;
	container: string;
	image: string;
	/** The row is intent, podman is truth. */
	network: boolean;
	reserved: boolean;
	leaseKind: "run" | "conversation" | "operator" | null;
	leaseId: string | null;
	leaseExpiresAt: number | null;
	/** The newest minted observation; an action consumes it. */
	lastObsId: string | null;
	lastObsUsed: boolean;
	/** sha256 of the observation frame — PNG bytes for screenshots,
	 *  the cua screenshot (or state JSON) for inspect. */
	lastObsHash: string | null;
	/** The identical-action-on-unchanged-screen refusal state. */
	lastActSig: string | null;
	lastActFrameHash: string | null;
	/** podman State.StartedAt the recorded observation was minted on;
	 *  null = unknown (the next reconcile records it). Optional because
	 *  unknown is a real state for row literals built outside this
	 *  module. */
	bootGen?: string | null;
	shotSeq: number;
	createdAt: number;
	lastUsedAt: number;
}

export interface DesktopStore {
	get(name: string): DesktopRow | null;
	list(): DesktopRow[];
	put(row: DesktopRow): void;
	delete(name: string): void;
	staleBefore(cutoffMs: number, excludeName: string): DesktopRow[];
	close(): void;
}

const rowSchema = z.object({
	name: z.string(),
	container: z.string(),
	image: z.string(),
	network: z.number(),
	reserved: z.number(),
	lease_kind: z.enum(["run", "conversation", "operator"]).nullable(),
	lease_id: z.string().nullable(),
	lease_expires_at: z.number().nullable(),
	last_obs_id: z.string().nullable(),
	last_obs_used: z.number(),
	last_obs_hash: z.string().nullable(),
	last_act_sig: z.string().nullable(),
	last_act_frame_hash: z.string().nullable(),
	boot_gen: z.string().nullable(),
	shot_seq: z.number(),
	created_at: z.number(),
	last_used_at: z.number(),
});

function toRow(row: unknown): DesktopRow {
	const r = rowSchema.parse(row);
	return {
		name: r.name,
		container: r.container,
		image: r.image,
		network: r.network !== 0,
		reserved: r.reserved !== 0,
		leaseKind: r.lease_kind,
		leaseId: r.lease_id,
		leaseExpiresAt: r.lease_expires_at,
		lastObsId: r.last_obs_id,
		lastObsUsed: r.last_obs_used !== 0,
		lastObsHash: r.last_obs_hash,
		lastActSig: r.last_act_sig,
		lastActFrameHash: r.last_act_frame_hash,
		bootGen: r.boot_gen,
		shotSeq: r.shot_seq,
		createdAt: r.created_at,
		lastUsedAt: r.last_used_at,
	};
}

export function openDesktops(dbPath: string): DesktopStore {
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
	db.exec(`CREATE TABLE IF NOT EXISTS desktops (
		name TEXT PRIMARY KEY,
		container TEXT NOT NULL,
		image TEXT NOT NULL,
		network INTEGER NOT NULL,
		reserved INTEGER NOT NULL DEFAULT 0,
		lease_kind TEXT,
		lease_id TEXT,
		lease_expires_at INTEGER,
		last_obs_id TEXT,
		last_obs_used INTEGER NOT NULL DEFAULT 0,
		last_obs_hash TEXT,
		last_act_sig TEXT,
		last_act_frame_hash TEXT,
		boot_gen TEXT,
		shot_seq INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL,
		last_used_at INTEGER NOT NULL
	)`);
	// NULL reads as unknown generation — the first reconcile
	// invalidates any recorded observation (fail-closed).
	const cols = new Set(
		db
			.query<{ name: string }, []>("PRAGMA table_info(desktops)")
			.all()
			.map((c) => c.name),
	);
	if (!cols.has("boot_gen")) db.run("ALTER TABLE desktops ADD COLUMN boot_gen TEXT");
	const qGet = db.query("SELECT * FROM desktops WHERE name = ?");
	const qList = db.query("SELECT * FROM desktops ORDER BY name");
	const qPut = db.query(
		`INSERT INTO desktops (name, container, image, network, reserved,
			lease_kind, lease_id, lease_expires_at,
			last_obs_id, last_obs_used, last_obs_hash,
			last_act_sig, last_act_frame_hash, boot_gen, shot_seq,
			created_at, last_used_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(name) DO UPDATE SET
			container = excluded.container, image = excluded.image,
			network = excluded.network, reserved = excluded.reserved,
			lease_kind = excluded.lease_kind, lease_id = excluded.lease_id,
			lease_expires_at = excluded.lease_expires_at,
			last_obs_id = excluded.last_obs_id,
			last_obs_used = excluded.last_obs_used,
			last_obs_hash = excluded.last_obs_hash,
			last_act_sig = excluded.last_act_sig,
			last_act_frame_hash = excluded.last_act_frame_hash,
			boot_gen = excluded.boot_gen,
			shot_seq = excluded.shot_seq,
			created_at = excluded.created_at,
			last_used_at = excluded.last_used_at`,
	);
	const qDelete = db.query("DELETE FROM desktops WHERE name = ?");
	const qStale = db.query("SELECT * FROM desktops WHERE last_used_at < ? AND name != ?");
	return {
		get: (name) => {
			const row = qGet.get(name);
			return row === null ? null : toRow(row);
		},
		list: () => qList.all().map(toRow),
		put: (row) =>
			void qPut.run(
				row.name,
				row.container,
				row.image,
				row.network ? 1 : 0,
				row.reserved ? 1 : 0,
				row.leaseKind,
				row.leaseId,
				row.leaseExpiresAt,
				row.lastObsId,
				row.lastObsUsed ? 1 : 0,
				row.lastObsHash,
				row.lastActSig,
				row.lastActFrameHash,
				row.bootGen ?? null,
				row.shotSeq,
				row.createdAt,
				row.lastUsedAt,
			),
		delete: (name) => void qDelete.run(name),
		staleBefore: (cutoffMs, exclude) => qStale.all(cutoffMs, exclude).map(toRow),
		close: () => db.close(),
	};
}

export const LEASE_TTL_MS = 10 * 60_000;

export function holderId(holder: LeaseHolder): string | null {
	return holder.kind === "operator" ? null : holder.id;
}

export function holderLabel(holder: LeaseHolder): string {
	return holder.kind === "operator" ? "operator" : `${holder.kind} ${holder.id}`;
}

export function rowHolderLabel(row: DesktopRow): string {
	return row.leaseKind === "operator" ? "operator" : `${row.leaseKind} ${row.leaseId ?? ""}`;
}

export function leaseLive(row: DesktopRow, now: number): boolean {
	return row.leaseKind !== null && row.leaseExpiresAt !== null && row.leaseExpiresAt > now;
}

export function leaseHeldBy(row: DesktopRow, holder: LeaseHolder, now: number): boolean {
	return leaseLive(row, now) && row.leaseKind === holder.kind && row.leaseId === holderId(holder);
}

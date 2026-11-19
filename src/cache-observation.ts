import type { Database } from "bun:sqlite";
import type { Usage } from "./message.ts";
import { z } from "zod";

export type CachePrefixRelation = "first" | "same" | "append" | "rewrite";

export interface CacheCompletedReceipt {
	finishedMs: number | null;
	idleMs: number | null;
	cacheRead: number | null;
	inputTokens: number | null;
	prefixRelation: CachePrefixRelation;
	settingsHash: string;
}

export interface CacheCallInput {
	callId: string;
	conversationId: string | null;
	purpose: string | null;
	model: string;
	routeKey: string;
	headHash: string;
	requestHash: string;
	settingsHash: string;
	promptHashes: string[];
}

export interface CacheCallObservation {
	readonly callId: string;
	readonly routeKey: string;
	readonly idleMs: number | null;
	readonly prefixRelation: CachePrefixRelation;
	readonly sharedMessages: number;
	finish(usage: Usage | undefined, cacheTtlMs?: number | null): void;
	fail(): void;
}

export interface IdleCacheCall {
	callId: string;
	routeKey: string;
	startedMs: number;
	inputTokens: number | null;
	ttlMs: number | null;
}

export interface CacheObservation {
	begin(input: CacheCallInput): CacheCallObservation;
	// Read-only lineage read for between-turns policy: the newest
	// completed normal (purpose IS NULL) call on one conversation+route
	// recorded under this settings hash — a profile's evidence must be
	// the same surface it authorizes. Null = no completed call exists;
	// never creates or mutates a row.
	lastCompleted(
		conversationId: string,
		routeKey: string,
		settingsHash: string,
	): CacheCompletedReceipt | null;
	// The same surface, every completed receipt started after `sinceMs`,
	// newest-first — the drift check must see receipts a later cache hit
	// masks, not only the latest one (a multi-call turn can bury an
	// earlier zero-read contradiction). `sinceMs` is the profile's
	// review: receipts the operator already saw when authorizing the
	// profile are acknowledged evidence, not fresh contradictions.
	completedReceipts(
		conversationId: string,
		routeKey: string,
		settingsHash: string,
		sinceMs: number,
	): CacheCompletedReceipt[];
	// A contradicted pruning profile stays suspended until the profile
	// itself changes — a later cache-hit receipt is evidence about a
	// different window, never proof the measured one was right.
	suspendPruning(input: {
		conversationId: string;
		routeKey: string;
		settingsHash: string;
		profileHash: string;
		reason: string;
	}): void;
	pruningSuspension(
		conversationId: string,
		routeKey: string,
		settingsHash: string,
		profileHash: string,
	): { reason: string; observedMs: number } | null;
	idleCacheCall(conversationId: string): IdleCacheCall | null;
	recentConversations(sinceMs: number): string[];
}

const prevSchema = z.object({
	started_ms: z.number(),
	finished_ms: z.number().nullable(),
	head_hash: z.string(),
	settings_hash: z.string(),
	prompt_hashes: z.string(),
});

const lastCompletedSchema = z.object({
	finished_ms: z.number().nullable(),
	idle_ms: z.number().nullable(),
	cache_read: z.number().nullable(),
	input_tokens: z.number().nullable(),
	prefix_relation: z.enum(["first", "same", "append", "rewrite"]),
	settings_hash: z.string(),
});

const hashesSchema = z.array(z.string());

function sharedPrefix(current: string[], previous: string[]): number {
	let n = 0;
	while (n < previous.length && n < current.length && previous[n] === current[n]) n++;
	return n;
}

const MODEL_CACHE_CALLS_DDL = `CREATE TABLE IF NOT EXISTS model_cache_calls (
	call_id TEXT PRIMARY KEY,
	conversation_id TEXT,
	purpose TEXT,
	route_key TEXT NOT NULL,
	model TEXT NOT NULL,
	started_ms INTEGER NOT NULL,
	finished_ms INTEGER,
	head_hash TEXT NOT NULL,
	request_hash TEXT NOT NULL,
	settings_hash TEXT NOT NULL,
	prompt_hashes TEXT NOT NULL,
	status TEXT NOT NULL,
	input_tokens INTEGER,
	cache_read INTEGER,
	cache_write INTEGER,
	output_tokens INTEGER,
	idle_ms INTEGER,
	prefix_relation TEXT NOT NULL,
	shared_messages INTEGER NOT NULL,
	cache_ttl_ms INTEGER
)`;

function ensureCacheTtlColumn(db: Database): void {
	const columns = z
		.array(z.object({ name: z.string() }))
		.parse(db.query("PRAGMA table_info(model_cache_calls)").all());
	if (!columns.some((column) => column.name === "cache_ttl_ms")) {
		db.run("ALTER TABLE model_cache_calls ADD COLUMN cache_ttl_ms INTEGER");
	}
}

export function openCacheObservation(
	db: Database,
	options?: { now?: () => number },
): CacheObservation {
	const now = options?.now ?? Date.now;
	db.run(MODEL_CACHE_CALLS_DDL);
	ensureCacheTtlColumn(db);
	db.run(
		"CREATE INDEX IF NOT EXISTS model_cache_calls_lineage ON model_cache_calls(conversation_id, route_key, purpose, started_ms DESC)",
	);
	const qInsert = db.query(
		`INSERT INTO model_cache_calls (
			call_id, conversation_id, purpose, route_key, model, started_ms,
			head_hash, request_hash, settings_hash, prompt_hashes, status,
			idle_ms, prefix_relation, shared_messages
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'started', ?, ?, ?)`,
	);
	const qComplete = db.query(
		`UPDATE model_cache_calls SET status = 'completed', finished_ms = ?,
			input_tokens = ?, cache_read = ?, cache_write = ?, output_tokens = ?, cache_ttl_ms = ?
		WHERE call_id = ?`,
	);
	const qIdleCall = db.query(
		`SELECT calls.call_id, calls.route_key, calls.started_ms, calls.input_tokens,
			(SELECT ttl.cache_ttl_ms FROM model_cache_calls ttl
			 WHERE ttl.conversation_id = calls.conversation_id AND ttl.route_key = calls.route_key
				AND ttl.purpose IS NULL AND ttl.status = 'completed' AND ttl.cache_ttl_ms IS NOT NULL
			 ORDER BY ttl.started_ms DESC, ttl.rowid DESC LIMIT 1) AS ttl_ms
		FROM model_cache_calls calls WHERE calls.conversation_id = ?
			AND calls.purpose IS NULL AND calls.status = 'completed'
		ORDER BY calls.started_ms DESC, calls.rowid DESC LIMIT 1`,
	);
	const idleCallSchema = z.object({
		call_id: z.string(),
		route_key: z.string(),
		started_ms: z.number(),
		input_tokens: z.number().nullable(),
		ttl_ms: z.number().nullable(),
	});
	const qRecentConversations = db.query(
		`SELECT DISTINCT conversation_id FROM model_cache_calls
		WHERE conversation_id IS NOT NULL AND purpose IS NULL
			AND status = 'completed' AND started_ms > ?`,
	);
	const qFailed = db.query(
		"UPDATE model_cache_calls SET status = 'failed', finished_ms = ? WHERE call_id = ?",
	);
	const qPrev = db.query(
		`SELECT started_ms, finished_ms, head_hash, settings_hash, prompt_hashes
		FROM model_cache_calls
		WHERE conversation_id = ? AND route_key = ? AND purpose IS ? AND status = 'completed'
		ORDER BY started_ms DESC, rowid DESC LIMIT 1`,
	);
	const qLastCompleted = db.query(
		`SELECT finished_ms, idle_ms, cache_read, input_tokens, prefix_relation, settings_hash
		FROM model_cache_calls
		WHERE conversation_id = ? AND route_key = ? AND settings_hash = ?
			AND purpose IS NULL AND status = 'completed'
		ORDER BY started_ms DESC, rowid DESC LIMIT 1`,
	);
	const qCompletedAll = db.query(
		`SELECT finished_ms, idle_ms, cache_read, input_tokens, prefix_relation, settings_hash
		FROM model_cache_calls
		WHERE conversation_id = ? AND route_key = ? AND settings_hash = ?
			AND purpose IS NULL AND status = 'completed' AND started_ms > ?
		ORDER BY started_ms DESC, rowid DESC`,
	);
	db.run(`CREATE TABLE IF NOT EXISTS cache_pruning_suspensions (
		conversation_id TEXT NOT NULL,
		route_key TEXT NOT NULL,
		settings_hash TEXT NOT NULL,
		profile_hash TEXT NOT NULL,
		reason TEXT NOT NULL,
		observed_ms INTEGER NOT NULL,
		PRIMARY KEY (conversation_id, route_key, settings_hash, profile_hash)
	)`);
	const qSuspend = db.query(
		`INSERT OR IGNORE INTO cache_pruning_suspensions
			(conversation_id, route_key, settings_hash, profile_hash, reason, observed_ms)
		VALUES (?, ?, ?, ?, ?, ?)`,
	);
	const qSuspension = db.query(
		`SELECT reason, observed_ms FROM cache_pruning_suspensions
		WHERE conversation_id = ? AND route_key = ? AND settings_hash = ? AND profile_hash = ?`,
	);
	return {
		lastCompleted(conversationId, routeKey, settingsHash) {
			const raw = qLastCompleted.get(conversationId, routeKey, settingsHash);
			if (raw === null) return null;
			const row = lastCompletedSchema.parse(raw);
			return {
				finishedMs: row.finished_ms,
				idleMs: row.idle_ms,
				cacheRead: row.cache_read,
				inputTokens: row.input_tokens,
				prefixRelation: row.prefix_relation,
				settingsHash: row.settings_hash,
			};
		},
		completedReceipts(conversationId, routeKey, settingsHash, sinceMs) {
			return qCompletedAll
				.all(conversationId, routeKey, settingsHash, sinceMs)
				.map((raw) => lastCompletedSchema.parse(raw))
				.map((row) => ({
					finishedMs: row.finished_ms,
					idleMs: row.idle_ms,
					cacheRead: row.cache_read,
					inputTokens: row.input_tokens,
					prefixRelation: row.prefix_relation,
					settingsHash: row.settings_hash,
				}));
		},
		suspendPruning(input) {
			qSuspend.run(
				input.conversationId,
				input.routeKey,
				input.settingsHash,
				input.profileHash,
				input.reason,
				now(),
			);
		},
		pruningSuspension(conversationId, routeKey, settingsHash, profileHash) {
			const raw = qSuspension.get(conversationId, routeKey, settingsHash, profileHash);
			if (raw === null) return null;
			const row = z.object({ reason: z.string(), observed_ms: z.number() }).parse(raw);
			return { reason: row.reason, observedMs: row.observed_ms };
		},
		idleCacheCall(conversationId) {
			const raw = qIdleCall.get(conversationId);
			if (raw === null) return null;
			const row = idleCallSchema.parse(raw);
			return {
				callId: row.call_id,
				routeKey: row.route_key,
				startedMs: row.started_ms,
				inputTokens: row.input_tokens,
				ttlMs: row.ttl_ms,
			};
		},
		recentConversations(sinceMs) {
			const rowSchema = z.object({ conversation_id: z.string().nullable() });
			return qRecentConversations
				.all(sinceMs)
				.map((raw) => rowSchema.parse(raw).conversation_id)
				.flatMap((id) => (id === null ? [] : [id]));
		},
		begin(input) {
			const raw =
				input.conversationId === null
					? null
					: qPrev.get(input.conversationId, input.routeKey, input.purpose);
			const prev = raw === null ? null : prevSchema.parse(raw);
			const startedMs = now();
			let idleMs: number | null = null;
			let shared = 0;
			let relation: CachePrefixRelation;
			if (prev === null) {
				relation = "first";
			} else {
				const prevHashes = hashesSchema.parse(JSON.parse(prev.prompt_hashes));
				shared = sharedPrefix(input.promptHashes, prevHashes);
				idleMs = prev.finished_ms === null ? null : Math.max(0, startedMs - prev.finished_ms);
				const sameHead = prev.head_hash === input.headHash;
				const sameSettings = prev.settings_hash === input.settingsHash;
				if (shared === prevHashes.length && shared === input.promptHashes.length) {
					relation = sameHead && sameSettings ? "same" : "rewrite";
				} else if (
					prevHashes.length < input.promptHashes.length &&
					shared === prevHashes.length &&
					sameHead &&
					sameSettings
				) {
					relation = "append";
				} else {
					relation = "rewrite";
				}
			}
			qInsert.run(
				input.callId,
				input.conversationId,
				input.purpose,
				input.routeKey,
				input.model,
				startedMs,
				input.headHash,
				input.requestHash,
				input.settingsHash,
				JSON.stringify(input.promptHashes),
				idleMs,
				relation,
				shared,
			);
			let settled = false;
			return {
				callId: input.callId,
				routeKey: input.routeKey,
				idleMs,
				prefixRelation: relation,
				sharedMessages: shared,
				finish(usage, cacheTtlMs = null) {
					if (settled) return;
					qComplete.run(
						now(),
						usage?.inputTokens ?? null,
						usage?.inputTokenDetails.cacheReadTokens ?? null,
						usage?.inputTokenDetails.cacheWriteTokens ?? null,
						usage?.outputTokens ?? null,
						cacheTtlMs,
						input.callId,
					);
					settled = true;
				},
				fail() {
					if (settled) return;
					qFailed.run(now(), input.callId);
					settled = true;
				},
			};
		},
	};
}

// ---------- the window view's call lineage ----------

// Every model call recorded against one conversation, newest first —
// the historical half of the context-window view (the stored window is
// the newest call's prompt; these rows are every call that hit it).
export interface CacheCallRow {
	callId: string;
	purpose: string | null;
	routeKey: string;
	model: string;
	startedMs: number;
	finishedMs: number | null;
	status: string;
	inputTokens: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
	outputTokens: number | null;
	prefixRelation: string;
	sharedMessages: number;
}

const callRowSchema = z.object({
	call_id: z.string(),
	purpose: z.string().nullable(),
	route_key: z.string(),
	model: z.string(),
	started_ms: z.number(),
	finished_ms: z.number().nullable(),
	status: z.string(),
	input_tokens: z.number().nullable(),
	cache_read: z.number().nullable(),
	cache_write: z.number().nullable(),
	output_tokens: z.number().nullable(),
	prefix_relation: z.string(),
	shared_messages: z.number(),
});

export function listCalls(db: Database, conversationId: string, limit = 200): CacheCallRow[] {
	db.run(MODEL_CACHE_CALLS_DDL);
	const rows = db
		.query(
			`SELECT call_id, purpose, route_key, model, started_ms, finished_ms, status,
				input_tokens, cache_read, cache_write, output_tokens, prefix_relation, shared_messages
			FROM model_cache_calls WHERE conversation_id = ?
			ORDER BY started_ms DESC, rowid DESC LIMIT ?`,
		)
		.all(conversationId, limit);
	return rows.map((raw) => {
		const row = callRowSchema.parse(raw);
		return {
			callId: row.call_id,
			purpose: row.purpose,
			routeKey: row.route_key,
			model: row.model,
			startedMs: row.started_ms,
			finishedMs: row.finished_ms,
			status: row.status,
			inputTokens: row.input_tokens,
			cacheRead: row.cache_read,
			cacheWrite: row.cache_write,
			outputTokens: row.output_tokens,
			prefixRelation: row.prefix_relation,
			sharedMessages: row.shared_messages,
		};
	});
}

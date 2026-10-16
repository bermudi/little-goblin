import type { Database } from "bun:sqlite";
import type { LanguageModelV4Usage } from "@ai-sdk/provider";
import { z } from "zod";

export type CachePrefixRelation = "first" | "same" | "append" | "rewrite";

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
	finish(usage: LanguageModelV4Usage | undefined): void;
	fail(): void;
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
	): {
		finishedMs: number | null;
		idleMs: number | null;
		cacheRead: number | null;
		inputTokens: number | null;
		prefixRelation: CachePrefixRelation;
		settingsHash: string;
	} | null;
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

export function openCacheObservation(
	db: Database,
	options?: { now?: () => number },
): CacheObservation {
	const now = options?.now ?? Date.now;
	db.run(`CREATE TABLE IF NOT EXISTS model_cache_calls (
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
		shared_messages INTEGER NOT NULL
	)`);
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
			input_tokens = ?, cache_read = ?, cache_write = ?, output_tokens = ?
		WHERE call_id = ?`,
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
				finish(usage) {
					if (settled) return;
					qComplete.run(
						now(),
						usage?.inputTokens.total ?? null,
						usage?.inputTokens.cacheRead ?? null,
						usage?.inputTokens.cacheWrite ?? null,
						usage?.outputTokens.total ?? null,
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

// Gmail reads through the gws CLI (DESIGN.md, "Email").
//
// The watcher's poll/profile/thread surface, backed by gws raw Discovery
// calls (users.history.list, users.messages.list/get, users.getProfile)
// with JSON output. The model's read path is the goblin-mail wrapper +
// gws skill, not this module — this is the background poller plus the
// approval gate's threading lookup.
//
// Fakes at the process seam: the runner is injectable (herdr.ts's
// pattern); tests never spawn the real gws. gws owns its auth
// (`gws auth login`) — no tokens here. Log lines carry action,
// filter/id, counts, exit code, ms — never bodies or snippets.

import { z } from "zod";
import { decodeRfc2047, HistoryExpiredError, type MailHit, type MailPoller } from "./mail.ts";
import { log } from "./log.ts";
import { boundedRun, spawnProc } from "./proc.ts";
import { ProviderError, str } from "./agent/tools/web.ts";

// One watcher tick fires once no matter how many matches — the batch
// cap bounds the per-tick get fan-out, oldest first.
const POLL_BATCH_CAP = 10;
// The intersection window: how many of the filter's recent matches the
// list call can see. A full page means arrivals older than the newest
// LIST_PAGE matches are invisible to the intersection — the one way a
// match can still be lost, and it gets a warn line when it's possible.
const LIST_PAGE = 50;

const GWS_TIMEOUT_MS = 30_000;
const GWS_MAX_OUTPUT = 1 << 20;

export interface GwsRunResult {
	code: number;
	stdout: string;
	stderr: string;
}
export type GwsRunner = (args: string[]) => Promise<GwsRunResult>;

const defaultRunner: GwsRunner = async (args) => {
	const proc = spawnProc(["gws", ...args]);
	const r = await boundedRun(proc, {
		timeoutMs: GWS_TIMEOUT_MS,
		maxOutput: GWS_MAX_OUTPUT,
	});
	return {
		code: r.exitCode ?? -1,
		stdout: r.stdout,
		// A killed run's real story is the timeout, not partial stderr.
		stderr: r.timedOut ? `gws timed out after ${GWS_TIMEOUT_MS}ms` : r.stderr,
	};
};

/** The gws-backed MailPoller — structurally a MailPoller (the watcher
 *  and the approval gate depend on the shape, not the name). */
export interface GwsMailReader extends MailPoller {}

// ---------- gws output shapes (raw Discovery JSON, --format json) ----------
// Load-bearing leaves are typed: a missing id or historyId is provider
// drift and must throw (parseOrThrow → ProviderError), not collapse to
// "" through str() and masquerade as success (audit #8). Display-only
// fields (snippet, resultSizeEstimate) stay lenient — absence is a
// legitimate empty, not drift.

const historyMessageSchema = z.object({
	message: z.object({ id: z.string(), threadId: z.string().optional() }).passthrough(),
}).passthrough();

const historyRecordSchema = z.object({
	id: z.string(),
	messagesAdded: z.array(historyMessageSchema).optional(),
}).passthrough();

const historyPageSchema = z.object({
	history: z.array(historyRecordSchema).optional(),
	historyId: z.string(),
	nextPageToken: z.string().optional(),
}).passthrough();

const messagesListSchema = z.object({
	messages: z.array(
		z.object({ id: z.string(), threadId: z.string().optional() }).passthrough(),
	).optional(),
	nextPageToken: z.string().optional(),
	resultSizeEstimate: z.unknown().optional(),
}).passthrough();

const messageGetSchema = z.object({
	id: z.string(),
	threadId: z.string(),
	snippet: z.string().optional(),
	payload: z.object({
		headers: z.array(
			z.object({ name: z.string(), value: z.string() }).passthrough(),
		).optional(),
	}).passthrough().optional(),
}).passthrough();

const profileSchema = z.object({
	historyId: z.string(),
}).passthrough();

function parseOrThrow<T>(action: string, schema: z.ZodType<T>, data: unknown): T {
	try {
		return schema.parse(data);
	} catch (err) {
		throw new ProviderError("gws", `${action} returned an unexpected shape — ${(err as Error).message.slice(0, 200)}`);
	}
}

function header(
	payload: { headers?: Array<{ name?: unknown; value?: unknown }> | undefined } | undefined,
	name: string,
): string {
	const headers = payload?.headers ?? [];
	const want = name.toLowerCase();
	for (const h of headers) {
		if (str(h.name).toLowerCase() === want) return decodeRfc2047(str(h.value));
	}
	return "";
}

/** The API error code gws carried on stdout, if any (Google error
 *  envelope `{error:{code}}` — the unauthenticated probe showed code
 *  401 there). Empty when stdout isn't that shape. */
/** A gws failure carrying the API error code it failed with — callers
 *  match on the parsed code ("404" means history-expiry or a missing
 *  target), never on message substrings: the message embeds stderr for
 *  the log, and an unrelated failure mentioning 404 must not silently
 *  re-baseline or swallow (audit #12). Empty code = no envelope. */
export class GwsApiError extends ProviderError {
	constructor(
		message: string,
		public readonly apiCode: string,
	) {
		super("gws", message);
		this.name = "GwsApiError";
	}
}

function apiCode(stdout: string): string {
	try {
		const parsed = JSON.parse(stdout) as { error?: { code?: unknown } };
		const code = parsed?.error?.code;
		if (typeof code === "number") return String(code);
		if (typeof code === "string" && code.trim() !== "") return code.trim();
	} catch {
		// Not the error envelope — no code to report.
	}
	return "";
}

export function makeGwsReader(run: GwsRunner = defaultRunner): GwsMailReader {
	// One gws call, parsed as JSON. Non-zero exits become ProviderError
	// carrying the API code when stdout names one (`HTTP 404` — the
	// history-expiry and missing-target signals callers match on) or the
	// exit code otherwise. Stderr is truncated and whitespace-collapsed:
	// it names the fix (re-login, bad args), never mail content.
	async function gwsJson(args: string[], action: string, fields: Record<string, unknown>): Promise<unknown> {
		const started = Date.now();
		let r: GwsRunResult;
		try {
			r = await run(args);
		} catch (err) {
			throw new ProviderError("gws", `${action} could not spawn gws — ${(err as Error).message}`);
		}
		const ms = Date.now() - started;
		if (r.code !== 0) {
			const code = apiCode(r.stdout);
			const detail = (r.stderr || "").replace(/\s+/g, " ").trim().slice(0, 300);
			log.warn("gws mail call failed", { action, ...fields, status: r.code, ms });
			throw new GwsApiError(
				code !== ""
					? `${action} failed — HTTP ${code}${detail ? ` — ${detail}` : ""}`
					: `${action} failed — exit ${r.code}${detail ? ` — ${detail}` : ""}`,
				code,
			);
		}
		let data: unknown;
		try {
			data = JSON.parse(r.stdout) as unknown;
		} catch (err) {
			throw new ProviderError("gws", `${action} returned non-JSON — ${(err as Error).message}`);
		}
		log.info("gws mail call", { action, ...fields, status: r.code, ms });
		return data;
	}

	async function getMetadata(id: string): Promise<MailHit> {
		const data = await gwsJson(
			["gmail", "users", "messages", "get", "--params",
				JSON.stringify({ userId: "me", id, format: "METADATA", metadataHeaders: ["From", "Subject", "Date"] }),
				"--format", "json"],
			"meta.get",
			{ id },
		);
		const body = parseOrThrow("meta.get", messageGetSchema, data);
		return {
			// No request-id substitution: an id-less get is drift and threw
			// above — the hit's identity is the wire's, always.
			id: body.id,
			threadId: body.threadId,
			from: header(body.payload, "From"),
			subject: header(body.payload, "Subject"),
			date: header(body.payload, "Date"),
			snippet: str(body.snippet),
		};
	}

	async function poll(filter: string, startHistoryId: string): Promise<{ hits: MailHit[]; historyId: string }> {
		const records: Array<{ id: string; ids: string[] }> = [];
		let latest = "";
		let pageToken = "";
		const seenTokens = new Set<string>();
		// Keep the records whole, in ascending id order: a capped batch
		// checkpoints at its last fired record so the unfired matches stay
		// ahead of the cursor instead of being skipped forever.
		do {
			const params: Record<string, unknown> = {
				userId: "me",
				startHistoryId,
				historyTypes: ["messageAdded"],
				...(pageToken !== "" ? { pageToken } : {}),
			};
			let data: unknown;
			try {
				data = await gwsJson(
					["gmail", "users", "history", "list", "--params", JSON.stringify(params), "--format", "json"],
					"poll.history",
					{ filter },
				);
			} catch (err) {
				// Expired ids 404 — the only 404 here that means "re-baseline";
				// anything else propagates as a poll failure.
				if (err instanceof GwsApiError && err.apiCode === "404") {
					throw new HistoryExpiredError();
				}
				throw err;
			}
			const body = parseOrThrow("poll.history", historyPageSchema, data);
			latest = body.historyId || latest;
			for (const h of body.history ?? []) {
				const ids: string[] = [];
				for (const m of h.messagesAdded ?? []) {
					const id = m.message.id;
					if (id !== "") ids.push(id);
				}
				records.push({ id: h.id, ids });
			}
			pageToken = body.nextPageToken ?? "";
			if (pageToken !== "" && (seenTokens.has(pageToken) || seenTokens.size >= 100)) {
				throw new ProviderError("gws", "history pagination repeated or exceeded 100 pages — cursor unchanged");
			}
			if (pageToken !== "") seenTokens.add(pageToken);
		} while (pageToken !== "");
		log.info("mail poll history pages loaded", { filter, pages: seenTokens.size + 1, records: records.length });
		records.sort((a, b) => Number(a.id) - Number(b.id));
		const added = new Set(records.flatMap((r) => r.ids));
		if (added.size === 0) return { hits: [], historyId: latest };
		// history.list takes no query — intersect the mailbox-wide
		// arrivals with the filter's own recent matches (newest first),
		// then present oldest first.
		const listData = await gwsJson(
			["gmail", "users", "messages", "list", "--params",
				JSON.stringify({ userId: "me", q: filter, maxResults: LIST_PAGE }), "--format", "json"],
			"poll.list",
			{ filter },
		);
		const listBody = parseOrThrow("poll.list", messagesListSchema, listData);
		const matching = listBody.messages ?? [];
		if (matching.length >= LIST_PAGE) {
			// The intersection window may have truncated: arrivals older
			// than the newest LIST_PAGE matches are invisible to it, and a
			// head checkpoint would skip them silently — the log says so.
			log.warn("mail poll filter list page full — matches older than the newest 50 may be skipped by this checkpoint", {
				filter,
				listed: matching.length,
			});
		}
		const matched = matching.map((m) => m.id).filter((id) => added.has(id));
		matched.reverse();
		// Within a record, keep the oldest-first order the list established.
		const order = new Map(matched.map((id, i) => [id, i] as const));
		// Batch WHOLE records: taking a record takes all of its matches,
		// and the batch stops before the record that would push it past
		// the cap — that record re-arrives on the next poll from the
		// record-boundary checkpoint below.
		const batch: string[] = [];
		let lastIncluded = "";
		let truncated = false;
		for (const rec of records) {
			const recMatched = rec.ids
				.filter((id) => order.has(id))
				.sort((a, b) => order.get(a)! - order.get(b)!);
			if (recMatched.length === 0) continue;
			if (batch.length + recMatched.length > POLL_BATCH_CAP) {
				if (batch.length === 0) {
					// A single record's burst alone exceeds the cap — a record
					// is the smallest checkpoint unit, so the overflow can only
					// be skipped, never deferred. Fire the first cap-many,
					// advance past the record, and say exactly what was lost.
					batch.push(...recMatched.slice(0, POLL_BATCH_CAP));
					log.warn(
						`Gmail collapsed a burst into one history record — ${recMatched.length - POLL_BATCH_CAP} matches skipped`,
						{ filter, matched: recMatched.length, firing: POLL_BATCH_CAP },
					);
					lastIncluded = rec.id;
				}
				truncated = true;
				break;
			}
			batch.push(...recMatched);
			lastIncluded = rec.id;
		}
		const hits: MailHit[] = [];
		for (const id of batch) hits.push(await getMetadata(id));
		// Every match fired → the head (past every record, matched or
		// not); truncated → the last fired record's id, so the unfired
		// remainder is still ahead of the cursor.
		return { hits, historyId: truncated ? lastIncluded : latest };
	}

	async function profileHistoryId(): Promise<string> {
		const data = await gwsJson(
			["gmail", "users", "getProfile", "--params", JSON.stringify({ userId: "me" }), "--format", "json"],
			"profile.get",
			{},
		);
		const body = parseOrThrow("profile.get", profileSchema, data);
		return body.historyId;
	}

	async function threadFor(replyToId: string): Promise<{ threadId: string; messageId: string | null } | null> {
		let data: unknown;
		try {
			data = await gwsJson(
				["gmail", "users", "messages", "get", "--params",
					JSON.stringify({ userId: "me", id: replyToId, format: "METADATA", metadataHeaders: ["Message-ID"] }),
					"--format", "json"],
				"reply.get",
				{ id: replyToId },
			);
		} catch (err) {
			// A missing reply target is model-actionable (don't thread a
			// ghost); anything else is a failure.
			if (err instanceof GwsApiError && err.apiCode === "404") return null;
			throw err;
		}
		const body = parseOrThrow("reply.get", messageGetSchema, data);
		const threadId = str(body.threadId);
		if (threadId === "") return null;
		const messageId = header(body.payload, "Message-ID");
		return { threadId, messageId: messageId === "" ? null : messageId };
	}

	return { poll, profileHistoryId, threadFor };
}

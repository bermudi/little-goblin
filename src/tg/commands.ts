// Commands are deliberately few: /voice /memory /forget /stop /compact
// — plus /start, the one non-settings command: a canned greeting for the
// message every Telegram client fires automatically on first open.
// /model and /think are retired — the mini app owns model and thinking
// settings. No conversation-lifecycle commands — topics own that. Every
// settings change bumps the conversation epoch, fencing in-flight turns.

import type { Database } from "bun:sqlite";
import type { Api } from "grammy";
import { type ConfigRef } from "../config.ts";
import type { Conversation, ConversationStore } from "../conversation.ts";
import { HindsightClient, HindsightError } from "../hindsight.ts";
import { memoryStatus, type MemoryContexts } from "../memory.ts";
import type { MemoryQueue } from "../memory-queue.ts";
import type { Runtime } from "../runtime.ts";
import { log } from "../log.ts";
import { ForgetListings, renderNumberedListing, type ForgetItem } from "./forget-listings.ts";

export interface CommandMemoryDeps {
	client: HindsightClient;
	contexts: MemoryContexts;
	queue: MemoryQueue;
	lastRecallOk(): boolean | null;
	// ISO timestamp of the latest recall outcome (set alongside
	// lastRecallOk) — null when no recall has happened yet.
	lastRecallAt(): string | null;
	// /forget delete's settle-wait timing. Production omits it and gets
	// the defaults; tests inject small values instead of sleeping the
	// real budget (same ruling as MemoryQueueWorker's injectable clock).
	settleTiming?: { pollMs: number; budgetMs: number };
}

export interface CommandDeps {
	api: Api;
	configRef: ConfigRef;
	store: ConversationStore;
	runtime: Runtime;
	// This bot's own username — commands can be addressed /cmd@botname.
	botUsername: string;
	// Long-term memory wiring — absent = memory not configured.
	memory?: CommandMemoryDeps;
}

function target(conv: Conversation) {
	return {
		...(conv.threadId !== null ? { message_thread_id: conv.threadId } : {}),
	};
}

// Local wall clock — the operator is the admin and /memory status is
// read by them, on this box (same ruling as cron's local timezone).
function clockHM(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "never";
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function reply(deps: CommandDeps, conv: Conversation, text: string): void {
	deps.api.sendMessage(conv.chatId, text, target(conv)).catch((err: unknown) => {
		log.warn("command reply failed", { error: String(err) });
	});
}

// /forget's numbered listings live in the store's own SQLite file — one
// ForgetListings per database, built on first use. Not a CommandDeps
// field: /forget is the only consumer, and the cache is command UX, not
// memory-domain wiring.
const forgetListingsByDb = new WeakMap<Database, ForgetListings>();
function listingsFor(db: Database): ForgetListings {
	let listings = forgetListingsByDb.get(db);
	if (listings === undefined) {
		listings = new ForgetListings(db);
		forgetListingsByDb.set(db, listings);
	}
	return listings;
}

// Apply a settings change: patch meta + bump epoch (fences in-flight
// turns) atomically.
function apply(deps: CommandDeps, conv: Conversation, patch: Parameters<ConversationStore["setMeta"]>[1]): void {
	deps.store.applySettings(conv.id, patch);
}

// /forget delete settles in-flight retention before deleting: a
// submitted operation is acknowledged but may still be processing
// remotely, and a replace-mode retain finishing after the delete would
// re-create the document server-side with its local row already gone
// (DESIGN.md: serialize against in-flight writes before deleting).
const SETTLE_POLL_MS = 2_000;
const SETTLE_BUDGET_MS = 30_000;
// `not_found` is already mapped to null by HindsightClient.operation.
const SETTLE_TERMINAL = new Set(["completed", "failed", "cancelled"]);

// True once every operation reached a terminal state (or was pruned
// server-side — null counts as settled) within the budget; false means
// something is still unsettled and the caller must refuse rather than
// race the delete. Transient Hindsight failures retry inside the same
// budget (each poll logs its own request line); anything that is not a
// HindsightError escapes so the forget attempt fails loud.
async function settleInflightRetention(
	client: HindsightClient,
	operationIds: string[],
	timing?: { pollMs?: number; budgetMs?: number },
): Promise<boolean> {
	const pollMs = timing?.pollMs ?? SETTLE_POLL_MS;
	const deadline = Date.now() + (timing?.budgetMs ?? SETTLE_BUDGET_MS);
	const outstanding = new Set(operationIds);
	while (outstanding.size > 0 && Date.now() < deadline) {
		for (const operationId of [...outstanding]) {
			try {
				const operation = await client.operation(operationId);
				if (operation === null || SETTLE_TERMINAL.has(operation.status)) outstanding.delete(operationId);
			} catch (err) {
				if (!(err instanceof HindsightError)) throw err;
			}
		}
		if (outstanding.size > 0) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) return false;
			await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
		}
	}
	return outstanding.size === 0;
}

// Returns true if the text was a command and got handled.
export function handleCommand(
	deps: CommandDeps,
	conv: Conversation,
	text: string,
): boolean {
	const [rawCmd, ...rest] = text.trim().split(/\s+/);
	const at = rawCmd!.indexOf("@");
	// "/stop@otherbot" is not for this bot — consumed silently rather than
	// fed to the model as a user message.
	if (at !== -1 && rawCmd!.slice(at + 1).toLowerCase() !== deps.botUsername.toLowerCase()) {
		return true;
	}
	const cmd = at === -1 ? rawCmd! : rawCmd!.slice(0, at);
	const arg = rest.join(" ").trim();

	switch (cmd) {
		case "/start": {
			// Sent automatically by the client on first open — answering it
			// with a model turn wastes the very first interaction; a canned
			// reply is the whole job. A deep-link payload is ignored.
			reply(
				deps,
				conv,
				"goblin online. just talk — each topic is its own conversation.\n/voice · /memory · /forget · /stop · /compact",
			);
			return true;
		}

		case "/stop": {
			const { stopped } = deps.runtime.stop(conv.id);
			reply(deps, conv, stopped ? "stopped" : "nothing was running");
			return true;
		}

		case "/compact": {
			// The manual lever (DESIGN.md, Compaction) — the same compaction
			// the 75% auto-trigger runs, forced now. Serialized through the
			// conversation's lane: a running turn completes first, so the cut
			// never orphans that exchange's response from its question.
			void (async () => {
				try {
					const outcome = await deps.runtime.compact(conv);
					if (outcome.kind === "noop") {
						reply(deps, conv, `nothing to compact — ${outcome.reason}`);
						return;
					}
					reply(
						deps,
						conv,
						`compacted ${outcome.eventsCompacted} messages into a summary · kept the last ${outcome.tailEvents} · ~${Math.round(outcome.tokensBefore / 1000)}k tokens folded`,
					);
				} catch (err) {
					log.error("compact failed", err, { conversation: conv.id });
					reply(deps, conv, `compact failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			})();
			return true;
		}

		case "/voice": {
			const ttsDown = deps.configRef.ttsDown;
			if ((!deps.configRef.current.tts || ttsDown) && !conv.voice) {
				reply(
					deps,
					conv,
					ttsDown
						? "voice replies unavailable — ffmpeg is missing on the host (install it and restart goblin)"
						: "voice replies unavailable — tts is turned off (settings → Voice notes)",
				);
				return true;
			}
			const enabled = !conv.voice;
			apply(deps, conv, { voice: enabled });
			log.info("voice mode changed", { conversation: conv.id, enabled });
			reply(deps, conv, `voice replies → ${enabled ? "on" : "off"}`);
			return true;
		}

		case "/memory": {
			const mem = deps.memory && deps.configRef.current.memory ? deps.memory : null;
			if (!mem) {
				reply(deps, conv, "memory is not configured — see docs/memory.md");
				return true;
			}
			if (arg === "off") {
				apply(deps, conv, { memoryExcluded: true });
				// The promise below is real: pending rows from this topic
				// are purged, so the worker can no longer send them.
				const cancelled = mem.queue.cancelConversation(conv.id);
				log.info("memory excluded", { conversation: conv.id, cancelled });
				reply(
					deps,
					conv,
					`memory → off for this topic (${cancelled} queued cancelled, nothing sent or recalled here)`,
				);
				return true;
			}
			if (arg === "on") {
				apply(deps, conv, { memoryExcluded: false });
				log.info("memory exclusion cleared", { conversation: conv.id });
				reply(deps, conv, "memory → on for this topic");
				return true;
			}
			if (arg === "retry") {
				// Fresh operation ids are the whole point — see MemoryQueue.retryBlocked.
				const requeued = mem.queue.retryBlocked(mem.client.target);
				log.info("memory blocked retentions requeued by operator", {
					conversation: conv.id,
					requeued,
				});
				reply(
					deps,
					conv,
					`memory: requeued ${requeued} blocked retention${requeued === 1 ? "" : "s"} with fresh operation ids`,
				);
				return true;
			}
			if (arg === "dismiss") {
				const dismissed = mem.queue.dismissBlocked(mem.client.target);
				log.info("memory blocked retentions dismissed by operator", {
					conversation: conv.id,
					dismissed,
				});
				reply(
					deps,
					conv,
					`memory: dismissed ${dismissed} blocked retention${dismissed === 1 ? "" : "s"} (kept for audit)`,
				);
				return true;
			}
			if (arg !== "" && arg !== "status") {
				reply(deps, conv, "usage: /memory on|off|retry|dismiss|status");
				return true;
			}
			const counts = mem.queue.counts(mem.client.target);
			const lastRecallAt = mem.lastRecallAt();
			const status = memoryStatus({
				enabled: true,
				counts,
				lastRecallOk: mem.lastRecallOk(),
				lastRecallAt,
				blockedDetail: mem.queue.blockedDetail(mem.client.target),
			});
			const queued = counts.pending + counts.submitted;
			const lines = [
				status.state === "degraded"
					? `memory: ${status.state} — ${status.detail}`
					: `memory: ${status.state}`,
			];
			if (counts.blocked > 0) {
				for (const [i, b] of status.blockedDetail.entries()) {
					lines.push(`  ${i + 1}. ${b.document} (${b.attempts} attempt${b.attempts === 1 ? "" : "s"}): ${b.error ?? "unknown error"}`);
				}
				// blockedDetail caps at 10 — the header count is the truth.
				if (counts.blocked > status.blockedDetail.length) {
					lines.push(`  … and ${counts.blocked - status.blockedDetail.length} more (goblin.log has every id)`);
				}
				lines.push("actions: /memory retry · /memory dismiss");
			}
			lines.push(
				`queue: ${queued} queued · ${counts.completed} retained` +
					(counts.dismissed > 0 ? ` · ${counts.dismissed} dismissed (kept for audit)` : ""),
				lastRecallAt === null
					? "last recall: never"
					: `last recall: ${clockHM(lastRecallAt)} (${mem.lastRecallOk() === false ? "failed" : "ok"})`,
				`this topic: ${conv.memoryExcluded ? "excluded" : "included"}`,
				"forget with /forget <query>",
			);
			reply(deps, conv, lines.join("\n"));
			return true;
		}

		case "/forget": {
			const mem = deps.memory && deps.configRef.current.memory ? deps.memory : null;
			if (!mem) {
				reply(deps, conv, "memory is not configured — see docs/memory.md");
				return true;
			}
			if (conv.memoryExcluded) {
				reply(deps, conv, "memory is excluded in this topic — nothing to forget here");
				return true;
			}
			if (arg === "" || arg === "help") {
				reply(
					deps,
					conv,
					"/forget <query> — list matching sources\n/forget delete <n> — or the full document id (irreversible)",
				);
				return true;
			}
			if (arg === "delete" || arg.startsWith("delete ")) {
				const ref = arg.slice("delete".length).trim();
				if (ref === "" || ref.length > 256 || ref === "." || ref === "..") {
					reply(deps, conv, "/forget delete <n> — or the document id from a /forget <query> listing");
					return true;
				}
				// A pure integer addresses the listing this conversation last
				// got from /forget <query> — no full document ids on a phone.
				// Fail-closed: expired, missing, or out of range refuses
				// outright; a stale number must never delete something unseen.
				let id = ref;
				let preview: string | null = null;
				if (/^\d+$/.test(ref)) {
					const picked = listingsFor(deps.store.db).resolve(conv.id, ref, Date.now());
					if (picked === null) {
						reply(deps, conv, "no usable listing for that number — run /forget <query> and pick within 10 minutes");
						return true;
					}
					id = picked.documentId;
					preview = picked.preview;
					log.info("forget listing ref resolved", { conversation: conv.id, ref, document: id });
				}
				// Resolve-then-confirm already happened: the operator ran
				// /forget <query>, saw this id, and typed delete. Settle
				// in-flight retention first — a submitted replace-mode retain
				// finishing after the delete would resurrect the document —
				// then suppress so nothing resurrects it, cancel, delete, redact.
				// Refusing the delete beats racing it (fail-loud, DESIGN.md).
				void (async () => {
					try {
						const submitted = mem.queue
							.inflightOps(id)
							.filter((op) => op.state === "submitted")
							.map((op) => op.operationId);
						if (submitted.length > 0) {
							const startedAt = Date.now();
							if (!(await settleInflightRetention(mem.client, submitted, mem.settleTiming))) {
								log.warn("forget refused — retention still processing remotely", {
									conversation: conv.id,
									document: id,
									operations: submitted.length,
								});
								reply(
									deps,
									conv,
									"memory for that document is still processing remotely — try /forget delete again in a minute",
								);
								return;
							}
							log.info("forget settled in-flight retention", {
								conversation: conv.id,
								document: id,
								operations: submitted.length,
								waitedMs: Date.now() - startedAt,
							});
						}
						mem.contexts.suppress(id);
						const cancelled = mem.queue.cancelDocument(id);
						await mem.client.deleteDocument(id);
						const redacted = mem.contexts.deleteByDocument(id);
						log.info("memory forgotten", {
							conversation: conv.id,
							document: id,
							cancelled,
							redacted,
							prefixReset: true,
						});
						reply(
							deps,
							conv,
							(preview !== null ? `forgotten ${id} — ${preview} ` : `forgotten ${id} `) +
								`(suppressed, ${cancelled} queued cancelled, ${redacted} snapshots redacted). ` +
								`Original chat history, backups, and provider retention are untouched.`,
						);
					} catch (err) {
						log.error("forget failed", err, { conversation: conv.id });
						reply(deps, conv, `forget failed: ${err instanceof Error ? err.message : String(err)}`);
					}
				})();
				return true;
			}
			if (arg.length > 800) {
				reply(deps, conv, "query too long — keep it under 800 characters");
				return true;
			}
			void (async () => {
				try {
					const facts = await mem.client.recall(arg, { maxTokens: 512, budget: "low" });
					if (facts.length === 0) {
						reply(deps, conv, "no matching memories found");
						return;
					}
					const seen = new Map<string, { date: string; snippet: string }>();
					for (const f of facts.slice(0, 20)) {
						if (!f.document_id || seen.has(f.document_id) || seen.size >= 5) continue;
						seen.set(f.document_id, {
							date: f.occurred_start ?? f.mentioned_at ?? f.occurred_end ?? "undated",
							snippet: f.text.length > 120 ? `${f.text.slice(0, 120)}…` : f.text,
						});
					}
					if (seen.size === 0) {
						reply(deps, conv, "no matching memories found");
						return;
					}
					const items: ForgetItem[] = [...seen.entries()].map(([doc, s]) => ({
						documentId: doc,
						preview: s.snippet,
						date: s.date,
					}));
					// The listing becomes this conversation's pick-list: numbers
					// address it for the next 10 minutes (/forget delete <n>).
					listingsFor(deps.store.db).save(conv.id, items);
					reply(
						deps,
						conv,
						`matching sources:\n${renderNumberedListing(items)}\n\n/forget delete <n> — or the full document id (irreversible)`,
					);
				} catch (err) {
					if (err instanceof HindsightError) {
						log.warn("forget search failed", { conversation: conv.id, kind: err.kind });
						reply(deps, conv, "memory unavailable — try again later");
						return;
					}
					log.error("forget search failed", err, { conversation: conv.id });
					reply(deps, conv, `forget failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			})();
			return true;
		}
	}
	return false;
}

// The settings surface Telegram advertises — registered via
// setMyCommands at boot so autocomplete shows exactly what works.
// COMMAND_RE derives from this list plus HIDDEN_COMMANDS: the two can
// never drift apart.
export const COMMANDS = [
	{ command: "voice", description: "toggle voice-note replies" },
	{ command: "memory", description: "memory status, retry or dismiss blocked retention" },
	{ command: "forget", description: "list or delete memorized sources" },
	{ command: "stop", description: "fence the running turn" },
	{ command: "compact", description: "summarize older history to free context" },
] as const;

// Handled but not advertised: /start is the client's automatic opener,
// not an operator command — it stays out of the command menu.
const HIDDEN_COMMANDS = ["start"] as const;

export const COMMAND_RE = new RegExp(
	`^/(${[...COMMANDS.map((c) => c.command), ...HIDDEN_COMMANDS].join("|")})(@\\w+)?(\\s|$)`,
);

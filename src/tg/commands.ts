// Commands are settings-only: /model /think /voice /memory /stop — plus
// /forget (memory deletion after review) and /start, the one
// non-settings command: a canned greeting for the message every
// Telegram client fires automatically on first open. No
// conversation-lifecycle commands — topics own that. Every settings change
// bumps the conversation epoch, fencing in-flight turns.

import type { Database } from "bun:sqlite";
import type { Api } from "grammy";
import { splitModelRef, type Config, type ThinkingLevel } from "../config.ts";
import { thinkingLevelsFor } from "../agent/providers.ts";
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
}

export interface CommandDeps {
	api: Api;
	configRef: { current: Config };
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
				"goblin online. just talk — each topic is its own conversation.\n/model · /think · /voice · /memory · /stop",
			);
			return true;
		}

		case "/stop": {
			const { stopped } = deps.runtime.stop(conv.id);
			reply(deps, conv, stopped ? "stopped" : "nothing was running");
			return true;
		}

		case "/model": {
			if (arg === "") {
				const current = conv.model ?? deps.configRef.current.model;
				const favs = deps.configRef.current.favorites.map((f) => `  ${f}`).join("\n");
				reply(
					deps,
					conv,
					`model: ${current}\nfavorites:\n${favs || "  (none)"}\n\n/model <ref> to switch · /model reset for the default`,
				);
				return true;
			}
			if (arg === "reset") {
				apply(deps, conv, { model: null });
				log.info("model override cleared", { conversation: conv.id });
				reply(deps, conv, `model → ${deps.configRef.current.model} (default)`);
				return true;
			}
			let ref: { provider: string; modelId: string };
			try {
				ref = splitModelRef(arg);
			} catch {
				reply(deps, conv, `model ref must be "<provider>/<model-id>", got "${arg}"`);
				return true;
			}
			if (!deps.configRef.current.providers[ref.provider]) {
				reply(
					deps,
					conv,
					`unknown provider in "${arg}" — providers: ${Object.keys(deps.configRef.current.providers).join(", ")}`,
				);
				return true;
			}
			apply(deps, conv, { model: arg });
			log.info("model override set", { conversation: conv.id, model: arg });
			reply(deps, conv, `model → ${arg}`);
			return true;
		}

		case "/voice": {
			if (!deps.configRef.current.tts && !conv.voice) {
				reply(deps, conv, "voice replies unavailable — tts is not configured");
				return true;
			}
			const enabled = !conv.voice;
			apply(deps, conv, { voice: enabled });
			log.info("voice mode changed", { conversation: conv.id, enabled });
			reply(deps, conv, `voice replies → ${enabled ? "on" : "off"}`);
			return true;
		}

		case "/think": {
			// Levels the conversation's model can actually express — the
			// vocabulary is wider than any single model's ladder.
			const ref = conv.model ?? deps.configRef.current.model;
			const { provider, modelId } = splitModelRef(ref);
			const p = deps.configRef.current.providers[provider];
			const valid = thinkingLevelsFor(
				p?.kind ?? "",
				modelId,
				p?.kind === "openai-compatible" ? p.baseUrl : undefined,
			);
			if (arg === "") {
				reply(
					deps,
					conv,
					`thinking: ${conv.thinking ?? deps.configRef.current.thinking}\n/think <${valid.join("|")}> · /think reset for the default`,
				);
				return true;
			}
			if (arg === "reset") {
				apply(deps, conv, { thinking: null });
				log.info("thinking override cleared", { conversation: conv.id });
				reply(deps, conv, `thinking → ${deps.configRef.current.thinking} (default)`);
				return true;
			}
			if (!(valid as readonly string[]).includes(arg)) {
				reply(deps, conv, `${modelId} supports: ${valid.join(", ")}`);
				return true;
			}
			apply(deps, conv, { thinking: arg as ThinkingLevel });
			log.info("thinking override set", { conversation: conv.id, thinking: arg });
			reply(deps, conv, `thinking → ${arg}`);
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
						reply(deps, conv, "listing expired — run /forget <query> again and pick within 10 minutes");
						return true;
					}
					id = picked.documentId;
					preview = picked.preview;
					log.info("forget listing ref resolved", { conversation: conv.id, ref, document: id });
				}
				// Resolve-then-confirm already happened: the operator ran
				// /forget <query>, saw this id, and typed delete. Suppress
				// first so nothing resurrects it, then cancel, delete, redact.
				void (async () => {
					try {
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
	{ command: "model", description: "show or override the model" },
	{ command: "think", description: "show or override thinking level" },
	{ command: "voice", description: "toggle voice-note replies" },
	{ command: "memory", description: "memory status, retry or dismiss blocked retention" },
	{ command: "forget", description: "list or delete memorized sources" },
	{ command: "stop", description: "fence the running turn" },
] as const;

// Handled but not advertised: /start is the client's automatic opener,
// not an operator command — it stays out of the command menu.
const HIDDEN_COMMANDS = ["start"] as const;

export const COMMAND_RE = new RegExp(
	`^/(${[...COMMANDS.map((c) => c.command), ...HIDDEN_COMMANDS].join("|")})(@\\w+)?(\\s|$)`,
);

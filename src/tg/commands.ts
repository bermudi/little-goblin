import type { Database } from "bun:sqlite";
import type { Api } from "grammy";
import { type ConfigRef } from "../config.ts";
import type { Conversation, ConversationStore } from "../conversation.ts";
import { log } from "../log.ts";
import { forgetDocument } from "../memory/forget.ts";
import { HindsightClient, HindsightError } from "../memory/hindsight.ts";
import { type MemoryContexts, type MemoryWorker, memoryStatus } from "../memory/mod.ts";
import type { MemoryQueue } from "../memory/queue.ts";
import type { Runtime } from "../runtime.ts";
import { numberedCalls, type ResumeOps } from "../turn-resume.ts";
import { canAuthorizeRetry } from "../turn/retry-guard.ts";
import { withTimeout } from "./deadline.ts";
import { type ForgetItem, ForgetListings, renderNumberedListing } from "./forget-listings.ts";

export interface CommandMemoryDeps {
	client: HindsightClient;
	clientForTarget?: (target: string) => HindsightClient | null;
	contexts: MemoryContexts;
	queue: MemoryQueue;
	withWorkerPaused: MemoryWorker["withWorkerPaused"];
	lastRecallOk(): boolean | null;
	lastRecallAt(): string | null;
	settleTiming?: { pollMs: number; budgetMs: number };
}

export interface CommandDeps {
	api: Api;
	configRef: ConfigRef;
	store: ConversationStore;
	runtime: Runtime;
	botUsername: string;
	memory?: CommandMemoryDeps;
	resumeOps?: () => ResumeOps | undefined;
}

export function parseCommand(
	text: string,
	botUsername: string,
): { command: string; arg: string; forThisBot: boolean } | null {
	const trimmed = text.trim();
	const match = /^\/(\w+)(?:@(\w+))?(?:\s|$)/.exec(trimmed);
	if (!match) return null;
	return {
		command: `/${match[1]!}`,
		arg: trimmed.slice(match[0].length).trim(),
		forThisBot: match[2] === undefined || match[2].toLowerCase() === botUsername.toLowerCase(),
	};
}

function target(conv: Conversation) {
	return {
		...(conv.threadId !== null ? { message_thread_id: conv.threadId } : {}),
	};
}

function clockHM(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "never";
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function reply(deps: CommandDeps, conv: Conversation, text: string): void {
	withTimeout(
		deps.api.sendMessage(conv.chatId, text, target(conv)),
		"sendMessage (command reply)",
	).catch((err: unknown) => {
		log.warn("command reply failed", err);
	});
}

const REPLY_CHUNK_LIMIT = 4000;

function replyLines(deps: CommandDeps, conv: Conversation, lines: string[]): void {
	let batch: string[] = [];
	let len = 0;
	const flush = (): void => {
		if (batch.length === 0) return;
		reply(deps, conv, batch.join("\n"));
		batch = [];
		len = 0;
	};
	for (const line of lines) {
		const capped = line.length > REPLY_CHUNK_LIMIT ? line.slice(0, REPLY_CHUNK_LIMIT) : line;
		if (batch.length > 0 && len + capped.length + 1 > REPLY_CHUNK_LIMIT) flush();
		batch.push(capped);
		len += capped.length + 1;
	}
	flush();
}

const forgetListingsByDb = new WeakMap<Database, ForgetListings>();
function listingsFor(db: Database): ForgetListings {
	let listings = forgetListingsByDb.get(db);
	if (listings === undefined) {
		listings = new ForgetListings(db);
		forgetListingsByDb.set(db, listings);
	}
	return listings;
}

function apply(
	deps: CommandDeps,
	conv: Conversation,
	patch: Parameters<ConversationStore["setMeta"]>[1],
): void {
	deps.store.applySettings(conv.id, patch);
}

export function handleCommand(deps: CommandDeps, conv: Conversation, text: string): boolean {
	const parsed = parseCommand(text, deps.botUsername);
	if (parsed === null) return false;
	if (!parsed.forThisBot) {
		return true;
	}
	const { command: cmd, arg } = parsed;

	switch (cmd) {
		case "/start": {
			reply(
				deps,
				conv,
				conv.chatId > 0
					? "goblin online. just talk — quiet gaps start fresh conversations.\n/new · /back · /voice · /memory · /forget · /stop · /compact"
					: "goblin online. just talk — each topic is its own conversation.\n/voice · /memory · /forget · /stop · /compact",
			);
			return true;
		}

		case "/stop": {
			const { stopped, reviewsCancelled } = deps.runtime.stop(conv.id);
			const suffix =
				reviewsCancelled > 0
					? ` — ${reviewsCancelled} review${reviewsCancelled === 1 ? "" : "s"} cancelled`
					: "";
			reply(deps, conv, stopped ? `stopped${suffix}` : `nothing was running${suffix}`);
			return true;
		}

		case "/compact": {
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

		case "/resume": {
			const ops = deps.resumeOps?.();
			if (ops === undefined) {
				reply(deps, conv, "turn resume is not wired");
				return true;
			}
			if (arg === "") {
				const runs = ops.interrupted(conv.id);
				if (runs.length === 0) {
					reply(deps, conv, "no interrupted turns in this conversation");
					return true;
				}
				const lines: string[] = [];
				for (const { run, calls } of runs) {
					const id = run.runId.slice(0, 8);
					lines.push(
						`interrupted run ${id} — started ${new Date(run.startedMs).toISOString()}`,
						`  ${run.calls.completed} completed · ${run.calls.dispatched} ambiguous · ${run.calls.resolved} decided · ${run.calls.planned} planned · ${run.calls.failed} failed`,
					);
					const numbered = numberedCalls(calls);
					for (const [i, c] of numbered.entries()) {
						const args = typeof c.args === "string" ? c.args : JSON.stringify(c.args);
						lines.push(
							c.state === "dispatched"
								? `  ${i + 1}. ${c.name} ${args.slice(0, 120)}`
								: `  ${i + 1}. ${c.name} — ${c.state}`,
						);
					}
					if (numbered.some((c) => c.state === "dispatched")) {
						lines.push(
							`  decide first: /decide ${id} <n|callId> record-result|authorize-retry|skip [note]`,
						);
					}
					// Known calls take one decision only — authorize another
					// execution — and only by explicit call id, never ordinals.
					const known = calls.filter((c) => c.state !== "dispatched" && canAuthorizeRetry(c));
					for (const c of known) {
						const args = typeof c.args === "string" ? c.args : JSON.stringify(c.args);
						lines.push(
							`  known: ${c.name} ${args.slice(0, 80)} — ${c.state}` +
								`  · re-run: /decide ${id} ${c.toolCallId} authorize-retry`,
						);
					}
					lines.push(`  /resume ${id} · /abandon ${id}`);
				}
				replyLines(deps, conv, lines);
				return true;
			}
			const outcome = ops.resume(conv.id, arg);
			if (outcome.kind === "resumed") {
				reply(deps, conv, `resumed ${outcome.runId.slice(0, 8)} — running as a fresh turn`);
				return true;
			}
			if (outcome.kind === "needs-decisions") {
				const id = outcome.runId.slice(0, 8);
				const lines = [
					"undecided tool calls block resume:",
					...outcome.numbered.flatMap((c, i) => {
						if (c.state !== "dispatched") return [];
						const args = typeof c.args === "string" ? c.args : JSON.stringify(c.args);
						return [`  ${i + 1}. ${c.name} ${args.slice(0, 120)} (${c.toolCallId})`];
					}),
					`/decide ${id} <n|callId> record-result|authorize-retry|skip [note]`,
				];
				replyLines(deps, conv, lines);
				return true;
			}
			reply(deps, conv, outcome.reason);
			return true;
		}

		case "/decide": {
			const ops = deps.resumeOps?.();
			if (ops === undefined) {
				reply(deps, conv, "turn resume is not wired");
				return true;
			}
			const m = /^(\S+)\s+(\S+)\s+(record-result|authorize-retry|skip)(?:\s+([\s\S]+))?$/.exec(arg);
			if (m === null) {
				reply(
					deps,
					conv,
					"usage: /decide <runId> <call#|callId> record-result|authorize-retry|skip [note]",
				);
				return true;
			}
			const outcome = ops.decide(
				conv.id,
				m[1]!,
				m[2]!,
				m[3]! as "record-result" | "authorize-retry" | "skip",
				m[4],
			);
			reply(deps, conv, outcome.kind === "ok" ? `call ${m[2]!} → ${m[3]!}` : outcome.reason);
			return true;
		}

		case "/abandon": {
			const ops = deps.resumeOps?.();
			if (ops === undefined) {
				reply(deps, conv, "turn resume is not wired");
				return true;
			}
			if (arg === "") {
				reply(deps, conv, "usage: /abandon <runId>");
				return true;
			}
			const outcome = ops.abandon(conv.id, arg);
			reply(
				deps,
				conv,
				outcome.kind === "ok"
					? `abandoned ${arg.slice(0, 8)} — it will not resume`
					: outcome.reason,
			);
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
			if (conv.persona === "guest") {
				reply(deps, conv, "memory is off for this lane by class — it is not a setting here");
				return true;
			}
			if (arg === "off") {
				apply(deps, conv, { memoryExcluded: true });
				const cancelled = mem.queue.cancelConversation(conv.id);
				log.info("memory excluded", { conversation: conv.id, cancelled });
				reply(
					deps,
					conv,
					`memory → off for this topic (${cancelled} queued cancelled; already-submitted operations still tracked; no new memories sent or recalled)`,
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
				deletingAll: mem.queue.deletingCount(),
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
					lines.push(
						`  ${i + 1}. ${b.document} (${b.attempts} attempt${b.attempts === 1 ? "" : "s"}): ${b.error ?? "unknown error"}`,
					);
				}
				if (counts.blocked > status.blockedDetail.length) {
					lines.push(
						`  … and ${counts.blocked - status.blockedDetail.length} more (goblin.log has every id)`,
					);
				}
				lines.push("actions: /memory retry · /memory dismiss");
			}
			lines.push(
				`queue: ${queued} queued · ${counts.completed} retained` +
					(counts.dismissed > 0 ? ` · ${counts.dismissed} dismissed (kept for audit)` : "") +
					(status.deleting > 0 ? ` · ${status.deleting} awaiting forget confirmation` : ""),
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
			if (conv.persona === "guest") {
				reply(deps, conv, "memory is off for this lane by class — nothing to forget here");
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
					reply(
						deps,
						conv,
						"/forget delete <n> — or the document id from a /forget <query> listing",
					);
					return true;
				}
				let id = ref;
				let preview: string | null = null;
				if (/^\d+$/.test(ref)) {
					const picked = listingsFor(deps.store.db).resolve(conv.id, ref, Date.now());
					if (picked === null) {
						reply(
							deps,
							conv,
							"no usable listing for that number — run /forget <query> and pick within 10 minutes",
						);
						return true;
					}
					id = picked.documentId;
					preview = picked.preview;
					log.info("forget listing ref resolved", { conversation: conv.id, ref, document: id });
				}
				void (async () => {
					try {
						deps.runtime.stop(conv.id);
						const result = await forgetDocument(mem, id, {
							channel: "telegram",
							conversation: conv.id,
						});
						if (result.outcome === "busy") {
							reply(
								deps,
								conv,
								"memory for that document is still processing remotely — try /forget delete again in a minute",
							);
							return;
						}
						if (result.outcome === "foreign-bank") {
							reply(
								deps,
								conv,
								"that document has memory work bound to a previous memory bank that can't be reached from here — nothing was forgotten; point memory back at that bank (restart) and retry",
							);
							return;
						}
						reply(
							deps,
							conv,
							(preview !== null ? `forgotten ${id} — ${preview} ` : `forgotten ${id} `) +
								`(suppressed, ${result.cancelled} queued cancelled, ${result.redacted} snapshots redacted). ` +
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

export const COMMANDS = [
	{ command: "voice", description: "toggle voice-note replies" },
	{ command: "memory", description: "memory status, retry or dismiss blocked retention" },
	{ command: "forget", description: "list or delete memorized sources" },
	{ command: "skill", description: "invoke a skill by name, or fetch one from a GitHub URL" },
	{ command: "stop", description: "fence the running turn" },
	{ command: "compact", description: "summarize older history to free context" },
	{ command: "resume", description: "resume an interrupted turn" },
	{ command: "decide", description: "resolve an interrupted tool call" },
	{ command: "abandon", description: "drop an interrupted turn" },
] as const;

export const DM_COMMANDS = [
	{ command: "new", description: "stop the current turn and start a fresh conversation" },
	{ command: "back", description: "stop the current turn and return to the previous conversation" },
	...COMMANDS,
] as const;

const HIDDEN_COMMANDS = ["start"] as const;

export const COMMAND_RE = new RegExp(
	`^/(${[...DM_COMMANDS.map((c) => c.command), ...HIDDEN_COMMANDS].join("|")})(@\\w+)?(\\s|$)`,
);

import { randomUUID } from "node:crypto";
import type { JSONValue } from "@ai-sdk/provider";
import type { ProviderMetadata, ToolSet, UIMessage } from "ai";
import { z } from "zod";
import { channelOf, type Conversation, type ConversationStore } from "./conversation.ts";
import { log } from "./log.ts";
import {
	type ResumeSeed,
	type Runtime,
	type RuntimeDeps,
	type TurnDone,
	type TurnSink,
	userMessage,
} from "./runtime.ts";
import { messageText } from "./memory/mod.ts";
import { summarize, toolOk, type ToolCallDigest } from "./reviewer.ts";
import { SKILL_PART } from "./skill-part.ts";
import { isCompactionSummaryId } from "./tags.ts";
import { canAuthorizeRetry } from "./turn/retry-guard.ts";
import type { LoopTurnState } from "./turn/state.ts";
import { sinkFor, type WakeDeps } from "./wake.ts";
import {
	type CallDecision,
	recordedOutput,
	RESOLVED_RETRY_NOTE,
	RESOLVED_SKIP_NOTE,
	type TurnJournal,
	type TurnRun,
	type TurnToolCall,
} from "./turn-journal.ts";

export type ResumeRefusalCode = "not-found" | "conflict" | "invalid" | "unavailable";

export type ResumeOutcome =
	| { kind: "resumed"; runId: string }
	| { kind: "needs-decisions"; runId: string; calls: TurnToolCall[]; numbered: TurnToolCall[] }
	| { kind: "refused"; code: ResumeRefusalCode; reason: string };

export type DecideOutcome =
	| { kind: "ok" }
	| { kind: "refused"; code: ResumeRefusalCode; reason: string };

export interface InterruptedRunView {
	run: TurnRun;
	calls: TurnToolCall[];
}

export interface ResumeOps {
	interrupted(convId: string): InterruptedRunView[];
	resume(convId: string, runRef: string): ResumeOutcome;
	decide(
		convId: string,
		runRef: string,
		callRef: string,
		decision: CallDecision,
		note?: string,
	): DecideOutcome;
	abandon(convId: string, runRef: string): DecideOutcome;
}

export interface ResumeDeps {
	store: ConversationStore;
	journal: TurnJournal;
	runtime: Runtime;
	captureConversation(conv: Conversation): Conversation;
	makeTools: RuntimeDeps["makeTools"];
	// Null means the lane's delivery channel is unavailable — refuse after
	// validation builds its tool surface, before any sink or submission.
	sinkFor(conv: Conversation): TurnSink | null;
	sinkHooks(conv: Conversation): { voice: boolean; recording: boolean; file: boolean };
	notifyDone?(conv: Conversation, sourceRunId: string, done: TurnDone): void;
}

export interface ResumeSinkDeps {
	wake: Pick<WakeDeps, "bell" | "delivery">;
	operators(): number[];
	sendDm?(chatId: number, text: string): Promise<unknown>;
}

export function makeResumeSinks(
	deps: ResumeSinkDeps,
): Pick<ResumeDeps, "sinkFor" | "sinkHooks" | "notifyDone"> {
	return {
		sinkFor: (conv) => sinkFor(deps.wake, conv, "refuse"),
		sinkHooks: (conv) =>
			// The app bell composes appMediaSink — durable file and voice-note
			// delivery (no recording indicator) — so its surface carries
			// send_file and speak like telegram's, minus the recording hook.
			channelOf(conv.id) === "app"
				? { voice: true, recording: false, file: true }
				: deps.wake.delivery === undefined
					? { voice: false, recording: false, file: false }
					: { voice: true, recording: true, file: true },
		notifyDone: (conv, sourceRunId, done) => {
			if (channelOf(conv.id) === "app") return;
			if (deps.sendDm === undefined) {
				log.warn("resumed turn notice skipped — telegram channel disabled", {
					conversation: conv.id,
					run: sourceRunId,
					outcome: done.kind,
				});
				return;
			}
			const text =
				`resumed turn ${sourceRunId.slice(0, 8)} in ${conv.title ?? conv.id}: ${done.kind}` +
				(done.kind === "error" ? ` — ${done.message}` : "");
			for (const chat of deps.operators()) {
				void deps.sendDm(chat, text).catch((err: unknown) => {
					log.warn("resumed turn notice failed", {
						conversation: conv.id,
						chat,
						error: String(err),
					});
				});
			}
		},
	};
}

type RunRef = { kind: "found"; run: TurnRun } | { kind: "ambiguous" } | { kind: "missing" };

function findRun(journal: TurnJournal, convId: string, ref: string): RunRef {
	const runs = journal.interruptedFor(convId);
	const matches = runs.filter((r) => r.runId === ref || r.runId.startsWith(ref));
	if (matches.length === 0) return { kind: "missing" };
	if (matches.length > 1) return { kind: "ambiguous" };
	return { kind: "found", run: matches[0]! };
}

function refused(code: ResumeRefusalCode, reason: string) {
	return { kind: "refused" as const, code, reason };
}

export function numberedCalls(calls: TurnToolCall[]): TurnToolCall[] {
	// A resolved-retry granted on a formerly-KNOWN row stays unnumbered —
	// the row held no ordinal before its grant, so counting it now would
	// shift every ambiguous call's number. Grants on ambiguous rows and
	// recorded outcomes keep theirs.
	return calls.filter(
		(c) => (c.state === "dispatched" || c.state.startsWith("resolved-")) && !c.retryFromKnown,
	);
}

const convSnapshotSchema = z.object({
	// The ref the run ran on — a fallback candidate when one served.
	model: z.string().nullable(),
	thinking: z.string().nullable(),
	// Present only when a fallback served: the operator's selection at
	// the time (design/model.md → Model fallback list).
	configuredModel: z.string().optional(),
});

const loopKindSchema = z.enum(["repeat", "watchdog", "context"]);
const loopStateSchema = z.object({
	detector: z.object({
		records: z.array(z.object({ argsHash: z.string(), resultHash: z.string() })),
		warned: z.array(z.string()),
	}),
	watchdogRing: z.array(
		z.object({ tool: z.string(), args: z.string(), result: z.string(), ok: z.boolean() }),
	),
	watchdogStrikes: z.number(),
	completedCalls: z.number(),
	modelCalls: z.number(),
	warnings: z.array(z.string()),
	cutKind: loopKindSchema.nullable(),
	forcedKind: loopKindSchema.nullable(),
});

const SEED_DIGEST_CHARS = 300;

// Journaled checkpoints are trusted server state, still validated at the
// boundary: providerOptions must be the SDK's SharedV4 JSON shape
// (record of record of JSON values) to ride back as UI providerMetadata —
// anything else drops the metadata, never the part.
const jsonValueSchema: z.ZodType<JSONValue> = z.lazy(() =>
	z.union([
		z.string(),
		z.number(),
		z.boolean(),
		z.null(),
		z.array(jsonValueSchema),
		z.record(z.string(), jsonValueSchema.optional()),
	]),
);
const providerOptionsSchema = z.record(z.string(), z.record(z.string(), jsonValueSchema));

const checkpointMessageSchema = z.looseObject({
	role: z.string(),
	content: z.union([z.string(), z.array(z.looseObject({ type: z.string() }))]),
});

function checkpointMeta(providerOptions: unknown): ProviderMetadata | undefined {
	const parsed = providerOptionsSchema.safeParse(providerOptions);
	return parsed.success ? parsed.data : undefined;
}

// A journaled tool call rendered the way the interrupted attempt's own
// progress reads: outcome evidence and decision notes — the state rules
// that gate replay live here, never in the checkpoint shape.
function seedCallPart(
	c: TurnToolCall,
	callProviderMetadata?: ProviderMetadata,
): UIMessage["parts"][number] | null {
	if (c.name === "") return null;
	const meta =
		callProviderMetadata === undefined ? {} : { callProviderMetadata };
	if (c.state === "completed" || c.state === "resolved-done") {
		return {
			type: `tool-${c.name}`,
			toolCallId: c.toolCallId,
			state: "output-available",
			input: c.args,
			output: recordedOutput(c),
			...meta,
		} as UIMessage["parts"][number];
	}
	if (c.state === "failed") {
		// A recorded failure is historical evidence too — the model sees
		// what the interrupted attempt already learned.
		return {
			type: `tool-${c.name}`,
			toolCallId: c.toolCallId,
			state: "output-error",
			input: c.args,
			errorText: c.error ?? "failed",
			...meta,
		} as UIMessage["parts"][number];
	}
	if (c.state === "resolved-retry" || c.state === "resolved-skip") {
		let note: string;
		if (c.state === "resolved-skip") {
			note = RESOLVED_SKIP_NOTE;
		} else {
			// A spent grant is evidence of what was authorized and
			// consumed — never fresh permission. Only an unconsumed
			// grant authorizes exactly one more execution.
			const grant = c.retryConsumed
				? "operator authorized re-running this call and that grant is spent — it does not permit another execution"
				: "operator authorized re-running this call";
			if (c.result !== null) {
				// The grant concerns one more EXECUTION — the recorded
				// outcome stays visible as evidence, never as the answer.
				note = `[turn-journal decision: ${grant} — its recorded result stays evidence: ${c.result}]`;
			} else if (c.error !== null) {
				note = `[turn-journal decision: ${grant} — its recorded failure stays evidence: ${c.error}]`;
			} else {
				note = c.retryConsumed ? `[turn-journal decision: ${grant}]` : RESOLVED_RETRY_NOTE;
			}
		}
		return {
			type: `tool-${c.name}`,
			toolCallId: c.toolCallId,
			state: "output-available",
			input: c.args,
			output: c.resolutionNote === null ? note : `${note} — ${c.resolutionNote}`,
			...meta,
		} as UIMessage["parts"][number];
	}
	return null;
}

// The checkpoint holds ModelMessages in step order — walk them as they
// were: reasoning parts carry their provider state verbatim (an empty
// summary still holds the opaque cipher), tool-call placeholders are
// rebuilt from the authoritative journal row at their own position, and
// step-start boundaries keep each step's tool results ahead of the next
// step's reasoning and text on SDK conversion. Journal rows the
// checkpoint never reached (a crash between completion and checkpoint)
// append once at the end.
function seedPartial(run: TurnRun, calls: TurnToolCall[]): UIMessage | null {
	const byCallId = new Map(calls.map((c) => [c.toolCallId, c]));
	const emitted = new Set<string>();
	const parts: UIMessage["parts"] = [];
	if (Array.isArray(run.partial)) {
		for (const m of run.partial) {
			const msg = checkpointMessageSchema.safeParse(m);
			if (!msg.success || msg.data.role !== "assistant") continue;
			const content = msg.data.content;
			const block: UIMessage["parts"] = [];
			if (typeof content === "string") {
				if (content !== "") block.push({ type: "text", text: content });
			} else {
				for (const p of content) {
					const providerMetadata = checkpointMeta(p.providerOptions);
					if (p.type === "text" && typeof p.text === "string" && p.text !== "") {
						block.push({
							type: "text",
							text: p.text,
							...(providerMetadata === undefined ? {} : { providerMetadata }),
						});
					} else if (p.type === "reasoning" && typeof p.text === "string") {
						block.push({
							type: "reasoning",
							text: p.text,
							...(providerMetadata === undefined ? {} : { providerMetadata }),
						});
					} else if (p.type === "tool-call" && typeof p.toolCallId === "string") {
						if (p.providerExecuted === true) {
							// Provider-executed calls (hosted web_search) are not
							// journal actions — the checkpoint keeps them out of
							// the seed entirely, never a "no journal row" warn.
							log.info("checkpointed provider-executed call skipped in resume seed", {
								run: run.runId,
								toolCallId: p.toolCallId,
							});
							continue;
						}
						// Position comes from the checkpoint; name/args/outcome
						// come from the journal. A call with no journal row can't
						// be trusted or replayed — the checkpoint shape alone is
						// not evidence.
						emitted.add(p.toolCallId);
						const call = byCallId.get(p.toolCallId);
						if (call === undefined) {
							log.warn("checkpointed tool call has no journal row — dropped from resume seed", {
								run: run.runId,
								toolCallId: p.toolCallId,
							});
							continue;
						}
						if (call.name === "") {
							log.warn(
								"checkpointed tool call's journal row has no tool name — dropped from resume seed",
								{ run: run.runId, toolCallId: p.toolCallId },
							);
							continue;
						}
						const toolPart = seedCallPart(call, providerMetadata);
						if (toolPart !== null) block.push(toolPart);
					}
				}
			}
			if (block.length === 0) continue;
			if (parts.length > 0) parts.push({ type: "step-start" });
			parts.push(...block);
		}
	}
	for (const c of calls) {
		if (emitted.has(c.toolCallId)) continue;
		if (c.name === "") continue;
		const toolPart = seedCallPart(c);
		if (toolPart !== null) parts.push(toolPart);
	}
	if (parts.length === 0) return null;
	return { id: randomUUID(), role: "assistant", parts };
}

function seedDigest(calls: TurnToolCall[]): { id: string; entry: ToolCallDigest }[] {
	const out: { id: string; entry: ToolCallDigest }[] = [];
	for (const c of calls) {
		if (c.name === "") continue;
		if (c.state !== "completed" && c.state !== "resolved-done") continue;
		const output = recordedOutput(c);
		out.push({
			id: c.toolCallId,
			entry: {
				tool: c.name,
				args: summarize(c.args, SEED_DIGEST_CHARS),
				result: summarize(output, SEED_DIGEST_CHARS),
				ok: toolOk(output),
			},
		});
	}
	return out;
}

function seedLoop(run: TurnRun, calls: TurnToolCall[]): LoopTurnState | "unreadable" {
	if (run.loopState !== null) {
		const parsed = loopStateSchema.safeParse(run.loopState);
		if (!parsed.success) return "unreadable";
		return parsed.data;
	}
	return {
		detector: { records: [], warned: [] },
		watchdogRing: [],
		watchdogStrikes: 0,
		completedCalls: calls.filter((c) => c.state === "completed" || c.state === "failed").length,
		modelCalls: 0,
		warnings: [],
		cutKind: null,
		forcedKind: null,
	};
}

// The generated resume event's provenance marker — explanatory only.
// Message metadata is client-controlled (the app channel), so it never
// exempts a user event by itself: the stale check trusts an event only
// when the source run's journaled registry names its seq AND this marker
// points back at the source.
const resumeMetaSchema = z.object({
	goblinResume: z.object({ sourceRunId: z.string() }),
});

function resumeEventSource(message: UIMessage): string | null {
	const meta = resumeMetaSchema.safeParse(message.metadata);
	return meta.success ? meta.data.goblinResume.sourceRunId : null;
}

type DetailEntry = { seq: number; anchorSeq: number | null; message: UIMessage };

function isOwnResumeRequest(e: DetailEntry, run: TurnRun): boolean {
	return (
		(run.resumeRequestSeqs?.includes(e.seq) ?? false) && resumeEventSource(e.message) === run.runId
	);
}

// Tail-only ownership: every durable user event after the run's anchor
// must be one the attempt recorded as its own input (admission entries
// plus folded-in steers) or a generated resume request the source
// registered. Both are journaled as durable event SEQS — message ids
// are app-controlled and carry no uniqueness guarantee, so they never
// authorize anything. The durable record (historyDetail) is read — the
// model view's compaction filter would hide both stale input and the
// trigger. Legacy rows (NULL ownership) fail closed to anchor-only; a
// malformed column is a readable refusal, never a silent policy change.
function stalenessRefusal(
	store: ConversationStore,
	convId: string,
	run: TurnRun,
):
	| { refuse: string; code: ResumeRefusalCode }
	| { anchor: DetailEntry | undefined; owned: DetailEntry[] } {
	if (run.ownedInputSeqsUnreadable) {
		return {
			code: "invalid",
			refuse: "the recorded input ownership is unreadable — not resumed",
		};
	}
	if (run.resumeRequestSeqsUnreadable) {
		return {
			code: "invalid",
			refuse: "the recorded resume-request registry is unreadable — not resumed",
		};
	}
	const detail = store.historyDetail(convId);
	const owned = new Set(run.ownedInputSeqs ?? []);
	let anchor: DetailEntry | undefined;
	if (run.anchorSeq !== null) {
		anchor = detail.find((e) => e.seq === run.anchorSeq);
		if (anchor === undefined || anchor.message.role !== "user") {
			return {
				code: "invalid",
				refuse: "the original request is gone or no longer a user message — not resumed",
			};
		}
		// A modern row that recorded ownership must name its own anchor —
		// anything else is an inconsistent source row, not a policy choice.
		if (run.ownedInputSeqs !== null && !owned.has(run.anchorSeq)) {
			return {
				code: "invalid",
				refuse: "the recorded input ownership does not name the run's own anchor — not resumed",
			};
		}
	}
	const postAnchorOwned: DetailEntry[] = [];
	for (const e of detail) {
		if (e.message.role !== "user") continue;
		if (isOwnResumeRequest(e, run)) continue;
		if (run.anchorSeq !== null && e.seq <= run.anchorSeq) continue;
		if (run.ownedInputSeqs !== null && owned.has(e.seq)) {
			postAnchorOwned.push(e);
			continue;
		}
		// The offending event did not necessarily arrive after the
		// interruption — steering sent while the turn ran is durable but
		// never folded — and an anchorless run has no anchor to compare
		// against at all.
		return {
			code: "conflict",
			refuse:
				(run.anchorSeq === null
					? "this run recorded no anchor and the conversation holds input it never owned"
					: "input after this run's anchor was never owned by it — it arrived while the turn ran or after it died") +
				" — not resumed; continue from the current conversation as a new request or abandon the interrupted run",
		};
	}
	return { anchor, owned: postAnchorOwned };
}

export function makeResumeOps(deps: ResumeDeps): ResumeOps {
	const { store, journal, runtime } = deps;
	// Between admission and markRun the source still reads 'interrupted', so this process-local claim stops a second resume from double-admitting it; it releases on terminal onDone so a resume that dies early stays re-resumable.
	const claimed = new Set<string>();

	return {
		interrupted(convId) {
			return journal
				.interruptedFor(convId)
				.map((run) => ({ run, calls: journal.callsFor(run.runId) }));
		},

		decide(convId, runRef, callRef, decision, note) {
			const found = findRun(journal, convId, runRef);
			if (found.kind !== "found") {
				return refused(
					found.kind === "ambiguous" ? "invalid" : "not-found",
					found.kind === "ambiguous"
						? `run id '${runRef}' matches more than one interrupted run — give more of it`
						: `no interrupted run matching '${runRef}' in this conversation`,
				);
			}
			if (claimed.has(found.run.runId)) {
				return refused(
					"conflict",
					`run ${found.run.runId.slice(0, 8)} has a resume in flight — decisions wait for it to settle`,
				);
			}
			const all = journal.callsFor(found.run.runId);
			const numbered = numberedCalls(all);
			let call: TurnToolCall | undefined;
			const exact = all.find((c) => c.toolCallId === callRef);
			if (exact !== undefined) {
				call = exact;
			} else if (/^\d+$/.test(callRef)) {
				const i = Number.parseInt(callRef, 10) - 1;
				if (i < 0 || i >= numbered.length) {
					return refused(
						"invalid",
						`no call ${callRef} — run ${found.run.runId.slice(0, 8)} has ${numbered.length}`,
					);
				}
				call = numbered[i];
			} else {
				const matches = all.filter((c) => c.toolCallId.startsWith(callRef));
				if (matches.length === 0) {
					return refused(
						"not-found",
						`no call matching '${callRef}' on run ${found.run.runId.slice(0, 8)}`,
					);
				}
				if (matches.length > 1) {
					return refused(
						"invalid",
						`'${callRef}' matches ${matches.length} calls — give more of the id`,
					);
				}
				call = matches[0];
			}
			if (call === undefined) {
				return refused("not-found", `no undecided call matching '${callRef}'`);
			}
			if (decision === "authorize-retry") {
				// Retry is the one decision that also reaches KNOWN calls —
				// completed/failed/resolved-done rows keep their recorded
				// outcome as evidence and grant one more execution.
				if (!canAuthorizeRetry(call)) {
					return refused(
						"conflict",
						call.replayed
							? `call ${call.toolCallId.slice(0, 8)} is a journaled recovery row — it cannot take a decision`
							: `call ${call.toolCallId.slice(0, 8)} is already '${call.state}' — no retry to authorize`,
					);
				}
			} else if (call.state !== "dispatched") {
				return refused(
					"conflict",
					`call ${call.toolCallId.slice(0, 8)} is already '${call.state}' — no decision to take`,
				);
			}
			try {
				journal.resolveCall(found.run.runId, call.toolCallId, decision, note);
			} catch (err) {
				return refused("conflict", err instanceof Error ? err.message : String(err));
			}
			return { kind: "ok" };
		},

		abandon(convId, runRef) {
			const found = findRun(journal, convId, runRef);
			if (found.kind !== "found") {
				return refused(
					found.kind === "ambiguous" ? "invalid" : "not-found",
					found.kind === "ambiguous"
						? `run id '${runRef}' matches more than one interrupted run — give more of it`
						: `no interrupted run matching '${runRef}' in this conversation`,
				);
			}
			if (claimed.has(found.run.runId)) {
				return refused(
					"conflict",
					`run ${found.run.runId.slice(0, 8)} has a resume in flight — stop that turn first`,
				);
			}
			try {
				journal.markRun(found.run.runId, "abandoned");
			} catch (err) {
				return refused("conflict", err instanceof Error ? err.message : String(err));
			}
			return { kind: "ok" };
		},

		resume(convId, runRef) {
			const found = findRun(journal, convId, runRef);
			if (found.kind === "ambiguous") {
				return refused(
					"invalid",
					`run id '${runRef}' matches more than one interrupted run — give more of it`,
				);
			}
			if (found.kind === "missing") {
				return refused("not-found", `no interrupted run matching '${runRef}' in this conversation`);
			}
			const run = found.run;
			if (claimed.has(run.runId)) {
				return refused("conflict", `run ${run.runId.slice(0, 8)} already has a resume in flight`);
			}
			const conv = store.get(convId);
			if (conv === null) {
				return refused("not-found", "the conversation is gone — the turn cannot resume");
			}
			if (!runtime.accepting()) {
				return refused("unavailable", "the runtime is shut down");
			}
			const calls = journal.callsFor(run.runId);
			const undecided = calls.filter((c) => c.state === "dispatched");
			if (undecided.length > 0) {
				return {
					kind: "needs-decisions",
					runId: run.runId,
					calls: undecided,
					numbered: numberedCalls(calls),
				};
			}
			let captured: Conversation;
			try {
				captured = deps.captureConversation(conv);
			} catch (err) {
				return refused(
					"invalid",
					`settings capture failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			const snap = convSnapshotSchema.safeParse(run.convSnapshot);
			if (!snap.success) {
				return refused("invalid", "the recorded settings snapshot is unreadable — not resumed");
			}
			const drift: string[] = [];
			// Drift is the operator's selection moving; a fallback-served run
			// compares its recorded selection, then resumes on the ref that
			// actually served — a resumed turn never switches models.
			const recordedSelection = snap.data.configuredModel ?? snap.data.model;
			if (recordedSelection !== captured.model) {
				drift.push(`model changed ${recordedSelection} → ${captured.model}`);
			}
			if (snap.data.thinking !== captured.thinking) {
				drift.push(`thinking changed ${snap.data.thinking} → ${captured.thinking}`);
			}
			if (drift.length > 0) {
				return refused("invalid", `${drift.join("; ")} since the interruption — not resumed`);
			}
			const servedByFallback =
				snap.data.configuredModel !== undefined &&
				snap.data.model !== null &&
				snap.data.model !== snap.data.configuredModel;
			if (servedByFallback) {
				log.info("resume stays on the fallback that served", {
					conversation: convId,
					run: run.runId,
					configured: snap.data.configuredModel,
					servedBy: snap.data.model,
				});
				captured = { ...captured, model: snap.data.model };
			}
			const hooks = deps.sinkHooks(conv);
			let tools: ToolSet;
			try {
				tools = deps.makeTools(
					captured,
					hooks.voice ? async () => {} : undefined,
					hooks.recording ? () => () => {} : undefined,
					hooks.file ? async () => {} : undefined,
				);
			} catch (err) {
				return refused(
					"invalid",
					`tool assembly failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			const present = new Set(Object.keys(tools));
			if (run.toolNames === null) {
				return refused("invalid", "the recorded tool surface is unreadable — not resumed");
			}
			const missing = run.toolNames.filter((n) => !present.has(n));
			if (missing.length > 0) {
				return refused(
					"invalid",
					`tool surface changed: ${missing.join(", ")} no longer exist — not resumed`,
				);
			}
			if (runtime.busy(convId)) {
				return refused(
					"conflict",
					"a turn or compaction is running or queued — stop it or wait for it to finish",
				);
			}
			// Tail-only staleness: a durable user event the dead turn never
			// owned — anything input after its anchor that is not recorded
			// steering or its own registered resume request — refuses.
			const stale = stalenessRefusal(store, convId, run);
			if ("refuse" in stale) {
				return refused(stale.code, stale.refuse);
			}
			const loop = seedLoop(run, calls);
			if (loop === "unreadable") {
				return refused("invalid", "the journaled loop checkpoint is unreadable — not resumed");
			}
			const partial = seedPartial(run, calls);
			// The resume is a NEW source-linked user event: the provenance
			// prefix, then the original request and the owned post-anchor
			// inputs verbatim — attachments and notes ride as parts. Parts
			// of an event still in the model view are NOT re-copied — it
			// reaches the model through its own entry, and re-copying
			// would double the text in the prompt and in the retention
			// document — with one exception: a skill invocation's durable
			// record is the reference alone (the body rides only the
			// owning turn's view), so a still-visible invocation loses its
			// body on resume unless the new event re-carries the ref for
			// the new run to own.
			// The compaction summary borrows boundarySeq, which can equal a
			// folded event's seq — exclude it or it masquerades as the anchor.
			const viewSeqs = new Set(
				store
					.modelEntries(convId)
					.filter((e) => !isCompactionSummaryId(e.message.id))
					.map((e) => e.seq),
			);
			// A folded event's whole content is revived; a visible event
			// contributes only its skill-invocation refs (stale.owned
			// starts past the anchor — the two never overlap).
			const revive = (e: DetailEntry): { parts: UIMessage["parts"]; folded: boolean } =>
				viewSeqs.has(e.seq)
					? {
							parts: e.message.parts.filter((p) => p.type === SKILL_PART),
							folded: false,
						}
					: { parts: [...e.message.parts], folded: true };
			const anchor = stale.anchor !== undefined ? revive(stale.anchor) : null;
			const steered = stale.owned.map(revive);
			// Journal-owned user events BEFORE the anchor (a coalesced
			// claim) keep the same rule: their invocation refs re-ride the
			// resume event — their ordinary content is never revived.
			// Legacy NULL ownership adds nothing.
			const ownedSeqs = new Set(run.ownedInputSeqs ?? []);
			const revived = [
				...store
					.historyDetail(convId)
					.filter(
						(e) =>
							run.anchorSeq !== null &&
							e.seq < run.anchorSeq &&
							e.message.role === "user" &&
							ownedSeqs.has(e.seq),
					)
					.flatMap((e) => e.message.parts.filter((p) => p.type === SKILL_PART)),
				...(anchor?.parts ?? []),
				...steered.flatMap((s) => s.parts),
			];
			const triggerVisible = stale.anchor !== undefined && viewSeqs.has(stale.anchor.seq);
			// Name exactly what the copied parts carry — the prefix claims
			// the request or consumed steering only when those folded
			// contents actually ride along.
			const requestCopied = anchor !== null && anchor.folded && anchor.parts.length > 0;
			const steeringCopied = steered.some((s) => s.folded && s.parts.length > 0);
			const follows = requestCopied
				? steeringCopied
					? "; original request and consumed steering follow"
					: "; original request follows"
				: steeringCopied
					? "; consumed steering follows"
					: "";
			const parts: UIMessage["parts"] = [
				{
					type: "text",
					text: `[operator resumed interrupted run ${run.runId}${follows}]`,
				},
				...revived,
			];
			if (!triggerVisible && revived.length === 0 && partial === null) {
				return refused(
					"invalid",
					"the trigger message and the journaled progress are both gone — nothing to resume",
				);
			}
			const resumeMessage: UIMessage = {
				...userMessage(parts),
				metadata: { goblinResume: { sourceRunId: run.runId } },
			};
			const legacySeqs = [
				...(stale.anchor !== undefined ? [stale.anchor.seq] : []),
				...stale.owned.map((e) => e.seq),
			];
			const sourceInputSeq =
				run.sourceInputSeq ??
				(run.resumedFrom === null && legacySeqs.length > 0 ? Math.max(...legacySeqs) : null);
			const seed: ResumeSeed = {
				conversation: captured,
				...(servedByFallback && snap.data.configuredModel !== undefined
					? { fallback: { configured: snap.data.configuredModel, tried: [] } }
					: {}),
				partial,
				sourceInputSeq,
				admissionExchangeExcluded: run.admissionExchangeExcluded,
				ownedInputSeqs: [
					...new Set([
						...(run.ownedInputSeqs ?? legacySeqs),
						...(sourceInputSeq === null ? [] : [sourceInputSeq]),
					]),
				],
				// The watchdog judges progress against the operator's real
				// request — the run's anchor, or its first owned input when
				// no anchor was recorded. The head event's marker text names
				// provenance only and must not take its place.
				operatorRequest:
					stale.anchor !== undefined
						? messageText(stale.anchor.message)
						: stale.owned[0] !== undefined
							? messageText(stale.owned[0].message)
							: undefined,
				seenText: partial !== null && partial.parts.some((p) => p.type === "text"),
				toolCalls: calls
					.filter((c) => c.name !== "" && (c.state === "completed" || c.state === "resolved-done"))
					.map((c) => c.name),
				digest: seedDigest(calls),
				loop,
				startedAt: run.startedMs,
				filterRetryUsed: run.filterRetryUsed,
				resumedFrom: run.runId,
			};
			// The sink is the last thing built — every refusal above must not
			// create it: a real delivery sink starts its typing interval at
			// construction, and only admission or an explicit fence stops it.
			const inner = deps.sinkFor(conv);
			if (inner === null) {
				return refused(
					"unavailable",
					"telegram channel is unavailable — the interrupted turn cannot resume",
				);
			}
			// A prototype clone still splits the receiver — getters and private state belong to the real instance, so forward through it; only onDone is overridden.
			const onDone = async (done: TurnDone) => {
				try {
					await inner.onDone(done);
				} finally {
					claimed.delete(run.runId);
					try {
						deps.notifyDone?.(conv, run.runId, done);
					} catch (err) {
						log.warn("resume completion notice failed", err, {
							conversation: convId,
							run: run.runId,
						});
					}
				}
			};
			const sink = new Proxy(inner, {
				get(target, prop) {
					if (prop === "onDone") return onDone;
					const value: unknown = Reflect.get(target, prop, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			claimed.add(run.runId);
			try {
				if (!runtime.resume(conv, resumeMessage, sink, seed)) {
					claimed.delete(run.runId);
					return refused("unavailable", "the runtime is shut down");
				}
			} catch (err) {
				claimed.delete(run.runId);
				// The attempt was never admitted — nobody else will settle this
				// sink, so fence it here (its typing interval is already live).
				try {
					void Promise.resolve(inner.onDone({ kind: "fenced" })).catch((disposeErr: unknown) => {
						log.warn("resume sink disposal failed", disposeErr, {
							conversation: convId,
							run: run.runId,
						});
					});
				} catch (disposeErr) {
					log.warn("resume sink disposal failed", disposeErr, {
						conversation: convId,
						run: run.runId,
					});
				}
				log.error("resume event could not be recorded", err, {
					conversation: convId,
					run: run.runId,
				});
				return refused(
					"unavailable",
					`resume could not be recorded: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			log.info("interrupted turn admitted for resume", {
				conversation: convId,
				run: run.runId,
				completed: run.calls.completed,
				resolved: run.calls.resolved,
				planned: run.calls.planned,
			});
			return { kind: "resumed", runId: run.runId };
		},
	};
}

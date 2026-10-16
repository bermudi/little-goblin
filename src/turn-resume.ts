// Turn resume — the only door from 'interrupted' back to a live turn
// (design/runtime-turn.md → The turn journal). Boot stays
// notice-only; this module is the explicit operator decision: validate
// the recorded contract (settings snapshot + tool surface), require
// every ambiguous 'dispatched' call resolved to a decision, then admit
// a FRESH queued turn carrying a recovery seed — a new run row linked
// to the source by resumed_from, never the old wire.
//
// Replay vs decide: 'completed' source calls (and 'resolved-done' —
// the operator asserted the outcome) replay their recorded result
// through the fence without executing. 'resolved-retry' re-executes
// exactly that call; 'resolved-skip' executes nothing and reads back
// the decision note. 'planned' calls the dead model emitted but never
// dispatched simply run if the resumed model asks for them again.

import { randomUUID } from "node:crypto";
import type { ToolSet, UIMessage } from "ai";
import { z } from "zod";
import type { Conversation, ConversationStore } from "./conversation.ts";
import { log } from "./log.ts";
import {
	type ResumeSeed,
	type Runtime,
	type RuntimeDeps,
	type TurnDone,
	type TurnSink,
	userMessage,
} from "./runtime.ts";
import { summarize, toolOk, type ToolCallDigest } from "./reviewer.ts";
import type { LoopTurnState } from "./turn/state.ts";
import {
	type CallDecision,
	recordedOutput,
	RESOLVED_RETRY_NOTE,
	RESOLVED_SKIP_NOTE,
	type TurnJournal,
	type TurnRun,
	type TurnToolCall,
} from "./turn-journal.ts";

// The refusal classes the surfaces map onto: not-found → the run isn't
// this conversation's interrupted row; conflict → a state fight (wrong
// status, lane busy, call already resolved); invalid → the recorded
// contract no longer holds (settings/tool drift, unreadable snapshot);
// unavailable → the runtime cannot take a turn at all.
export type ResumeRefusalCode = "not-found" | "conflict" | "invalid" | "unavailable";

export type ResumeOutcome =
	| { kind: "resumed"; runId: string }
	| { kind: "needs-decisions"; runId: string; calls: TurnToolCall[] }
	| { kind: "refused"; code: ResumeRefusalCode; reason: string };

export type DecideOutcome =
	| { kind: "ok" }
	| { kind: "refused"; code: ResumeRefusalCode; reason: string };

// One interrupted run as the surfaces list it: the run row plus every
// journaled call so the operator sees what completed, what's ambiguous,
// and what was already decided.
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
	// Same capture the runtime runs at admission — the snapshot compare
	// is only honest if it uses the identical function.
	captureConversation(conv: Conversation): Conversation;
	// The composition's tool factory — validation rebuilds the surface
	// the resumed attempt will get and refuses on a shrink.
	makeTools: RuntimeDeps["makeTools"];
	// The resumed turn's sink — the channel's ordinary terminal sink,
	// not a streaming door: the interrupted wire died with the process.
	sinkFor(conv: Conversation): TurnSink;
	// Which delivery hooks the resume sink carries — the tool-surface
	// check must see the resumed attempt's set without constructing the
	// sink (construction starts indicators).
	sinkHooks(conv: Conversation): { voice: boolean; recording: boolean; file: boolean };
	// One terminal notice per resumed turn — it is headless, nobody is
	// watching a stream. Fires even when the sink's own onDone throws.
	notifyDone?(conv: Conversation, sourceRunId: string, done: TurnDone): void;
}

type RunRef = { kind: "found"; run: TurnRun } | { kind: "ambiguous" } | { kind: "missing" };

// Surface addressing is by run-id prefix (what the boot notice and
// /resume print) or the full id — resolved against this conversation's
// interrupted runs only, so a decided/live row can never be addressed.
function findRun(journal: TurnJournal, convId: string, ref: string): RunRef {
	const runs = journal.interrupted().filter((r) => r.conversationId === convId);
	const matches = runs.filter((r) => r.runId === ref || r.runId.startsWith(ref));
	if (matches.length === 0) return { kind: "missing" };
	if (matches.length > 1) return { kind: "ambiguous" };
	return { kind: "found", run: matches[0]! };
}

function refused(code: ResumeRefusalCode, reason: string) {
	return { kind: "refused" as const, code, reason };
}

const convSnapshotSchema = z.object({
	model: z.string().nullable(),
	thinking: z.string().nullable(),
});

// The journaled watchdog/loop checkpoint — a corrupt one is a refusal,
// never a partial restore.
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

// Bounded digest entries for the seeded evidence — the reviewer's
// default window, since the resumed turn has no richer source.
const SEED_DIGEST_CHARS = 300;

// Assistant text the interrupted attempt checkpointed — run.partial is
// bounded JSON of ModelMessage[]; a cut document decodes to raw text
// and is unusable.
function checkpointedText(partial: unknown): UIMessage["parts"] {
	const parts: UIMessage["parts"] = [];
	if (!Array.isArray(partial)) return parts;
	for (const m of partial) {
		if (typeof m !== "object" || m === null) continue;
		const msg = m as { role?: unknown; content?: unknown };
		if (msg.role !== "assistant") continue;
		if (typeof msg.content === "string") {
			if (msg.content !== "") parts.push({ type: "text", text: msg.content });
			continue;
		}
		if (!Array.isArray(msg.content)) continue;
		for (const p of msg.content) {
			if (typeof p !== "object" || p === null) continue;
			const part = p as { type?: unknown; text?: unknown };
			if (part.type === "text" && typeof part.text === "string" && part.text !== "") {
				parts.push({ type: "text", text: part.text });
			}
		}
	}
	return parts;
}

// The reconstructed partial: journal calls become tool parts the model
// reads as already-answered (recorded/decided output) — the fence then
// replays the same answers if the model re-emits the call anyway.
// Text lands first, calls last: the tail the model continues is the
// call list, the most common resume need.
function seedPartial(run: TurnRun, calls: TurnToolCall[]): UIMessage | null {
	const parts: UIMessage["parts"] = checkpointedText(run.partial);
	for (const c of calls) {
		if (c.name === "") continue; // marker rows carry no call identity
		if (c.state === "completed" || c.state === "resolved-done") {
			parts.push({
				type: `tool-${c.name}`,
				toolCallId: c.toolCallId,
				state: "output-available",
				input: c.args,
				output: recordedOutput(c),
			} as UIMessage["parts"][number]);
		} else if (c.state === "resolved-retry" || c.state === "resolved-skip") {
			const note = c.state === "resolved-retry" ? RESOLVED_RETRY_NOTE : RESOLVED_SKIP_NOTE;
			parts.push({
				type: `tool-${c.name}`,
				toolCallId: c.toolCallId,
				state: "output-available",
				input: c.args,
				output: c.resolutionNote === null ? note : `${note} — ${c.resolutionNote}`,
			} as UIMessage["parts"][number]);
		}
		// planned/failed have nothing recorded — the model re-emits a
		// planned call if it still wants it; a failed call's error row
		// is not a result the dead attempt ever saw.
	}
	if (parts.length === 0) return null;
	return { id: randomUUID(), role: "assistant", parts };
}

// Digest evidence for the calls a resume replays — enough for the
// reviewer's gate to see what this turn answered without pretending
// the dead attempt's stream details survived.
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
	// No checkpoint survived: keep the honest counts the rows prove so
	// the watchdog's cadence reflects the work that already happened.
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

// The resumed turn's trigger row — the original user message is
// durable history already, so it is only a label (request text for the
// watchdog); a conversation compaction that since removed it gets the
// honest placeholder instead of a refusal. `found` reports whether the
// label rides a real history entry — the caller refuses when neither
// it nor a journaled partial can seed the model view.
function triggerMessage(
	store: ConversationStore,
	convId: string,
	run: TurnRun,
): { message: UIMessage; found: boolean } {
	const entry =
		run.anchorSeq === null
			? undefined
			: store.modelEntries(convId).find((e) => e.seq === run.anchorSeq);
	if (entry !== undefined) return { message: entry.message, found: true };
	log.debug("resume trigger message not in history — using placeholder", {
		conversation: convId,
		run: run.runId,
		anchorSeq: run.anchorSeq,
	});
	return {
		message: userMessage([
			{ type: "text", text: `(resumed interrupted turn ${run.runId.slice(0, 8)})` },
		]),
		found: false,
	};
}

export function makeResumeOps(deps: ResumeDeps): ResumeOps {
	const { store, journal, runtime } = deps;
	// The in-flight window between admission and the attempt's markRun:
	// the source row still reads 'interrupted' there, so a second resume
	// would validate and queue a second turn replaying the same calls.
	// The claim is process-local by design — a crash in the window
	// evaporates it AND leaves the row interrupted, the correct pair.
	// It releases on the attempt's terminal onDone — an accepted resume
	// that dies fenced, errored, or stopped before its markRun must not
	// leave the source interrupted yet permanently un-resumable.
	const claimed = new Set<string>();

	return {
		interrupted(convId) {
			return journal
				.interrupted()
				.filter((r) => r.conversationId === convId)
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
			const all = journal.callsFor(found.run.runId);
			const ambiguous = all.filter((c) => c.state === "dispatched");
			let call: TurnToolCall | undefined;
			if (/^\d+$/.test(callRef)) {
				// Ordinals index the undecided list — the numbering /resume prints.
				const i = Number.parseInt(callRef, 10) - 1;
				if (i < 0 || i >= ambiguous.length) {
					return refused(
						"invalid",
						`no undecided call ${callRef} — run ${found.run.runId.slice(0, 8)} has ${ambiguous.length}`,
					);
				}
				call = ambiguous[i];
			} else {
				// Id refs search every journaled call, so a retry on a
				// settled call reads as the conflict it is, not a miss.
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
				if (call !== undefined && call.state !== "dispatched") {
					return refused(
						"conflict",
						`call ${call.toolCallId.slice(0, 8)} is already '${call.state}' — no decision to take`,
					);
				}
			}
			if (call === undefined) {
				return refused("not-found", `no undecided call matching '${callRef}'`);
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
				return { kind: "needs-decisions", runId: run.runId, calls: undecided };
			}
			// The contract the dead turn ran under: model + thinking must
			// still be what the row recorded, or the resume is a different
			// turn pretending to be that one.
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
			if (snap.data.model !== captured.model) {
				drift.push(`model changed ${snap.data.model} → ${captured.model}`);
			}
			if (snap.data.thinking !== captured.thinking) {
				drift.push(`thinking changed ${snap.data.thinking} → ${captured.thinking}`);
			}
			if (drift.length > 0) {
				return refused("invalid", `${drift.join("; ")} since the interruption — not resumed`);
			}
			// The recorded tool surface must still exist — a recorded call
			// for a now-missing tool could neither replay nor be re-asked.
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
					"a turn is running or queued — stop it or wait for it to finish",
				);
			}
			const loop = seedLoop(run, calls);
			if (loop === "unreadable") {
				return refused("invalid", "the journaled loop checkpoint is unreadable — not resumed");
			}
			const partial = seedPartial(run, calls);
			const trigger = triggerMessage(store, convId, run);
			// The model view is durable history + the seeded partial —
			// when the trigger was compacted away AND nothing journaled,
			// the resumed attempt would ask the model to continue
			// nothing.
			if (!trigger.found && partial === null) {
				return refused(
					"invalid",
					"the trigger message and the journaled progress are both gone — nothing to resume",
				);
			}
			const seed: ResumeSeed = {
				conversation: captured,
				partial,
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
			const inner = deps.sinkFor(conv);
			// A spread copies own fields but drops prototype methods — sink
			// implementations may be classes. Clone through the prototype
			// so every member keeps working, then override the terminal hook.
			const sink: TurnSink = Object.assign(
				Object.create(Object.getPrototypeOf(inner)) as TurnSink,
				inner,
				{
					onDone: async (done: TurnDone) => {
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
					},
				},
			);
			claimed.add(run.runId);
			if (!runtime.resume(conv, trigger.message, sink, seed)) {
				claimed.delete(run.runId);
				return refused("unavailable", "the runtime is shut down");
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

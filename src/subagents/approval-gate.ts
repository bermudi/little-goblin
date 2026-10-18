// The crash-approval gate and its durable lease (design/subagents.md →
// Crash approval; Owner decomposition ruling 2026-10-17). Extracted
// from mod.ts verbatim — the lease is a correctness boundary, not
// plumbing: it decides whether a replayed side-effecting tool call may
// run again after a restart, and nothing in the move may change that.

import type { Context, JsonValue } from "@earendil-works/chord";
import { awaitWithContext } from "@earendil-works/chord/context";
import {
	defineDoc,
	type ToolDiagnostic,
	type ToolExecutionApi,
	type ToolExecutionResult,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import { log } from "../log.ts";
import {
	approvalDecisionSchema,
	type SubagentApprovalDecision,
	type SubagentRun,
	type SubagentRuns,
} from "../subagent-runs.ts";
import { SubagentError } from "./errors.ts";
import type { RunOutcomeBody } from "./run-doc.ts";

// ---------- the crash-approval lease ----------

// Every side-effecting subagent tool is lease-gated (design/subagents.md
// → Crash approval): a process kill between the call's durable dispatch
// and its result commit leaves "dispatched, effect unobserved" — and a
// Goblin verdict says what that means. The lease is a
// task-scoped pi-durable doc keyed by the tool task's own id, so claim,
// decision, and a completed-but-unsettled result share the tool task's
// commit line and survive SIGKILL with exactly the durability the
// transcript has. The run row's pendingApproval is only a routing mirror
// — this doc is the truth.

// The decision type and its boundary schema live in subagent-runs.ts —
// the verdict now persists on the row's pendingApproval mirror.
export type { SubagentApprovalDecision };

const ApprovalLeaseSchema = z.discriminatedUnion("state", [
	z.object({ state: z.literal("absent") }),
	z.object({ state: z.literal("claimed"), attempts: z.number() }),
	z.object({
		state: z.literal("decided"),
		attempts: z.number(),
		decision: approvalDecisionSchema,
	}),
	z.object({ state: z.literal("done"), result: z.unknown() }),
]);

type JsonObject = { [key: string]: JsonValue };

// Flat storage row so whole-value writes typecheck; nulls, not absent
// keys — doc values are strict JSON. Reads validate the persisted shape
// against ApprovalLeaseSchema at the boundary (readApprovalLease).
type ApprovalLeaseRow = {
	state: "absent" | "claimed" | "decided" | "done";
	attempts: number | null;
	decision: JsonValue | null;
	result: JsonValue | null;
};

const approvalClaimRow = (attempts: number): ApprovalLeaseRow => ({
	state: "claimed",
	attempts,
	decision: null,
	result: null,
});
const approvalDecidedRow = (attempts: number, decision: JsonValue): ApprovalLeaseRow => ({
	state: "decided",
	attempts,
	decision,
	result: null,
});
const approvalDoneRow = (result: JsonValue): ApprovalLeaseRow => ({
	state: "done",
	attempts: null,
	decision: null,
	result,
});

// Exported for the crash tests: a pre-seeded `done` lease is how the
// result-committed-but-unobserved window is exercised without racing a
// real kill.
export const approvalLeaseDoc = defineDoc<ApprovalLeaseRow>({
	kind: "goblin.subagent-approval-lease",
	version: 1,
	scope: "task",
	initial: () => ({ state: "absent", attempts: null, decision: null, result: null }),
});

function readApprovalLease(
	snapshot: Readonly<JsonObject> | undefined,
): ApprovalLeaseRow | undefined {
	if (snapshot === undefined) return undefined;
	const parsed = ApprovalLeaseSchema.safeParse(snapshot);
	if (!parsed.success) {
		throw new SubagentError(`corrupt approval lease: ${parsed.error.message}`);
	}
	const row = parsed.data;
	return {
		state: row.state,
		attempts: row.state === "claimed" || row.state === "decided" ? row.attempts : null,
		decision: row.state === "decided" ? (row.decision as JsonValue) : null,
		result: row.state === "done" ? (row.result as JsonValue) : null,
	};
}

/** The claim generation and any prior decision a validated lease carries. */
function approvalLeaseGeneration(lease: ApprovalLeaseRow | undefined): {
	attempts: number;
	decision: SubagentApprovalDecision | undefined;
} {
	if (lease?.state === "claimed") {
		return { attempts: lease.attempts ?? 0, decision: undefined };
	}
	if (lease?.state === "decided") {
		// readApprovalLease validated the decision's shape; the cast only
		// restores the type zod already checked.
		return {
			attempts: lease.attempts ?? 0,
			decision: lease.decision as SubagentApprovalDecision,
		};
	}
	return { attempts: 0, decision: undefined };
}

function asJson<T>(value: T): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}

async function commitApprovalLease(
	api: ToolExecutionApi,
	lease: ApprovalLeaseRow,
	context: Context,
): Promise<void> {
	await api.commit(async (tx) => {
		const draft = await tx.doc(approvalLeaseDoc, api.taskId);
		draft.state = lease.state;
		draft.attempts = lease.attempts;
		draft.decision = lease.decision;
		draft.result = lease.result;
	}, context);
}

// ---------- the approval host (the gate's park surface) ----------

export interface ApprovalGateDeps {
	runs: SubagentRuns;
	rowForConversation: (piConversationId: string) => SubagentRun | null;
	recordOutcome: (api: ToolExecutionApi, outcome: RunOutcomeBody) => Promise<void>;
	notify: (row: SubagentRun) => void;
	releaseLeases: (row: SubagentRun) => void;
	scheduleDrain: () => void;
	// Best-effort abort of the run's Pi conversation after a park that
	// could not persist — the owner supplies it because the harness is
	// its own dependency (and binds only at buildHarness time).
	abortConversation: (row: SubagentRun) => Promise<void>;
}

interface ApprovalRequest {
	conversationId: string;
	taskId: string;
	callId: string;
	tool: string;
	args: unknown;
	attempts: number;
}

interface ApprovalHost {
	requestApproval(request: ApprovalRequest, context: Context): Promise<SubagentApprovalDecision>;
}

type Waiters = Map<string, (decision: SubagentApprovalDecision) => void>;
type Decisions = Map<string, SubagentApprovalDecision>;

function approvalKey(piConversationId: string, piTaskId: string): string {
	return `${piConversationId}:${piTaskId}`;
}

function approvalQuestion(request: {
	tool: string;
	callId: string;
	args: unknown;
	attempts: number;
}): string {
	let argsText: string;
	try {
		argsText = JSON.stringify(request.args) ?? "null";
	} catch {
		argsText = "[unserializable arguments]";
	}
	if (argsText.length > 4000) argsText = `${argsText.slice(0, 4000)}…`;
	return [
		`A ${request.tool} call was interrupted by a restart and may have partially run — whether its side effect landed is unknown.`,
		`tool: ${request.tool}\ncall: ${request.callId}\nattempts: ${request.attempts}\narguments: ${argsText}`,
		`Goblin should inspect available evidence and decide with evidence and reasoning: record-result supplies a declared result without re-executing, authorize-retry runs the call once more, or abandon ends the run. A verdict does not verify the interrupted effect. Ask the operator only if resolution needs their judgment or an action already requires their permission, not merely because this call crashed.`,
	].join("\n\n");
}

// Parking writes the run needs_input plus the pendingApproval mirror
// and notice — the same routing surface ask_operator uses — then waits
// on decide(), raced against the invocation's abort so a stopped or
// closing run ends the wait instead of hanging waitForIdle. The host
// deliberately never takes the run lane: completeStop joins the Pi
// conversation that is waiting here, so a lane-held park would
// deadlock the stop.
function makeApprovalHost(
	deps: ApprovalGateDeps,
	waiters: Waiters,
	decisions: Decisions,
): ApprovalHost {
	const { runs, rowForConversation, notify, releaseLeases, scheduleDrain, abortConversation } =
		deps;
	return {
		async requestApproval(request, context) {
			const key = approvalKey(request.conversationId, request.taskId);
			const queued = decisions.get(key);
			if (queued !== undefined) {
				// decide() ran before this task re-entered the gate — the
				// post-restart window. Apply the stored decision instead of
				// asking again.
				decisions.delete(key);
				log.info("subagent approval: stored decision applied on gate re-entry", {
					piConversation: request.conversationId,
					piTaskId: request.taskId,
					tool: request.tool,
					callId: request.callId,
					kind: queued.kind,
				});
				return queued;
			}
			const row = rowForConversation(request.conversationId);
			if (row === null) {
				throw new SubagentError("approval request on an unknown subagent conversation");
			}
			if (
				row.stopRequested ||
				row.status === "stopped" ||
				row.status === "done" ||
				row.status === "failed"
			) {
				// Stop or settle won the race — the invocation's own abort
				// lands next; refuse to stand the wait up at all.
				throw new SubagentError(
					`run #${row.id} is ${row.stopRequested ? "stopping" : row.status} — no approval is parked`,
				);
			}
			if (row.status === "queued" && row.pendingApproval?.decision !== undefined) {
				// The verdict is durable on the row and the run waits only
				// for a global slot — re-parking would clobber it. The
				// scheduler's grant resolves this wait; the invocation's
				// abort still ends it on a stop or close.
				try {
					return await awaitWithContext(
						new Promise<SubagentApprovalDecision>((resolve) => {
							waiters.set(key, resolve);
						}),
						context,
					);
				} finally {
					waiters.delete(key);
				}
			}
			// needs_input frees the run's global slot, and for a computer
			// run the desktop controller lease releases — the same rules
			// as an ask_operator park. The write is idempotent across
			// re-entries: a crash between the recorded decision and its
			// lease commit re-parks the same ask.
			let parked: SubagentRun;
			try {
				parked = runs.update(row.id, {
					status: "needs_input",
					question: approvalQuestion(request),
					pendingApproval: {
						piTaskId: request.taskId,
						callId: request.callId,
						tool: request.tool,
						args: request.args,
						attempts: request.attempts,
					},
				});
			} catch (err) {
				// A park the store can't record must NOT become an ordinary
				// tool error — the model would retry the interrupted side
				// effect with no operator decision behind it. Persisted
				// stop intent fences every later tool re-entry (requireLive
				// refuses a stopping row), the fired abort ends this
				// invocation, and the scan's pendingStops completes the
				// terminal mark. When even the intent can't land, a direct
				// 'failed' mark is the last fence a retry can hit.
				log.error("crash-approval park could not persist — fencing the run", err, {
					run: row.id,
					tool: request.tool,
					callId: request.callId,
				});
				try {
					runs.update(row.id, { stopRequested: true });
				} catch (e) {
					log.warn("stop intent could not persist after the failed park", e, { run: row.id });
					try {
						runs.update(row.id, {
							status: "failed",
							error:
								"the approval park could not persist — the interrupted call's effect is unobserved",
							noticePending: true,
							finishedAt: Date.now(),
						});
					} catch (e2) {
						log.warn("the failed-park fence could not settle the row either", e2, {
							run: row.id,
						});
					}
				}
				await abortConversation(row);
				throw new SubagentError(
					`run #${row.id} approval park could not persist — the run is fenced`,
				);
			}
			releaseLeases(parked);
			log.info("subagent parked on a crash-ambiguous tool call", {
				run: row.id,
				piTaskId: request.taskId,
				tool: request.tool,
				callId: request.callId,
				attempts: request.attempts,
			});
			notify(parked);
			// The parked row just freed its slot — admit whoever is queued.
			scheduleDrain();
			try {
				return await awaitWithContext(
					new Promise<SubagentApprovalDecision>((resolve) => {
						waiters.set(key, resolve);
					}),
					context,
				);
			} finally {
				waiters.delete(key);
			}
		},
	};
}

// ---------- the gate wrapper ----------

// The crash-approval gate (design/subagents.md → Crash approval).
// replay:"safe" is deliberate and NOT an idempotency claim: it is
// the only re-entry point pi-durable offers — recovery re-executes
// replay-safe tool tasks — and re-entry lands here. Re-entry on a
// `claimed` lease parks the run for an operator decision; on a
// `done` lease it replays the recorded result without re-executing.
// This wrapper sits OUTSIDE withRunGuards: a parked row is
// needs_input, which requireLive rejects — inside the guards the
// re-entry could never reach the gate.

const legacyDeclaredDoneSchema = z
	.object({
		content: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1),
		diagnostics: z.array(z.object({ code: z.string() })),
	})
	.refine((r) => r.diagnostics.some((d) => d.code === "operator_recorded"));

function declaredApprovalResult(
	name: string,
	decision: SubagentApprovalDecision,
): ToolExecutionResult {
	return {
		output: [
			{
				type: "text" as const,
				text: `[crash resolution: ${decision.decidedBy === "goblin" ? "Goblin-decided" : "legacy decision; provenance not recorded"}; interrupted outcome: unverified]\nThis is a declared result, not observed tool output or proof of success. Independently check the effect before claiming success.\nDeclared result: ${decision.result}\nEvidence: ${decision.evidence ?? "not recorded (legacy decision)"}\nReasoning: ${decision.reasoning ?? "not recorded (legacy decision)"}${decision.note === undefined ? "" : `\nDecision note: ${decision.note}`}`,
			},
		],
		// Answered as an error result, not a success: a successful
		// call would have to return the tool's own schema-valid
		// `structuredOutput`, and a declaration must never present
		// itself as observed output. `isError` is the harness's own
		// convention for a call that produced no observed result, and
		// the model still reads the declaration text above.
		isError: true,
		diagnostics: [
			{
				severity: "warn" as const,
				code: "crash_resolution_unverified",
				message: `The interrupted ${name} outcome remains unverified; this result is a declaration, not proof of success.`,
			},
		],
		details: {
			crashResolution: {
				decidedBy: decision.decidedBy ?? "legacy-unknown",
				outcome: "unverified",
				kind: decision.kind,
				evidence: decision.evidence ?? null,
				reasoning: decision.reasoning ?? null,
			},
			declaredResult: decision.result as string,
		},
	} satisfies ToolExecutionResult;
}

function withApprovalGate<T extends ToolRegistration>(
	tool: T,
	host: ApprovalHost,
	deps: ApprovalGateDeps,
): T {
	const inner = tool.execute;
	const name = tool.name;
	const { rowForConversation, recordOutcome } = deps;
	// A tool that declares a structured output schema can only have
	// succeeded with that output; a persisted row without it — a
	// declaration committed by a build from before declarations
	// became error results — replays as an error result, exactly as
	// a fresh declaration returns. A pure function of the stored row,
	// so replay stays deterministic across restarts.
	function replayed(result: ToolExecutionResult, api: ToolExecutionApi): ToolExecutionResult {
		if (tool.structuredOutputSchema === undefined) return result;
		if (result.isError === true || result.structuredOutput !== undefined) return result;
		log.info("subagent crash lease: persisted result replayed as an error result", {
			run: rowForConversation(String(api.conversationId))?.id,
			piTaskId: String(api.taskId),
			tool: name,
			callId: api.callId,
		});
		return { ...result, isError: true };
	}
	return {
		...tool,
		replay: "safe",
		execute: async (args: never, api: ToolExecutionApi, context: Context) => {
			const lease = readApprovalLease(await api.snapshot(approvalLeaseDoc, api.taskId, context));
			if (lease?.state === "done") {
				const legacy = legacyDeclaredDoneSchema.safeParse(lease.result);
				if (legacy.success) {
					const result = declaredApprovalResult(name, {
						kind: "record-result",
						result: legacy.data.content.map((p) => p.text).join(""),
					});
					await commitApprovalLease(api, approvalDoneRow(asJson(result)), context);
					log.info("subagent crash lease: legacy declared result normalized", {
						run: rowForConversation(String(api.conversationId))?.id,
						piTaskId: String(api.taskId),
						tool: name,
						callId: api.callId,
					});
					return result;
				}
				return replayed(lease.result as ToolExecutionResult, api);
			}
			// Claim generations survive decisions — a retry that itself
			// dies mid-flight re-asks with the raised count.
			const prior = approvalLeaseGeneration(lease);
			let decision = prior.decision;
			if (decision === undefined && lease?.state === "claimed") {
				// The ambiguity: dispatch committed, result absent, effect
				// unobserved. Park — nothing model-facing happens until a
				// decide verdict lands.
				api.output(
					`${name} was interrupted and may have partially run — awaiting Goblin crash resolution`,
				);
				decision = await host.requestApproval(
					{
						conversationId: String(api.conversationId),
						taskId: String(api.taskId),
						callId: api.callId,
						tool: name,
						args,
						attempts: prior.attempts,
					},
					context,
				);
			}
			if (decision !== undefined) {
				// The decision commits BEFORE acting on it — a crash in
				// between leaves `claimed` and the gate re-asks on the
				// next boot.
				await commitApprovalLease(
					api,
					approvalDecidedRow(prior.attempts, asJson(decision)),
					context,
				);
			}
			if (decision !== undefined && decision.kind === "record-result") {
				if (decision.result === undefined || decision.result === "") {
					throw new SubagentError(
						"record-result decision without result text — the lease is inconsistent",
					);
				}
				const result = declaredApprovalResult(name, decision);
				await commitApprovalLease(api, approvalDoneRow(asJson(result)), context);
				return result;
			}
			if (decision !== undefined && decision.kind === "abandon") {
				const reason = `${decision.decidedBy === "goblin" ? "Goblin abandoned this run" : "A legacy decision abandoned this run"} after an interrupted ${name} call; the call's effect remains unverified. Evidence: ${decision.evidence ?? "not recorded (legacy decision)"}. Reasoning: ${decision.reasoning ?? "not recorded (legacy decision)"}${decision.note === undefined ? "" : ` Decision note: ${decision.note}`}`;
				await recordOutcome(api, { kind: "aborted", reason });
				return {
					output: [
						{
							type: "text" as const,
							text: reason,
						},
					],
					// The call never produced an observed result, so it is
					// answered as an error result — the harness's own
					// convention for an interrupted call (see
					// declaredApprovalResult above).
					isError: true,
					control: { terminate: true },
				} satisfies ToolExecutionResult;
			}
			// Fresh call, or an authorized re-execution. Either way the
			// gate admits exactly one dispatch under this generation.
			await commitApprovalLease(api, approvalClaimRow(prior.attempts + 1), context);
			// The lease must replay the result the model actually saw —
			// Pi folds streamed output(), diagnostic() and details()
			// calls into the resolved result when the return value
			// omits them (bash returns {} and streams stdout/stderr).
			// Persisting the raw return would replay "(no tool
			// output)" after a restart, so the durable row carries the
			// effective result instead.
			const capturedOutput: string[] = [];
			const capturedDiagnostics: ToolDiagnostic[] = [];
			let capturedDetails: JsonValue | undefined;
			const decoder = new TextDecoder();
			const observed: ToolExecutionApi = {
				...api,
				output(chunk) {
					capturedOutput.push(
						typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }),
					);
					api.output(chunk);
				},
				diagnostic(d) {
					capturedDiagnostics.push(d);
					api.diagnostic(d);
				},
				async details(v, ctx) {
					capturedDetails = v as JsonValue;
					await api.details(v, ctx);
				},
			};
			const result = await inner(args, observed, context);
			const tail = decoder.decode();
			if (tail !== "") capturedOutput.push(tail);
			const effective: ToolExecutionResult = {
				...(result.output === undefined && capturedOutput.length > 0
					? {
							output: [{ type: "text" as const, text: capturedOutput.join("") }],
						}
					: {}),
				...result,
				...(result.details === undefined && capturedDetails !== undefined
					? { details: capturedDetails }
					: {}),
				diagnostics: [...capturedDiagnostics, ...(result.diagnostics ?? [])],
			};
			await commitApprovalLease(api, approvalDoneRow(asJson(effective)), context);
			// The settled tool-result replay and the model-facing
			// result both come from this return — the lease doc
			// itself retires with the tool task, so it can only
			// cover a crash inside the call's own window.
			return effective;
		},
	} as T;
}

// ---------- the gate surface ----------

export interface ApprovalGate {
	/** Wrap a side-effecting tool registration in the lease gate. */
	withGate<T extends ToolRegistration>(tool: T): T;
	/** The waiter/decision map key for a Pi conversation + task. */
	approvalKey(piConversationId: string, piTaskId: string): string;
	/** Take the parked invocation's waiter if this process holds one —
	 *  admission resolves it only after the settlement watcher attaches. */
	takeWaiter(key: string): ((decision: SubagentApprovalDecision) => void) | undefined;
	/** Store a decision for a gate re-entry that has not happened yet. */
	storeDecision(key: string, decision: SubagentApprovalDecision): void;
	/** Drop every waiter/decision keyed under a Pi conversation. */
	dropForConversation(piConversationId: string): void;
}

export function makeApprovalGate(deps: ApprovalGateDeps): ApprovalGate {
	// In-memory waiters and pre-registered decisions, keyed by
	// piConv:piTaskId. A parked gate resolves on decide(); a decide()
	// landing before the gate's post-restart re-entry is consumed by the
	// next park instead of re-asking. Both maps die with the owner —
	// waiters reject on the invocation's abort at close, and a parked
	// row re-parks from the durable lease on the next boot.
	const waiters: Waiters = new Map();
	const decisions: Decisions = new Map();
	const host = makeApprovalHost(deps, waiters, decisions);
	return {
		withGate: (tool) => withApprovalGate(tool, host, deps),
		approvalKey,
		takeWaiter(key) {
			const waiter = waiters.get(key);
			if (waiter !== undefined) waiters.delete(key);
			return waiter;
		},
		storeDecision(key, decision) {
			decisions.set(key, decision);
		},
		dropForConversation(piConversationId) {
			const prefix = `${piConversationId}:`;
			for (const key of [...decisions.keys()]) {
				if (key.startsWith(prefix)) decisions.delete(key);
			}
			for (const key of [...waiters.keys()]) {
				if (key.startsWith(prefix)) waiters.delete(key);
			}
		},
	};
}

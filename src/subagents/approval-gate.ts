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

export type { SubagentApprovalDecision };

// Keyed by the tool task's own id, so claim, decision and result share
// its commit line and survive SIGKILL with transcript durability; the
// row's pendingApproval is only a routing mirror — this doc is truth.
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

function approvalLeaseGeneration(lease: ApprovalLeaseRow | undefined): {
	attempts: number;
	decision: SubagentApprovalDecision | undefined;
} {
	if (lease?.state === "claimed") {
		return { attempts: lease.attempts ?? 0, decision: undefined };
	}
	if (lease?.state === "decided") {
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

export interface ApprovalGateDeps {
	runs: SubagentRuns;
	rowForConversation: (piConversationId: string) => SubagentRun | null;
	recordOutcome: (api: ToolExecutionApi, outcome: RunOutcomeBody) => Promise<void>;
	notify: (row: SubagentRun) => void;
	releaseLeases: (row: SubagentRun) => void;
	scheduleDrain: () => void;
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

// The host deliberately never takes the run lane: completeStop joins
// the Pi conversation waiting here, so a lane-held park would deadlock
// the stop.
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
				throw new SubagentError(
					`run #${row.id} is ${row.stopRequested ? "stopping" : row.status} — no approval is parked`,
				);
			}
			if (row.status === "queued" && row.pendingApproval?.decision !== undefined) {
				// The verdict is already durable — re-parking would
				// clobber it; the scheduler's grant resolves this wait.
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
				// A park the store can't record must NOT surface as an ordinary
				// tool error — the model would retry the interrupted side effect.
				// Fence: stop intent, the fired abort, then a direct failed mark.
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

// replay:"safe" is pi-durable's only re-entry point, not an idempotency
// claim — recovery re-executes replay-safe tool tasks and lands here. Outside
// withRunGuards: a parked row is needs_input, which requireLive rejects.

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
	// A persisted declaration from before declarations became error
	// results carries no structuredOutput — replay it as an error, a
	// pure function of the stored row so restarts stay deterministic.
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
			// Claim generations survive decisions — a retry that dies
			// mid-flight re-asks with the raised count.
			const prior = approvalLeaseGeneration(lease);
			let decision = prior.decision;
			if (decision === undefined && lease?.state === "claimed") {
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
					isError: true,
					control: { terminate: true },
				} satisfies ToolExecutionResult;
			}
			await commitApprovalLease(api, approvalClaimRow(prior.attempts + 1), context);
			// Pi folds streamed output(), diagnostic() and details() into the
			// resolved result when the return omits them (bash returns {} and
			// streams stdout/stderr); persist the effective result for replay.
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
			return effective;
		},
	} as T;
}

export interface ApprovalGate {
	withGate<T extends ToolRegistration>(tool: T): T;
	approvalKey(piConversationId: string, piTaskId: string): string;
	takeWaiter(key: string): ((decision: SubagentApprovalDecision) => void) | undefined;
	storeDecision(key: string, decision: SubagentApprovalDecision): void;
	dropForConversation(piConversationId: string): void;
}

export function makeApprovalGate(deps: ApprovalGateDeps): ApprovalGate {
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

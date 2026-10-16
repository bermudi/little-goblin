// Approval gate for Pi Durable tool calls — goblin's notify-don't-retry
// rule (DESIGN.md → The authority rule) applied to crash-ambiguous tool
// executions. Experimental integration; imported by experimental/pi-approval
// tests only, never by src/.
//
// The gap this closes, verified against the pinned @earendil-works/pi-durable
// 1.0.2 (dist/harness/tool.js): a tool task whose process died between its
// durable intent commit and its result commit is resolved on reopen WITHOUT
// any hook — an unsafe tool settles as `interrupted and may have partially
// run` and the generation CONTINUES on the next model request, so the model
// — not the operator — decides what an unobserved side effect meant. The
// only re-entry point the harness offers is the replay rule: a tool
// registered `replay: "safe"` is re-executed on recovery.
//
// gateTool() uses that deliberately. `"safe"` here means safe to RE-ENTER,
// never safe to repeat: re-entry lands in this gate, and no side effect
// re-runs without an operator decision. The lease below is a task-scoped
// document inside pi-durable's own commit line, so the ambiguity, the
// operator's decision, and a completed-but-unsettled result all survive
// further crashes with exactly the durability the transcript has.

import type { Context, JsonValue } from "@earendil-works/chord";
import {
	defineDoc,
	defineTool,
	type ToolExecutionApi,
	type ToolExecutionResult,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { z } from "zod";

export type ApprovalDecision = {
	kind: "retry" | "interrupted" | "abort";
	note?: string | undefined;
};

export interface ApprovalRequest {
	conversationId: string;
	taskId: string;
	callId: string;
	tool: string;
	args: unknown;
	/** Claim generations seen, including the interrupted one. */
	attempts: number;
}

export interface ApprovalHost {
	/** Resolves when the operator decides. The gate commits the decision
	 *  before acting on it, so hosts may resolve from any channel. */
	requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
}

const DecisionSchema = z.object({
	kind: z.union([z.literal("retry"), z.literal("interrupted"), z.literal("abort")]),
	note: z.string().optional(),
});

const LeaseSchema = z.discriminatedUnion("state", [
	z.object({ state: z.literal("absent") }),
	z.object({ state: z.literal("claimed"), attempts: z.number() }),
	z.object({ state: z.literal("decided"), attempts: z.number(), decision: DecisionSchema }),
	z.object({ state: z.literal("done"), result: z.unknown() }),
]);

type JsonObject = { [key: string]: JsonValue };

// Storage row is flat so whole-value writes typecheck; nulls, not absent
// keys, because doc values are strict JSON. Reads validate the persisted
// shape against LeaseSchema at the boundary (readLease).
type LeaseRow = {
	state: "absent" | "claimed" | "decided" | "done";
	attempts: number | null;
	decision: JsonValue | null;
	result: JsonValue | null;
};

const claimRow = (attempts: number): LeaseRow => ({
	state: "claimed",
	attempts,
	decision: null,
	result: null,
});
const decidedRow = (attempts: number, decision: JsonValue): LeaseRow => ({
	state: "decided",
	attempts,
	decision,
	result: null,
});
const doneRow = (result: JsonValue): LeaseRow => ({
	state: "done",
	attempts: null,
	decision: null,
	result,
});

const LeaseDoc = defineDoc<LeaseRow>({
	kind: "goblin.experimental.approval-lease",
	version: 1,
	scope: "task",
	initial: () => ({ state: "absent", attempts: null, decision: null, result: null }),
});

function readLease(snapshot: Readonly<JsonObject> | undefined): LeaseRow | undefined {
	if (snapshot === undefined) return undefined;
	const parsed = LeaseSchema.safeParse(snapshot);
	if (!parsed.success) {
		throw new Error(`corrupt approval lease: ${parsed.error.message}`);
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
function leaseGeneration(lease: LeaseRow | undefined): {
	attempts: number;
	decision: ApprovalDecision | undefined;
} {
	if (lease?.state === "claimed") {
		return { attempts: lease.attempts ?? 0, decision: undefined };
	}
	if (lease?.state === "decided") {
		// readLease validated the decision's shape; the cast only restores
		// the type zod already checked.
		return { attempts: lease.attempts ?? 0, decision: lease.decision as ApprovalDecision };
	}
	return { attempts: 0, decision: undefined };
}

function asJson<T>(value: T): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function decisionNote(decision: ApprovalDecision): string {
	return decision.note === undefined ? "" : ` Operator note: ${decision.note}`;
}

/**
 * Wrap one tool so a crash-ambiguous execution parks for an operator
 * decision instead of auto-resolving. The returned registration keeps the
 * original name, schema, and description; the original execute() runs only
 * after the gate admits it.
 */
export function gateTool(tool: ToolRegistration, host: ApprovalHost): ToolRegistration {
	const name = tool.name;
	const execute = tool.execute;
	if (execute === undefined) throw new Error(`tool ${name} has no execute to gate`);
	return defineTool({
		...tool,
		// Deliberate: this is NOT an idempotency claim. It routes recovery
		// re-entry into this gate (pi-durable reruns only replay-safe tools);
		// the gate, not this flag, is what keeps repetition off.
		replay: "safe",
		execute: async (args, api, context) => {
			const lease = readLease(await api.snapshot(LeaseDoc, api.taskId, context));
			if (lease?.state === "done") {
				return lease.result as ToolExecutionResult;
			}
			// Claim generations survive decisions so a retry that itself
			// crashes mid-flight asks again with the raised count.
			const prior = leaseGeneration(lease);
			let decision = prior.decision;
			if (decision === undefined && lease?.state === "claimed") {
				// The ambiguity: intent committed, result absent, effect
				// unobserved. Park the run here — nothing model-facing
				// happens until the operator decides.
				api.output(
					`⏸ ${name} was interrupted and may have partially run — awaiting operator decision`,
				);
				decision = await host.requestApproval({
					conversationId: String(api.conversationId),
					taskId: String(api.taskId),
					callId: api.callId,
					tool: name,
					args,
					attempts: prior.attempts,
				});
			}
			if (decision === undefined || decision.kind === "retry") {
				// Fresh call, or an approved re-execution.
				const attempts = prior.attempts + 1;
				await commitLease(api, claimRow(attempts), context);
			} else if (decision.kind === "interrupted") {
				await commitLease(api, decidedRow(prior.attempts, asJson(decision)), context);
				throw new Error(
					`Tool ${name} was interrupted and may have partially run. Operator decision: report interrupted, do not re-run.${decisionNote(decision)}`,
				);
			} else {
				await commitLease(api, decidedRow(prior.attempts, asJson(decision)), context);
				return {
					content: [
						{
							type: "text",
							text: `Operator aborted the run after an interrupted ${name} call; the call's effect is unobserved.${decisionNote(decision)}`,
						},
					],
					control: { terminate: true },
				} satisfies ToolExecutionResult;
			}
			// The gate admits the run: execute the real tool once.
			const result = await execute(args, api, context);
			await commitLease(api, doneRow(asJson(result)), context);
			return result;
		},
	});
}

async function commitLease(
	api: ToolExecutionApi,
	lease: LeaseRow,
	context: Context,
): Promise<void> {
	await api.commit(async (tx) => {
		const draft = await tx.doc(LeaseDoc, api.taskId);
		draft.state = lease.state;
		draft.attempts = lease.attempts;
		draft.decision = lease.decision;
		draft.result = lease.result;
	}, context);
}

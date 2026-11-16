// The recovery guard: whether a tool call in a continued attempt (an
// overflow or fallback continuation — the only kind left, #594) may
// execute, answer as a safe read, or refuse as an unowned historical
// effect. Built ONCE per run from the calls beginRun's inheritance just
// landed — calls the new attempt then makes never join this set
// (same-attempt repetition is not this feature's concern).
//
// Identity is `name:args_hash` — the full canonical-args hash, not the
// bounded preview. A signature is evidence about what ran; it is never
// execution identity.

import { policyOf } from "../agent/tool-policy.ts";
import { RESOLVED_SKIP_NOTE, type ToolCallState, type TurnToolCall } from "../turn-journal.ts";

// States that are historical EXECUTIONS — evidence a side effect may
// have run. planned is a declared intent (never entered) and dispatched
// rows never inherit (ambiguity stays on the dead attempt's row).
// resolved-* rows are legacy operator decisions (#594 removed the
// decision path): resolved-done and resolved-retry count as executions,
// resolved-skip keeps its explicit refusal below.
const EXECUTION_STATES: ReadonlySet<ToolCallState> = new Set([
	"completed",
	"failed",
	"resolved-done",
	"resolved-retry",
]);

export interface GuardEntry {
	toolCallId: string;
	state: ToolCallState;
	resolutionNote: string | null;
}

// The guard itself: signature → inherited call entries, in row order.
export type RetryGuard = Map<string, GuardEntry[]>;

export function buildRetryGuard(calls: TurnToolCall[]): RetryGuard {
	const guard: RetryGuard = new Map();
	for (const c of calls) {
		if (c.name === "") continue;
		if (c.replayed) continue; // synthetic journaled rows are not executions
		if (c.state === "planned" || c.state === "dispatched") continue;
		const key = `${c.name}:${c.argsHash}`;
		const entry: GuardEntry = {
			toolCallId: c.toolCallId,
			state: c.state,
			resolutionNote: c.resolutionNote,
		};
		const list = guard.get(key);
		if (list === undefined) guard.set(key, [entry]);
		else list.push(entry);
	}
	return guard;
}

export type RetryVerdict =
	// Execute under a normal dispatch journal write.
	| { kind: "execute" }
	// An explicit operator skip keeps refusing — it never disappears.
	| { kind: "refuse"; error: string };

// The label the model sees on a refused re-ask: structured, with the
// historical call ids and states so the operator can act on them.
function conflictError(name: string, entries: GuardEntry[]): string {
	const hist = entries.map((e) => `${e.toolCallId} (${e.state})`).join(", ");
	return (
		`[turn-journal conflict] '${name}' with identical arguments already ran ` +
		`in the earlier attempt: ${hist}. Those recorded outcomes are ` +
		`evidence — this call did NOT execute. To run it again deliberately, ` +
		`request the action in a fresh turn.`
	);
}

// Decide what a new tool invocation may do given the signature's
// inherited entries. Order: an explicit skip refuses; a matching safe
// read executes afresh; any other historical execution refuses as an
// unowned repeat; nothing recorded executes normally.
export function classifyRetry(name: string, entries: GuardEntry[] | undefined): RetryVerdict {
	if (entries !== undefined) {
		const skip = entries.find((e) => e.state === "resolved-skip");
		if (skip !== undefined) {
			return {
				kind: "refuse",
				error:
					skip.resolutionNote === null
						? RESOLVED_SKIP_NOTE
						: `${RESOLVED_SKIP_NOTE} — ${skip.resolutionNote}`,
			};
		}
		if (policyOf(name).replay === "safe") return { kind: "execute" };
		const executions = entries.filter((e) => EXECUTION_STATES.has(e.state));
		if (executions.length > 0) {
			return { kind: "refuse", error: conflictError(name, executions) };
		}
	}
	return { kind: "execute" };
}

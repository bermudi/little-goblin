// The recovery guard: whether a tool call in a resumed/continued attempt
// may execute, answer from a consumed operator grant, or refuse as an
// unowned historical effect. Built ONCE per run from the calls beginRun's
// inheritance just landed — calls the new attempt then makes never join
// this set (same-attempt repetition is not this feature's concern).
//
// Identity is `name:args_hash` — the full canonical-args hash, not the
// bounded preview — and historical CALL ids for grants. A signature is
// evidence about what ran; it is never execution identity.

import { RESOLVED_SKIP_NOTE, type ToolCallState, type TurnToolCall } from "../turn-journal.ts";

// Reads whose observed value is only meaningful when freshly observed —
// they execute again without an operator grant (a stale file listing is
// worse than none). Everything else — bash, script, fetch, unknown names
// — is conservatively potentially effectful.
export const SAFE_READ_TOOLS: ReadonlySet<string> = new Set([
	"read_file",
	"history_search",
	"memory_search",
]);

// States a call may be in for `authorize-retry` to take: the ambiguous
// dispatched case plus the KNOWN completed/failed/resolved-done
// executions. record-result and skip remain dispatched-only, a
// resolved-retry row is re-authorized by deciding its successor's
// dispatched call, and synthetic replayed rows can never grant.
export const RETRY_AUTHORIZABLE: ReadonlySet<ToolCallState> = new Set([
	"dispatched",
	"completed",
	"failed",
	"resolved-done",
]);

export function canAuthorizeRetry(call: { state: ToolCallState; replayed: boolean }): boolean {
	return !call.replayed && RETRY_AUTHORIZABLE.has(call.state);
}

// States that are historical EXECUTIONS — evidence a side effect may
// have run. planned is a declared intent (never entered) and dispatched
// rows never inherit (ambiguity stays on the interrupted run's row).
const EXECUTION_STATES: ReadonlySet<ToolCallState> = new Set([
	"completed",
	"failed",
	"resolved-done",
	"resolved-retry",
]);

export interface GuardEntry {
	toolCallId: string;
	state: ToolCallState;
	retryConsumed: boolean;
	resolutionNote: string | null;
}

// The guard itself: signature → inherited call entries, in row order so
// identical grants consume oldest-first.
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
			retryConsumed: c.retryConsumed,
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
	// Execute after atomically consuming this historical grant — the
	// source's resolved-retry row flips retry_consumed in the same
	// transaction as the new dispatch.
	| { kind: "execute-grant"; grant: GuardEntry }
	// An explicit operator skip keeps refusing — it never disappears.
	| { kind: "refuse"; error: string };

// The label the model sees on a refused re-ask: structured, with the
// historical call ids and states so the operator can act on them.
function conflictError(name: string, entries: GuardEntry[]): string {
	const hist = entries.map((e) => `${e.toolCallId} (${e.state})`).join(", ");
	return (
		`[turn-journal conflict] '${name}' with identical arguments already ran ` +
		`in the interrupted attempt: ${hist}. Those recorded outcomes are ` +
		`evidence — this call did NOT execute. To run it again deliberately, the ` +
		`operator authorizes a retry on a historical call id before resuming, or ` +
		`requests the action in a fresh turn.`
	);
}

// Decide what a new tool invocation may do given the signature's
// inherited entries. Order: an unconsumed grant executes (a skipped
// sibling never cancels a separately authorized execution); an explicit
// skip refuses; a matching safe read executes afresh; any other
// historical execution refuses as an unowned repeat; nothing recorded
// executes normally.
export function classifyRetry(name: string, entries: GuardEntry[] | undefined): RetryVerdict {
	if (entries !== undefined) {
		const grant = entries.find((e) => e.state === "resolved-retry" && !e.retryConsumed);
		if (grant !== undefined) return { kind: "execute-grant", grant };
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
		if (SAFE_READ_TOOLS.has(name)) return { kind: "execute" };
		const executions = entries.filter((e) => EXECUTION_STATES.has(e.state));
		if (executions.length > 0) {
			return { kind: "refuse", error: conflictError(name, executions) };
		}
	}
	return { kind: "execute" };
}

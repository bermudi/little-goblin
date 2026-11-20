
import { policyOf } from "../agent/tool-policy.ts";
import { RESOLVED_SKIP_NOTE, type ToolCallState, type TurnToolCall } from "../turn-journal.ts";

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

export type RetryGuard = Map<string, GuardEntry[]>;

export function buildRetryGuard(calls: TurnToolCall[]): RetryGuard {
	const guard: RetryGuard = new Map();
	for (const c of calls) {
		if (c.name === "") continue;
		if (c.replayed) continue;
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
	| { kind: "execute" }
	| { kind: "refuse"; error: string };

function conflictError(name: string, entries: GuardEntry[]): string {
	const hist = entries.map((e) => `${e.toolCallId} (${e.state})`).join(", ");
	return (
		`[turn-journal conflict] '${name}' with identical arguments already ran ` +
		`in the earlier attempt: ${hist}. Those recorded outcomes are ` +
		`evidence — this call did NOT execute. To run it again deliberately, ` +
		`request the action in a fresh turn.`
	);
}

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

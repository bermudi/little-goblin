// Tool authority fencing and the crash journal's dispatch/result/error writes — one pipeline for every tool execute.

import type { ToolExecutionOptions } from "@ai-sdk/provider-utils";
import type { ToolSet } from "ai";
import { bindScriptDispatch, type ToolDispatch } from "../agent/tools/script.ts";
import { log } from "../log.ts";
import { classifyRetry, type RetryGuard } from "./retry-guard.ts";
import { replayKey, type TurnJournal } from "../turn-journal.ts";

// Tools execute inside the SDK stream, so each tool needs its own authority
// check; tools are fresh per turn. A tool cannot rely on the outer chunk
// loop's check to fence its side effects. The same seam writes the crash
// journal's dispatch/result/error transitions — dispatch only after the
// authority check passes, so a fenced call never reads as entered.
//
// A journal write that throws is fatal to the turn, not a tool error:
// the row is the only record of what ran — letting the SDK surface an
// ordinary tool failure invites the model to repeat a side effect the
// journal can no longer describe. The first fault aborts the attempt
// and fences every later dispatch; the attempt's catch reports it as
// a turn error, never 'fenced'.
//
// #477's steer skip: the exact result text an unlaunched call answers
// with — fixed wording the model can key on.
const STEER_SKIPPED = "skipped: the user sent new input; re-issue if still needed";

export function fenceTools(opts: {
	tools: ToolSet;
	convId: string;
	epoch: number;
	journal: TurnJournal | undefined;
	checkAuthority: () => void;
	runId?: string;
	guard?: RetryGuard | undefined;
	journalFault?: { current: unknown };
	onJournalFault?: () => void;
	// #477: a parked steer skips launches it precedes — the runtime arms
	// this only for an engine whose model-call boundary claims steers.
	steerWaiting?: (() => boolean) | undefined;
}): ToolSet {
	const { tools, convId, journal, checkAuthority, runId, guard, journalFault, onJournalFault } =
		opts;
	const note = (write: () => void): void => {
		try {
			write();
		} catch (err) {
			if (journalFault !== undefined && journalFault.current === undefined) {
				journalFault.current = err;
			}
			onJournalFault?.();
			throw err;
		}
	};
	// One pipeline for every execute: a model-issued call and a call
	// nested in `script` both enter by tool name. The input tools are
	// never mutated — the returned set holds copies routed through here.
	const dispatch: ToolDispatch = (name, input, options) => {
		const raw = tools[name];
		const execute = raw?.execute?.bind(raw);
		if (execute === undefined) throw new Error(`tool ${name} has no execute`);
		checkAuthority();
		if (journalFault?.current !== undefined) throw journalFault.current;
		// #477: a steer parked on the lane claims into the next model
		// call — skipping an unstarted call keeps its effects from
		// landing ahead of input the model has not seen. A call already
		// past this line finishes normally; the claim itself stays at
		// the model-call boundary. Journaled replayed like the recovery
		// fence's refusal: the model's record, never an execution.
		if (opts.steerWaiting?.() === true) {
			const value = { error: STEER_SKIPPED };
			if (journal !== undefined && runId !== undefined) {
				note(() => journal.noteToolResult(runId, options.toolCallId, value, { replayed: true }));
			}
			log.info("tool call skipped — steer waiting", {
				conversation: convId,
				tool: name,
				toolCallId: options.toolCallId,
			});
			return value;
		}
		if (journal !== undefined && runId !== undefined) {
			// Recovery fence: a signature that collides with the
			// interrupted attempt's own history is evidence, never an
			// answer. An operator's grant CAS-consumes in the same
			// transaction as the dispatch; a refusal journals as a
			// synthetic replayed result — it never reads as execution.
			const verdict = classifyRetry(name, guard?.get(replayKey(name, input)));
			if (verdict.kind === "refuse") {
				const value = { error: verdict.error };
				note(() =>
					journal.noteToolResult(runId, options.toolCallId, value, {
						replayed: true,
					}),
				);
				log.info("tool call refused by the recovery fence", {
					conversation: convId,
					tool: name,
					toolCallId: options.toolCallId,
				});
				return value;
			}
			note(() =>
				journal.noteToolDispatch(
					runId,
					options.toolCallId,
					name,
					input,
					verdict.kind === "execute-grant" ? { retryCallId: verdict.grant.toolCallId } : undefined,
				),
			);
			if (verdict.kind === "execute-grant") {
				verdict.grant.retryConsumed = true;
			}
		}
		let result: ReturnType<typeof execute>;
		try {
			result = execute(input as never, options);
		} catch (err) {
			if (journal !== undefined && runId !== undefined) {
				note(() => journal.noteToolError(runId, options.toolCallId, err));
			}
			throw err;
		}
		if (
			journal !== undefined &&
			runId !== undefined &&
			result !== null &&
			typeof result === "object" &&
			"then" in result &&
			typeof (result as { then: unknown }).then === "function"
		) {
			// A settled promise is the earliest the result is known —
			// the wrapper resolves only after the journal row lands.
			return (result as PromiseLike<unknown>).then(
				(value) => {
					note(() => journal.noteToolResult(runId, options.toolCallId, value));
					return value;
				},
				(err: unknown) => {
					note(() => journal.noteToolError(runId, options.toolCallId, err));
					throw err;
				},
			);
		}
		if (journal !== undefined && runId !== undefined) {
			note(() => journal.noteToolResult(runId, options.toolCallId, result));
		}
		return result;
	};
	const out: ToolSet = {};
	for (const [name, t] of Object.entries(tools)) {
		out[name] =
			t.execute === undefined
				? t
				: {
						...t,
						execute: (input: unknown, options: ToolExecutionOptions<unknown>) =>
							dispatch(name, input, options),
					};
	}
	bindScriptDispatch(tools, dispatch);
	return out;
}


import { isHosted, type ToolCallContext, type Tools } from "../tool.ts";
import { bindScriptDispatch, type ToolDispatch } from "../agent/tools/script.ts";
import { log } from "../log.ts";
import { classifyRetry, type RetryGuard } from "./retry-guard.ts";
import { replayKey, type TurnJournal } from "../turn-journal.ts";

const STEER_SKIPPED = "skipped: the user sent new input; re-issue if still needed";

export function fenceTools(opts: {
	tools: Tools;
	convId: string;
	epoch: number;
	journal: TurnJournal | undefined;
	checkAuthority: () => void;
	runId?: string;
	guard?: RetryGuard | undefined;
	journalFault?: { current: unknown };
	onJournalFault?: () => void;
	steerWaiting?: (() => boolean) | undefined;
}): Tools {
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
	const dispatch: ToolDispatch = (name, input, options) => {
		const raw = tools[name];
		const execute = raw === undefined || isHosted(raw) ? undefined : raw.execute.bind(raw);
		if (execute === undefined) throw new Error(`tool ${name} has no execute`);
		checkAuthority();
		if (journalFault?.current !== undefined) throw journalFault.current;
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
			note(() => journal.noteToolDispatch(runId, options.toolCallId, name, input));
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
	const out: Tools = {};
	for (const [name, t] of Object.entries(tools)) {
		out[name] =
			isHosted(t)
				? t
				: {
						...t,
						execute: (input: unknown, options: ToolCallContext) =>
							dispatch(name, input, options),
					};
	}
	bindScriptDispatch(tools, dispatch);
	return out;
}

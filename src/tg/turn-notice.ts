import type { Api } from "grammy";
import { APP_ID_PREFIX } from "../conversation.ts";
import { log } from "../log.ts";
import type { TurnRun } from "../turn-journal.ts";
import { withTimeout } from "./deadline.ts";

export function sendInterruptedTurnNotices(
	api: Api,
	runs: readonly TurnRun[],
	operators: readonly number[],
	titleFor: (conversationId: string) => string | undefined,
): void {
	void Promise.allSettled(
		runs.flatMap((run) => {
			// The notice lands in the operator DM, but /resume resolves against
			// the conversation the command arrives in — say where to send it.
			// App lanes are unreachable from Telegram; only the app surfaces
			// them (its /interrupted route).
			const resumeHow = run.conversationId.startsWith(APP_ID_PREFIX)
				? "open that conversation in the app to resume it — Telegram /resume can't reach app lanes."
				: `resume explicitly with /resume ${run.runId.slice(0, 8)} sent in that conversation, not in this DM.`;
			const text =
				`interrupted turn ${run.runId.slice(0, 8)} — ` +
				`${titleFor(run.conversationId) ?? run.conversationId}, started ${new Date(run.startedMs).toISOString()}: ` +
				`${run.calls.completed} completed, ${run.calls.dispatched} dispatched (ambiguous), ` +
				`${run.calls.resolved} decided, ${run.calls.planned} planned tool call(s). ` +
				`The turn was not replayed — ${resumeHow}`;
			return operators.map(async (chat) => {
				try {
					await withTimeout(api.sendMessage(chat, text), "sendMessage (interrupted turn notice)");
					log.info("interrupted turn notice sent", {
						run: run.runId,
						conversation: run.conversationId,
						chat,
						started: new Date(run.startedMs).toISOString(),
						calls: run.calls,
					});
				} catch (err) {
					log.error("interrupted turn notice send failed", err, {
						run: run.runId,
						conversation: run.conversationId,
						chat,
					});
				}
			});
		}),
	);
}

// Durable wake ownership (wake-dispatcher.ts): the composition's window
// into which journal run processes which submitted message.

export interface RunOwnershipHooks {
	/** `begin` fires after the run row exists and before the stream can
	 *  reach a tool — the admitted members' durable event seqs plus the
	 *  run rows this attempt continues (explicit resume) or inherits
	 *  (overflow). `members` fires when a steered submit joins the
	 *  membership mid-run. `end` fires at the run's terminal journal
	 *  stamp. Membership is named by event seq, never by client message
	 *  id — ids are untrusted and may repeat across events, so an id
	 *  match could hand a wake to a run that never processed it. Only
	 *  meaningful when a turn journal exists; hooks must not throw (they
	 *  observe the turn, they never gate it). */
	begin(event: {
		runId: string;
		conversationId: string;
		memberSeqs: number[];
		resumedFrom?: string;
		inheritFrom?: string[];
	}): void;
	members(runId: string, conversationId: string, memberSeqs: number[]): void;
	end(
		runId: string,
		status: "fenced" | "completed" | "error",
		delivery: "delivered" | "undelivered" | "failed",
	): void;
	/** The attempt died before `begin` could link its members — no run
	 *  row exists for reconcile to read, so the attempt's terminal
	 *  outcome is otherwise invisible to ownership. Fired on every
	 *  pre-run terminal path (a refused admission, an overflow that
	 *  will NOT resume — a resuming attempt's fresh run links
	 *  normally). Hooks must not throw, like the rest. */
	preRunFailure?(event: { conversationId: string; memberSeqs: number[]; error: string }): void;
}

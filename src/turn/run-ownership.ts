
export interface RunOwnershipHooks {
	begin(event: {
		runId: string;
		conversationId: string;
		memberSeqs: number[];
		inheritFrom?: string[];
	}): void;
	members(runId: string, conversationId: string, memberSeqs: number[]): void;
	end(
		runId: string,
		status: "fenced" | "completed" | "error",
		delivery: "delivered" | "undelivered" | "failed",
	): void;
	preRunFailure?(event: { conversationId: string; memberSeqs: number[]; error: string }): void;
}

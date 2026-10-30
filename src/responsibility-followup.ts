import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Program } from "./programs.ts";

// A safety net, not an inference heartbeat. Known commitments replace
// this default; meaningful developments move only the silence backstop.
export const SILENCE_LIMIT_MS = 60 * 60_000;
export const followupCommitmentSchema = z.strictObject({
	dueAt: z.iso.datetime({ offset: true }),
	reason: z.string().trim().min(1).max(2000),
});
export const followupSchema = followupCommitmentSchema.extend({
	token: z.string().min(1),
	kind: z.enum(["commitment", "silence"]),
});
export type ResponsibilityFollowup = z.infer<typeof followupSchema>;

export function silenceFollowup(at: Date): ResponsibilityFollowup {
	return {
		token: randomUUID(),
		kind: "silence",
		dueAt: new Date(at.getTime() + SILENCE_LIMIT_MS).toISOString(),
		reason: "Silence limit: assess progress and verify that the next action has not stalled.",
	};
}

export function isFollowupProgram(program: Program): boolean {
	return program.kind === "followup" || program.name === `followup:${program.responsibilityId}`;
}

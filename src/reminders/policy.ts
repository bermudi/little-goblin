// Reminds the operator that handed-over work still waits on them. Plain
// code and a push, never a model call: the silence backstop stays held
// (design/programs.md → Reports and stages). The ordinal is derived from
// the latest report's age, so nothing here needs its own stored state,
// and a report or correction that changes the stage ends the series.

import type { PromptOperation, Responsibility } from "../responsibility-types.ts";
import type { ResponsibilityReport } from "../responsibility-reports.ts";
import { responsibilityStage, type StageName } from "../responsibility-stage.ts";

export const REMINDER_FIRST_MS = 4 * 60 * 60_000;
export const REMINDER_EVERY_MS = 24 * 60 * 60_000;

export interface OperatorReminder {
	/** Durable identity of one send: one report, one step of the series. */
	key: string;
	/** Stable across steps: a newer step replaces an older undelivered one. */
	series: string;
	responsibilityId: string;
	conversationId: string;
	stage: StageName;
}

const REMINDER_TEXT: Partial<Record<StageName, string>> = {
	question: "A question is still waiting for you",
	review: "Work is still waiting for your review",
	blocked: "Blocked work is still waiting for you",
	failed: "Failed work is still waiting for you",
};

export function reminderText(stage: StageName): string {
	return REMINDER_TEXT[stage] ?? "Work is still waiting for you";
}

export function dueReminder(
	resp: Pick<
		Responsibility,
		"responsibilityId" | "coordinationConversationId" | "status" | "revision"
	>,
	latest: ResponsibilityReport | null,
	operations: readonly Pick<PromptOperation, "operationId" | "state">[],
	now: Date,
): OperatorReminder | null {
	// A pause is the operator's own choice, not an unanswered request.
	if (resp.status !== "active" || latest === null) return null;
	const stage = responsibilityStage(resp, latest, operations);
	if (stage.waitsFor !== "operator") return null;
	const elapsed = now.getTime() - Date.parse(latest.createdAt);
	if (elapsed < REMINDER_FIRST_MS) return null;
	// Only the newest step: downtime coalesces instead of ringing a backlog.
	const step = 1 + Math.floor((elapsed - REMINDER_FIRST_MS) / REMINDER_EVERY_MS);
	return {
		key: `reminder:${resp.responsibilityId}:${latest.reportId}:${step}`,
		series: `reminder:${resp.responsibilityId}`,
		responsibilityId: resp.responsibilityId,
		conversationId: resp.coordinationConversationId,
		stage: stage.stage,
	};
}

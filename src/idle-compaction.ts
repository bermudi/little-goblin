import type { IdleCacheCall } from "./cache-observation.ts";
import { channelOf } from "./conversation-address.ts";
import { log } from "./log.ts";
import { after, type Timer } from "./timing.ts";

export const IDLE_FOLD_LEAD_MS = 2 * 60_000;
export const IDLE_FOLD_MIN_TOKENS = 100_000;

export function idleFoldPlan(input: {
	conversationId: string;
	call: IdleCacheCall | null;
	lastFoldMs: number | null;
	nowMs: number;
}):
	| { kind: "arm"; callId: string; fireAtMs: number; expiresAtMs: number }
	| { kind: "skip"; reason: string } {
	if (channelOf(input.conversationId) !== "app") return { kind: "skip", reason: "not app" };
	if (input.call === null) return { kind: "skip", reason: "no completed call" };
	if (input.call.ttlMs === null) return { kind: "skip", reason: "no cache lifetime reported" };
	if (input.call.inputTokens === null || input.call.inputTokens < IDLE_FOLD_MIN_TOKENS) {
		return { kind: "skip", reason: "below token minimum" };
	}
	if (input.lastFoldMs !== null && input.lastFoldMs >= input.call.startedMs) {
		return { kind: "skip", reason: "fold already ran after call" };
	}
	const expiresAtMs = input.call.startedMs + input.call.ttlMs;
	if (input.nowMs >= expiresAtMs) return { kind: "skip", reason: "cache already expired" };
	return {
		kind: "arm",
		callId: input.call.callId,
		fireAtMs: Math.max(input.nowMs, expiresAtMs - IDLE_FOLD_LEAD_MS),
		expiresAtMs,
	};
}

export interface IdleCompactorDeps {
	call(conversationId: string): IdleCacheCall | null;
	lastFoldMs(conversationId: string): number | null;
	recentConversations(sinceMs: number): string[];
	fold(conversationId: string): Promise<"compacted" | "noop" | "busy" | "gone">;
	now(): number;
	setTimer(callback: () => void, delayMs: number): Timer;
}

export function createIdleCompactor(
	deps: Omit<IdleCompactorDeps, "setTimer"> &
		Partial<Pick<IdleCompactorDeps, "setTimer">>,
): { arm(conversationId: string): void; armAll(): void; stop(): void } {
	const setTimer = deps.setTimer ?? ((callback, delay) =>
		after(delay, "idle compaction", callback, { unref: true }));
	const timers = new Map<string, Timer>();
	const planFor = (conversationId: string) =>
		idleFoldPlan({
			conversationId,
			call: deps.call(conversationId),
			lastFoldMs: deps.lastFoldMs(conversationId),
			nowMs: deps.now(),
		});
	const clear = (conversationId: string): void => {
		const timer = timers.get(conversationId);
		if (timer !== undefined) timer.cancel();
		timers.delete(conversationId);
	};
	const arm = (conversationId: string): void => {
		clear(conversationId);
		const call = deps.call(conversationId);
		const plan = idleFoldPlan({
			conversationId,
			call,
			lastFoldMs: deps.lastFoldMs(conversationId),
			nowMs: deps.now(),
		});
		if (plan.kind === "skip") {
			log.info("idle fold skipped", { conversationId, reason: plan.reason });
			return;
		}
		log.info("idle fold armed", {
			conversationId,
			callId: plan.callId,
			fireAtMs: plan.fireAtMs,
			expiresAtMs: plan.expiresAtMs,
			ttlMs: call?.ttlMs ?? null,
			inputTokens: call?.inputTokens ?? null,
		});
		const timer = setTimer(() => {
			timers.delete(conversationId);
			let current: ReturnType<typeof idleFoldPlan>;
			try {
				current = planFor(conversationId);
			} catch (error) {
				log.error("idle fold plan failed", error, { conversationId });
				return;
			}
			if (current.kind !== "arm" || current.callId !== plan.callId) {
				log.info("idle fold skipped", {
					conversationId,
					reason: current.kind === "skip" ? current.reason : "newer call",
				});
				return;
			}
			void deps.fold(conversationId).then(
				(outcome) => log.info("idle fold ran", { conversationId, outcome }),
				(error: unknown) => log.warn("idle fold failed", error, { conversationId }),
			);
		}, Math.max(0, plan.fireAtMs - deps.now()));
		timers.set(conversationId, timer);
	};
	return {
		arm,
		armAll() {
			for (const id of deps.recentConversations(deps.now() - 3_600_000)) arm(id);
		},
		stop() {
			for (const timer of timers.values()) timer.cancel();
			timers.clear();
		},
	};
}

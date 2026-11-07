import { expect, test } from "bun:test";
import type { OperatorStatusResponse } from "../../src/http/operator-wire.ts";
import { statusParts, statusVerdict } from "./StatusView.tsx";

function status(over: Partial<OperatorStatusResponse["memory"]>, hints: string[] = []) {
	return {
		version: "1",
		startedAt: "2026-11-07T00:00:00Z",
		uptimeSec: 100,
		restartHints: hints,
		memory: {
			state: "healthy",
			deleting: 0,
			detail: "ok",
			completed: 3,
			blocked: 0,
			dismissed: 0,
			queued: 0,
			lastRecallAt: null,
			lastRecallOk: true,
			topicNote: null,
			blockedDetail: [],
			lastSaveAt: null,
			blockedConversations: [],
			blockedCauses: [],
			retry: null,
			...over,
		},
		programs: { total: 2, enabled: 1 },
		delegations: null,
	} satisfies OperatorStatusResponse;
}

const verdict = (s: OperatorStatusResponse) => statusVerdict(statusParts(s));

test("healthy, off and draining memory are OK", () => {
	expect(verdict(status({})).title).toBe("Goblin is OK");
	expect(verdict(status({ state: "disabled" })).title).toBe("Goblin is OK");
	expect(verdict(status({ state: "pending", queued: 2 })).title).toBe("Goblin is OK");
});

test("blocked memory or a restart hint needs attention", () => {
	const blocked = status({ state: "degraded", blocked: 1, detail: "1 blocked" });
	expect(verdict(blocked)).toEqual({ tone: "warn", title: "1 thing needs attention" });
	expect(verdict(status({}, ["model"])).tone).toBe("warn");
	expect(verdict(status({ state: "degraded", blocked: 1 }, ["model"])).title).toBe(
		"2 things need attention",
	);
});

test("failing recall is broken; count-only parts say no signal", () => {
	const s = status({ state: "degraded", lastRecallOk: false, detail: "recall failed" });
	expect(verdict(s).title).toBe("Something is broken");
	const pills = statusParts(s).filter((p) => p.name !== "Memory" && p.name !== "Service");
	expect(pills.map((p) => p.pill)).toEqual(["no signal", "no signal"]);
});

import { describe, expect, test } from "bun:test";
import {
	INJECTION_QUESTIONS,
	DEFAULT_INJECTION_THRESHOLDS,
	checkInjection,
	verdictLine,
	type InjectionThresholds,
} from "./injection.ts";
import { JevError, type JevClient } from "./jev.ts";

// Fake the gate at the edge: scripted answers, or a thrown error.
function fakeGate(answersOrError: Record<string, number> | Error): Pick<JevClient, "decide"> {
	return {
		decide: async () => {
			if (answersOrError instanceof Error) throw answersOrError;
			return { answers: { ...answersOrError }, inputTokens: null, cost: null };
		},
	};
}

const verdict = (injection: number, severity = 0.1): Record<string, number> => ({ injection, severity });

describe("checkInjection", () => {
	test("maps clean/suspicious/malicious at custom thresholds", async () => {
		const thresholds: InjectionThresholds = { flag: 0.8, warn: 0.5 };
		const clean = await checkInjection(fakeGate(verdict(0.1)), "hello", { thresholds });
		expect(clean.status).toBe("clean");
		expect(clean.injection).toBe(0.1);
		const suspicious = await checkInjection(fakeGate(verdict(0.6)), "hello", { thresholds });
		expect(suspicious.status).toBe("suspicious");
		const malicious = await checkInjection(fakeGate(verdict(0.9)), "hello", { thresholds });
		expect(malicious.status).toBe("malicious");
		expect(malicious.severity).toBe(0.1);
	});

	test("default thresholds: 0.7 → malicious, 0.3 → suspicious, 0.299 → clean", async () => {
		expect(DEFAULT_INJECTION_THRESHOLDS).toEqual({ flag: 0.7, warn: 0.3 });
		expect((await checkInjection(fakeGate(verdict(0.7)), "t")).status).toBe("malicious");
		expect((await checkInjection(fakeGate(verdict(0.3)), "t")).status).toBe("suspicious");
		expect((await checkInjection(fakeGate(verdict(0.299)), "t")).status).toBe("clean");
	});

	test("unavailable on every JevError kind, with null probabilities", async () => {
		const kinds: Error[] = [
			new JevError("http", 500),
			new JevError("transport"),
			new JevError("timeout"),
			new JevError("protocol"),
			new JevError("auth"),
		];
		for (const err of kinds) {
			const v = await checkInjection(fakeGate(err), "t");
			expect(v.status).toBe("unavailable");
			expect(v.injection).toBeNull();
			expect(v.severity).toBeNull();
		}
	});

	test("missing answer keys default to 0 (clean)", async () => {
		const v = await checkInjection(fakeGate({}), "t");
		expect(v.status).toBe("clean");
		expect(v.injection).toBe(0);
		expect(v.severity).toBe(0);
	});

	test("non-JevError propagates", async () => {
		await expect(checkInjection(fakeGate(new Error("bug")), "t")).rejects.toThrow("bug");
	});

	test("truncates to maxChars (head-cut) before calling the gate", async () => {
		let seen = "";
		const gate: Pick<JevClient, "decide"> = {
			decide: async (state: unknown) => {
				seen = state as string;
				return { answers: { injection: 0, severity: 0 }, inputTokens: null, cost: null };
			},
		};
		await checkInjection(gate, "x".repeat(9000), { maxChars: 100 });
		expect(seen.length).toBeLessThanOrEqual(100);
		expect(seen).toBe("x".repeat(100));
	});
});

describe("verdictLine", () => {
	test("formats clean/suspicious/malicious with two decimals", () => {
		expect(verdictLine({ status: "clean", injection: 0.02, severity: 0.01, ms: 1 })).toBe(
			"[injection check: clean p=0.02 sev=0.01]",
		);
		expect(verdictLine({ status: "suspicious", injection: 0.45, severity: 0.2, ms: 1 })).toBe(
			"[injection check: suspicious p=0.45 sev=0.20]",
		);
		expect(verdictLine({ status: "malicious", injection: 0.91, severity: 0.88, ms: 1 })).toBe(
			"[injection check: malicious p=0.91 sev=0.88]",
		);
	});

	test("unavailable has its own string", () => {
		expect(verdictLine({ status: "unavailable", injection: null, severity: null, ms: 1 })).toBe(
			"[injection check unavailable]",
		);
	});
});

describe("INJECTION_QUESTIONS", () => {
	test("has injection + severity, both noul with non-empty criteria", () => {
		expect(Object.keys(INJECTION_QUESTIONS).sort()).toEqual(["injection", "severity"]);
		for (const q of Object.values(INJECTION_QUESTIONS)) {
			expect(q.type).toBe("noul");
			expect(q.instructions.length).toBeGreaterThan(0);
			expect(q.criteria.true.length).toBeGreaterThan(0);
			expect(q.criteria.false.length).toBeGreaterThan(0);
		}
	});
});

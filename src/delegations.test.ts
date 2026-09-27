// The delegation store's name contract: agent names must land in
// herdr's agent-name charset ([a-z][a-z0-9_-]{0,31}) regardless of
// what the operator or model put in the delegation name.

import { describe, expect, test } from "bun:test";
import { agentNameFor } from "./delegations.ts";

describe("agentNameFor", () => {
	test("slugifies into herdr's name charset, capped at 32", () => {
		expect(agentNameFor(3, "Fix the THING!!")).toBe("g3-fix-the-thing");
		expect(agentNameFor(12, "résumé — unicode ✨")).toMatch(/^g12-[a-z0-9_-]+$/);
		expect(agentNameFor(9, "x".repeat(60)).length).toBeLessThanOrEqual(32);
		expect(agentNameFor(4, "!!!")).toBe("g4-delegation");
	});
});

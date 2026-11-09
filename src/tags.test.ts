// The tag codec's invariants: constructor ∘ predicate round-trips,
// exact spellings (memory and the model read these strings), and
// near-misses rejected — a typo in one site must fail here, not
// silently change what reaches memory.
import { describe, expect, test } from "bun:test";
import {
	compactionSummaryId,
	corruptRowId,
	delegationNoticeTag,
	isMachineryText,
	memoryBlockId,
	programFireTag,
	subagentNoticeTag,
} from "./tags.ts";

describe("message tags", () => {
	test("program fire headers are exact and read back as machinery", () => {
		expect(programFireTag("morning brief", "schedule")).toBe(
			"[program: morning brief · trigger: schedule]",
		);
		expect(programFireTag("ci", "webhook")).toBe("[program: ci · trigger: webhook]");
		expect(isMachineryText(programFireTag("bank watch", "mail"))).toBe(true);
	});

	test("delegation notice headers are exact and read back as machinery", () => {
		expect(delegationNoticeTag(7, "fix it", "done")).toBe("[delegation: #7 fix it · done]");
		expect(delegationNoticeTag(7, "stuck", "needs input", "waiting on you")).toBe(
			"[delegation: #7 stuck · needs input] waiting on you",
		);
		expect(delegationNoticeTag(0, "orphan", "failed")).toBe("[delegation: #0 orphan · failed]");
		expect(isMachineryText(delegationNoticeTag(7, "fix it", "done"))).toBe(true);
	});

	test("the pre-cutover scheduled prefix is operator speech again (W2.2 purge)", () => {
		expect(isMachineryText("[scheduled: old job]\ndo it")).toBe(false);
	});

	test("operator speech and near-misses are not machinery", () => {
		for (const text of [
			"", // empty burst text never matches
			"[program:", // missing space
			"[program ", // missing colon
			"[programmer: looks like one]",
			"text [program: fake]", // matching is anchored at the start
			"[delegation:",
			"[Delegation: case matters]",
		]) {
			expect(isMachineryText(text)).toBe(false);
		}
	});

	// The id is a legibility label only (#206): no predicate matches on it,
	// so the exact spelling is all there is to pin.
	test("compaction summary ids build exactly", () => {
		expect(compactionSummaryId(2)).toBe("compact-2");
		expect(compactionSummaryId(1234)).toBe("compact-1234");
	});

	test("synthetic block and placeholder ids are unique per anchor/seq", () => {
		expect(memoryBlockId(5)).toBe("memory-5");
		expect(memoryBlockId(5)).not.toBe(memoryBlockId(6));
		expect(corruptRowId(9)).toBe("corrupt-9");
		expect(corruptRowId(9)).not.toBe(corruptRowId(10));
	});
});

describe("subagentNoticeTag", () => {
	test("shares the delegation shape and counts as machinery speech", () => {
		expect(subagentNoticeTag(3, "worker", "done")).toBe("[subagent: #3 worker · done]");
		expect(subagentNoticeTag(3, "worker", "needs_input")).toBe(
			"[subagent: #3 worker · needs input]",
		);
		expect(isMachineryText(subagentNoticeTag(3, "worker", "done"))).toBe(true);
	});
});

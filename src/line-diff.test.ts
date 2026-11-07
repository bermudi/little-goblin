import { expect, test } from "bun:test";
import { diffLines } from "./line-diff.ts";

test("identical text has no hunks", () => {
	expect(diffLines("a\nb\n", "a\nb\n")).toEqual([]);
});

test("a changed line shows as one removal and one addition inside its context", () => {
	expect(diffLines("a\nb\nc\n", "a\nB\nc\n")).toEqual([
		{ op: "ctx", text: "a" },
		{ op: "del", text: "b" },
		{ op: "add", text: "B" },
		{ op: "ctx", text: "c" },
	]);
});

test("distant changes become separate hunks with a gap between them", () => {
	const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
	const after = before.replace("l1\n", "L1\n").replace("l18\n", "L18\n");
	const lines = diffLines(before, after, 1);
	expect(lines.filter((l) => l.op === "gap")).toEqual([{ op: "gap", skipped: 14 }]);
	expect(lines.filter((l) => l.op === "add").map((l) => (l as { text: string }).text)).toEqual([
		"L1",
		"L18",
	]);
});

test("insertions and deletions in the middle keep the unchanged lines as context", () => {
	const out = diffLines("a\nb\nc\nd", "a\nc\nd\ne");
	expect(out.filter((l) => l.op === "del")).toEqual([{ op: "del", text: "b" }]);
	expect(out.filter((l) => l.op === "add")).toEqual([{ op: "add", text: "e" }]);
});

test("empty before is all additions; empty after is all removals", () => {
	expect(diffLines("", "x\ny")).toEqual([
		{ op: "add", text: "x" },
		{ op: "add", text: "y" },
	]);
	expect(diffLines("x\ny", "")).toEqual([
		{ op: "del", text: "x" },
		{ op: "del", text: "y" },
	]);
});

test("a very large replacement still returns, as remove-all then add-all", () => {
	const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join("\n");
	const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join("\n");
	const out = diffLines(a, b);
	expect(out.filter((l) => l.op === "del").length).toBe(3000);
	expect(out.filter((l) => l.op === "add").length).toBe(3000);
});

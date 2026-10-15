import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spillFile, truncateTail, windowText } from "./truncate.ts";

describe("windowText", () => {
	test("under budget passes through untruncated", () => {
		expect(windowText("short", 100)).toEqual({ window: "short", truncated: false });
	});

	test("cuts on line boundaries with a visible elision", () => {
		const text = Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n");
		const { window, truncated } = windowText(text, 400);
		expect(truncated).toBe(true);
		expect(window).toContain("line-0");
		expect(window).toContain("line-99");
		expect(window).toContain("[…]");
		expect(window).not.toContain("line-50\n");
	});

	test.each([0.75, 0.25])(
		"retains a long line's tail before its terminating newline (head share %p)",
		(headShare) => {
			const text = `${"x".repeat(20_000)}FINAL_STATUS\n`;
			const { window, truncated } = windowText(text, 15_000, headShare);
			expect(truncated).toBe(true);
			const tail = window.split("\n\n[…]\n\n")[1]!;
			expect(tail).toBe(text.slice(-(15_000 - Math.round(15_000 * headShare))));
			expect(tail).toEndWith("FINAL_STATUS\n");
		},
	);

	test("an explicit 0.75 headShare renders identically to the default", () => {
		const text = Array.from({ length: 200 }, (_, i) => `row-${String(i).padStart(4, "0")}`).join(
			"\n",
		);
		expect(windowText(text, 400)).toEqual(windowText(text, 400, 0.75));
	});

	test("a tail-heavy headShare keeps a short head and a long tail — bash's split", () => {
		const text = Array.from({ length: 200 }, (_, i) => `row-${String(i).padStart(4, "0")}`).join(
			"\n",
		);
		const { window, truncated } = windowText(text, 400, 0.25);
		expect(truncated).toBe(true);
		const [head, tail] = window.split("\n\n[…]\n\n");
		// ~25% head: the first rows survive, cut on a line boundary.
		expect(head).toBe(text.slice(0, text.lastIndexOf("\n", 100)));
		expect(head!.endsWith("row-0010")).toBe(true);
		expect(head!.length).toBeLessThan(120);
		// The tail carries the rest of the budget, whole lines only.
		expect(tail).toContain("row-0199");
		expect(text.endsWith(`\n${tail}`)).toBe(true);
		expect(window).not.toContain("row-0100\n");
	});
});

describe("spillFile", () => {
	test("content-addressed: same body lands the same path holding the body", () => {
		const dir = mkdtempSync(join(tmpdir(), "goblin-spill-"));
		try {
			const body = "the full output\nwith several lines\n";
			const cache = join(dir, "cache");
			const a = spillFile(cache, body);
			const b = spillFile(cache, body);
			expect(a).toBe(b);
			expect(a.startsWith(`${cache}/`)).toBe(true);
			expect(a.endsWith(".txt")).toBe(true);
			expect(readFileSync(a, "utf8")).toBe(body);
			// A different body addresses a different file.
			expect(spillFile(cache, "other")).not.toBe(a);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("truncateTail", () => {
	test("under-cap input passes through unchanged", () => {
		const text = "one\ntwo\nthree\n";
		const r = truncateTail(text, 1024);
		expect(r).toEqual({ content: text, truncated: false, droppedBytes: 0 });
	});

	test("over-cap multi-line input keeps only complete lines from the end", () => {
		const lines = Array.from({ length: 100 }, (_, i) => `line-${String(i).padStart(3, "0")}`);
		const text = lines.join("\n");
		const cap = 16 * 12; // room for ~16 lines
		const r = truncateTail(text, cap);
		expect(r.truncated).toBe(true);
		expect(r.droppedBytes).toBeGreaterThan(0);
		const outLines = r.content.split("\n");
		// First line is the notice; every subsequent line must be a whole
		// input line, and the tail must be contiguous with the input's end.
		expect(outLines[0]).toMatch(/^\[… \d+ bytes of earlier output skipped — showing the tail\]$/);
		const keptLines = outLines.slice(1);
		const last = keptLines[keptLines.length - 1] ?? "";
		expect(last).toBe("line-099");
		expect(keptLines.length).toBeLessThan(100);
		expect(Buffer.byteLength(keptLines.join("\n"), "utf-8")).toBeLessThanOrEqual(cap);
		// No partial first content line.
		expect(lines).toContain(keptLines[0] ?? "");
	});

	test("a single line larger than the cap returns its last bytes at a UTF-8 boundary", () => {
		// 🎉 is 4 bytes each; 100 of them = 400 bytes, cap = 50 → boundary
		// must land on a character start, never mid-surrogate.
		const text = "🎉".repeat(100);
		const r = truncateTail(text, 50);
		expect(r.truncated).toBe(true);
		const keptLine = r.content.split("\n")[1] ?? "";
		// droppedBytes counts input bytes only — the … marker is not input.
		expect(r.droppedBytes).toBe(400 - Buffer.byteLength(keptLine.slice(1), "utf-8"));
		const kept = r.content.split("\n")[1] ?? "";
		// Decodes cleanly: round-trips as whole emoji, no replacement chars.
		// (Leading … marks the mid-line fragment start.)
		expect(kept).not.toContain("\ufffd");
		expect([...kept.slice(1)].every((c) => c === "🎉")).toBe(true);
		expect(Buffer.byteLength(kept.slice(1), "utf-8")).toBeLessThanOrEqual(50); // input bytes; the … marker is free
		expect(Buffer.byteLength(kept, "utf-8")).toBeGreaterThanOrEqual(48); // boundary walked < 4 bytes
	});

	test("empty input", () => {
		expect(truncateTail("", 10)).toEqual({ content: "", truncated: false, droppedBytes: 0 });
	});

	test("zero cap on non-empty input keeps nothing but the notice", () => {
		const r = truncateTail("hello", 0);
		expect(r.truncated).toBe(true);
		expect(r.droppedBytes).toBe(5);
		expect(r.content.endsWith("\nhello")).toBe(false);
	});

	test("a single line over the budget is kept as a marked fragment, never a fake whole line", () => {
		const r = truncateTail(`head of output here\n${"FRAGMENT_TAIL_" + "x".repeat(200)}`, 100);
		expect(r.truncated).toBe(true);
		const lines = r.content.split("\n");
		expect(lines[1]!.startsWith("…")).toBe(true); // mid-line start is marked
	});
});

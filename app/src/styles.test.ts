import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Fold-arrow invariant (regression 2026-10-19): the ▸/▾ content
// switchers lived on descendant selectors — `.worked[open] summary::before`
// — so an open Worked row restyled EVERY nested tool-run/Thought summary
// to the open arrow, whatever their own state. The switchers must pin the
// fold's own summary with a child combinator. Pseudo-element cascades
// aren't observable in happy-dom, so the test guards the stylesheet
// itself: every triangle rule must carry `> summary::before`.
const css = readFileSync(join(import.meta.dir, "styles.css"), "utf8");

const arrowRule = /([^{}\n]+summary::before)\s*\{[^}]*content:\s*"(▸|▾)"/g;

describe("fold arrow selectors", () => {
	test("every triangle rule targets the fold's own summary", () => {
		const offenders = [...css.matchAll(arrowRule)]
			.map(([, selector]) => selector ?? "")
			.map((selector) => selector.trim())
			.filter((selector) => !selector.includes("> summary::before"));
		expect(offenders).toEqual([]);
	});

	test("all three fold families switch both states", () => {
		const rules = [...css.matchAll(arrowRule)].map(([, selector, arrow]) => ({
			selector: (selector ?? "").trim(),
			arrow: arrow ?? "",
		}));
		for (const fold of ["worked", "tool-run", "reasoning-fold"]) {
			const closed = rules.find((r) => r.selector.startsWith(`.${fold} `) && r.arrow === "▸");
			const open = rules.find(
				(r) => r.selector.startsWith(`.${fold}[open]`) && r.arrow === "▾",
			);
			expect(closed, `.${fold} closed arrow`).toBeDefined();
			expect(open, `.${fold} open arrow`).toBeDefined();
		}
		// And nothing else flips triangles through summary::before.
		expect(rules.length).toBe(6);
	});
});

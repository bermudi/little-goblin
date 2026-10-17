// The refactor round's structural rules, executable — so the next split
// can't silently regress a boundary the way docs alone allowed. Seeded
// by the sabotage drill's grammy check (d79ace76,
// origin/arena/47e3f1e6-little-goblin); the three rules below pin this
// round's rulings:
//
//  1. grammy — only src/tg knows it (AGENTS.md guardrail). A type-only
//     import changes no runtime behavior, and the leak is invisible
//     until it isn't, so the boundary is checked statically: an import
//     of grammy outside src/tg is the wall coming down.
//  2. Pi packages — only src/subagents/ imports pi-durable, pi-ai or
//     chord (design/subagents.md: "Only src/subagents/ knows Pi Durable
//     / pi-ai / chord"). Deliberately not pi-codemode: the script tool's
//     QuickJS VM lives outside the rule.
//  3. src/http/mod.ts stays runtime-free — the serving layer reaches the
//     turn machinery only through injected opaque deps (the composition
//     root's appApi callback, HttpDeps). Naming ../runtime.ts would tie
//     the server to the harness, so every import form counts.
//  4. No non-test sibling imports its own directory's mod.ts — mod.ts is
//     the directory's face for outside consumers; siblings wire through
//     each other. Value imports only: `import type` is the sanctioned
//     cycle-breaker (app-sse.ts type-imports ../runtime.ts under the
//     same principle). The subagents test edges (the testing.ts rig, the
//     crash test's crash-child.ts, the podman test's kill.driver.ts) are
//     test-only per design/subagents.md → Files.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = import.meta.dir;

const GRAMMY_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*)["']grammy(?:\/[^"']*)?["']/;
const PI_IMPORT =
	/(?:\bfrom\s*|\bimport\s*\(\s*)["']@earendil-works\/(?:pi-durable|pi-ai|chord)(?:\/[^"']*)?["']/;
const RUNTIME_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*)["']\.\.\/runtime\.ts["']/;
const SIBLING_MOD_IMPORT =
	/(?:\bimport\b|\bexport\b)(?!\s*type\b)[^;]*from\s*["']\.\/mod\.ts["']|\bimport\s*\(\s*["']\.\/mod\.ts["']\s*\)/;

// Production modules only for the grammy scan: src/tg owns grammy, and
// the test-only edge fakes (testkit/fake-api.ts builds the Api stub) are
// not production.
const GRAMMY_EXEMPT_DIRS = new Set(["tg", "testkit"]);

// Test-only edges the design docs bless: the shared rigs the module
// maps own (design/subagents.md → Files, design/app.md → Files) — they
// build the family's real entry to fake at the edge — and the
// crash/podman tests' spawned child and driver processes.
const SIBLING_EXEMPT = new Set([
	"http/app-testing.ts",
	"subagents/crash-child.ts",
	"subagents/kill.driver.ts",
	"subagents/testing.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path, out);
		else if (entry.name.endsWith(".ts")) out.push(path);
	}
	return out;
}

function rel(file: string): string {
	return file.slice(SRC.length + 1);
}

describe("module boundaries", () => {
	test("grammy is imported only under src/tg", () => {
		const offenders = walk(SRC)
			.filter(
				(file) =>
					!rel(file)
						.split("/")
						.some((part) => GRAMMY_EXEMPT_DIRS.has(part)),
			)
			.filter((file) => !file.endsWith(".test.ts"))
			.filter((file) => GRAMMY_IMPORT.test(readFileSync(file, "utf8")))
			.map(rel);
		expect(offenders).toEqual([]);
	});

	test("pi-durable, pi-ai and chord are imported only under src/subagents", () => {
		const offenders = walk(SRC)
			.filter((file) => !rel(file).split("/").includes("subagents"))
			// This file carries the patterns; it names no package as an import.
			.filter((file) => rel(file) !== "module-boundaries.test.ts")
			.filter((file) => PI_IMPORT.test(readFileSync(file, "utf8")))
			.map(rel);
		expect(offenders).toEqual([]);
	});

	test("http/mod.ts stays runtime-free", () => {
		const source = readFileSync(join(SRC, "http", "mod.ts"), "utf8");
		expect(RUNTIME_IMPORT.test(source)).toBe(false);
	});

	test("no non-test sibling imports its own directory's mod.ts", () => {
		const offenders: string[] = [];
		for (const mod of walk(SRC).filter((file) => file.endsWith("/mod.ts"))) {
			const dir = mod.slice(0, -"/mod.ts".length);
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
				if (entry.name === "mod.ts" || entry.name.endsWith(".test.ts")) continue;
				const file = join(dir, entry.name);
				if (SIBLING_EXEMPT.has(rel(file))) continue;
				if (SIBLING_MOD_IMPORT.test(readFileSync(file, "utf8"))) offenders.push(rel(file));
			}
		}
		expect(offenders).toEqual([]);
	});
});

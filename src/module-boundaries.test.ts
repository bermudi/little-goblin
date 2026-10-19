//  1. grammy — only src/tg knows it; checked statically because a
//     type-only import leaks invisibly.
//  2. pi-durable/pi-ai/chord — only src/subagents/. Deliberately not
//     pi-codemode: the script tool's QuickJS VM lives outside the rule.
//  3. src/http/mod.ts stays runtime-free — naming ../runtime.ts ties the
//     server to the harness, so every import form counts.
//  4. No non-test sibling imports its own dir's mod.ts; `import type`
//     is the sanctioned cycle-breaker.
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

// testkit's fake-api.ts builds the Api stub — not production code.
const GRAMMY_EXEMPT_DIRS = new Set(["tg", "testkit"]);

// Test-only edges: shared rigs that build the family's real entry to
// fake at it, and the crash/podman tests' spawned child/driver processes.
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

// AGENTS.md guardrail: only src/tg/ knows grammy — domain modules never
// see a Telegram context object. The leak is invisible at runtime (a
// type-only import changes no behavior), so the boundary is checked
// statically: an import of grammy outside src/tg is the wall coming down.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = import.meta.dir;

const GRAMMY_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*)["']grammy(?:\/[^"']*)?["']/;

// Production modules only: src/tg owns grammy, and the test-only edge
// fakes (testkit/fake-api.ts builds the Api stub) are not production.
const EXEMPT_DIRS = new Set(["tg", "testkit", "test-helpers"]);

function productionFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (EXEMPT_DIRS.has(entry.name)) continue;
			productionFiles(join(dir, entry.name), out);
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
			out.push(join(dir, entry.name));
		}
	}
	return out;
}

describe("module boundaries", () => {
	test("grammy is imported only under src/tg", () => {
		const offenders = productionFiles(SRC)
			.filter((file) => GRAMMY_IMPORT.test(readFileSync(file, "utf8")))
			.map((file) => file.slice(SRC.length + 1));
		expect(offenders).toEqual([]);
	});
});

/**
 * Enforce that src/agent/** never imports from grammy or ../tg/.
 * The agent layer must remain Telegram-agnostic.
 */
import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const AGENT_DIR = join(import.meta.dir);

function walkTs(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      results.push(...walkTs(join(dir, entry.name)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      results.push(join(dir, entry.name));
    }
  }
  return results;
}

const FORBIDDEN = [/^grammy/, /^\.\.\/tg\//];

describe("agent boundary: no grammy or tg imports", () => {
  const files = walkTs(AGENT_DIR);

  it("finds at least one agent source file", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const rel = relative(AGENT_DIR, file);
    it(`${rel} has no forbidden imports`, () => {
      const src = readFileSync(file, "utf-8");
      const importLines = src
        .split("\n")
        .filter((line) => /^\s*import\b/.test(line));

      for (const line of importLines) {
        const match = line.match(/from\s+["']([^"']+)["']/);
        if (!match) continue;
        const specifier = match[1]!;
        for (const pattern of FORBIDDEN) {
          expect(
            pattern.test(specifier),
            `${rel}: forbidden import "${specifier}" matches ${pattern}`
          ).toBe(false);
        }
      }
    });
  }
});

import { describe, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const srcRoot = join(import.meta.dir, "..");
const allowedRelative = new Set(["sessions/types.ts", "sessions/surface-compat.ts", "sessions/surface-migration.ts"]);

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, files);
    } else if (full.endsWith(".ts") && !full.endsWith(".test.ts") && !full.endsWith(".d.ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("surface identity integrity", () => {
  it("does not use ChatLocator or locatorFromCtx outside migration files", () => {
    const failures: string[] = [];
    const allowed = new Set([...allowedRelative].map((rel) => join(srcRoot, rel)));

    for (const file of walk(srcRoot)) {
      if (allowed.has(file)) continue;
      const content = readFileSync(file, "utf8");
      if (content.includes("ChatLocator")) {
        failures.push(`${file}: ChatLocator`);
      }
      if (content.includes("locatorFromCtx")) {
        failures.push(`${file}: locatorFromCtx`);
      }
    }

    if (failures.length > 0) {
      throw new Error(`Banned legacy surface identifiers found in production code:\n${failures.join("\n")}`);
    }
  });
});

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";

/**
 * The subagent suites install a process-global pi module mock. Run this suite
 * in a child Bun process so it exercises the real SDK instead of whichever
 * mock happened to load first in the parent test process.
 */
describe("AgentRunner pi-ai contract", () => {
  it("runs against the real SDK in an isolated process", () => {
    const repoRoot = join(import.meta.dir, "../..");
    const suitePath = join(import.meta.dir, "contract.suite.ts");
    const suiteArg = `./${relative(repoRoot, suitePath)}`;
    const result = spawnSync(process.execPath, ["test", suiteArg, "--timeout", "30000"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    expect(result.status, output || "contract suite exited without output").toBe(0);
  });
});

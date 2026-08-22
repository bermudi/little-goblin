import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryDbPath } from "./memory/paths.ts";
import { pendingProjectAssignmentPath } from "./sessions/paths.ts";
import { CURRENT_STATE_VERSION, writeStateVersion } from "./state-version.ts";

describe("startup entry point", () => {
  it(
    "refuses old state before memory creation, reconciliation, scheduling, or polling and prints the remedy",
    () => {
      const home = mkdtempSync(join(tmpdir(), "goblin-startup-gate-"));
      const reconciliationSentinel = "startup must not parse this pending assignment";
      const testToken = "startup-test-token-must-not-be-logged";

      try {
        mkdirSync(join(home, "state"), { recursive: true });
        writeFileSync(
          join(home, "goblin.json5"),
          JSON.stringify({
            botToken: testToken,
            allowedUsers: [123456],
            model: "startup-test-model-that-must-not-be-validated",
            logLevel: "info",
          }),
        );
        writeStateVersion(home, CURRENT_STATE_VERSION - 1);
        writeFileSync(pendingProjectAssignmentPath(home), reconciliationSentinel);

        const result = spawnSync(process.execPath, [join(import.meta.dir, "index.ts")], {
          cwd: join(import.meta.dir, ".."),
          encoding: "utf-8",
          timeout: 15_000,
          env: {
            GOBLIN_HOME: home,
            HOME: home,
            PATH: process.env.PATH ?? "",
            NO_COLOR: "1",
          },
        });

        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("state version mismatch");
        expect(result.stderr).toContain("bun run migrate");
        expect(result.stderr).toContain(`"required":${CURRENT_STATE_VERSION}`);
        expect(`${result.stdout}${result.stderr}`).not.toContain(testToken);

        // MemoryEngine construction creates this file, while cold-start
        // reconciliation would try to parse the deliberately invalid sentinel.
        // Both remain untouched, so all later startup stages (including the
        // scheduler and Telegram polling) are unreachable in the real entrypoint.
        expect(existsSync(memoryDbPath(home))).toBe(false);
        expect(readFileSync(pendingProjectAssignmentPath(home), "utf-8")).toBe(
          reconciliationSentinel,
        );
        expect(result.stderr).not.toContain(reconciliationSentinel);
        expect(result.stderr).not.toContain("pending-project-assignment");
        expect(result.stderr).not.toContain("little-goblin starting");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    20_000,
  );
});

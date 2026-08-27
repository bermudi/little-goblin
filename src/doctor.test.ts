import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { CURRENT_STATE_VERSION, writeStateVersion } from "./state-version.ts";
import { memoryDbPath } from "./memory/paths.ts";
import { sessionsDir } from "./sessions/paths.ts";
import { ConversationStore } from "./sessions/conversation-store.ts";
import { personalEnvironment } from "./sessions/environment.ts";
import { agentsMdPath, soulMdPath } from "./workspace/paths.ts";
import "./doctor.ts";

const repoRoot = join(import.meta.dir, "..");

type SpawnEnv = Record<string, string | undefined>;

function buildConfigContent(): string {
  return `{
    botToken: "test-token",
    allowedUsers: [123456],
    model: "openai/gpt-5.4",
    openaiApiKey: "test-key",
    logLevel: "info",
    favorites: ["openai/gpt-5.4-mini"],
  }`;
}

function setupHealthyHome(): string {
  const home = mkdtempSync(join(tmpdir(), "goblin-doctor-healthy-"));

  mkdirSync(join(home, "workspace"), { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
  mkdirSync(join(home, "state", "memory"), { recursive: true });
  mkdirSync(join(home, "state", "sessions"), { recursive: true });
  mkdirSync(join(home, "scratch"), { recursive: true });

  writeStateVersion(home, CURRENT_STATE_VERSION);
  writeFileSync(join(home, "goblin.json5"), buildConfigContent());
  writeFileSync(soulMdPath(home), "# Test Goblin\n");
  writeFileSync(agentsMdPath(home), "## Test Agents\n");

  // Create a valid, empty memory database with the canonical schema.
  const db = new Database(memoryDbPath(home));
  db.close();

  // Create one active and one archived conversation.
  const store = new ConversationStore(home);
  const active = store.create(personalEnvironment());
  const toArchive = store.create(personalEnvironment());
  store.archive(toArchive.id);

  // Guard: active and archived directories must exist.
  if (!existsSync(join(sessionsDir(home), active.id))) {
    throw new Error("active conversation directory was not created");
  }
  if (!existsSync(join(sessionsDir(home), "archive", toArchive.id))) {
    throw new Error("archived conversation directory was not created");
  }

  return home;
}

function runDoctor(home: string, extraEnv: SpawnEnv = {}): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [join(import.meta.dir, "doctor.ts")], {
    cwd: repoRoot,
    encoding: "utf-8",
    timeout: 15_000,
    env: {
      GOBLIN_HOME: home,
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      NO_COLOR: "1",
      ...extraEnv,
    },
  });
}

describe("bun run doctor", () => {
  it(
    "exits 0 in a healthy GOBLIN_HOME and prints the required checks",
    () => {
      const home = setupHealthyHome();
      try {
        const result = runDoctor(home);

        const output = `${result.stdout}\n${result.stderr}`;

        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status).toBe(0);
        expect(output).toContain("state version");
        expect(output).toContain("memory");
        expect(output).toContain("config");
        expect(output).toContain("favorites");
        expect(output).toContain("prompt files");
        expect(output).toContain("disk");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it(
    "exits 1 and names the state version failure when state-version is mismatched",
    () => {
      const home = mkdtempSync(join(tmpdir(), "goblin-doctor-mismatch-"));
      try {
        mkdirSync(join(home, "workspace"), { recursive: true });
        mkdirSync(join(home, "state"), { recursive: true });
        mkdirSync(join(home, "state", "memory"), { recursive: true });
        mkdirSync(join(home, "state", "sessions"), { recursive: true });
        mkdirSync(join(home, "scratch"), { recursive: true });

        // Intentionally set an older state version so only this check fails.
        writeStateVersion(home, CURRENT_STATE_VERSION - 1);
        writeFileSync(join(home, "goblin.json5"), buildConfigContent());
        writeFileSync(soulMdPath(home), "# Test Goblin\n");
        writeFileSync(agentsMdPath(home), "## Test Agents\n");

        const db = new Database(memoryDbPath(home));
        db.close();

        const result = runDoctor(home);
        const output = `${result.stdout}\n${result.stderr}`;

        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status).toBe(1);
        expect(output).toContain("state version");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    20_000,
  );
});

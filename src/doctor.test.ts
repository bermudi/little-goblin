import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_STATE_VERSION, writeStateVersion } from "./state-version.ts";
import { MemoryDatabase } from "./memory/db.ts";
import { memoryDbPath } from "./memory/paths.ts";
import { archiveDir, sessionsDir } from "./sessions/paths.ts";
import { ConversationStore } from "./sessions/conversation-store.ts";
import { personalEnvironment } from "./sessions/environment.ts";
import { agentsMdPath, soulMdPath } from "./workspace/paths.ts";
import { runDoctor, type ConnectivityProbes } from "./doctor.ts";

interface TestDoctorResult {
  exitCode: number;
  lines: readonly string[];
}

const noopProbes: ConnectivityProbes = {
  checkTelegramToken: async () => {},
  checkModelProvider: async () => {},
  checkEdgeTtsAvailable: async () => {},
};

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
  const db = new MemoryDatabase(memoryDbPath(home));
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
  if (!existsSync(join(archiveDir(home), toArchive.id))) {
    throw new Error("archived conversation directory was not created");
  }

  return home;
}

async function callDoctor(
  home: string,
  opts?: { strict?: boolean; probes?: ConnectivityProbes },
): Promise<TestDoctorResult> {
  const previousHome = process.env.GOBLIN_HOME;
  try {
    process.env.GOBLIN_HOME = home;
    const result = await runDoctor(opts);
    return { exitCode: result.exitCode, lines: result.lines };
  } finally {
    if (previousHome === undefined) {
      delete process.env.GOBLIN_HOME;
    } else {
      process.env.GOBLIN_HOME = previousHome;
    }
  }
}

describe("bun run doctor", () => {
  it(
    "exits 0 in a healthy GOBLIN_HOME and prints the required checks",
    async () => {
      const home = setupHealthyHome();
      try {
        const result = await callDoctor(home, { probes: noopProbes });

        const output = result.lines.join("\n");

        expect(result.exitCode).toBe(0);
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
    async () => {
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

        const db = new MemoryDatabase(memoryDbPath(home));
        db.close();

        const result = await callDoctor(home, { probes: noopProbes });
        const output = result.lines.join("\n");

        expect(result.exitCode).toBe(1);
        expect(output).toContain("state version");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    20_000,
  );
});

describe("runDoctor connectivity", () => {
  it(
    "exits 0 in strict mode when all configured probes pass",
    async () => {
      const home = setupHealthyHome();
      try {
        const result = await callDoctor(home, {
          strict: true,
          probes: noopProbes,
        });

        expect(result.exitCode).toBe(0);
        const output = result.lines.join("\n");
        expect(output).toContain("Telegram");
        expect(output).toContain("model provider");
        expect(output).toContain("Edge TTS");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it(
    "exits 1 in strict mode when the model provider is unreachable",
    async () => {
      const home = setupHealthyHome();
      try {
        const result = await callDoctor(home, {
          strict: true,
          probes: {
            checkTelegramToken: async () => {},
            checkModelProvider: async () => {
              throw new Error("simulated model provider unreachable");
            },
            checkEdgeTtsAvailable: async () => {},
          },
        });

        expect(result.exitCode).toBe(1);
        const output = result.lines.join("\n");
        expect(output).toContain("model provider");
        expect(output).toContain("unreachable");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    20_000,
  );
});

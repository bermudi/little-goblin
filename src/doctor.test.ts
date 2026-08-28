import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CURRENT_STATE_VERSION, writeStateVersion } from "./state-version.ts";
import { MemoryDatabase } from "./memory/db.ts";
import { memoryDbPath, memoryDir } from "./memory/paths.ts";
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

interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run `bun run doctor` as a real subprocess with a hermetic environment.
 * Connectivity probes are controlled through GOBLIN_DOCTOR_PROBE_STUB
 * ("pass" | "fail") so no real network access is attempted.
 */
function runDoctorCli(
  home: string,
  args: readonly string[] = [],
  extraEnv: Record<string, string> = {},
): CliResult {
  const result = Bun.spawnSync({
    cmd: ["bun", "run", "doctor", ...args],
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      PATH: process.env.PATH ?? "",
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      GOBLIN_HOME: home,
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
  };
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
        expect(output).toContain("GOBLIN_HOME: pass");
        expect(output).toContain("conversations: pass");
        expect(output).toContain("config");
        expect(output).toContain("favorites");
        expect(output).toContain("prompt files");
        expect(output).toContain("disk");
        expect(output).toMatch(/\b0 failed\b/);
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

describe("doctor read-only behavior", () => {
  it(
    "leaves the memory directory file set unchanged after a doctor run",
    async () => {
      const home = setupHealthyHome();
      try {
        const dir = memoryDir(home);
        const before = readdirSync(dir).sort();

        await callDoctor(home, { probes: noopProbes });

        const after = readdirSync(dir).sort();
        expect(after).toEqual(before);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    20_000,
  );
});

describe("bun run doctor subprocess", () => {
  it(
    "exits 0 with the full report when every probe passes (stubbed)",
    () => {
      const home = setupHealthyHome();
      try {
        const res = runDoctorCli(home, ["--strict"], { GOBLIN_DOCTOR_PROBE_STUB: "pass" });

        expect(res.exitCode).toBe(0);
        expect(res.stdout).toContain("GOBLIN_HOME: pass");
        expect(res.stdout).toContain("conversations: pass");
        expect(res.stdout).toMatch(/0 failed \(strict\)/);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it(
    "exits 1 in strict mode and 0 otherwise when stubbed probes fail",
    () => {
      const home = setupHealthyHome();
      try {
        const strict = runDoctorCli(home, ["--strict"], { GOBLIN_DOCTOR_PROBE_STUB: "fail" });
        expect(strict.exitCode).toBe(1);
        expect(strict.stdout).toMatch(/failed \(strict\)/);

        const lax = runDoctorCli(home, [], { GOBLIN_DOCTOR_PROBE_STUB: "fail" });
        expect(lax.exitCode).toBe(0);
        expect(lax.stdout).toMatch(/warned/);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it(
    "exits 1 when the state version mismatches",
    () => {
      const home = setupHealthyHome();
      try {
        writeStateVersion(home, CURRENT_STATE_VERSION - 1);

        const res = runDoctorCli(home);

        expect(res.exitCode).toBe(1);
        expect(res.stdout).toContain("state version: fail");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CURRENT_STATE_VERSION, writeStateVersion } from "./state-version.ts";
import { MemoryDatabase, MemorySnapshot } from "./memory/db.ts";
import { memoryDbPath, memoryDir } from "./memory/paths.ts";
import { archiveDir, sessionsDir } from "./sessions/paths.ts";
import { ConversationStore } from "./sessions/conversation-store.ts";
import { personalEnvironment } from "./sessions/environment.ts";
import { agentsMdPath, soulMdPath } from "./workspace/paths.ts";
import { buildMcporterCommand } from "./mcp/runner.ts";
import { runDoctor, type ConnectivityProbes } from "./doctor.ts";
import JSON5 from "json5";

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

        // [L1] every required check reports its one-line detail.
        expect(output).toContain(
          `state version ${CURRENT_STATE_VERSION} matches expected ${CURRENT_STATE_VERSION}`,
        );
        expect(output).toContain(
          "subdirs: workspace, state, state/memory, state/sessions, scratch",
        );
        expect(output).toMatch(
          /memory: pass \(0 entries, budget \d+ \/ \d+ chars, embedding .+ \(.+\) ok, last sync never, db .+\)/,
        );
        expect(output).toContain("1 active, 1 archived");
        expect(output).toContain("default model openai/gpt-5.4 resolves to");
        expect(output).toContain("1 favorites resolve");
        expect(output).toContain("SOUL.md and AGENTS.md present");
        expect(output).toMatch(/disk: pass \(.+ free \/ .+ total on /);
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
    "leaves the memory directory file set and contents unchanged after a doctor run",
    async () => {
      const home = setupHealthyHome();
      try {
        const dir = memoryDir(home);
        const before = readdirSync(dir).sort();
        const beforeHashes = Object.fromEntries(
          before.map((f) => [
            f,
            createHash("sha256").update(readFileSync(join(dir, f))).digest("hex"),
          ]),
        );

        await callDoctor(home, { probes: noopProbes });

        const after = readdirSync(dir).sort();
        const afterHashes = Object.fromEntries(
          after.map((f) => [
            f,
            createHash("sha256").update(readFileSync(join(dir, f))).digest("hex"),
          ]),
        );
        expect(after).toEqual(before);
        expect(afterHashes).toEqual(beforeHashes);
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

        const res = runDoctorCli(home, [], { GOBLIN_DOCTOR_PROBE_STUB: "pass" });

        expect(res.exitCode).toBe(1);
        expect(res.stdout).toContain("state version: fail");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

describe("MCP gateway status connectivity probe", () => {
  it(
    "hermetic MCP gateway status probe records --status and --exit-code and preserves lax/strict exits",
    () => {
      const home = setupHealthyHome();
      const tmpBin = mkdtempSync(join(tmpdir(), "goblin-fake-mcporter-"));
      const argvPath = join(tmpBin, "gateway-argv");
      const fakeBunx = join(tmpBin, "bunx");
      const raw = JSON5.parse(buildConfigContent());
      raw.mcp = { configPath: "mcporter.json" };
      writeFileSync(join(home, "goblin.json5"), JSON5.stringify(raw, { space: 2 }));
      writeFileSync(
        fakeBunx,
        `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(argvPath)}
printf '%s\\n' 'tavily: unhealthy (gateway unavailable)' >&2
exit 1
`,
      );
      chmodSync(fakeBunx, 0o755);

      const extraEnv = {
        PATH: `${tmpBin}:${process.env.PATH ?? ""}`,
        GOBLIN_DOCTOR_PROBE_STUB: "pass-except-mcp",
      };
      const expectedArgv = [
        "--silent",
        "mcporter",
        "--log-level",
        "error",
        "--config",
        join(home, "mcporter.json"),
        "list",
        "--json",
        "--status",
        "--exit-code",
      ];

      try {
        const lax = runDoctorCli(home, [], extraEnv);
        expect(lax.exitCode).toBe(0);
        expect(lax.stdout).toContain("MCP servers: warn");
        expect(lax.stdout).toContain("tavily: unhealthy (gateway unavailable)");
        expect(readFileSync(argvPath, "utf8").trim().split("\n")).toEqual(expectedArgv);

        const strict = runDoctorCli(home, ["--strict"], extraEnv);
        expect(strict.exitCode).toBe(1);
        expect(strict.stdout).toContain("MCP servers: warn");
        expect(strict.stdout).toContain("tavily: unhealthy (gateway unavailable)");
        expect(readFileSync(argvPath, "utf8").trim().split("\n")).toEqual(expectedArgv);
      } finally {
        rmSync(tmpBin, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

describe("non-ENOENT filesystem error retention", () => {
  // chmod 000 on a directory leaves the directory itself statable but makes
  // every child path unstatable (EACCES), which is how a permission problem
  // reaches these checks. Skip under root, where permissions do not bind.
  const skipAsRoot = process.getuid?.() === 0;

  it.skipIf(skipAsRoot)(
    "fails prompt files with the underlying error when SOUL.md cannot be statted",
    async () => {
      const home = setupHealthyHome();
      try {
        chmodSync(join(home, "workspace"), 0o000);

        const result = await callDoctor(home, { probes: noopProbes });
        const line = result.lines.find((l) => l.startsWith("prompt files"));

        expect(result.exitCode).toBe(1);
        expect(line).toContain("prompt files: fail");
        expect(line).toContain("cannot stat SOUL.md");
        expect(line).toMatch(/permission denied/i);
      } finally {
        chmodSync(join(home, "workspace"), 0o755);
        rmSync(home, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it.skipIf(skipAsRoot)(
    "fails prompt files with the underlying error when AGENTS.md cannot be statted",
    async () => {
      const home = setupHealthyHome();
      try {
        // A self-referencing symlink makes stat fail with ELOOP (a non-ENOENT
        // error) for AGENTS.md only, while SOUL.md stays readable.
        rmSync(agentsMdPath(home));
        symlinkSync(agentsMdPath(home), agentsMdPath(home));

        const result = await callDoctor(home, { probes: noopProbes });
        const line = result.lines.find((l) => l.startsWith("prompt files"));

        expect(result.exitCode).toBe(1);
        expect(line).toContain("prompt files: fail");
        expect(line).toContain("cannot stat AGENTS.md");
        expect(line).toMatch(/too many symbolic links/i);
        expect(line).not.toContain("missing");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it.skipIf(skipAsRoot)(
    "fails GOBLIN_HOME with the underlying error when a required subdir cannot be statted",
    async () => {
      const home = setupHealthyHome();
      try {
        chmodSync(join(home, "state"), 0o000);

        const result = await callDoctor(home, { probes: noopProbes });
        const line = result.lines.find((l) => l.startsWith("GOBLIN_HOME"));

        expect(result.exitCode).toBe(1);
        expect(line).toContain("GOBLIN_HOME: fail");
        expect(line).toMatch(/state\/memory: .*permission denied/i);
        expect(line).not.toContain("state/memory is missing");
      } finally {
        chmodSync(join(home, "state"), 0o755);
        rmSync(home, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it.skipIf(skipAsRoot)(
    "fails conversations with the underlying error when an archived state file cannot be statted",
    async () => {
      const home = setupHealthyHome();
      const archive = archiveDir(home);
      const archivedIds = readdirSync(archive).filter((id) =>
        /^[0-9a-f]{10}$/.test(id),
      );
      expect(archivedIds.length).toBe(1);
      const archivedId = archivedIds[0]!;
      const archivedDir = join(archive, archivedId);
      try {
        chmodSync(archivedDir, 0o000);

        const result = await callDoctor(home, { probes: noopProbes });
        const line = result.lines.find((l) => l.startsWith("conversations"));

        expect(result.exitCode).toBe(1);
        expect(line).toContain("conversations: fail");
        expect(line).toContain(archivedId);
        expect(line).toMatch(/permission denied/i);
      } finally {
        chmodSync(archivedDir, 0o755);
        rmSync(home, { recursive: true, force: true });
      }
    },
    20_000,
  );
});

describe("prompt files classification", () => {
  it(
    "warns and exits 0 without --strict when optional AGENTS.md is missing",
    async () => {
      const home = setupHealthyHome();
      try {
        rmSync(agentsMdPath(home));

        const lax = await callDoctor(home, { probes: noopProbes });
        expect(lax.exitCode).toBe(0);
        expect(lax.lines.join("\n")).toContain("prompt files: warn");
        expect(lax.lines.join("\n")).toContain("AGENTS.md missing");

        const strict = await callDoctor(home, { strict: true, probes: noopProbes });
        expect(strict.exitCode).toBe(1);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it(
    "fails critically when mandatory SOUL.md is missing",
    async () => {
      const home = setupHealthyHome();
      try {
        rmSync(soulMdPath(home));

        const result = await callDoctor(home, { probes: noopProbes });
        expect(result.exitCode).toBe(1);
        expect(result.lines.join("\n")).toContain("prompt files: fail");
        expect(result.lines.join("\n")).toContain("SOUL.md missing");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    20_000,
  );
});

describe("connectivity probe timeout reporting", () => {
  it(
    "reports immediate exit 143 as a warning, not a timeout",
    async () => {
      const home = setupHealthyHome();
      const tmpBin = mkdtempSync(join(tmpdir(), "goblin-fake-uvx-"));
      const fakeUvx = join(tmpBin, "uvx");
      writeFileSync(fakeUvx, "#!/bin/sh\nexit 143\n");
      chmodSync(fakeUvx, 0o755);

      try {
        const result = runDoctorCli(home, ["--strict"], {
          PATH: `${tmpBin}:${process.env.PATH ?? ""}`,
        });

        expect(result.exitCode).toBe(1);
        expect(result.stdout).toContain("Edge TTS: warn");
        expect(result.stdout).not.toContain("Edge TTS: timeout");
      } finally {
        rmSync(tmpBin, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it(
    "reports a process that overruns the five-second deadline as a timeout",
    async () => {
      const home = setupHealthyHome();
      const tmpBin = mkdtempSync(join(tmpdir(), "goblin-fake-uvx-"));
      const fakeUvx = join(tmpBin, "uvx");
      writeFileSync(fakeUvx, "#!/bin/sh\nsleep 6\n");
      chmodSync(fakeUvx, 0o755);

      try {
        const result = runDoctorCli(home, ["--strict"], {
          PATH: `${tmpBin}:${process.env.PATH ?? ""}`,
        });

        expect(result.exitCode).toBe(1);
        expect(result.stdout).toContain("Edge TTS: timeout");
      } finally {
        rmSync(tmpBin, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it(
    "does not classify 'timeout' in a generic error message as a timeout",
    async () => {
      const home = setupHealthyHome();
      try {
        const result = await callDoctor(home, {
          probes: {
            checkTelegramToken: async () => {},
            checkModelProvider: async () => {},
            checkEdgeTtsAvailable: async () => {
              throw new Error("configuration timeout is disabled");
            },
          },
        });

        expect(result.exitCode).toBe(0);
        const edgeLine = result.lines.find((l) => l.startsWith("Edge TTS"));
        expect(edgeLine).toContain("Edge TTS: warn");
        expect(edgeLine).not.toContain("Edge TTS: timeout");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    20_000,
  );
});

describe("doctor memory WAL awareness", () => {
  it(
    "sees uncheckpointed writes while a writer keeps the WAL open",
    async () => {
      const home = setupHealthyHome();
      const db = new MemoryDatabase(memoryDbPath(home));
      try {
        const dir = memoryDir(home);

        const ts = Date.now();
        db.setMeta("last_transcript_sync", String(ts));

        const before = readdirSync(dir).sort();
        const beforeHashes = Object.fromEntries(
          before.map((f) => [
            f,
            createHash("sha256").update(readFileSync(join(dir, f))).digest("hex"),
          ]),
        );

        const result = await callDoctor(home, { probes: noopProbes });
        const after = readdirSync(dir).sort();
        const afterHashes = Object.fromEntries(
          after.map((f) => [
            f,
            createHash("sha256").update(readFileSync(join(dir, f))).digest("hex"),
          ]),
        );

        expect(result.exitCode).toBe(0);
        expect(result.lines.join("\n")).toContain(
          `last sync ${new Date(ts).toISOString()}`,
        );
        expect(after).toEqual(before);
        expect(afterHashes).toEqual(beforeHashes);
      } finally {
        db.close();
        rmSync(home, { recursive: true, force: true });
      }
    },
    20_000,
  );
});

describe("doctor memory schema validation", () => {
  it(
    "fails the memory check when the schema version is unsupported",
    async () => {
      const home = setupHealthyHome();
      const db = new MemoryDatabase(memoryDbPath(home));
      try {
        db.setMeta("schema_version", "999");
      } finally {
        db.close();
      }

      try {
        const result = await callDoctor(home, { probes: noopProbes });
        expect(result.exitCode).toBe(1);
        expect(result.lines.join("\n")).toContain("memory: fail");
        expect(result.lines.join("\n")).toContain("schema version 999");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    20_000,
  );
});

describe("mcp and external agent construction", () => {
  it(
    "builds the MCP list command with the same argv as McpRunner",
    () => {
      const cmd = buildMcporterCommand(["list", "--json"], "/tmp/mcporter.json");
      expect(cmd).toEqual([
        "bunx",
        "--silent",
        "mcporter",
        "--log-level",
        "error",
        "--config",
        "/tmp/mcporter.json",
        "list",
        "--json",
      ]);
    },
    20_000,
  );

  it(
    "runs external agent probes concurrently",
    async () => {
      const home = setupHealthyHome();
      const tmpBin = mkdtempSync(join(tmpdir(), "goblin-fake-backends-"));
      writeFileSync(join(tmpBin, "codex"), "#!/bin/sh\nsleep 3\nexit 0\n");
      writeFileSync(join(tmpBin, "claude"), "#!/bin/sh\nsleep 3\nexit 0\n");
      chmodSync(join(tmpBin, "codex"), 0o755);
      chmodSync(join(tmpBin, "claude"), 0o755);

      const raw = JSON5.parse(buildConfigContent());
      raw.externalAgents = { backends: ["codex", "claude"] };
      writeFileSync(join(home, "goblin.json5"), JSON5.stringify(raw, { space: 2 }));

      const originalPath = process.env.PATH;
      process.env.PATH = `${tmpBin}:${originalPath ?? ""}`;

      try {
        const start = performance.now();
        const result = await callDoctor(home, { probes: noopProbes });
        const elapsed = performance.now() - start;

        expect(result.lines.join("\n")).toContain("external agents: pass");
        expect(result.exitCode).toBe(0);
        expect(elapsed).toBeLessThan(5_500);
      } finally {
        process.env.PATH = originalPath;
        rmSync(tmpBin, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    },
    20_000,
  );
});

describe("doctor timeout edge cases", () => {
  it(
    "times out a fetch with a stalled response body before 6 seconds",
    async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        text: () => new Promise<string>((resolve) => setTimeout(() => resolve("body"), 10_000)),
      } as unknown as Response)) as unknown as typeof globalThis.fetch;

      const home = setupHealthyHome();
      try {
        const start = performance.now();
        const result = await callDoctor(home, { strict: true });
        const elapsed = performance.now() - start;
        expect(result.exitCode).toBe(1);
        expect(result.lines.join("\n")).toContain("Telegram: timeout");
        expect(elapsed).toBeLessThan(6_000);
      } finally {
        globalThis.fetch = originalFetch;
        rmSync(home, { recursive: true, force: true });
      }
    },
    20_000,
  );

});

describe("MemorySnapshot cleanup", () => {
  it(
    "removes the temp copy when schema validation fails",
    () => {
      const home = setupHealthyHome();
      const db = new MemoryDatabase(memoryDbPath(home));
      try {
        db.setMeta("schema_version", "999");
      } finally {
        db.close();
      }

      const before = new Set(
        readdirSync(tmpdir())
          .filter((name) => name.startsWith("goblin-memory-snapshot-"))
          .sort(),
      );

      expect(() => new MemorySnapshot(memoryDbPath(home))).toThrow("schema version 999");

      const after = readdirSync(tmpdir())
        .filter((name) => name.startsWith("goblin-memory-snapshot-"))
        .sort();
      const added = after.filter((name) => !before.has(name));
      expect(added).toEqual([]);

      rmSync(home, { recursive: true, force: true });
    },
    20_000,
  );
});

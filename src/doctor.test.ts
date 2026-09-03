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
import {
  agentsMdPath,
  goblinSkillsPath,
  personalEnvironmentSkillsPath,
  soulMdPath,
} from "./workspace/paths.ts";
import { delegatedWorkRunsRoot } from "./delegated-work/paths.ts";
import { ensureGoblinHome, type Config } from "./config.ts";
import { buildMcporterCommand } from "./mcp/runner.ts";
import { buildProviderEndpoint, runDoctor, type ConnectivityProbes } from "./doctor.ts";
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

describe("model provider probe endpoint", () => {
  it("normalizes trailing slashes without duplicating the API version", () => {
    expect(buildProviderEndpoint("https://provider.example/v1/")).toBe(
      "https://provider.example/v1/models",
    );
    expect(buildProviderEndpoint("https://provider.example/")).toBe(
      "https://provider.example/v1/models",
    );
  });
});

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

function homeConfig(goblinHome: string): Config {
  return {
    botToken: "test-token",
    allowedTgUserIds: new Set([123456]),
    modelName: "openai/gpt-5.4",
    openaiApiKey: "test-key",
    goblinHome,
    logLevel: "info",
    toolVisibility: "standard",
    favorites: [],
    voiceName: "en-US-EmmaMultilingualNeural",
  };
}

function setupHealthyHome(): string {
  const home = mkdtempSync(join(tmpdir(), "goblin-doctor-healthy-"));
  ensureGoblinHome(homeConfig(home));

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

interface TestDoctorOptions {
  readonly strict?: boolean;
  readonly probes?: ConnectivityProbes;
  /** Test seam for deterministic local filesystem conditions. */
  readonly dependencies?: {
    readonly statfs?: (path: string) => {
      readonly bsize: number;
      readonly blocks: number;
      readonly bavail: number;
    };
  };
}

async function callDoctor(
  home: string,
  opts?: TestDoctorOptions,
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

interface ChildDoctorResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Start a fresh Bun process so the default Edge probe inherits the fake PATH
 * at process launch. Connectivity is injected in the child; the mock-fetch
 * mode exercises all production defaults without leaving the test network.
 */
function runDoctorInChild(
  home: string,
  extraEnv: Record<string, string>,
  mode: "injected-network-probes" | "mock-fetch",
): ChildDoctorResult {
  const doctorUrl = new URL("./doctor.ts", import.meta.url).href;
  const setup = mode === "mock-fetch"
    ? 'globalThis.fetch = async () => new Response("{}", { status: 200 });'
    : "";
  const options = mode === "injected-network-probes"
    ? "{ strict: true, probes: { checkTelegramToken: async () => {}, checkModelProvider: async () => {} } }"
    : "{ strict: true }";
  const script = `
import { runDoctor } from ${JSON.stringify(doctorUrl)};
${setup}
const result = await runDoctor(${options});
process.stdout.write(result.lines.join("\\n"));
process.exit(result.exitCode);
`;
  const result = Bun.spawnSync({
    cmd: ["bun", "--eval", script],
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

interface CliResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly elapsedMs: number;
}

const doctorCliHarnessPath = fileURLToPath(
  new URL("./doctor-cli.test-support.ts", import.meta.url),
);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * Make the nested `bun run src/doctor.ts` in the package script preload the
 * test-only network transport. The outer command remains `bun run doctor`, so
 * this exercises package wiring and CLI argument handling. Doctor itself has
 * no environment-driven probe bypass: without this test-only PATH wrapper it
 * always runs the production probes.
 */
function installDoctorCliHarness(binDir: string): void {
  const fakeBun = join(binDir, "bun");
  writeFileSync(
    fakeBun,
    `#!/bin/sh\nif [ "$1" = run ]; then\n  shift\n  exec ${JSON.stringify(process.execPath)} run --preload ${JSON.stringify(doctorCliHarnessPath)} "$@"\nfi\nexec ${JSON.stringify(process.execPath)} --preload ${JSON.stringify(doctorCliHarnessPath)} "$@"\n`,
  );
  chmodSync(fakeBun, 0o755);
}

function runDoctorCli(
  home: string,
  args: readonly string[] = [],
  extraEnv: Record<string, string> = {},
): CliResult {
  const start = performance.now();
  const result = Bun.spawnSync({
    cmd: [process.execPath, "run", "doctor", ...args],
    cwd: repositoryRoot,
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
    elapsedMs: performance.now() - start,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
          "subdirs: workspace, .agents/skills, workspace/.agents/skills, workspace/agents, state, state/sessions, state/memory, state/pi, state/delegated-work/runs, scratch, scratch/external-agents",
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
      const home = setupHealthyHome();
      try {
        // Intentionally set an older state version so only this check fails.
        writeStateVersion(home, CURRENT_STATE_VERSION - 1);

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

describe("bun run doctor subprocess", () => {
  it(
    "uses package wiring to parse --strict and render a healthy full report",
    () => {
      const home = setupHealthyHome();
      const tmpBin = mkdtempSync(join(tmpdir(), "goblin-doctor-cli-"));
      const fakeUvx = join(tmpBin, "uvx");
      writeFileSync(fakeUvx, "#!/bin/sh\nexit 0\n");
      chmodSync(fakeUvx, 0o755);
      installDoctorCliHarness(tmpBin);

      try {
        const result = runDoctorCli(home, ["--strict"], {
          PATH: `${tmpBin}:${process.env.PATH ?? ""}`,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("state version: pass");
        expect(result.stdout).toContain("GOBLIN_HOME: pass");
        expect(result.stdout).toContain("memory: pass");
        expect(result.stdout).toContain("conversations: pass");
        expect(result.stdout).toContain("config: pass");
        expect(result.stdout).toContain("favorites: pass");
        expect(result.stdout).toContain("prompt files: pass");
        expect(result.stdout).toContain("disk: pass");
        expect(result.stdout).toContain("Telegram: pass");
        expect(result.stdout).toContain("model provider: pass");
        expect(result.stdout).toContain("Edge TTS: pass");
        expect(result.stdout).toMatch(/\b0 failed \(strict\)/);
        expect(result.elapsedMs).toBeLessThan(4_000);
      } finally {
        rmSync(tmpBin, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it(
    "bounds oversized HTTP warnings without dropping later checks or the summary",
    () => {
      const home = setupHealthyHome();
      const tmpBin = mkdtempSync(join(tmpdir(), "goblin-doctor-cli-output-"));
      const fakeUvx = join(tmpBin, "uvx");
      const cancelMarker = join(tmpBin, "http-body-canceled");
      writeFileSync(fakeUvx, "#!/bin/sh\nexit 0\n");
      chmodSync(fakeUvx, 0o755);
      installDoctorCliHarness(tmpBin);
      const probeEnv = {
        PATH: `${tmpBin}:${process.env.PATH ?? ""}`,
        GOBLIN_DOCTOR_TEST_HTTP_ERROR_BYTES: String(1024 * 1024),
        GOBLIN_DOCTOR_TEST_HTTP_CANCEL_MARKER: cancelMarker,
      };

      try {
        const lax = runDoctorCli(home, [], probeEnv);

        expect(lax.exitCode).toBe(0);
        expect(lax.stdout).toContain("Telegram: warn");
        expect(lax.stdout).toContain("model provider: warn");
        expect(lax.stdout).toContain("[truncated]");
        expect(lax.stdout).toContain("Edge TTS: pass");
        expect(lax.stdout).toContain("0 failed, 2 warned");
        expect(lax.stdout.indexOf("Edge TTS: pass")).toBeGreaterThan(
          lax.stdout.indexOf("Telegram: warn"),
        );
        expect(lax.stdout.lastIndexOf("0 failed, 2 warned")).toBeGreaterThan(
          lax.stdout.indexOf("Edge TTS: pass"),
        );
        expect(lax.stdout.length).toBeLessThan(40_000);
        expect(lax.elapsedMs).toBeLessThan(4_000);
        expect(existsSync(cancelMarker)).toBe(true);

        const strict = runDoctorCli(home, ["--strict"], probeEnv);
        expect(strict.exitCode).toBe(1);
        expect(strict.stdout).toContain("Edge TTS: pass");
        expect(strict.stdout).toContain("2 failed (strict)");
      } finally {
        rmSync(tmpBin, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    },
    20_000,
  );
});

describe("startup directory inventory", () => {
  it(
    "fails when startup-required skill or delegated-work roots are absent",
    async () => {
      const home = setupHealthyHome();
      const requiredRoots: readonly [label: string, path: string][] = [
        [".agents/skills", goblinSkillsPath(home)],
        ["workspace/.agents/skills", personalEnvironmentSkillsPath(home)],
        ["state/delegated-work/runs", delegatedWorkRunsRoot(home)],
      ];

      try {
        for (const [label, path] of requiredRoots) {
          rmSync(path, { recursive: true, force: true });
          const result = await callDoctor(home, { probes: noopProbes });
          const line = result.lines.find((candidate) => candidate.startsWith("GOBLIN_HOME"));

          expect(result.exitCode).toBe(1);
          expect(line).toContain("GOBLIN_HOME: fail");
          expect(line).toContain(`${label} is missing`);

          ensureGoblinHome(homeConfig(home));
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    20_000,
  );
});

describe("disk availability", () => {
  it(
    "fails critically when the GOBLIN_HOME volume has zero available blocks",
    async () => {
      const home = setupHealthyHome();
      try {
        const result = await callDoctor(home, {
          probes: noopProbes,
          dependencies: {
            statfs: () => ({ bsize: 4096, blocks: 256, bavail: 0 }),
          },
        });
        const line = result.lines.find((candidate) => candidate.startsWith("disk"));

        expect(result.exitCode).toBe(1);
        expect(line).toContain("disk: fail");
        expect(line).toContain("0 available blocks");
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

describe("live connectivity probe policy", () => {
  it(
    "does not let an environment variable bypass live probes",
    () => {
      const home = setupHealthyHome();
      const tmpBin = mkdtempSync(join(tmpdir(), "goblin-fake-uvx-"));
      const fakeUvx = join(tmpBin, "uvx");
      writeFileSync(fakeUvx, "#!/bin/sh\nexit 1\n");
      chmodSync(fakeUvx, 0o755);

      try {
        const result = runDoctorInChild(
          home,
          {
            PATH: `${tmpBin}:${process.env.PATH ?? ""}`,
            GOBLIN_DOCTOR_PROBE_STUB: "pass",
          },
          "mock-fetch",
        );
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toContain("Edge TTS: warn");
      } finally {
        rmSync(tmpBin, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    },
    20_000,
  );
});

describe("MCP gateway status connectivity probe", () => {
  it(
    "hermetic MCP gateway status probe records --status and --exit-code and preserves lax/strict exits",
    async () => {
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
printf '%s\\n' 'gateway stdout: tavily status unavailable'
printf '%s\\n' 'gateway stderr: tavily unhealthy' >&2
exit 1
`,
      );
      chmodSync(fakeBunx, 0o755);

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
      const previousPath = process.env.PATH;

      try {
        process.env.PATH = `${tmpBin}:${previousPath ?? ""}`;

        const lax = await callDoctor(home, { probes: noopProbes });
        expect(lax.exitCode).toBe(0);
        expect(lax.lines.join("\n")).toContain("MCP servers: warn");
        expect(lax.lines.join("\n")).toContain("gateway stdout: tavily status unavailable");
        expect(lax.lines.join("\n")).toContain("gateway stderr: tavily unhealthy");
        expect(readFileSync(argvPath, "utf8").trim().split("\n")).toEqual(expectedArgv);

        const strict = await callDoctor(home, { strict: true, probes: noopProbes });
        expect(strict.exitCode).toBe(1);
        expect(strict.lines.join("\n")).toContain("MCP servers: warn");
        expect(strict.lines.join("\n")).toContain("gateway stdout: tavily status unavailable");
        expect(strict.lines.join("\n")).toContain("gateway stderr: tavily unhealthy");
        expect(readFileSync(argvPath, "utf8").trim().split("\n")).toEqual(expectedArgv);
      } finally {
        if (previousPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = previousPath;
        }
        rmSync(tmpBin, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it(
    "bounds captured stdout and stderr while retaining their trailing diagnostic detail",
    async () => {
      const home = setupHealthyHome();
      const tmpBin = mkdtempSync(join(tmpdir(), "goblin-fake-mcporter-output-"));
      const fakeBunx = join(tmpBin, "bunx");
      const raw = JSON5.parse(buildConfigContent());
      raw.mcp = {};
      writeFileSync(join(home, "goblin.json5"), JSON5.stringify(raw, { space: 2 }));
      writeFileSync(
        fakeBunx,
        `#!/bin/sh
printf '%*s' 20000 '' | tr ' ' x
printf '%s\\n' 'stdout trailing diagnostic'
printf '%*s' 20000 '' | tr ' ' y >&2
printf '%s\\n' 'stderr trailing diagnostic' >&2
exit 1
`,
      );
      chmodSync(fakeBunx, 0o755);
      const previousPath = process.env.PATH;

      try {
        process.env.PATH = `${tmpBin}:${previousPath ?? ""}`;
        const result = await callDoctor(home, { probes: noopProbes });
        const line = result.lines.find((candidate) => candidate.startsWith("MCP servers"));

        expect(line).toContain("MCP servers: warn");
        expect(line).toContain("stdout trailing diagnostic");
        expect(line).toContain("stderr trailing diagnostic");
        expect(line).toContain("[truncated]");
        expect(line?.length).toBeLessThan(20_000);
      } finally {
        if (previousPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = previousPath;
        }
        rmSync(tmpBin, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    },
    20_000,
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

  it(
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

  it(
    "fails memory diagnostics with ELOOP instead of suppressing the stat error",
    async () => {
      const home = setupHealthyHome();
      const dbPath = memoryDbPath(home);
      try {
        rmSync(dbPath);
        rmSync(`${dbPath}-wal`, { force: true });
        rmSync(`${dbPath}-shm`, { force: true });
        symlinkSync(dbPath, dbPath);

        const result = await callDoctor(home, { probes: noopProbes });
        const line = result.lines.find((candidate) => candidate.startsWith("memory"));

        expect(result.exitCode).toBe(1);
        expect(line).toContain("memory: fail");
        expect(line).toContain("cannot open memory DB");
        expect(line).toMatch(/too many .*symbolic links/i);
        expect(line).not.toContain("could not get a stable copy");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it.skipIf(skipAsRoot)(
    "fails prompt files critically when AGENTS.md is unreadable",
    async () => {
      const home = setupHealthyHome();
      try {
        chmodSync(agentsMdPath(home), 0o000);

        const result = await callDoctor(home, { probes: noopProbes });
        const line = result.lines.find((l) => l.startsWith("prompt files"));

        expect(result.exitCode).toBe(1);
        expect(line).toContain("prompt files: fail");
        expect(line).toContain("AGENTS.md");
        expect(line).toMatch(/permission denied/i);
      } finally {
        chmodSync(agentsMdPath(home), 0o644);
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
    "fails critically when optional AGENTS.md is not a regular file",
    async () => {
      const home = setupHealthyHome();
      try {
        rmSync(agentsMdPath(home));
        mkdirSync(agentsMdPath(home));

        const result = await callDoctor(home, { probes: noopProbes });
        const line = result.lines.find((candidate) => candidate.startsWith("prompt files"));

        expect(result.exitCode).toBe(1);
        expect(line).toContain("prompt files: fail");
        expect(line).toMatch(/AGENTS\.md.*regular/i);
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
    () => {
      const home = setupHealthyHome();
      const tmpBin = mkdtempSync(join(tmpdir(), "goblin-fake-uvx-"));
      const fakeUvx = join(tmpBin, "uvx");
      writeFileSync(fakeUvx, "#!/bin/sh\nexit 143\n");
      chmodSync(fakeUvx, 0o755);

      try {
        const result = runDoctorInChild(
          home,
          { PATH: `${tmpBin}:${process.env.PATH ?? ""}` },
          "injected-network-probes",
        );

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
    () => {
      const home = setupHealthyHome();
      const tmpBin = mkdtempSync(join(tmpdir(), "goblin-fake-uvx-"));
      const fakeUvx = join(tmpBin, "uvx");
      writeFileSync(fakeUvx, "#!/bin/sh\nsleep 6\n");
      chmodSync(fakeUvx, 0o755);

      try {
        const result = runDoctorInChild(
          home,
          { PATH: `${tmpBin}:${process.env.PATH ?? ""}` },
          "injected-network-probes",
        );

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
    "terminates process-group descendants when an Edge TTS probe times out",
    async () => {
      const home = setupHealthyHome();
      const tmpBin = mkdtempSync(join(tmpdir(), "goblin-fake-uvx-group-"));
      const fakeUvx = join(tmpBin, "uvx");
      const descendantMarker = join(tmpBin, "descendant-survived");
      writeFileSync(
        fakeUvx,
        `#!/bin/sh
(
  sleep 6
  printf '%s\\n' survived > ${JSON.stringify(descendantMarker)}
) &
sleep 30
`,
      );
      chmodSync(fakeUvx, 0o755);

      try {
        const result = runDoctorInChild(
          home,
          { PATH: `${tmpBin}:${process.env.PATH ?? ""}` },
          "injected-network-probes",
        );

        expect(result.exitCode).toBe(1);
        expect(result.stdout).toContain("Edge TTS: timeout");
        await delay(1_500);
        expect(existsSync(descendantMarker)).toBe(false);
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
    "times out an error response with a stalled body and cancels the reader",
    async () => {
      const originalFetch = globalThis.fetch;
      let cancellations = 0;
      const stalledFetch = Object.assign(
        async (): Promise<Response> => new Response(
          new ReadableStream<Uint8Array>({
            cancel(): void {
              cancellations++;
            },
          }),
          { status: 503 },
        ),
        { preconnect: originalFetch.preconnect },
      );
      globalThis.fetch = stalledFetch;

      const home = setupHealthyHome();
      try {
        const start = performance.now();
        const result = await callDoctor(home, { strict: true });
        const elapsed = performance.now() - start;
        expect(result.exitCode).toBe(1);
        expect(result.lines.join("\n")).toContain("Telegram: timeout");
        expect(cancellations).toBeGreaterThanOrEqual(2);
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

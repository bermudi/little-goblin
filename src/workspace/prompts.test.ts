import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MissingSoulError,
  preflightWorkspacePromptFiles,
  readOptionalPromptFile,
  readRequiredPromptFile,
  workspacePromptCatalog,
  workspacePromptFile,
} from "./prompts.ts";
import { agentsMdPath, heartbeatMdPath, soulMdPath } from "./paths.ts";

describe("workspacePromptCatalog", () => {
  it("enumerates the deployment prompt files via path helpers with required/optional classification", () => {
    const home = join("nonexistent", "home");
    const catalog = workspacePromptCatalog(home);

    expect(catalog.map((file) => file.name)).toEqual(["SOUL.md", "AGENTS.md", "HEARTBEAT.md"]);
    expect(workspacePromptFile(home, "SOUL.md")).toMatchObject({
      requirement: "required",
      path: soulMdPath(home),
    });
    expect(workspacePromptFile(home, "AGENTS.md")).toMatchObject({
      requirement: "optional",
      path: agentsMdPath(home),
    });
    expect(workspacePromptFile(home, "HEARTBEAT.md")).toMatchObject({
      requirement: "optional",
      path: heartbeatMdPath(home),
    });
  });
});

describe("prompt-file read policy", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "goblin-workspace-prompts-"));
    mkdirSync(join(home, "workspace"), { recursive: true });
  });

  afterEach(() => {
    chmodSync(home, 0o700);
    chmodSync(join(home, "workspace"), 0o700);
    rmSync(home, { recursive: true, force: true });
  });

  it("throws MissingSoulError when the required SOUL.md is absent", async () => {
    const file = workspacePromptFile(home, "SOUL.md");
    try {
      await readRequiredPromptFile(file.path);
      expect.unreachable("expected readRequiredPromptFile to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingSoulError);
      expect((err as MissingSoulError).code).toBe("GOBLIN_MISSING_SOUL");
      expect((err as MissingSoulError).path).toBe(soulMdPath(home));
    }
  });

  it("yields absent when optional AGENTS.md or HEARTBEAT.md is missing", async () => {
    await expect(readOptionalPromptFile(agentsMdPath(home))).resolves.toBeNull();
    await expect(readOptionalPromptFile(heartbeatMdPath(home))).resolves.toBeNull();
  });

  it("returns file contents for present files", async () => {
    writeFileSync(soulMdPath(home), "soul identity\n", "utf-8");
    writeFileSync(agentsMdPath(home), "agent rules\n", "utf-8");
    await expect(readRequiredPromptFile(soulMdPath(home))).resolves.toBe("soul identity\n");
    await expect(readOptionalPromptFile(agentsMdPath(home))).resolves.toBe("agent rules\n");
  });

  it("propagates non-ENOENT failures on required files unwrapped", async () => {
    writeFileSync(soulMdPath(home), "soul identity\n", "utf-8");
    chmodSync(soulMdPath(home), 0o000);
    try {
      await readRequiredPromptFile(soulMdPath(home));
      expect.unreachable("expected readRequiredPromptFile to reject");
    } catch (err) {
      expect(err).toBeDefined();
      expect(err).not.toBeInstanceOf(MissingSoulError);
    }
  });

  it("propagates non-ENOENT failures on optional files unwrapped", async () => {
    writeFileSync(agentsMdPath(home), "agent rules\n", "utf-8");
    chmodSync(agentsMdPath(home), 0o000);
    await expect(readOptionalPromptFile(agentsMdPath(home))).rejects.toThrow();
  });
});

describe("preflightWorkspacePromptFiles", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "goblin-workspace-preflight-"));
    mkdirSync(join(home, "workspace"), { recursive: true });
  });

  afterEach(() => {
    chmodSync(home, 0o700);
    chmodSync(join(home, "workspace"), 0o700);
    rmSync(home, { recursive: true, force: true });
  });

  it("throws MissingSoulError when the required file is absent", async () => {
    await expect(
      preflightWorkspacePromptFiles({ home, warn: () => undefined }),
    ).rejects.toBeInstanceOf(MissingSoulError);
  });

  it("warns only for the missing optional file that carries a missing note", async () => {
    writeFileSync(soulMdPath(home), "soul identity\n", "utf-8");
    const warnings: Array<{ message: string; extra?: unknown }> = [];

    await preflightWorkspacePromptFiles({
      home,
      warn: (message, extra) => warnings.push({ message, extra }),
    });

    expect(warnings).toEqual([
      {
        message: "optional Goblin prompt file missing",
        extra: {
          path: agentsMdPath(home),
          note: "Create AGENTS.md in $GOBLIN_HOME/workspace/ for agent operating rules.",
        },
      },
    ]);
  });

  it("stays quiet when every catalog file is present", async () => {
    writeFileSync(soulMdPath(home), "soul identity\n", "utf-8");
    writeFileSync(agentsMdPath(home), "agent rules\n", "utf-8");
    writeFileSync(heartbeatMdPath(home), "heartbeat body\n", "utf-8");
    const warnings: string[] = [];

    await preflightWorkspacePromptFiles({
      home,
      warn: (message) => warnings.push(message),
    });

    expect(warnings).toEqual([]);
  });

  it("propagates non-ENOENT check failures instead of remapping them", async () => {
    writeFileSync(soulMdPath(home), "soul identity\n", "utf-8");
    chmodSync(join(home, "workspace"), 0o000);
    try {
      await preflightWorkspacePromptFiles({ home, warn: () => undefined });
      expect.unreachable("expected preflightWorkspacePromptFiles to reject");
    } catch (err) {
      expect(err).toBeDefined();
      expect(err).not.toBeInstanceOf(MissingSoulError);
    }
  });
});

describe("prompt-file ownership drift pins", () => {
  it("system-prompt.ts holds no prompt-file read or ENOENT policy of its own", () => {
    const source = readFileSync(join(import.meta.dir, "..", "agent", "system-prompt.ts"), "utf-8");
    expect(source).not.toContain("readFile");
    expect(source).not.toContain("access(");
    expect(source).not.toContain("ENOENT");
    expect(source).toContain("workspace/mod.ts");
  });

  it("preflight delegates prompt-file checks to the module instead of enumerating paths", () => {
    const source = readFileSync(join(import.meta.dir, "..", "preflight.ts"), "utf-8");
    expect(source).toContain("preflightWorkspacePromptFiles");
    expect(source).not.toContain("soulMdPath");
    expect(source).not.toContain("agentsMdPath");
    expect(source).not.toContain("heartbeatMdPath");
    expect(source).not.toContain("preflightGoblinPromptFiles");
  });
});

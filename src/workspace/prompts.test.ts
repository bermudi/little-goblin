import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  deploymentPromptFilePaths,
  HEARTBEAT_PROMPT,
  inspectPromptFile,
  materializePromptFiles,
  MissingSoulError,
  preflightWorkspacePromptFiles,
  readOptionalPromptFile,
  readRequiredPromptFile,
  reservedPromptFilePaths,
  resolveHeartbeatPrompt,
  workspacePromptCatalog,
  workspacePromptFile,
} from "./prompts.ts";
import { agentsMdPath, heartbeatMdPath, soulMdPath } from "./paths.ts";
import { surfaceHeartbeatPath } from "../sessions/paths.ts";
import { dmSurface, surfaceId, type Surface } from "../surface.ts";

/** Capture a rejection without routing it through a catch block that could
 *  also swallow an expect.unreachable() failure. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected promise to reject");
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected function to throw");
}

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
    const err = await rejectionOf(readRequiredPromptFile(file.path));
    expect(err).toBeInstanceOf(MissingSoulError);
    expect((err as MissingSoulError).code).toBe("GOBLIN_MISSING_SOUL");
    expect((err as MissingSoulError).path).toBe(soulMdPath(home));
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
    const err = await rejectionOf(readRequiredPromptFile(soulMdPath(home)));
    expect(err).toBeDefined();
    expect(err).not.toBeInstanceOf(MissingSoulError);
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
    const err = await rejectionOf(
      preflightWorkspacePromptFiles({ home, warn: () => undefined }),
    );
    expect(err).toBeDefined();
    expect(err).not.toBeInstanceOf(MissingSoulError);
  });

  it("rejects when the required file is present but not a regular readable file", async () => {
    mkdirSync(soulMdPath(home));
    const err = await rejectionOf(
      preflightWorkspacePromptFiles({ home, warn: () => undefined }),
    );
    expect(err).toBeDefined();
    expect(err).not.toBeInstanceOf(MissingSoulError);
  });

  it("rejects when a warn-checked optional file is present but not a regular readable file", async () => {
    writeFileSync(soulMdPath(home), "soul identity\n", "utf-8");
    mkdirSync(agentsMdPath(home));
    const err = await rejectionOf(
      preflightWorkspacePromptFiles({ home, warn: () => undefined }),
    );
    expect(err).toBeDefined();
    expect(err).not.toBeInstanceOf(MissingSoulError);
  });

  it("rejects when the required file exists but is unreadable", async () => {
    writeFileSync(soulMdPath(home), "soul identity\n", "utf-8");
    chmodSync(soulMdPath(home), 0o000);
    const err = await rejectionOf(
      preflightWorkspacePromptFiles({ home, warn: () => undefined }),
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(MissingSoulError);
    expect((err as Error).message).toContain("not a regular readable file");
    expect((err as Error).message).toContain(soulMdPath(home));
  });

  it("rejects when a warn-checked optional file exists but is unreadable", async () => {
    writeFileSync(soulMdPath(home), "soul identity\n", "utf-8");
    writeFileSync(agentsMdPath(home), "agent rules\n", "utf-8");
    chmodSync(agentsMdPath(home), 0o000);
    const err = await rejectionOf(
      preflightWorkspacePromptFiles({ home, warn: () => undefined }),
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("not a regular readable file");
    expect((err as Error).message).toContain(agentsMdPath(home));
  });

  it("treats a dangling symlink at the required file as missing", async () => {
    // access()-style semantics: a dangling symlink resolves to ENOENT
    // downstream, so the required file is absent, not "not regular".
    symlinkSync(join(home, "nonexistent-target"), soulMdPath(home));
    const err = await rejectionOf(
      preflightWorkspacePromptFiles({ home, warn: () => undefined }),
    );
    expect(err).toBeInstanceOf(MissingSoulError);
  });

  it("treats a dangling symlink at the warn-checked optional file as missing", async () => {
    writeFileSync(soulMdPath(home), "soul identity\n", "utf-8");
    symlinkSync(join(home, "nonexistent-target"), agentsMdPath(home));
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

  it("does not touch optional files that carry no preflight policy", async () => {
    writeFileSync(soulMdPath(home), "soul identity\n", "utf-8");
    writeFileSync(agentsMdPath(home), "agent rules\n", "utf-8");
    // A self-symlink ELOOPs on stat/access; preflight must not inspect it.
    symlinkSync(heartbeatMdPath(home), heartbeatMdPath(home));
    const warnings: string[] = [];

    await preflightWorkspacePromptFiles({
      home,
      warn: (message) => warnings.push(message),
    });

    expect(warnings).toEqual([]);
  });
});

describe("resolveHeartbeatPrompt", () => {
  const SURFACE = dmSurface(100);
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "goblin-heartbeat-prompts-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function writeWorkspaceHeartbeat(content: string): void {
    const path = heartbeatMdPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf-8");
  }

  function writeSurfaceHeartbeat(surface: Surface, content: string): void {
    const path = surfaceHeartbeatPath(home, surfaceId(surface));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf-8");
  }

  it("surface-scoped HEARTBEAT.md wins over the workspace file", () => {
    writeSurfaceHeartbeat(SURFACE, "surface body");
    writeWorkspaceHeartbeat("workspace body");
    expect(resolveHeartbeatPrompt(home, SURFACE)).toBe("[heartbeat] surface body");
  });

  it("workspace HEARTBEAT.md wins over the built-in constant", () => {
    writeWorkspaceHeartbeat("workspace body");
    expect(resolveHeartbeatPrompt(home, SURFACE)).toBe("[heartbeat] workspace body");
  });

  it("falls back to the built-in constant when both files are absent", () => {
    expect(resolveHeartbeatPrompt(home, SURFACE)).toBe(HEARTBEAT_PROMPT);
    expect(resolveHeartbeatPrompt(home, SURFACE).match(/\[heartbeat\]/g)).toHaveLength(1);
  });

  it("falls through a whitespace-only surface file to the workspace file", () => {
    writeSurfaceHeartbeat(SURFACE, "   \n\t \n");
    writeWorkspaceHeartbeat("workspace body");
    expect(resolveHeartbeatPrompt(home, SURFACE)).toBe("[heartbeat] workspace body");
  });

  it("does not double-prefix a file body already carrying [heartbeat]", () => {
    writeSurfaceHeartbeat(SURFACE, "[heartbeat] already marked");
    expect(resolveHeartbeatPrompt(home, SURFACE)).toBe("[heartbeat] already marked");
    expect(resolveHeartbeatPrompt(home, SURFACE).match(/\[heartbeat\]/g)).toHaveLength(1);
  });

  it("strips an indented [heartbeat] marker while preserving the indentation", () => {
    writeSurfaceHeartbeat(SURFACE, "  [heartbeat] indented body");
    expect(resolveHeartbeatPrompt(home, SURFACE)).toBe("[heartbeat]   indented body");
    expect(resolveHeartbeatPrompt(home, SURFACE).match(/\[heartbeat\]/g)).toHaveLength(1);
  });

  it("strips trailing whitespace and preserves leading whitespace", () => {
    writeSurfaceHeartbeat(SURFACE, "  \tindented body  \n\n");
    expect(resolveHeartbeatPrompt(home, SURFACE)).toBe("[heartbeat]   \tindented body");
  });

  it("propagates a non-ENOENT read failure on a candidate", () => {
    // home pointing at a plain file makes state/surfaces/<id>/HEARTBEAT.md
    // resolve under a non-directory ancestor: ENOTDIR, not ENOENT.
    const blockingFile = join(home, "blocking");
    writeFileSync(blockingFile, "x", "utf-8");
    const err = thrownBy(() => resolveHeartbeatPrompt(blockingFile, SURFACE));
    expect((err as NodeJS.ErrnoException).code).toBe("ENOTDIR");
  });
});

describe("prompt-file set projections", () => {
  it("deploymentPromptFilePaths resolves every catalog path", () => {
    const home = join("nonexistent", "home");
    expect(deploymentPromptFilePaths(home)).toEqual(new Set([
      resolve(soulMdPath(home)),
      resolve(agentsMdPath(home)),
      resolve(heartbeatMdPath(home)),
    ]));
  });

  it("reservedPromptFilePaths adds the bound Surface heartbeat to the catalog", () => {
    const home = join("nonexistent", "home");
    const surface = dmSurface(7);
    expect(reservedPromptFilePaths(home, surface)).toEqual(new Set([
      resolve(soulMdPath(home)),
      resolve(agentsMdPath(home)),
      resolve(heartbeatMdPath(home)),
      resolve(surfaceHeartbeatPath(home, surfaceId(surface))),
    ]));
    expect(reservedPromptFilePaths(home)).toEqual(deploymentPromptFilePaths(home));
  });
});

describe("inspectPromptFile", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "goblin-inspect-prompt-"));
    mkdirSync(join(home, "workspace"), { recursive: true });
  });

  afterEach(() => {
    chmodSync(join(home, "workspace"), 0o700);
    rmSync(home, { recursive: true, force: true });
  });

  it("classifies a readable regular file as regular", () => {
    const path = soulMdPath(home);
    writeFileSync(path, "soul identity\n", "utf-8");
    expect(inspectPromptFile(path)).toEqual({ kind: "regular" });
  });

  it("classifies an absent path as missing", () => {
    expect(inspectPromptFile(agentsMdPath(home))).toEqual({ kind: "missing" });
  });

  it("classifies a directory as not-regular", () => {
    const expected = { kind: "not-regular" as const, danglingSymlink: false };
    expect(inspectPromptFile(join(home, "workspace"))).toEqual(expected);
  });

  it("classifies a symlink to a regular file as regular", () => {
    const target = join(home, "target.md");
    writeFileSync(target, "x\n", "utf-8");
    const path = agentsMdPath(home);
    symlinkSync(target, path);
    expect(inspectPromptFile(path)).toEqual({ kind: "regular" });
  });

  it("flags a dangling symlink so callers can treat it as absent downstream", () => {
    const path = agentsMdPath(home);
    symlinkSync(join(home, "nonexistent-target"), path);
    const expected = { kind: "not-regular" as const, danglingSymlink: true };
    expect(inspectPromptFile(path)).toEqual(expected);
  });

  it("reports an unreadable file as a read error", () => {
    const path = soulMdPath(home);
    writeFileSync(path, "soul identity\n", "utf-8");
    chmodSync(path, 0o000);
    const presence = inspectPromptFile(path);
    expect(presence.kind).toBe("error");
    if (presence.kind === "error") expect(presence.operation).toBe("read");
  });

  it("reports a non-ENOENT stat failure as a stat error", () => {
    const blocking = join(home, "blocking");
    writeFileSync(blocking, "x", "utf-8");
    const presence = inspectPromptFile(join(blocking, "SOUL.md"));
    expect(presence.kind).toBe("error");
    if (presence.kind === "error") expect(presence.operation).toBe("stat");
  });
});

describe("materializePromptFiles", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "goblin-materialize-prompts-"));
  });

  afterEach(() => {
    chmodSync(home, 0o700);
    const workspace = join(home, "workspace");
    if (existsSync(workspace)) chmodSync(workspace, 0o700);
    rmSync(home, { recursive: true, force: true });
  });

  it("creates SOUL.md and AGENTS.md from templates in a fresh home", () => {
    const result = materializePromptFiles(home, "Moss");

    expect(result).toEqual({ createdSoul: true, createdAgents: true, agentsWithoutSoul: false });
    expect(readFileSync(soulMdPath(home), "utf-8")).toContain("# Moss");
    expect(readFileSync(agentsMdPath(home), "utf-8").length).toBeGreaterThan(0);
  });

  it("creates neither file and preserves contents on a second run", () => {
    materializePromptFiles(home, "Moss");
    const soulBefore = readFileSync(soulMdPath(home), "utf-8");
    const agentsBefore = readFileSync(agentsMdPath(home), "utf-8");

    const result = materializePromptFiles(home, "Other");

    expect(result).toEqual({ createdSoul: false, createdAgents: false, agentsWithoutSoul: false });
    expect(readFileSync(soulMdPath(home), "utf-8")).toBe(soulBefore);
    expect(readFileSync(agentsMdPath(home), "utf-8")).toBe(agentsBefore);
  });

  it("leaves a pre-existing file byte-identical", () => {
    mkdirSync(join(home, "workspace"), { recursive: true });
    writeFileSync(soulMdPath(home), "existing soul\n", "utf-8");

    const result = materializePromptFiles(home, "Moss");

    expect(result).toEqual({ createdSoul: false, createdAgents: true, agentsWithoutSoul: false });
    expect(readFileSync(soulMdPath(home), "utf-8")).toBe("existing soul\n");
  });

  it("signals AGENTS-without-SOUL, creates SOUL.md, and leaves AGENTS.md intact", () => {
    mkdirSync(join(home, "workspace"), { recursive: true });
    writeFileSync(agentsMdPath(home), "old identity from agents\n", "utf-8");

    const result = materializePromptFiles(home, "Moss");

    expect(result).toEqual({ createdSoul: true, createdAgents: false, agentsWithoutSoul: true });
    expect(readFileSync(soulMdPath(home), "utf-8")).toContain("# Moss");
    expect(readFileSync(soulMdPath(home), "utf-8")).not.toContain("old identity from agents");
    expect(readFileSync(agentsMdPath(home), "utf-8")).toBe("old identity from agents\n");
  });

  it("never materializes HEARTBEAT.md", () => {
    materializePromptFiles(home, "Moss");
    materializePromptFiles(home, "Moss");

    expect(existsSync(heartbeatMdPath(home))).toBe(false);
  });

  it("propagates non-ENOENT filesystem failures", () => {
    mkdirSync(join(home, "workspace"), { recursive: true });
    chmodSync(join(home, "workspace"), 0o500);
    expect(thrownBy(() => materializePromptFiles(home, "Moss"))).toBeDefined();
  });
});

describe("prompt-file ownership drift pins", () => {
  it("system-prompt.ts holds no prompt-file read or ENOENT policy of its own", () => {
    const source = readFileSync(join(import.meta.dir, "..", "agent", "system-prompt.ts"), "utf-8");
    expect(source).not.toContain("readFile");
    expect(source).not.toContain("access(");
    expect(source).not.toContain("ENOENT");
    expect(source).toContain("workspace/mod.ts");
    // Read policy dispatches on the catalog's requirement; call sites must
    // not re-select required-vs-optional policy per file name.
    expect(source).toContain("readPromptFile");
    expect(source).not.toContain("readRequiredPromptFile");
    expect(source).not.toContain("readOptionalPromptFile");
  });

  it("preflight delegates prompt-file checks to the module instead of enumerating paths", () => {
    const source = readFileSync(join(import.meta.dir, "..", "preflight.ts"), "utf-8");
    expect(source).toContain("preflightWorkspacePromptFiles");
    expect(source).not.toContain("soulMdPath");
    expect(source).not.toContain("agentsMdPath");
    expect(source).not.toContain("heartbeatMdPath");
    expect(source).not.toContain("preflightGoblinPromptFiles");
  });

  it("loop.ts delegates heartbeat prompt resolution instead of owning prompt-file reads", () => {
    const source = readFileSync(join(import.meta.dir, "..", "scheduler", "loop.ts"), "utf-8");
    expect(source).toContain("resolveHeartbeatPrompt");
    expect(source).toContain("workspace/mod.ts");
    expect(source).not.toContain("readFile");
    expect(source).not.toContain("ENOENT");
    expect(source).not.toContain("heartbeatMdPath");
    expect(source).not.toContain("surfaceHeartbeatPath");
  });

  it("event-handler.ts derives its write-notice reserved set from the module", () => {
    const source = readFileSync(join(import.meta.dir, "..", "agent", "event-handler.ts"), "utf-8");
    expect(source).toContain("reservedPromptFilePaths");
    expect(source).toContain("workspace/mod.ts");
    expect(source).not.toContain("soulMdPath");
    expect(source).not.toContain("agentsMdPath");
    expect(source).not.toContain("heartbeatMdPath");
    expect(source).not.toContain("surfaceHeartbeatPath");
  });

  it("host.ts derives its subagent exclusion set from the module", () => {
    const source = readFileSync(join(import.meta.dir, "..", "subagents", "host.ts"), "utf-8");
    expect(source).toContain("deploymentPromptFilePaths");
    expect(source).toContain("workspace/mod.ts");
    expect(source).not.toContain("soulMdPath");
    expect(source).not.toContain("agentsMdPath");
    expect(source).not.toContain("heartbeatMdPath");
  });

  it("doctor.ts derives prompt-file presence and required policy from the module", () => {
    const source = readFileSync(join(import.meta.dir, "..", "doctor.ts"), "utf-8");
    expect(source).toContain("workspace/mod.ts");
    expect(source).toContain("workspacePromptFile");
    expect(source).toContain("inspectPromptFile");
    expect(source).not.toContain("soulMdPath");
    expect(source).not.toContain("agentsMdPath");
    expect(source).not.toContain("heartbeatMdPath");
    expect(source).not.toContain("function inspectPromptFile");
  });

  it("onboard.ts delegates prompt-file materialization to the module", () => {
    const source = readFileSync(join(import.meta.dir, "..", "onboard.ts"), "utf-8");
    expect(source).toContain("materializePromptFiles");
    expect(source).toContain("workspace/mod.ts");
    expect(source).not.toContain('flag: "wx"');
    expect(source).not.toContain("writeFileSync(soulPath");
    expect(source).not.toContain("writeFileSync(agentsPath");
    expect(source).not.toContain("DEFAULT_AGENTS_TEMPLATE");
    expect(source).not.toContain("buildSoulTemplate(");
  });
});

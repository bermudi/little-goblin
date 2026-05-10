import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GOBLIN_PRODUCT_SHELL,
  MissingSoulError,
  buildGoblinSystemPrompt,
} from "./system-prompt.ts";

describe("GOBLIN_PRODUCT_SHELL", () => {
  it("contains approved runtime mechanics without deployed identity fallback", () => {
    expect(GOBLIN_PRODUCT_SHELL).toContain("## Runtime Mechanics");
    expect(GOBLIN_PRODUCT_SHELL).toContain("Telegram-native personal AI agent");
    expect(GOBLIN_PRODUCT_SHELL).toContain("Be truthful about tool results");
    expect(GOBLIN_PRODUCT_SHELL).toContain("Ask before irreversible or destructive actions");
    expect(GOBLIN_PRODUCT_SHELL).toContain("Memory snapshots arrive as per-turn context asides");
    expect(GOBLIN_PRODUCT_SHELL).not.toContain("Bermudi");
    expect(GOBLIN_PRODUCT_SHELL).not.toContain("your name is");
    expect(GOBLIN_PRODUCT_SHELL).not.toContain("coding assistant");
  });
});

describe("buildGoblinSystemPrompt", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-system-prompt-test-"));
  });

  afterEach(() => {
    chmodSync(tmpDir, 0o700);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("includes required SOUL, optional deployment AGENTS, product shell, and exact project AGENTS", async () => {
    const projectDir = join(tmpDir, "project");
    mkdirSync(projectDir);
    writeFileSync(join(tmpDir, "SOUL.md"), "soul identity\n", "utf-8");
    writeFileSync(join(tmpDir, "AGENTS.md"), "deployment rules\n", "utf-8");
    writeFileSync(join(projectDir, "AGENTS.md"), "project rules\n", "utf-8");

    const prompt = await buildGoblinSystemPrompt({ home: tmpDir, projectDir });

    expect(prompt).toContain("## Deployment Identity and Voice (SOUL.md)\n\nsoul identity");
    expect(prompt).toContain("## Deployment Operating Rules (AGENTS.md)\n\ndeployment rules");
    expect(prompt).toContain(GOBLIN_PRODUCT_SHELL);
    expect(prompt).toContain("## Project Guidance (projectDir/AGENTS.md)\n\nproject rules");
    expect(prompt.indexOf("soul identity")).toBeLessThan(prompt.indexOf("deployment rules"));
    expect(prompt.indexOf("deployment rules")).toBeLessThan(prompt.indexOf("## Runtime Mechanics"));
    expect(prompt.indexOf("## Runtime Mechanics")).toBeLessThan(prompt.indexOf("project rules"));
  });

  it("throws the shared missing-SOUL configuration error when SOUL.md is missing", async () => {
    await expect(buildGoblinSystemPrompt({ home: tmpDir })).rejects.toBeInstanceOf(MissingSoulError);
  });

  it("continues when optional deployment and project AGENTS files are missing", async () => {
    const projectDir = join(tmpDir, "project");
    mkdirSync(projectDir);
    writeFileSync(join(tmpDir, "SOUL.md"), "soul identity\n", "utf-8");

    const prompt = await buildGoblinSystemPrompt({ home: tmpDir, projectDir });

    expect(prompt).toContain("soul identity");
    expect(prompt).toContain(GOBLIN_PRODUCT_SHELL);
    expect(prompt).not.toContain("Deployment Operating Rules");
    expect(prompt).not.toContain("Project Guidance");
  });

  it("uses only the exact bound project AGENTS.md and excludes ancestor/global/compatibility files", async () => {
    const globalDir = join(tmpDir, "global");
    const parentDir = join(tmpDir, "parent");
    const projectDir = join(parentDir, "project");
    mkdirSync(globalDir);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(tmpDir, "SOUL.md"), "soul identity\n", "utf-8");
    writeFileSync(join(globalDir, "AGENTS.md"), "global rules\n", "utf-8");
    writeFileSync(join(parentDir, "AGENTS.md"), "ancestor rules\n", "utf-8");
    writeFileSync(join(projectDir, "CLAUDE.md"), "compat rules\n", "utf-8");
    writeFileSync(join(projectDir, ".cursorrules"), "cursor rules\n", "utf-8");
    writeFileSync(join(projectDir, "AGENTS.md"), "exact project rules\n", "utf-8");

    const prompt = await buildGoblinSystemPrompt({ home: tmpDir, projectDir });

    expect(prompt).toContain("exact project rules");
    expect(prompt).not.toContain("global rules");
    expect(prompt).not.toContain("ancestor rules");
    expect(prompt).not.toContain("compat rules");
    expect(prompt).not.toContain("cursor rules");
  });

  it("propagates non-ENOENT read failures for optional deployment AGENTS.md", async () => {
    writeFileSync(join(tmpDir, "SOUL.md"), "soul identity\n", "utf-8");
    writeFileSync(join(tmpDir, "AGENTS.md"), "deployment rules\n", "utf-8");
    chmodSync(join(tmpDir, "AGENTS.md"), 0o000);

    await expect(buildGoblinSystemPrompt({ home: tmpDir })).rejects.toThrow();
  });

  it("propagates non-ENOENT read failures for optional project AGENTS.md", async () => {
    const projectDir = join(tmpDir, "project");
    mkdirSync(projectDir);
    writeFileSync(join(tmpDir, "SOUL.md"), "soul identity\n", "utf-8");
    writeFileSync(join(projectDir, "AGENTS.md"), "project rules\n", "utf-8");
    chmodSync(join(projectDir, "AGENTS.md"), 0o000);

    await expect(buildGoblinSystemPrompt({ home: tmpDir, projectDir })).rejects.toThrow();
  });
});

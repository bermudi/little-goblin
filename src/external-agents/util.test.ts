import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPathWithinProject } from "./util.ts";

const dirs: string[] = [];

function makeProject(): { projectDir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "goblin-external-util-"));
  dirs.push(dir);
  return { projectDir: dir, cleanup: () => {} };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("isPathWithinProject", () => {
  it("allows files inside the project directory", () => {
    const { projectDir } = makeProject();
    writeFileSync(join(projectDir, "file.txt"), "hello");
    expect(isPathWithinProject(join(projectDir, "file.txt"), projectDir)).toBe(true);
  });

  it("allows files inside a new subdirectory of the project directory", () => {
    const { projectDir } = makeProject();
    expect(isPathWithinProject(join(projectDir, "sub", "file.txt"), projectDir)).toBe(true);
  });

  it("rejects files outside the project directory", () => {
    const { projectDir } = makeProject();
    expect(isPathWithinProject(join(tmpdir(), "evil.txt"), projectDir)).toBe(false);
  });

  it("rejects paths that escape via ..", () => {
    const { projectDir } = makeProject();
    expect(isPathWithinProject(join(projectDir, "..", "evil.txt"), projectDir)).toBe(false);
  });

  it("rejects a symlink pointing outside the project directory", () => {
    const { projectDir } = makeProject();
    const outside = mkdtempSync(join(tmpdir(), "goblin-external-outside-"));
    dirs.push(outside);
    symlinkSync(outside, join(projectDir, "link"));
    expect(isPathWithinProject(join(projectDir, "link"), projectDir)).toBe(false);
  });

  it("rejects a path inside a symlinked directory that points outside the project", () => {
    const { projectDir } = makeProject();
    const outside = mkdtempSync(join(tmpdir(), "goblin-external-outside-"));
    dirs.push(outside);
    mkdirSync(join(outside, "sub"), { recursive: true });
    symlinkSync(join(outside, "sub"), join(projectDir, "sub-link"));
    expect(isPathWithinProject(join(projectDir, "sub-link", "file.txt"), projectDir)).toBe(false);
  });

  it("rejects a new file path under a symlinked directory", () => {
    const { projectDir } = makeProject();
    const outside = mkdtempSync(join(tmpdir(), "goblin-external-outside-"));
    dirs.push(outside);
    symlinkSync(outside, join(projectDir, "out-link"));
    expect(isPathWithinProject(join(projectDir, "out-link", "new", "file.txt"), projectDir)).toBe(false);
  });

  it("rejects .. traversal through a symlink that points outside the project", () => {
    const { projectDir } = makeProject();
    const outside = mkdtempSync(join(tmpdir(), "goblin-external-outside-"));
    dirs.push(outside);
    mkdirSync(join(outside, "sub"), { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(join(outside, "sub"), join(projectDir, "link"));
    const path = `${projectDir}/link/../secret.txt`;
    expect(isPathWithinProject(path, projectDir)).toBe(false);
  });

  it("rejects a broken symlink that points outside the project", () => {
    const { projectDir } = makeProject();
    const outside = mkdtempSync(join(tmpdir(), "goblin-external-outside-"));
    dirs.push(outside);
    symlinkSync(join(outside, "nonexistent", "path"), join(projectDir, "link"));
    expect(isPathWithinProject(`${projectDir}/link`, projectDir)).toBe(false);
    expect(isPathWithinProject(`${projectDir}/link/../secret.txt`, projectDir)).toBe(false);
  });
});

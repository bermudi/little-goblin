import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { planDelegatedWorkLayout, applyDelegatedWorkLayout } from "./layout-migration.ts";
import { delegatedWorkRunsRoot } from "./paths.ts";

describe("planDelegatedWorkLayout", () => {
  let home: string;
  let runsRoot: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "goblin-layout-migration-"));
    runsRoot = delegatedWorkRunsRoot(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns runsRootExisted: false when the runs root is absent and creatable", () => {
    mkdirSync(dirname(runsRoot), { recursive: true });
    const plan = planDelegatedWorkLayout(home);
    expect(plan.runsRoot).toBe(runsRoot);
    expect(plan.runsRootExisted).toBe(false);
  });

  it("returns runsRootExisted: true when the runs root exists as a writable directory", () => {
    mkdirSync(runsRoot, { recursive: true });
    const plan = planDelegatedWorkLayout(home);
    expect(plan.runsRoot).toBe(runsRoot);
    expect(plan.runsRootExisted).toBe(true);
  });

  it("throws when the runs root exists as a regular file", () => {
    mkdirSync(dirname(runsRoot), { recursive: true });
    writeFileSync(runsRoot, "");
    expect(() => planDelegatedWorkLayout(home)).toThrow(
      /delegated-work runs root exists but is not a directory/,
    );
    expect(() => planDelegatedWorkLayout(home)).toThrow(runsRoot);
  });

  it("throws when the runs root is a dangling symlink", () => {
    mkdirSync(dirname(runsRoot), { recursive: true });
    symlinkSync(join(home, "missing-target"), runsRoot);
    expect(() => planDelegatedWorkLayout(home)).toThrow(
      /delegated-work runs root is a dangling symlink/,
    );
    expect(() => planDelegatedWorkLayout(home)).toThrow(runsRoot);
  });

  it("returns runsRootExisted: true when the runs root is a symlink to a writable directory", () => {
    const target = join(home, "real-runs-root");
    mkdirSync(target, { recursive: true });
    mkdirSync(dirname(runsRoot), { recursive: true });
    symlinkSync(target, runsRoot);
    const plan = planDelegatedWorkLayout(home);
    expect(plan.runsRoot).toBe(runsRoot);
    expect(plan.runsRootExisted).toBe(true);
    expect(lstatSync(runsRoot).isSymbolicLink()).toBe(true);
  });

  it("throws when the runs root exists as a directory but is not writable", () => {
    mkdirSync(runsRoot, { recursive: true });
    chmodSync(runsRoot, 0o555);
    try {
      expect(() => planDelegatedWorkLayout(home)).toThrow(/EACCES|permission denied/i);
    } finally {
      chmodSync(runsRoot, 0o755);
    }
  });

  it("throws when the runs root exists as a directory that is writable but not searchable", () => {
    mkdirSync(runsRoot, { recursive: true });
    chmodSync(runsRoot, 0o644);
    try {
      expect(() => planDelegatedWorkLayout(home)).toThrow(/EACCES|permission denied/i);
    } finally {
      chmodSync(runsRoot, 0o755);
    }
  });

  it("throws when the runs root is absent and its parent is not writable", () => {
    const parent = dirname(runsRoot);
    mkdirSync(parent, { recursive: true });
    chmodSync(parent, 0o555);
    try {
      expect(() => planDelegatedWorkLayout(home)).toThrow(/EACCES|permission denied/i);
    } finally {
      chmodSync(parent, 0o755);
    }
  });

  it("returns runsRootExisted: false when the runs root is absent but a writable ancestor exists", () => {
    mkdirSync(join(home, "state"), { recursive: true });
    const plan = planDelegatedWorkLayout(home);
    expect(plan.runsRoot).toBe(runsRoot);
    expect(plan.runsRootExisted).toBe(false);
    applyDelegatedWorkLayout(home, plan);
    expect(lstatSync(runsRoot).isDirectory()).toBe(true);
  });

  it("throws when the runs root is absent and the nearest existing ancestor is not writable", () => {
    mkdirSync(join(home, "state"), { recursive: true });
    chmodSync(join(home, "state"), 0o555);
    try {
      expect(() => planDelegatedWorkLayout(home)).toThrow(/EACCES|permission denied/i);
    } finally {
      chmodSync(join(home, "state"), 0o755);
    }
  });

  it("throws when an intermediate ancestor is a dangling symlink", () => {
    const intermediate = dirname(runsRoot);
    mkdirSync(dirname(intermediate), { recursive: true });
    symlinkSync(join(home, "missing-delegated-work"), intermediate);
    try {
      expect(() => planDelegatedWorkLayout(home)).toThrow(
        /delegated-work runs root ancestor is a dangling symlink/,
      );
      expect(() => planDelegatedWorkLayout(home)).toThrow(intermediate);
    } finally {
      // rmSync in afterEach handles cleanup; unlink here so a failed
      // assertion does not leave a symlink that would block removal.
      rmSync(intermediate, { force: true });
    }
  });
});

describe("applyDelegatedWorkLayout", () => {
  let home: string;
  let runsRoot: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "goblin-layout-migration-"));
    runsRoot = delegatedWorkRunsRoot(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("creates the runs root when the plan says it did not exist", () => {
    const plan = planDelegatedWorkLayout(home);
    expect(plan.runsRootExisted).toBe(false);
    applyDelegatedWorkLayout(home, plan);
    expect(lstatSync(runsRoot).isDirectory()).toBe(true);
  });

  it("is a no-op when the runs root already existed", () => {
    mkdirSync(runsRoot, { recursive: true });
    const plan = planDelegatedWorkLayout(home);
    expect(plan.runsRootExisted).toBe(true);
    const before = lstatSync(runsRoot).ino;
    applyDelegatedWorkLayout(home, plan);
    expect(lstatSync(runsRoot).ino).toBe(before);
  });
});

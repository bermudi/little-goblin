import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  environmentCwd,
  environmentFromProjectRoot,
  environmentsEqual,
  isProjectEnvironment,
  personalEnvironment,
  projectEnvironment,
  projectRootOf,
  resolveProjectRoot,
} from "./environment.ts";

describe("environment", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-env-test-"));
  });

  afterEach(() => {
    // Reset permissions so rmSync can clean up even after chmod 000 tests.
    try {
      chmodSync(tmpDir, 0o755);
    } catch {
      // ignore
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("resolveProjectRoot", () => {
    it("expands a leading tilde to the home directory", () => {
      const home = process.env.HOME ?? process.env.USERPROFILE ?? "/";
      expect(resolveProjectRoot("~")).toBe(resolve(home));
      expect(resolveProjectRoot("~/")).toBe(resolve(home));
    });

    it("resolves relative paths against the current working directory", () => {
      const dir = "src";
      const resolved = resolveProjectRoot(dir);
      expect(resolved.startsWith("/")).toBe(true);
      expect(resolved.endsWith("/src")).toBe(true);
    });

    it("returns the canonical realpath for an absolute directory", () => {
      const dir = join(tmpDir, "project");
      mkdirSync(dir, { recursive: true });
      expect(resolveProjectRoot(dir)).toBe(dir);
    });

    it("resolves symlinks to the real directory path", () => {
      const real = join(tmpDir, "real");
      const link = join(tmpDir, "link");
      mkdirSync(real, { recursive: true });
      symlinkSync(real, link);
      expect(resolveProjectRoot(link)).toBe(real);
    });

    it("throws when the path does not exist", () => {
      expect(() => resolveProjectRoot(join(tmpDir, "missing"))).toThrow(/does not exist/);
    });

    it("throws when the path is a file", () => {
      const file = join(tmpDir, "not-a-dir");
      writeFileSync(file, "x");
      expect(() => resolveProjectRoot(file)).toThrow(/not a directory/);
    });

    it("throws when the directory is not readable", () => {
      const dir = join(tmpDir, "no-read");
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o000);
      try {
        expect(() => resolveProjectRoot(dir)).toThrow(/not accessible/);
      } finally {
        chmodSync(dir, 0o755);
      }
    });

    it("throws when the directory is not writable", () => {
      const dir = join(tmpDir, "no-write");
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o555);
      try {
        expect(() => resolveProjectRoot(dir)).toThrow(/not accessible/);
      } finally {
        chmodSync(dir, 0o755);
      }
    });
  });

  describe("environment constructors and predicates", () => {
    it("personalEnvironment returns a personal env", () => {
      expect(personalEnvironment()).toEqual({ kind: "personal" });
    });

    it("projectEnvironment returns a project env", () => {
      expect(projectEnvironment("/foo")).toEqual({ kind: "project", projectRoot: "/foo" });
    });

    it("isProjectEnvironment narrows project envs", () => {
      const env = projectEnvironment("/foo");
      expect(isProjectEnvironment(env)).toBe(true);
      if (isProjectEnvironment(env)) {
        expect(env.projectRoot).toBe("/foo");
      }
      expect(isProjectEnvironment(personalEnvironment())).toBe(false);
    });

    it("projectRootOf returns the root or undefined", () => {
      expect(projectRootOf(projectEnvironment("/foo"))).toBe("/foo");
      expect(projectRootOf(personalEnvironment())).toBeUndefined();
    });
  });

  describe("environmentsEqual", () => {
    it("considers two personal environments equal", () => {
      expect(environmentsEqual(personalEnvironment(), personalEnvironment())).toBe(true);
    });

    it("considers project environments with the same root equal", () => {
      expect(environmentsEqual(projectEnvironment("/foo"), projectEnvironment("/foo"))).toBe(true);
    });

    it("considers project environments with different roots unequal", () => {
      expect(environmentsEqual(projectEnvironment("/foo"), projectEnvironment("/bar"))).toBe(false);
    });

    it("considers personal and project environments unequal", () => {
      expect(environmentsEqual(personalEnvironment(), projectEnvironment("/foo"))).toBe(false);
    });
  });

  describe("environmentFromProjectRoot", () => {
    it("returns personal for undefined or empty roots", () => {
      expect(environmentFromProjectRoot(undefined)).toEqual(personalEnvironment());
      expect(environmentFromProjectRoot("")).toEqual(personalEnvironment());
    });

    it("returns project for non-empty roots", () => {
      expect(environmentFromProjectRoot("/foo")).toEqual(projectEnvironment("/foo"));
    });
  });

  describe("environmentCwd", () => {
    it("returns workspacePath for personal environments", () => {
      const home = "/tmp/goblin-home";
      expect(environmentCwd(personalEnvironment(), home)).toBe(join(home, "workspace"));
    });

    it("returns projectRoot for project environments", () => {
      expect(environmentCwd(projectEnvironment("/srv/foo"), "/tmp/goblin-home")).toBe("/srv/foo");
    });
  });
});

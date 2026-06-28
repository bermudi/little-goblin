import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite } from "./fs.ts";

describe("atomicWrite", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-fs-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes data to a new file", () => {
    const target = join(tmpDir, "out.json");
    atomicWrite(target, '{"hello":"world"}');
    expect(readFileSync(target, "utf-8")).toBe('{"hello":"world"}');
  });

  it("overwrites an existing file with new contents", () => {
    const target = join(tmpDir, "out.json");
    writeFileSync(target, "old", "utf-8");
    atomicWrite(target, "new");
    expect(readFileSync(target, "utf-8")).toBe("new");
  });

  it("leaves no temp file behind", () => {
    const target = join(tmpDir, "out.json");
    atomicWrite(target, "data");
    expect(readdirSync(tmpDir)).toEqual(["out.json"]);
  });

  it("creates parent directories as needed", () => {
    const target = join(tmpDir, "nested", "deep", "out.json");
    atomicWrite(target, "data");
    expect(readFileSync(target, "utf-8")).toBe("data");
  });

  it("preserves a symlinked target (writes through to the real file)", () => {
    // Real file lives in a subdir; the symlink in tmpDir points at it.
    const realDir = join(tmpDir, "real");
    mkdirSync(realDir, { recursive: true });
    const realFile = join(realDir, "state.json");
    writeFileSync(realFile, "old", "utf-8");

    const link = join(tmpDir, "state.json");
    symlinkSync(realFile, link);

    atomicWrite(link, "new");

    // The symlink itself must still be a symlink.
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    // And the real file must hold the new contents.
    expect(readFileSync(realFile, "utf-8")).toBe("new");
    expect(readFileSync(link, "utf-8")).toBe("new");
  });

  it("writes through a symlinked parent directory", () => {
    // Real dir lives elsewhere; symlink in tmpDir points at it.
    const realDir = join(tmpDir, "real-target");
    mkdirSync(realDir, { recursive: true });
    const linkDir = join(tmpDir, "link-dir");
    symlinkSync(realDir, linkDir);

    const target = join(linkDir, "state.json");
    atomicWrite(target, "payload");

    // The symlinked dir must still be a symlink.
    expect(lstatSync(linkDir).isSymbolicLink()).toBe(true);
    // The real directory holds the file.
    expect(readFileSync(join(realDir, "state.json"), "utf-8")).toBe("payload");
  });

  describe("failure paths", () => {
    // These tests lock in two contracts:
    //   1. atomicWrite propagates errors (does not swallow them).
    //   2. No `.tmp` file leaks into the target directory on failure.
    //      This matters because memory/store.ts archiveOrphan aborts on
    //      any `.tmp` file present in a scope directory.
    //
    // We trigger pre-tmp-creation failures (mkdir / open), which are the
    // reliably portable cases. The write/fsync/rename failure branch
    // shares the same cleanup catch block, so the structural guarantee
    // holds there too even though we can't trigger it without mocking fs.

    it("throws and leaves no tmp when the parent path is a file, not a dir", () => {
      // `dir` resolves to a regular file → mkdirSync throws ENOTDIR,
      // which is NOT suppressed by the EEXIST catch, so it propagates.
      const blocker = join(tmpDir, "blocker");
      writeFileSync(blocker, "x", "utf-8");
      const target = join(blocker, "out.json");

      expect(() => atomicWrite(target, "data")).toThrow();
      // tmpDir contains only the blocker file — no stray .tmp.
      expect(readdirSync(tmpDir)).toEqual(["blocker"]);
    });

    it("throws and leaves no tmp when the parent dir is read-only", () => {
      // Read-only dir → openSync cannot create the tmp file → EACCES.
      const roDir = join(tmpDir, "readonly");
      mkdirSync(roDir, { recursive: true });
      chmodSync(roDir, 0o555);
      const target = join(roDir, "out.json");

      try {
        expect(() => atomicWrite(target, "data")).toThrow();
        // No tmp file leaked into the read-only dir.
        expect(readdirSync(roDir)).toEqual([]);
      } finally {
        // Restore so afterEach cleanup can remove it.
        chmodSync(roDir, 0o755);
      }
    });
  });
});

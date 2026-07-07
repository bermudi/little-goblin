import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadJsonFile, saveJsonFile } from "./state-file.ts";
import { log } from "../log.ts";

describe("state-file", () => {
  let tmpDir: string;
  let path: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-state-file-"));
    path = join(tmpDir, "state.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("loadJsonFile", () => {
    it("returns parsed JSON when the file exists", () => {
      writeFileSync(path, JSON.stringify({ a: 1, b: [2, 3] }), "utf-8");
      const value = loadJsonFile<{ a: number; b: number[] }>(path, { a: 0, b: [] });
      expect(value).toEqual({ a: 1, b: [2, 3] });
    });

    it("returns a null default on ENOENT (file missing)", () => {
      const missing = join(tmpDir, "nope.json");
      const value = loadJsonFile<{ x: number } | null>(missing, null);
      expect(value).toBeNull();
    });

    it("returns a structured-clone default on ENOENT", () => {
      const missing = join(tmpDir, "nope.json");
      const def = { items: [] as number[] };
      const value = loadJsonFile(missing, def);
      expect(value).toEqual({ items: [] });
    });

    it("returns the default and logs a warning on malformed JSON", () => {
      writeFileSync(path, "not json {{{", "utf-8");
      const calls: { msg: string; extra: unknown }[] = [];
      const originalWarn = log.warn;
      // bun:test `mock()` spies carry through `.mock.calls`, but swapping the
      // method on the singleton is the simplest way to observe the warn path
      // without pulling process-global `mock.module` machinery into a unit test.
      log.warn = (msg: string, extra?: unknown) => { calls.push({ msg, extra }); };

      try {
        const value = loadJsonFile<{ ok: boolean } | null>(path, null);
        expect(value).toBeNull();
        expect(calls).toHaveLength(1);
        expect(calls[0]!.msg).toBe("malformed JSON state file, returning default");
        expect(calls[0]!.extra).toMatchObject({ path });
      } finally {
        log.warn = originalWarn;
      }
    });

    it("propagates non-ENOENT, non-Syntax errors (e.g. EISDIR)", () => {
      // Reading a directory throws EISDIR — not ENOENT, not SyntaxError.
      mkdirSync(join(tmpDir, "adir"));
      const dirPath = join(tmpDir, "adir");
      expect(() => loadJsonFile(dirPath, null)).toThrow();
    });
  });

  describe("saveJsonFile", () => {
    it("writes JSON.stringify(value, null, 2) + newline", () => {
      saveJsonFile(path, { hello: "world", n: 3 });
      const onDisk = readFileSync(path, "utf-8");
      expect(onDisk).toBe(JSON.stringify({ hello: "world", n: 3 }, null, 2) + "\n");
    });

    it("creates parent directories as needed (atomicWrite)", () => {
      const nested = join(tmpDir, "nested", "deep", "state.json");
      saveJsonFile(nested, { ok: true });
      expect(readFileSync(nested, "utf-8")).toBe(JSON.stringify({ ok: true }, null, 2) + "\n");
    });

    it("round-trips through loadJsonFile", () => {
      type Shape = { name: string; flags: boolean[]; nested: { k: number } };
      const original: Shape = { name: "goblin", flags: [true, false], nested: { k: 1 } };
      saveJsonFile(path, original);
      const loaded = loadJsonFile<Shape>(path, { name: "", flags: [], nested: { k: 0 } });
      expect(loaded).toEqual(original);
    });
  });
});

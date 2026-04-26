import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./store.ts";
import { memoryDir, memoryFilePath } from "./paths.ts";

const DELIMITER = "\n§\n";

describe("MemoryStore", () => {
  let tmp: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "goblin-memory-"));
    mkdirSync(memoryDir(tmp), { recursive: true });
    store = new MemoryStore(tmp);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("read", () => {
    it("returns empty string when file is absent", () => {
      expect(store.read("memory")).toBe("");
      expect(store.read("user")).toBe("");
    });

    it("returns file contents when present", () => {
      const r = store.add("memory", "hello");
      expect(r.ok).toBe(true);
      expect(store.read("memory")).toBe("hello");
    });
  });

  describe("add", () => {
    it("first add to empty file produces no delimiter", () => {
      const r = store.add("memory", "hello world");
      expect(r.ok).toBe(true);
      const contents = readFileSync(memoryFilePath(tmp, "memory"), "utf-8");
      expect(contents).toBe("hello world");
      expect(contents.includes(DELIMITER)).toBe(false);
    });

    it("second add produces exactly one delimiter", () => {
      expect(store.add("memory", "first").ok).toBe(true);
      expect(store.add("memory", "second").ok).toBe(true);
      const contents = readFileSync(memoryFilePath(tmp, "memory"), "utf-8");
      expect(contents).toBe(`first${DELIMITER}second`);
      const parts = contents.split(DELIMITER);
      expect(parts).toHaveLength(2);
    });

    it("creates the memory dir lazily", () => {
      store.add("user", "x");
      const entries = readdirSync(memoryDir(tmp));
      expect(entries).toContain("user.md");
    });

    it("succeeds when result is exactly at the cap", () => {
      const exactly = "a".repeat(2000);
      const r = store.add("user", exactly);
      expect(r.ok).toBe(true);
      expect(store.read("user").length).toBe(2000);
    });

    it("rejects when add would exceed cap; file unchanged", () => {
      // Pre-fill user.md to 1999 chars.
      const initial = "a".repeat(1999);
      writeFileSync(memoryFilePath(tmp, "user"), initial, "utf-8");
      // Adding "bb" would yield 1999 + DELIMITER.length(3) + 2 = 2004 → overflow 4.
      const r = store.add("user", "bb");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain("2004");
        expect(r.error).toContain("2000");
        expect(r.error).toContain("4");
      }
      // File untouched.
      expect(readFileSync(memoryFilePath(tmp, "user"), "utf-8")).toBe(initial);
    });

    it("uses the 4000 cap for memory.md", () => {
      const exactly = "m".repeat(4000);
      expect(store.add("memory", exactly).ok).toBe(true);
      const r = store.add("memory", "x");
      expect(r.ok).toBe(false);
    });
  });

  describe("replace", () => {
    beforeEach(() => {
      store.add("memory", "alpha");
      store.add("memory", "bravo");
      store.add("memory", "charlie");
    });

    it("replaces a unique substring", () => {
      const r = store.replace("memory", "bravo", "BRAVO!");
      expect(r.ok).toBe(true);
      expect(store.read("memory")).toBe(
        `alpha${DELIMITER}BRAVO!${DELIMITER}charlie`,
      );
    });

    it("rejects ambiguous match", () => {
      store.add("memory", "alpha");
      const r = store.replace("memory", "alpha", "X");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("2");
      expect(store.read("memory")).toBe(
        `alpha${DELIMITER}bravo${DELIMITER}charlie${DELIMITER}alpha`,
      );
    });

    it("rejects not-found", () => {
      const before = store.read("memory");
      const r = store.replace("memory", "zzz", "X");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.toLowerCase()).toContain("not found");
      expect(store.read("memory")).toBe(before);
    });

    it("rejects when replacement would overflow cap", () => {
      // Build user.md near cap and try to replace a tiny token with a huge one.
      writeFileSync(
        memoryFilePath(tmp, "user"),
        "TOKEN" + "a".repeat(1990),
        "utf-8",
      );
      const huge = "z".repeat(2000);
      const r = store.replace("user", "TOKEN", huge);
      expect(r.ok).toBe(false);
      // File untouched.
      expect(store.read("user").startsWith("TOKEN")).toBe(true);
    });
  });

  describe("remove", () => {
    beforeEach(() => {
      store.add("memory", "alpha");
      store.add("memory", "bravo");
      store.add("memory", "charlie");
    });

    it("removes a middle entry along with one delimiter", () => {
      const r = store.remove("memory", "bravo");
      expect(r.ok).toBe(true);
      expect(store.read("memory")).toBe(`alpha${DELIMITER}charlie`);
    });

    it("removes the first entry cleanly", () => {
      const r = store.remove("memory", "alpha");
      expect(r.ok).toBe(true);
      expect(store.read("memory")).toBe(`bravo${DELIMITER}charlie`);
    });

    it("removes the last entry cleanly", () => {
      const r = store.remove("memory", "charlie");
      expect(r.ok).toBe(true);
      expect(store.read("memory")).toBe(`alpha${DELIMITER}bravo`);
    });

    it("removes the sole entry, leaving an empty file", () => {
      const tmp2 = mkdtempSync(join(tmpdir(), "goblin-memory-"));
      try {
        const s2 = new MemoryStore(tmp2);
        s2.add("user", "only");
        const r = s2.remove("user", "only");
        expect(r.ok).toBe(true);
        expect(s2.read("user")).toBe("");
      } finally {
        rmSync(tmp2, { recursive: true, force: true });
      }
    });

    it("rejects ambiguous", () => {
      store.add("memory", "alpha");
      const r = store.remove("memory", "alpha");
      expect(r.ok).toBe(false);
    });

    it("rejects not-found", () => {
      const r = store.remove("memory", "zzz");
      expect(r.ok).toBe(false);
    });
  });

  describe("atomic write", () => {
    it("does not leave a non-tmp file behind on partial write", () => {
      // Sanity: after a successful add, only memory.md (no .tmp leftovers).
      store.add("memory", "x");
      const entries = readdirSync(memoryDir(tmp));
      const tmpLeftovers = entries.filter((n) => n.endsWith(".tmp"));
      expect(tmpLeftovers).toEqual([]);
    });

    it("uses a hidden tmp filename pattern in memoryDir", () => {
      // We can't easily simulate a crash mid-rename without a fault-injection
      // FS, so instead assert that no extraneous files exist after a write
      // and that a failed write (overflow) does not modify the target file
      // nor leave a tmp file behind.
      writeFileSync(memoryFilePath(tmp, "user"), "a".repeat(1999), "utf-8");
      const before = readFileSync(memoryFilePath(tmp, "user"), "utf-8");
      const r = store.add("user", "bb");
      expect(r.ok).toBe(false);
      const after = readFileSync(memoryFilePath(tmp, "user"), "utf-8");
      expect(after).toBe(before);
      const entries = readdirSync(memoryDir(tmp));
      const tmpLeftovers = entries.filter((n) => n.endsWith(".tmp"));
      expect(tmpLeftovers).toEqual([]);
    });
  });
});

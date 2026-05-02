import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./store.ts";
import { archiveTopicPath, memoryDir, scopeMemoryPath, userPath } from "./paths.ts";

const DELIMITER = "\n§\n";

function gitOut(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
  return (r.stdout ?? "").trim();
}

function commitCount(cwd: string): number {
  const out = gitOut(cwd, ["rev-list", "--count", "HEAD"]);
  return Number.parseInt(out, 10);
}

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
    it("returns empty parsed memory when file is absent", () => {
      expect(store.read("memory")).toEqual({ body: "" });
      expect(store.read("user")).toEqual({ body: "" });
    });

    it("returns file contents when present", () => {
      expect(store.add("memory", "hello").ok).toBe(true);
      expect(store.readBody("memory")).toBe("hello");
    });

    it("parses one-line description frontmatter separately from body", () => {
      const scope = { topic: { chatId: -100, topicId: 42 } };
      mkdirSync(join(memoryDir(tmp), "topics", "-100", "42"), { recursive: true });
      writeFileSync(
        scopeMemoryPath(tmp, scope),
        "---\ndescription: health notes\n---\n\nalpha",
        "utf-8",
      );
      expect(store.read(scope)).toEqual({ description: "health notes", body: "alpha" });
    });
  });

  describe("add", () => {
    it("first add to empty file produces no delimiter", () => {
      expect(store.add("memory", "hello world").ok).toBe(true);
      const contents = readFileSync(scopeMemoryPath(tmp, "general"), "utf-8");
      expect(contents).toBe("hello world");
      expect(contents.includes(DELIMITER)).toBe(false);
    });

    it("second add produces exactly one delimiter", () => {
      expect(store.add("memory", "first").ok).toBe(true);
      expect(store.add("memory", "second").ok).toBe(true);
      expect(readFileSync(scopeMemoryPath(tmp, "general"), "utf-8")).toBe(
        `first${DELIMITER}second`,
      );
    });

    it("creates scope directories lazily", () => {
      const scope = { topic: { chatId: -100, topicId: 42 } };
      expect(store.add(scope, "x").ok).toBe(true);
      expect(readFileSync(scopeMemoryPath(tmp, scope), "utf-8")).toBe("x");
    });

    it("succeeds when result is exactly at the cap", () => {
      expect(store.add("user", "a".repeat(2000)).ok).toBe(true);
      expect(store.readBody("user").length).toBe(2000);
    });

    it("rejects when add would exceed cap; file unchanged", () => {
      const initial = "a".repeat(1999);
      mkdirSync(memoryDir(tmp), { recursive: true });
      writeFileSync(userPath(tmp), initial, "utf-8");
      const r = store.add("user", "bb");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain("2004");
        expect(r.error).toContain("2000");
        expect(r.error).toContain("4");
      }
      expect(readFileSync(userPath(tmp), "utf-8")).toBe(initial);
    });

    it("keeps caps independent per scope", () => {
      const topic42 = { topic: { chatId: -100, topicId: 42 } };
      const topic7 = { topic: { chatId: -100, topicId: 7 } };
      expect(store.add(topic42, "m".repeat(4000)).ok).toBe(true);
      expect(store.add(topic42, "x").ok).toBe(false);
      expect(store.add(topic7, "fresh").ok).toBe(true);
      expect(store.readBody(topic7)).toBe("fresh");
    });
  });

  describe("replace", () => {
    beforeEach(() => {
      store.add("memory", "alpha");
      store.add("memory", "bravo");
      store.add("memory", "charlie");
    });

    it("replaces a unique substring", () => {
      expect(store.replace("memory", "bravo", "BRAVO!").ok).toBe(true);
      expect(store.readBody("memory")).toBe(`alpha${DELIMITER}BRAVO!${DELIMITER}charlie`);
    });

    it("rejects ambiguous match", () => {
      store.add("memory", "alpha");
      const r = store.replace("memory", "alpha", "X");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("2");
    });

    it("rejects not-found", () => {
      const before = store.readBody("memory");
      const r = store.replace("memory", "zzz", "X");
      expect(r.ok).toBe(false);
      expect(store.readBody("memory")).toBe(before);
    });
  });

  describe("remove", () => {
    beforeEach(() => {
      store.add("memory", "alpha");
      store.add("memory", "bravo");
      store.add("memory", "charlie");
    });

    it("removes a middle entry along with one delimiter", () => {
      expect(store.remove("memory", "bravo").ok).toBe(true);
      expect(store.readBody("memory")).toBe(`alpha${DELIMITER}charlie`);
    });

    it("removes the first entry cleanly", () => {
      expect(store.remove("memory", "alpha").ok).toBe(true);
      expect(store.readBody("memory")).toBe(`bravo${DELIMITER}charlie`);
    });

    it("removes the last entry cleanly", () => {
      expect(store.remove("memory", "charlie").ok).toBe(true);
      expect(store.readBody("memory")).toBe(`alpha${DELIMITER}bravo`);
    });

    it("removes the sole entry, leaving an empty file", () => {
      const tmp2 = mkdtempSync(join(tmpdir(), "goblin-memory-"));
      try {
        const s2 = new MemoryStore(tmp2);
        s2.add("user", "only");
        expect(s2.remove("user", "only").ok).toBe(true);
        expect(s2.readBody("user")).toBe("");
      } finally {
        rmSync(tmp2, { recursive: true, force: true });
      }
    });
  });

  describe("frontmatter", () => {
    it("setDescription preserves body and empty description removes header", () => {
      const scope = { topic: { chatId: -100, topicId: 42 } };
      store.add(scope, "alpha");
      expect(store.setDescription(scope, "health notes").ok).toBe(true);
      expect(readFileSync(scopeMemoryPath(tmp, scope), "utf-8")).toBe(
        "---\ndescription: health notes\n---\n\nalpha",
      );
      expect(store.setDescription(scope, "").ok).toBe(true);
      expect(readFileSync(scopeMemoryPath(tmp, scope), "utf-8")).toBe("alpha");
    });

    it("round-trips description through add, replace, remove, and rewrite", () => {
      const scope = { topic: { chatId: -100, topicId: 42 } };
      store.setDescription(scope, "ops notes");
      store.add(scope, "alpha");
      store.add(scope, "bravo");
      store.replace(scope, "bravo", "charlie");
      store.remove(scope, "alpha");
      store.rewrite(scope, "delta");
      expect(store.read(scope)).toEqual({ description: "ops notes", body: "delta" });
    });

    it("rejects multiline and overlong descriptions", () => {
      expect(store.setDescription("memory", "bad\nwolf").ok).toBe(false);
      expect(store.setDescription("memory", "x".repeat(201)).ok).toBe(false);
    });

    it("excludes frontmatter from body cap calculation", () => {
      const scope = { agent: { name: "researcher" } };
      expect(store.setDescription(scope, "x".repeat(200)).ok).toBe(true);
      expect(store.rewrite(scope, "m".repeat(4000)).ok).toBe(true);
      expect(store.read(scope).body.length).toBe(4000);
    });
  });

  describe("atomic write", () => {
    it("does not leave a non-tmp file behind on successful write", () => {
      store.add("memory", "x");
      const entries = readdirSync(join(memoryDir(tmp), "general"));
      expect(entries.filter((n) => n.endsWith(".tmp"))).toEqual([]);
    });

    it("uses a hidden tmp filename pattern in target dir", () => {
      writeFileSync(userPath(tmp), "a".repeat(1999), "utf-8");
      const before = readFileSync(userPath(tmp), "utf-8");
      expect(store.add("user", "bb").ok).toBe(false);
      expect(readFileSync(userPath(tmp), "utf-8")).toBe(before);
      expect(readdirSync(memoryDir(tmp)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    });
  });

  describe("git versioning", () => {
    it("first successful write initializes .git", () => {
      const dir = memoryDir(tmp);
      expect(existsSync(join(dir, ".git"))).toBe(false);
      expect(store.add("memory", "first").ok).toBe(true);
      expect(existsSync(join(dir, ".git"))).toBe(true);
      expect(commitCount(dir)).toBe(1);
    });

    it("each successful write produces exactly one commit", () => {
      const dir = memoryDir(tmp);
      store.add("memory", "alpha");
      expect(commitCount(dir)).toBe(1);
      store.add("user", "u-pref");
      expect(commitCount(dir)).toBe(2);
      store.replace("memory", "alpha", "ALPHA");
      expect(commitCount(dir)).toBe(3);
      store.remove("memory", "ALPHA");
      expect(commitCount(dir)).toBe(4);
    });

    it("commit subjects include scope tags", () => {
      const dir = memoryDir(tmp);
      store.add("user", "x");
      expect(gitOut(dir, ["log", "-1", "--format=%s"])).toBe("memory: add in user");
      store.add({ topic: { chatId: -100, topicId: 42 } }, "m1");
      expect(gitOut(dir, ["log", "-1", "--format=%s"])).toBe(
        "memory: add in topics/-100/42",
      );
      store.setDescription("memory", "general notes");
      expect(gitOut(dir, ["log", "-1", "--format=%s"])).toBe(
        "memory: set_description in general",
      );
    });

    it("swallows commit failures: file persists, no throw, no commit", () => {
      const dir = memoryDir(tmp);
      writeFileSync(join(dir, ".git"), "not a real repo", "utf-8");
      expect(store.add("memory", "should-persist").ok).toBe(true);
      expect(store.readBody("memory")).toBe("should-persist");
      const rev = spawnSync("git", ["rev-list", "--count", "HEAD"], {
        cwd: dir,
        encoding: "utf-8",
      });
      expect(rev.status).not.toBe(0);
    });

    it("failed writes do not produce commits", () => {
      const dir = memoryDir(tmp);
      store.add("memory", "seed");
      const before = commitCount(dir);
      writeFileSync(userPath(tmp), "a".repeat(1999), "utf-8");
      expect(store.add("user", "bb").ok).toBe(false);
      store.add("memory", "seed");
      expect(store.replace("memory", "seed", "X").ok).toBe(false);
      expect(commitCount(dir)).toBe(before + 1);
    });
  });

  describe("archiveOrphan", () => {
    it("moves a topic directory to archive and commits", () => {
      const scope = { topic: { chatId: -100, topicId: 42 } };
      store.add(scope, "alpha");
      expect(store.archiveOrphan(-100, 42)).toBe(true);
      expect(existsSync(scopeMemoryPath(tmp, scope))).toBe(false);
      expect(existsSync(join(archiveTopicPath(tmp, -100, 42), "memory.md"))).toBe(true);
      expect(gitOut(memoryDir(tmp), ["log", "-1", "--format=%s"])).toBe(
        "memory: archive orphan topics/-100/42",
      );
      const treePaths = gitOut(memoryDir(tmp), ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n");
      expect(treePaths).toContain("archive/topics/-100/42/memory.md");
      expect(treePaths).not.toContain("topics/-100/42/memory.md");
      expect(gitOut(memoryDir(tmp), ["status", "--short"])).toBe("");
    });

    it("returns false when the source is missing", () => {
      expect(store.archiveOrphan(-100, 42)).toBe(false);
    });
  });

  describe("listIndex", () => {
    it("filters topics by chat id and optionally includes agents", () => {
      store.setDescription({ topic: { chatId: -100, topicId: 1 } }, "chat A one");
      store.setDescription({ topic: { chatId: -100, topicId: 2 } }, "chat A two");
      store.setDescription({ topic: { chatId: -200, topicId: 9 } }, "chat B nine");
      store.setDescription({ agent: { name: "researcher" } }, "research persona");

      expect(store.listIndex({ chatId: -100, includeAgents: false })).toEqual({
        topics: [
          { chatId: -100, topicId: 1, description: "chat A one" },
          { chatId: -100, topicId: 2, description: "chat A two" },
        ],
        agents: [],
      });
      expect(store.listIndex({ includeAgents: true })).toEqual({
        topics: [
          { chatId: -200, topicId: 9, description: "chat B nine" },
          { chatId: -100, topicId: 1, description: "chat A one" },
          { chatId: -100, topicId: 2, description: "chat A two" },
        ],
        agents: [{ name: "researcher", description: "research persona" }],
      });
    });
  });
});

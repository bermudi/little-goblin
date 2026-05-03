import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

    it("returns file contents when present", async () => {
      expect((await store.add("memory", "hello")).ok).toBe(true);
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
    it("first add to empty file produces no delimiter", async () => {
      expect((await store.add("memory", "hello world")).ok).toBe(true);
      const contents = readFileSync(scopeMemoryPath(tmp, "general"), "utf-8");
      expect(contents).toBe("hello world");
      expect(contents.includes(DELIMITER)).toBe(false);
    });

    it("second add produces exactly one delimiter", async () => {
      expect((await store.add("memory", "first")).ok).toBe(true);
      expect((await store.add("memory", "second")).ok).toBe(true);
      expect(readFileSync(scopeMemoryPath(tmp, "general"), "utf-8")).toBe(
        `first${DELIMITER}second`,
      );
    });

    it("creates scope directories lazily", async () => {
      const scope = { topic: { chatId: -100, topicId: 42 } };
      expect((await store.add(scope, "x")).ok).toBe(true);
      expect(readFileSync(scopeMemoryPath(tmp, scope), "utf-8")).toBe("x");
    });

    it("succeeds when result is exactly at the cap", async () => {
      expect((await store.add("user", "a".repeat(2000))).ok).toBe(true);
      expect(store.readBody("user").length).toBe(2000);
    });

    it("rejects when add would exceed cap; file unchanged", async () => {
      const initial = "a".repeat(1999);
      mkdirSync(memoryDir(tmp), { recursive: true });
      writeFileSync(userPath(tmp), initial, "utf-8");
      const r = await store.add("user", "bb");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain("2004");
        expect(r.error).toContain("2000");
        expect(r.error).toContain("4");
      }
      expect(readFileSync(userPath(tmp), "utf-8")).toBe(initial);
    });

    it("keeps caps independent per scope", async () => {
      const topic42 = { topic: { chatId: -100, topicId: 42 } };
      const topic7 = { topic: { chatId: -100, topicId: 7 } };
      expect((await store.add(topic42, "m".repeat(4000))).ok).toBe(true);
      expect((await store.add(topic42, "x")).ok).toBe(false);
      expect((await store.add(topic7, "fresh")).ok).toBe(true);
      expect(store.readBody(topic7)).toBe("fresh");
    });
  });

  describe("replace", () => {
    beforeEach(async () => {
      await store.add("memory", "alpha");
      await store.add("memory", "bravo");
      await store.add("memory", "charlie");
    });

    it("replaces a unique substring", async () => {
      expect((await store.replace("memory", "bravo", "BRAVO!")).ok).toBe(true);
      expect(store.readBody("memory")).toBe(`alpha${DELIMITER}BRAVO!${DELIMITER}charlie`);
    });

    it("rejects ambiguous match", async () => {
      await store.add("memory", "alpha");
      const r = await store.replace("memory", "alpha", "X");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("2");
    });

    it("rejects not-found", async () => {
      const before = store.readBody("memory");
      const r = await store.replace("memory", "zzz", "X");
      expect(r.ok).toBe(false);
      expect(store.readBody("memory")).toBe(before);
    });
  });

  describe("remove", () => {
    beforeEach(async () => {
      await store.add("memory", "alpha");
      await store.add("memory", "bravo");
      await store.add("memory", "charlie");
    });

    it("removes a middle entry along with one delimiter", async () => {
      expect((await store.remove("memory", "bravo")).ok).toBe(true);
      expect(store.readBody("memory")).toBe(`alpha${DELIMITER}charlie`);
    });

    it("removes the first entry cleanly", async () => {
      expect((await store.remove("memory", "alpha")).ok).toBe(true);
      expect(store.readBody("memory")).toBe(`bravo${DELIMITER}charlie`);
    });

    it("removes the last entry cleanly", async () => {
      expect((await store.remove("memory", "charlie")).ok).toBe(true);
      expect(store.readBody("memory")).toBe(`alpha${DELIMITER}bravo`);
    });

    it("removes the sole entry, leaving an empty file", async () => {
      const tmp2 = mkdtempSync(join(tmpdir(), "goblin-memory-"));
      try {
        const s2 = new MemoryStore(tmp2);
        await s2.add("user", "only");
        expect((await s2.remove("user", "only")).ok).toBe(true);
        expect(s2.readBody("user")).toBe("");
      } finally {
        rmSync(tmp2, { recursive: true, force: true });
      }
    });

    it("handles entry containing the section delimiter character", async () => {
      // Regression test: entry content containing '§' should not confuse removal
      await store.add("memory", `text with section ${DELIMITER.trim()} inside`);
      expect((await store.remove("memory", "bravo")).ok).toBe(true);
      // The entry with the delimiter inside should remain intact
      const body = store.readBody("memory");
      expect(body).toContain("text with section");
      expect(body).not.toContain("bravo");
    });

    it("handles entry containing partial delimiter", async () => {
      // Regression test: entry containing just '\n§' or '§\n' should not confuse removal
      await store.add("memory", "line1\n§line2");
      expect((await store.remove("memory", "bravo")).ok).toBe(true);
      const body = store.readBody("memory");
      expect(body).toContain("line1\n§line2");
      expect(body).not.toContain("bravo");
    });
  });

  describe("frontmatter", () => {
    it("setDescription preserves body and empty description removes header", async () => {
      const scope = { topic: { chatId: -100, topicId: 42 } };
      await store.add(scope, "alpha");
      expect((await store.setDescription(scope, "health notes")).ok).toBe(true);
      expect(readFileSync(scopeMemoryPath(tmp, scope), "utf-8")).toBe(
        "---\ndescription: health notes\n---\n\nalpha",
      );
      expect((await store.setDescription(scope, "")).ok).toBe(true);
      expect(readFileSync(scopeMemoryPath(tmp, scope), "utf-8")).toBe("alpha");
    });

    it("round-trips description through add, replace, remove, and rewrite", async () => {
      const scope = { topic: { chatId: -100, topicId: 42 } };
      await store.setDescription(scope, "ops notes");
      await store.add(scope, "alpha");
      await store.add(scope, "bravo");
      await store.replace(scope, "bravo", "charlie");
      await store.remove(scope, "alpha");
      await store.rewrite(scope, "delta");
      expect(store.read(scope)).toEqual({ description: "ops notes", body: "delta" });
    });

    it("rejects multiline and overlong descriptions", async () => {
      expect((await store.setDescription("memory", "bad\nwolf")).ok).toBe(false);
      expect((await store.setDescription("memory", "x".repeat(201))).ok).toBe(false);
    });

    it("excludes frontmatter from body cap calculation", async () => {
      const scope = { agent: { name: "researcher" } };
      expect((await store.setDescription(scope, "x".repeat(200))).ok).toBe(true);
      expect((await store.rewrite(scope, "m".repeat(4000))).ok).toBe(true);
      expect(store.read(scope).body.length).toBe(4000);
    });
  });

  describe("atomic write", () => {
    it("does not leave a non-tmp file behind on successful write", async () => {
      await store.add("memory", "x");
      const entries = readdirSync(join(memoryDir(tmp), "general"));
      expect(entries.filter((n) => n.endsWith(".tmp"))).toEqual([]);
    });

    it("uses a hidden tmp filename pattern in target dir", async () => {
      writeFileSync(userPath(tmp), "a".repeat(1999), "utf-8");
      const before = readFileSync(userPath(tmp), "utf-8");
      expect((await store.add("user", "bb")).ok).toBe(false);
      expect(readFileSync(userPath(tmp), "utf-8")).toBe(before);
      expect(readdirSync(memoryDir(tmp)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    });
  });

  describe("git versioning", () => {
    it("first successful write initializes .git", async () => {
      const dir = memoryDir(tmp);
      expect(existsSync(join(dir, ".git"))).toBe(false);
      expect((await store.add("memory", "first")).ok).toBe(true);
      expect(existsSync(join(dir, ".git"))).toBe(true);
      expect(commitCount(dir)).toBe(1);
    });

    it("each successful write produces exactly one commit", async () => {
      const dir = memoryDir(tmp);
      await store.add("memory", "alpha");
      expect(commitCount(dir)).toBe(1);
      await store.add("user", "u-pref");
      expect(commitCount(dir)).toBe(2);
      await store.replace("memory", "alpha", "ALPHA");
      expect(commitCount(dir)).toBe(3);
      await store.remove("memory", "ALPHA");
      expect(commitCount(dir)).toBe(4);
    });

    it("commit subjects include scope tags", async () => {
      const dir = memoryDir(tmp);
      await store.add("user", "x");
      expect(gitOut(dir, ["log", "-1", "--format=%s"])).toBe("memory: add in user");
      await store.add({ topic: { chatId: -100, topicId: 42 } }, "m1");
      expect(gitOut(dir, ["log", "-1", "--format=%s"])).toBe(
        "memory: add in topics/-100/42",
      );
      await store.setDescription("memory", "general notes");
      expect(gitOut(dir, ["log", "-1", "--format=%s"])).toBe(
        "memory: set_description in general",
      );
    });

    it("swallows commit failures: file persists, no throw, no commit", async () => {
      const dir = memoryDir(tmp);
      writeFileSync(join(dir, ".git"), "not a real repo", "utf-8");
      expect((await store.add("memory", "should-persist")).ok).toBe(true);
      expect(store.readBody("memory")).toBe("should-persist");
      const rev = spawnSync("git", ["rev-list", "--count", "HEAD"], {
        cwd: dir,
        encoding: "utf-8",
      });
      expect(rev.status).not.toBe(0);
    });

    it("failed writes do not produce commits", async () => {
      const dir = memoryDir(tmp);
      await store.add("memory", "seed");
      const before = commitCount(dir);
      writeFileSync(userPath(tmp), "a".repeat(1999), "utf-8");
      expect((await store.add("user", "bb")).ok).toBe(false);
      await store.add("memory", "seed");
      expect((await store.replace("memory", "seed", "X")).ok).toBe(false);
      expect(commitCount(dir)).toBe(before + 1);
    });
  });

  describe("archiveOrphan", () => {
    it("moves a topic directory to archive and commits", async () => {
      const scope = { topic: { chatId: -100, topicId: 42 } };
      await store.add(scope, "alpha");
      expect(await store.archiveOrphan(-100, 42)).toBe(true);
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

    it("returns false when the source is missing", async () => {
      expect(await store.archiveOrphan(-100, 42)).toBe(false);
    });

    it("returns false when a temp file exists in the source directory", async () => {
      const scope = { topic: { chatId: -100, topicId: 42 } };
      await store.add(scope, "alpha");
      const sourceDir = dirname(scopeMemoryPath(tmp, scope));
      writeFileSync(join(sourceDir, ".memory.md.abcdef.tmp"), "in-flight");
      expect(await store.archiveOrphan(-100, 42)).toBe(false);
      expect(existsSync(scopeMemoryPath(tmp, scope))).toBe(true);
      expect(existsSync(archiveTopicPath(tmp, -100, 42))).toBe(false);
    });

    it("overwrites an existing archive destination", async () => {
      const scope = { topic: { chatId: -100, topicId: 42 } };
      await store.add(scope, "alpha");
      expect(await store.archiveOrphan(-100, 42)).toBe(true);
      // Move it back and change content
      const source = dirname(scopeMemoryPath(tmp, scope));
      const dest = archiveTopicPath(tmp, -100, 42);
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, "memory.md"), "beta");
      // Archive again — should overwrite the previous archive
      expect(await store.archiveOrphan(-100, 42)).toBe(true);
      expect(existsSync(source)).toBe(false);
      expect(readFileSync(join(dest, "memory.md"), "utf-8")).toBe("beta");
    });
  });

  describe("listIndex", () => {
    it("filters topics by chat id and optionally includes agents", async () => {
      await store.setDescription({ topic: { chatId: -100, topicId: 1 } }, "chat A one");
      await store.setDescription({ topic: { chatId: -100, topicId: 2 } }, "chat A two");
      await store.setDescription({ topic: { chatId: -200, topicId: 9 } }, "chat B nine");
      await store.setDescription({ agent: { name: "researcher" } }, "research persona");

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

  describe("concurrent safety", () => {
    it("serializes concurrent writes to the same scope (no data loss)", async () => {
      // Simulate multiple agents writing concurrently to the same scope.
      // Without proper locking, read-modify-write races cause data loss.
      const scope = { topic: { chatId: -100, topicId: 999 } };
      const entries = ["alpha", "bravo", "charlie", "delta", "echo"];

      // Create multiple store instances (simulating different agents/subagents)
      const stores = entries.map(() => new MemoryStore(tmp));

      // All write concurrently to the same scope
      await Promise.all(
        entries.map((entry, i) => Promise.resolve(stores[i]?.add(scope, entry))),
      );

      const body = store.readBody(scope);
      const parts = body.split(DELIMITER);

      // All entries should be present (no data lost to race conditions)
      expect(parts.length).toBe(entries.length);
      for (const entry of entries) {
        expect(parts).toContain(entry);
      }
    });

    it("serializes concurrent writes to user scope", async () => {
      const entries = ["pref1", "pref2", "pref3", "pref4", "pref5"];
      const stores = entries.map(() => new MemoryStore(tmp));

      await Promise.all(
        entries.map((entry, i) => Promise.resolve(stores[i]?.add("user", entry))),
      );

      const body = store.readBody("user");
      const parts = body.split(DELIMITER);

      expect(parts.length).toBe(entries.length);
      for (const entry of entries) {
        expect(parts).toContain(entry);
      }
    });

    it("serializes concurrent writes to named agent scope", async () => {
      const scope = { agent: { name: "researcher" } };
      const entries = ["fact1", "fact2", "fact3", "fact4", "fact5"];
      const stores = entries.map(() => new MemoryStore(tmp));

      await Promise.all(
        entries.map((entry, i) => Promise.resolve(stores[i]?.add(scope, entry))),
      );

      const body = store.readBody(scope);
      const parts = body.split(DELIMITER);

      expect(parts.length).toBe(entries.length);
      for (const entry of entries) {
        expect(parts).toContain(entry);
      }
    });

    it("allows concurrent writes to different scopes (independent files)", async () => {
      const scopes = [
        { topic: { chatId: -100, topicId: 1 } },
        { topic: { chatId: -100, topicId: 2 } },
        { topic: { chatId: -200, topicId: 1 } },
        "user" as const,
        { agent: { name: "assistant" } },
      ];
      const stores = scopes.map(() => new MemoryStore(tmp));

      await Promise.all(
        scopes.map((scope, i) => Promise.resolve(stores[i]?.add(scope, `entry-${i}`))),
      );

      // Each scope should have exactly one entry
      for (let i = 0; i < scopes.length; i++) {
        expect(store.readBody(scopes[i] as typeof scopes[number])).toBe(`entry-${i}`);
      }
    });
  });
});

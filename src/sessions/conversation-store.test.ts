import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationStore } from "./conversation-store.ts";
import { sessionDir, sessionsDir, statePath, transcriptPath, metricsPath } from "./paths.ts";
import { personalEnvironment, projectEnvironment } from "./environment.ts";
import type { SessionState } from "./types.ts";

describe("ConversationStore", () => {
  let tmpDir: string;
  let store: ConversationStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-conversation-store-"));
    store = new ConversationStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("create", () => {
    it("creates a personal conversation with required files", () => {
      const state = store.create(personalEnvironment(), "test");
      expect(state.id).toHaveLength(10);
      expect(state.title).toBe("test");
      expect(state.executionEnvironment).toEqual(personalEnvironment());

      expect(existsSync(sessionDir(tmpDir, state.id))).toBe(true);
      expect(existsSync(transcriptPath(tmpDir, state.id))).toBe(true);
      expect(existsSync(metricsPath(tmpDir, state.id))).toBe(true);
      expect(existsSync(join(sessionDir(tmpDir, state.id), "events.jsonl"))).toBe(true);
    });

    it("creates a project conversation", () => {
      const projectRoot = join(tmpDir, "project");
      mkdirSync(projectRoot, { recursive: true });
      const state = store.create(projectEnvironment(projectRoot));
      expect(state.executionEnvironment).toEqual(projectEnvironment(projectRoot));
    });

    it("creates state.json with only canonical fields", () => {
      const state = store.create(personalEnvironment(), "canonical");
      const raw = JSON.parse(readFileSync(statePath(tmpDir, state.id), "utf-8"));
      expect(raw).toEqual({
        id: state.id,
        createdAt: state.createdAt,
        title: "canonical",
        executionEnvironment: { kind: "personal" },
      });
      expect(raw).not.toHaveProperty("chatId");
      expect(raw).not.toHaveProperty("modelName");
      expect(raw).not.toHaveProperty("thinkingLevel");
    });

    it("completes a partial conversation directory for a planned-id recovery", () => {
      const id = "abc123def0";
      mkdirSync(sessionDir(tmpDir, id), { recursive: true });
      writeFileSync(transcriptPath(tmpDir, id), "");
      writeFileSync(metricsPath(tmpDir, id), "");
      writeFileSync(join(sessionDir(tmpDir, id), "events.jsonl"), "");

      const created = store.createWithId(personalEnvironment(), id);

      expect(created.id).toBe(id);
      expect(store.load(id)).toEqual(created);
    });
  });

  describe("load", () => {
    it("returns the created conversation", () => {
      const created = store.create(personalEnvironment(), "load me");
      const loaded = store.load(created.id);
      expect(loaded).toEqual(created);
    });

    it("returns null for a missing conversation", () => {
      expect(store.load("0000000000")).toBeNull();
    });

    it("returns null for an internal session", () => {
      const internal: SessionState = {
        id: "abc123def0",
        createdAt: new Date().toISOString(),
        chatId: 0,
        title: "dreaming",
        executionEnvironment: personalEnvironment(),
      };
      mkdirSync(sessionDir(tmpDir, "abc123def0"), { recursive: true });
      writeFileSync(statePath(tmpDir, "abc123def0"), JSON.stringify(internal));
      expect(store.load("abc123def0")).toBeNull();
    });

    it("throws for a conversation with an invalid executionEnvironment", () => {
      mkdirSync(sessionDir(tmpDir, "abc123def0"), { recursive: true });
      writeFileSync(
        statePath(tmpDir, "abc123def0"),
        JSON.stringify({ id: "abc123def0", createdAt: new Date().toISOString(), executionEnvironment: { kind: "project", projectRoot: "" } }),
      );
      expect(() => store.load("abc123def0")).toThrow(/invalid executionEnvironment/);
    });

    it("drops legacy fields when loading a legacy record", () => {
      const legacy: SessionState = {
        id: "abc123def0" ,
        createdAt: "2024-01-01T00:00:00.000Z",
        chatId: 123,
        topicId: 7,
        title: "legacy",
        modelName: "poe/test",
        thinkingLevel: "medium",
        executionEnvironment: personalEnvironment(),
      };
      mkdirSync(sessionDir(tmpDir, "abc123def0"), { recursive: true });
      writeFileSync(statePath(tmpDir, "abc123def0"), JSON.stringify(legacy));

      const loaded = store.load("abc123def0");
      expect(loaded?.id).toBe("abc123def0");
      expect(loaded?.title).toBe("legacy");
      expect(loaded).not.toHaveProperty("chatId");
      expect(loaded).not.toHaveProperty("modelName");
      expect(loaded).not.toHaveProperty("thinkingLevel");
    });

    it("throws when state.json id field points to a different conversation", () => {
      const a = store.create(personalEnvironment(), "A");
      const b = store.create(personalEnvironment(), "B");
      const raw = JSON.parse(readFileSync(statePath(tmpDir, a.id), "utf-8"));
      raw.id = b.id;
      writeFileSync(statePath(tmpDir, a.id), JSON.stringify(raw));

      expect(() => store.load(a.id)).toThrow(/state file id mismatch/);
    });
  });

  describe("list", () => {
    it("returns empty array for a missing sessions directory", () => {
      rmSync(sessionsDir(tmpDir), { recursive: true, force: true });
      expect(store.list()).toEqual([]);
    });

    it("lists conversations sorted by createdAt", () => {
      const first = store.create(personalEnvironment(), "first");
      const second = store.create(personalEnvironment(), "second");
      const list = store.list();
      const createdAts = list.map((c) => c.createdAt);
      expect(createdAts).toEqual([...createdAts].sort());
      expect(new Set(list.map((c) => c.id))).toEqual(new Set([first.id, second.id]));
    });

    it("filters by compatible execution environment", () => {
      const projectRoot = join(tmpDir, "project");
      mkdirSync(projectRoot, { recursive: true });
      const personal = store.create(personalEnvironment());
      const project = store.create(projectEnvironment(projectRoot));

      expect(store.list(personalEnvironment()).map((c) => c.id)).toEqual([personal.id]);
      expect(store.list(projectEnvironment(projectRoot)).map((c) => c.id)).toEqual([project.id]);
    });

    it("excludes archived conversations", () => {
      const conv = store.create(personalEnvironment());
      store.archive(conv.id);
      expect(store.list()).toEqual([]);
    });

    it("excludes internal conversations with chatId 0", () => {
      const internal: SessionState = {
        id: "abc123def0" ,
        createdAt: new Date().toISOString(),
        chatId: 0,
        title: "dreaming",
        executionEnvironment: personalEnvironment(),
      };
      mkdirSync(sessionDir(tmpDir, "abc123def0"), { recursive: true });
      writeFileSync(statePath(tmpDir, "abc123def0"), JSON.stringify(internal));
      expect(store.list().find((c) => c.id === "abc123def0")).toBeUndefined();
    });

    it("ignores entries without state.json", () => {
      mkdirSync(sessionDir(tmpDir, "deadbeef00"), { recursive: true });
      expect(store.list()).toEqual([]);
    });

    it("uses the directory name as the conversation id when state.json omits id", () => {
      const a = store.create(personalEnvironment(), "A");
      const raw = JSON.parse(readFileSync(statePath(tmpDir, a.id), "utf-8"));
      delete raw.id;
      writeFileSync(statePath(tmpDir, a.id), JSON.stringify(raw));

      const list = store.list();
      expect(list.map((c) => c.id)).toEqual([a.id]);
    });

    it("throws when a state.json id field points to a different conversation", () => {
      const a = store.create(personalEnvironment(), "A");
      const b = store.create(personalEnvironment(), "B");
      const raw = JSON.parse(readFileSync(statePath(tmpDir, a.id), "utf-8"));
      raw.id = b.id;
      writeFileSync(statePath(tmpDir, a.id), JSON.stringify(raw));

      expect(() => store.list()).toThrow(/state file id mismatch/);
    });
  });

  describe("setTitle", () => {
    it("updates the conversation title", () => {
      const conv = store.create(personalEnvironment(), "old");
      store.setTitle(conv.id, "new");
      expect(store.load(conv.id)?.title).toBe("new");
    });

    it("throws for a missing conversation", () => {
      expect(() => store.setTitle("0000000000" , "x")).toThrow(/conversation not found/);
    });

    it("rewrites only canonical fields", () => {
      const conv = store.create(personalEnvironment(), "old");
      store.setTitle(conv.id, "new");
      const raw = JSON.parse(readFileSync(statePath(tmpDir, conv.id), "utf-8"));
      expect(raw.title).toBe("new");
      expect(raw).not.toHaveProperty("chatId");
    });

    it("does not overwrite another conversation when state.json id is tampered", () => {
      const a = store.create(personalEnvironment(), "A");
      const b = store.create(personalEnvironment(), "B");
      const raw = JSON.parse(readFileSync(statePath(tmpDir, a.id), "utf-8"));
      raw.id = b.id;
      writeFileSync(statePath(tmpDir, a.id), JSON.stringify(raw));

      expect(() => store.setTitle(a.id, "hijacked")).toThrow(/state file id mismatch/);
      expect(store.load(b.id)?.title).toBe("B");
      const aRaw = JSON.parse(readFileSync(statePath(tmpDir, a.id), "utf-8"));
      expect(aRaw.title).toBe("A");
    });
  });

  describe("archive", () => {
    it("moves the conversation directory to sessions/archive", () => {
      const conv = store.create(personalEnvironment());
      store.archive(conv.id);
      expect(existsSync(sessionDir(tmpDir, conv.id))).toBe(false);
      expect(existsSync(join(sessionsDir(tmpDir), "archive", conv.id))).toBe(true);
    });

    it("throws when the conversation does not exist", () => {
      expect(() => store.archive("0000000000")).toThrow(/conversation not found/);
    });

    it("throws when the conversation is already archived", () => {
      const conv = store.create(personalEnvironment());
      store.archive(conv.id);
      expect(() => store.archive(conv.id)).toThrow(/already archived/);
    });

    it("leaves bindings.json untouched", () => {
      const conv = store.create(personalEnvironment());
      writeFileSync(join(tmpDir, "state", "bindings.json"), JSON.stringify({ version: 1, surfaces: {} }));
      store.archive(conv.id);
      const bindings = JSON.parse(readFileSync(join(tmpDir, "state", "bindings.json"), "utf-8"));
      expect(bindings).toEqual({ version: 1, surfaces: {} });
    });
  });

  describe("atomic writes", () => {
    it("write does not leave a temp file behind", () => {
      const conv = store.create(personalEnvironment());
      const files = readdirSync(sessionDir(tmpDir, conv.id));
      expect(files.some((f) => f.startsWith(".") && f.endsWith(".tmp"))).toBe(false);
    });
  });
});

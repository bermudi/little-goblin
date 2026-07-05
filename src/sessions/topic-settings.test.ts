import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ChatLocator } from "./types.ts";
import {
  loadTopicSettings,
  saveTopicSettings,
  getProjectDir,
  bindProjectDir,
  consumeProjectNotice,
  type TopicSettingsFile,
} from "./topic-settings.ts";
import { topicSettingsPath } from "./paths.ts";

describe("topic-settings", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("loadTopicSettings", () => {
    it("returns default when file is missing", () => {
      const settings = loadTopicSettings(tmpDir);
      expect(settings).toEqual({ topics: {}, dm: {}, supergroups: {} });
    });

    it("returns parsed settings when file exists", () => {
      const data: TopicSettingsFile = {
        topics: { "123": { "7": { projectDir: "/home/daniel/project" } } },
        dm: {},
        supergroups: {},
      };
      // writeFileSync needs the parent dir; saveTopicSettings would also work
      // but the point here is to place a file for loadTopicSettings to read.
      mkdirSync(dirname(topicSettingsPath(tmpDir)), { recursive: true });
      writeFileSync(topicSettingsPath(tmpDir), JSON.stringify(data), "utf-8");

      const settings = loadTopicSettings(tmpDir);
      expect(settings.topics?.["123"]?.["7"]?.projectDir).toBe("/home/daniel/project");
    });

    it("returns default when file contains invalid JSON", () => {
      mkdirSync(dirname(topicSettingsPath(tmpDir)), { recursive: true });
      writeFileSync(topicSettingsPath(tmpDir), "not json {{{", "utf-8");

      const settings = loadTopicSettings(tmpDir);
      expect(settings).toEqual({ topics: {}, dm: {}, supergroups: {} });
    });
  });

  describe("saveTopicSettings", () => {
    it("writes and reads back a roundtrip", () => {
      const data: TopicSettingsFile = {
        topics: { "999": { "42": { projectDir: "/foo" } } },
        dm: { "123": { projectDir: "/bar" } },
        supergroups: {},
      };
      saveTopicSettings(tmpDir, data);

      const loaded = loadTopicSettings(tmpDir);
      expect(loaded).toEqual(data);
    });

    it("uses atomic write (no temp file left behind)", () => {
      const data: TopicSettingsFile = { topics: {}, dm: {}, supergroups: {} };
      saveTopicSettings(tmpDir, data);

      // Only topic-settings.json should exist in its directory, no .tmp files
      const dir = dirname(topicSettingsPath(tmpDir));
      const files = readdirSync(dir);
      expect(files).toEqual(["topic-settings.json"]);
    });
  });

  describe("getProjectDir", () => {
    it("returns projectDir for a topic", () => {
      const data: TopicSettingsFile = {
        topics: { "123": { "7": { projectDir: "/home/daniel/project" } } },
        dm: {},
        supergroups: {},
      };
      saveTopicSettings(tmpDir, data);

      const loc: ChatLocator = { chatId: 123, topicId: 7 };
      expect(getProjectDir(tmpDir, loc)).toBe("/home/daniel/project");
    });

    it("returns undefined when topic has no projectDir", () => {
      const data: TopicSettingsFile = { topics: { "123": { "7": {} } }, dm: {}, supergroups: {} };
      saveTopicSettings(tmpDir, data);

      const loc: ChatLocator = { chatId: 123, topicId: 7 };
      expect(getProjectDir(tmpDir, loc)).toBeUndefined();
    });

    it("returns undefined for unknown topic", () => {
      saveTopicSettings(tmpDir, { topics: {}, dm: {}, supergroups: {} });
      const loc: ChatLocator = { chatId: 123, topicId: 999 };
      expect(getProjectDir(tmpDir, loc)).toBeUndefined();
    });

    it("returns projectDir for a DM", () => {
      const data: TopicSettingsFile = {
        topics: {},
        dm: { "889192981": { projectDir: "/home/daniel/dm-project" } },
        supergroups: {},
      };
      saveTopicSettings(tmpDir, data);

      const loc: ChatLocator = { chatId: 889192981 };
      expect(getProjectDir(tmpDir, loc)).toBe("/home/daniel/dm-project");
    });

    it("returns undefined for DM without projectDir", () => {
      saveTopicSettings(tmpDir, { topics: {}, dm: {}, supergroups: {} });
      const loc: ChatLocator = { chatId: 889192981 };
      expect(getProjectDir(tmpDir, loc)).toBeUndefined();
    });

    it("returns projectDir for a supergroup", () => {
      const data: TopicSettingsFile = {
        topics: {},
        dm: {},
        supergroups: { "-1003958530002": { projectDir: "/home/daniel/sg-project" } },
      };
      saveTopicSettings(tmpDir, data);

      const loc: ChatLocator = { chatId: -1003958530002 };
      expect(getProjectDir(tmpDir, loc)).toBe("/home/daniel/sg-project");
    });

    it("returns undefined for supergroup without projectDir", () => {
      saveTopicSettings(tmpDir, { topics: {}, dm: {}, supergroups: {} });
      const loc: ChatLocator = { chatId: -1003958530002 };
      expect(getProjectDir(tmpDir, loc)).toBeUndefined();
    });
  });

  describe("bindProjectDir", () => {
    it("sets projectDir for a topic", () => {
      const loc: ChatLocator = { chatId: -1003958530002, topicId: 180 };
      bindProjectDir(tmpDir, loc, "/home/daniel/project");

      const loaded = loadTopicSettings(tmpDir);
      expect(loaded.topics?.["-1003958530002"]?.["180"]?.projectDir).toBe("/home/daniel/project");
    });

    it("clears projectDir for a topic", () => {
      const loc: ChatLocator = { chatId: -1003958530002, topicId: 180 };
      bindProjectDir(tmpDir, loc, "/home/daniel/project");
      bindProjectDir(tmpDir, loc, undefined);

      const loaded = loadTopicSettings(tmpDir);
      expect(loaded.topics?.["-1003958530002"]?.["180"]).toBeUndefined();
      // Prunes empty chat entry
      expect(loaded.topics?.["-1003958530002"]).toBeUndefined();
    });

    it("sets projectDir for a DM", () => {
      const loc: ChatLocator = { chatId: 889192981 };
      bindProjectDir(tmpDir, loc, "/home/daniel/dm-project");

      const loaded = loadTopicSettings(tmpDir);
      expect(loaded.dm?.["889192981"]?.projectDir).toBe("/home/daniel/dm-project");
    });

    it("clears projectDir for a DM", () => {
      const loc: ChatLocator = { chatId: 889192981 };
      bindProjectDir(tmpDir, loc, "/home/daniel/dm-project");
      bindProjectDir(tmpDir, loc, undefined);

      const loaded = loadTopicSettings(tmpDir);
      expect(loaded.dm?.["889192981"]).toBeUndefined();
    });

    it("sets projectDir for a supergroup", () => {
      const loc: ChatLocator = { chatId: -1003958530002 };
      bindProjectDir(tmpDir, loc, "/home/daniel/sg-project");

      const loaded = loadTopicSettings(tmpDir);
      expect(loaded.supergroups?.["-1003958530002"]?.projectDir).toBe("/home/daniel/sg-project");
    });

    it("clears projectDir for a supergroup", () => {
      const loc: ChatLocator = { chatId: -1003958530002 };
      bindProjectDir(tmpDir, loc, "/home/daniel/sg-project");
      bindProjectDir(tmpDir, loc, undefined);

      const loaded = loadTopicSettings(tmpDir);
      expect(loaded.supergroups?.["-1003958530002"]).toBeUndefined();
    });

    it("does not interfere with existing bindings for other surfaces", () => {
      const topicLoc: ChatLocator = { chatId: -100, topicId: 1 };
      const dmLoc: ChatLocator = { chatId: 500 };

      bindProjectDir(tmpDir, topicLoc, "/topic-path");
      bindProjectDir(tmpDir, dmLoc, "/dm-path");

      const loaded = loadTopicSettings(tmpDir);
      expect(loaded.topics?.["-100"]?.["1"]?.projectDir).toBe("/topic-path");
      expect(loaded.dm?.["500"]?.projectDir).toBe("/dm-path");
    });
  });

  describe("pendingProjectNotice", () => {
    it("sets a pending notice when binding a project dir", () => {
      const loc: ChatLocator = { chatId: 123, topicId: 7 };
      bindProjectDir(tmpDir, loc, "/home/daniel/project");

      const loaded = loadTopicSettings(tmpDir);
      expect(loaded.topics?.["123"]?.["7"]?.pendingProjectNotice).toBe(
        "Project directory changed to `/home/daniel/project`.",
      );
    });

    it("does not set a notice when clearing project dir", () => {
      const loc: ChatLocator = { chatId: 123 };
      bindProjectDir(tmpDir, loc, "/home/daniel/project");
      bindProjectDir(tmpDir, loc, undefined);

      const loaded = loadTopicSettings(tmpDir);
      expect(loaded.dm?.["123"]).toBeUndefined();
    });

    it("consumeProjectNotice returns and clears the notice", () => {
      const loc: ChatLocator = { chatId: 123, topicId: 7 };
      bindProjectDir(tmpDir, loc, "/home/daniel/project");

      const notice = consumeProjectNotice(tmpDir, loc);
      expect(notice).toBe("Project directory changed to `/home/daniel/project`.");

      // Notice is consumed
      const loaded = loadTopicSettings(tmpDir);
      expect(loaded.topics?.["123"]?.["7"]?.pendingProjectNotice).toBeUndefined();
      // projectDir persists
      expect(loaded.topics?.["123"]?.["7"]?.projectDir).toBe("/home/daniel/project");
    });

    it("consumeProjectNotice returns undefined when no notice is pending", () => {
      const loc: ChatLocator = { chatId: 123 };
      expect(consumeProjectNotice(tmpDir, loc)).toBeUndefined();
    });

    it("consumeProjectNotice is idempotent", () => {
      const loc: ChatLocator = { chatId: 123 };
      bindProjectDir(tmpDir, loc, "/home/daniel/project");

      expect(consumeProjectNotice(tmpDir, loc)).toBeTruthy();
      expect(consumeProjectNotice(tmpDir, loc)).toBeUndefined();
    });
  });
});

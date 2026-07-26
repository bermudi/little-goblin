import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  loadTopicSettings,
  saveTopicSettings,
  getProjectDir,
  bindProjectDir,
  consumeProjectNotice,
  type TopicSettingsFile,
} from "./topic-settings.ts";
import { topicSettingsPath } from "./paths.ts";
import { dmSurface, supergroupSurface, topicSurface, surfaceId } from "../surface.ts";

const dm = dmSurface(889192981);
const sg = supergroupSurface(-1003958530002);
const topic = topicSurface("supergroup", -1003958530002, 180);
const dmKey = surfaceId(dm);
const sgKey = surfaceId(sg);
const topicKey = surfaceId(topic);

function emptyTopicSettings(): TopicSettingsFile {
  return { version: 1, surfaces: {} };
}

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
      expect(settings).toEqual({ version: 1, surfaces: {} });
    });

    it("returns parsed settings when file exists", () => {
      const surfaceKey = surfaceId(topicSurface("supergroup", 123, 7));
      const data: TopicSettingsFile = {
        version: 1,
        surfaces: {
          [surfaceKey]: { projectDir: "/home/daniel/project" },
        },
      };
      mkdirSync(dirname(topicSettingsPath(tmpDir)), { recursive: true });
      writeFileSync(topicSettingsPath(tmpDir), JSON.stringify(data), "utf-8");

      const settings = loadTopicSettings(tmpDir);
      expect(settings.surfaces[surfaceKey]?.projectDir).toBe("/home/daniel/project");
    });

    it("returns default when file contains invalid JSON", () => {
      mkdirSync(dirname(topicSettingsPath(tmpDir)), { recursive: true });
      writeFileSync(topicSettingsPath(tmpDir), "not json {{{", "utf-8");

      const settings = loadTopicSettings(tmpDir);
      expect(settings).toEqual({ version: 1, surfaces: {} });
    });
  });

  describe("saveTopicSettings", () => {
    it("writes and reads back a roundtrip", () => {
      const data: TopicSettingsFile = {
        version: 1,
        surfaces: {
          [topicKey]: { projectDir: "/foo" },
          [dmKey]: { projectDir: "/bar" },
        },
      };
      saveTopicSettings(tmpDir, data);

      const loaded = loadTopicSettings(tmpDir);
      expect(loaded).toEqual(data);
    });

    it("uses atomic write (no temp file left behind)", () => {
      saveTopicSettings(tmpDir, emptyTopicSettings());

      const dir = dirname(topicSettingsPath(tmpDir));
      const files = readdirSync(dir);
      expect(files).toEqual(["topic-settings.json"]);
    });
  });

  describe("getProjectDir", () => {
    it("returns projectDir for a topic surface", () => {
      saveTopicSettings(tmpDir, {
        version: 1,
        surfaces: { [topicKey]: { projectDir: "/home/daniel/project" } },
      });

      expect(getProjectDir(tmpDir, topic)).toBe("/home/daniel/project");
    });

    it("returns undefined when topic has no projectDir", () => {
      saveTopicSettings(tmpDir, { version: 1, surfaces: { [topicKey]: {} } });
      expect(getProjectDir(tmpDir, topic)).toBeUndefined();
    });

    it("returns undefined for unknown topic", () => {
      saveTopicSettings(tmpDir, emptyTopicSettings());
      expect(getProjectDir(tmpDir, topicSurface("supergroup", 123, 999))).toBeUndefined();
    });

    it("returns projectDir for a DM surface", () => {
      saveTopicSettings(tmpDir, {
        version: 1,
        surfaces: { [dmKey]: { projectDir: "/home/daniel/dm-project" } },
      });
      expect(getProjectDir(tmpDir, dm)).toBe("/home/daniel/dm-project");
    });

    it("returns undefined for DM without projectDir", () => {
      saveTopicSettings(tmpDir, emptyTopicSettings());
      expect(getProjectDir(tmpDir, dm)).toBeUndefined();
    });

    it("returns projectDir for a supergroup surface", () => {
      saveTopicSettings(tmpDir, {
        version: 1,
        surfaces: { [sgKey]: { projectDir: "/home/daniel/sg-project" } },
      });
      expect(getProjectDir(tmpDir, sg)).toBe("/home/daniel/sg-project");
    });

    it("keeps similar numeric surfaces separate", () => {
      const dmWithSgNumber = dmSurface(-1003958530002);
      const dmWithSgNumberKey = surfaceId(dmWithSgNumber);
      saveTopicSettings(tmpDir, {
        version: 1,
        surfaces: {
          [sgKey]: { projectDir: "/sg" },
          [dmWithSgNumberKey]: { projectDir: "/dm" },
        },
      });
      expect(getProjectDir(tmpDir, sg)).toBe("/sg");
      expect(getProjectDir(tmpDir, dmWithSgNumber)).toBe("/dm");
    });
  });

  describe("bindProjectDir", () => {
    it("sets projectDir for a surface", () => {
      bindProjectDir(tmpDir, topic, "/home/daniel/project");

      const loaded = loadTopicSettings(tmpDir);
      expect(loaded.surfaces[topicKey]?.projectDir).toBe("/home/daniel/project");
    });

    it("clears projectDir for a surface", () => {
      bindProjectDir(tmpDir, topic, "/home/daniel/project");
      bindProjectDir(tmpDir, topic, undefined);

      const loaded = loadTopicSettings(tmpDir);
      expect(loaded.surfaces[topicKey]).toBeUndefined();
    });

    it("sets projectDir for a DM", () => {
      bindProjectDir(tmpDir, dm, "/home/daniel/dm-project");

      const loaded = loadTopicSettings(tmpDir);
      expect(loaded.surfaces[dmKey]?.projectDir).toBe("/home/daniel/dm-project");
    });

    it("sets projectDir for a supergroup", () => {
      bindProjectDir(tmpDir, sg, "/home/daniel/sg-project");

      const loaded = loadTopicSettings(tmpDir);
      expect(loaded.surfaces[sgKey]?.projectDir).toBe("/home/daniel/sg-project");
    });

    it("does not interfere with existing settings for other surfaces", () => {
      const dm2 = dmSurface(500);
      const dm2Key = surfaceId(dm2);
      bindProjectDir(tmpDir, topic, "/topic-path");
      bindProjectDir(tmpDir, dm2, "/dm-path");

      const loaded = loadTopicSettings(tmpDir);
      expect(loaded.surfaces[topicKey]?.projectDir).toBe("/topic-path");
      expect(loaded.surfaces[dm2Key]?.projectDir).toBe("/dm-path");
    });
  });

  describe("pendingProjectNotice", () => {
    it("sets a pending notice when binding a project dir", () => {
      bindProjectDir(tmpDir, topic, "/home/daniel/project");

      const loaded = loadTopicSettings(tmpDir);
      expect(loaded.surfaces[topicKey]?.pendingProjectNotice).toBe(
        "Project directory changed to `/home/daniel/project`.",
      );
    });

    it("does not set a notice when clearing project dir", () => {
      bindProjectDir(tmpDir, dm, "/home/daniel/project");
      bindProjectDir(tmpDir, dm, undefined);

      const loaded = loadTopicSettings(tmpDir);
      expect(loaded.surfaces[dmKey]).toBeUndefined();
    });

    it("consumeProjectNotice returns and clears the notice", () => {
      bindProjectDir(tmpDir, topic, "/home/daniel/project");

      const notice = consumeProjectNotice(tmpDir, topic);
      expect(notice).toBe("Project directory changed to `/home/daniel/project`.");

      const loaded = loadTopicSettings(tmpDir);
      expect(loaded.surfaces[topicKey]?.pendingProjectNotice).toBeUndefined();
      expect(loaded.surfaces[topicKey]?.projectDir).toBe("/home/daniel/project");
    });

    it("consumeProjectNotice returns undefined when no notice is pending", () => {
      expect(consumeProjectNotice(tmpDir, dm)).toBeUndefined();
    });

    it("consumeProjectNotice is idempotent", () => {
      bindProjectDir(tmpDir, dm, "/home/daniel/project");

      expect(consumeProjectNotice(tmpDir, dm)).toBeTruthy();
      expect(consumeProjectNotice(tmpDir, dm)).toBeUndefined();
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  loadTopicSettings,
  saveTopicSettings,
  getProjectRoot,
  bindProjectRoot,
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
          [surfaceKey]: { projectRoot: "/home/daniel/project" },
        },
      };
      mkdirSync(dirname(topicSettingsPath(tmpDir)), { recursive: true });
      writeFileSync(topicSettingsPath(tmpDir), JSON.stringify(data), "utf-8");

      const settings = loadTopicSettings(tmpDir);
      expect(settings.surfaces[surfaceKey]?.projectRoot).toBe("/home/daniel/project");
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
          [topicKey]: { projectRoot: "/foo" },
          [dmKey]: { projectRoot: "/bar" },
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

  describe("getProjectRoot", () => {
    it("returns projectRoot for a topic surface", () => {
      saveTopicSettings(tmpDir, {
        version: 1,
        surfaces: { [topicKey]: { projectRoot: "/home/daniel/project" } },
      });

      expect(getProjectRoot(tmpDir, topic)).toBe("/home/daniel/project");
    });

    it("returns undefined when topic has no projectRoot", () => {
      saveTopicSettings(tmpDir, { version: 1, surfaces: { [topicKey]: {} } });
      expect(getProjectRoot(tmpDir, topic)).toBeUndefined();
    });

    it("returns undefined for unknown topic", () => {
      saveTopicSettings(tmpDir, emptyTopicSettings());
      expect(getProjectRoot(tmpDir, topicSurface("supergroup", 123, 999))).toBeUndefined();
    });

    it("returns projectRoot for a DM surface", () => {
      saveTopicSettings(tmpDir, {
        version: 1,
        surfaces: { [dmKey]: { projectRoot: "/home/daniel/dm-project" } },
      });
      expect(getProjectRoot(tmpDir, dm)).toBe("/home/daniel/dm-project");
    });

    it("returns undefined for DM without projectRoot", () => {
      saveTopicSettings(tmpDir, emptyTopicSettings());
      expect(getProjectRoot(tmpDir, dm)).toBeUndefined();
    });

    it("returns projectRoot for a supergroup surface", () => {
      saveTopicSettings(tmpDir, {
        version: 1,
        surfaces: { [sgKey]: { projectRoot: "/home/daniel/sg-project" } },
      });
      expect(getProjectRoot(tmpDir, sg)).toBe("/home/daniel/sg-project");
    });

    it("keeps similar numeric surfaces separate", () => {
      const dmWithSgNumber = dmSurface(-1003958530002);
      const dmWithSgNumberKey = surfaceId(dmWithSgNumber);
      saveTopicSettings(tmpDir, {
        version: 1,
        surfaces: {
          [sgKey]: { projectRoot: "/sg" },
          [dmWithSgNumberKey]: { projectRoot: "/dm" },
        },
      });
      expect(getProjectRoot(tmpDir, sg)).toBe("/sg");
      expect(getProjectRoot(tmpDir, dmWithSgNumber)).toBe("/dm");
    });

    it("does not fall back to legacy projectDir", () => {
      saveTopicSettings(tmpDir, { version: 1, surfaces: { [topicKey]: { projectDir: "/legacy" } } });
      expect(getProjectRoot(tmpDir, topic)).toBeUndefined();
    });
  });

  describe("bindProjectRoot", () => {
    function makeProjectDir(name: string): string {
      const dir = join(tmpDir, name);
      mkdirSync(dir, { recursive: true });
      return dir;
    }

    it("stores a canonical projectRoot", () => {
      const projectDir = makeProjectDir("project");
      bindProjectRoot(tmpDir, topic, projectDir);

      const loaded = loadTopicSettings(tmpDir);
      expect(loaded.surfaces[topicKey]).toEqual({ projectRoot: projectDir });
      expect(getProjectRoot(tmpDir, topic)).toBe(projectDir);
    });

    it("is idempotent for the same root", () => {
      const projectDir = makeProjectDir("project");
      bindProjectRoot(tmpDir, topic, projectDir);
      bindProjectRoot(tmpDir, topic, projectDir);

      const loaded = loadTopicSettings(tmpDir);
      expect(loaded.surfaces[topicKey]).toEqual({ projectRoot: projectDir });
    });

    it("rejects a different root on an already-assigned surface", () => {
      const projectA = makeProjectDir("project-a");
      const projectB = makeProjectDir("project-b");
      bindProjectRoot(tmpDir, topic, projectA);

      expect(() => bindProjectRoot(tmpDir, topic, projectB)).toThrow(/already assigned/);
      expect(getProjectRoot(tmpDir, topic)).toBe(projectA);
    });

    it("rejects clearing the project root", () => {
      bindProjectRoot(tmpDir, topic, makeProjectDir("project"));

      expect(() => bindProjectRoot(tmpDir, topic, "")).toThrow(/projectRoot is required/);
    });

    it("does not interfere with existing settings for other surfaces", () => {
      const dm2 = dmSurface(500);
      const dm2Key = surfaceId(dm2);
      const topicProject = makeProjectDir("topic-path");
      const dmProject = makeProjectDir("dm-path");
      bindProjectRoot(tmpDir, topic, topicProject);
      bindProjectRoot(tmpDir, dm2, dmProject);

      const loaded = loadTopicSettings(tmpDir);
      expect(loaded.surfaces[topicKey]?.projectRoot).toBe(topicProject);
      expect(loaded.surfaces[dm2Key]?.projectRoot).toBe(dmProject);
    });

    it("strips legacy projectDir when writing", () => {
      const projectDir = makeProjectDir("project");
      const legacy: TopicSettingsFile = {
        version: 1,
        surfaces: {
          [topicKey]: {
            projectDir,
          },
        },
      };
      saveTopicSettings(tmpDir, legacy);
      bindProjectRoot(tmpDir, topic, projectDir);

      const loaded = loadTopicSettings(tmpDir);
      expect(loaded.surfaces[topicKey]).toEqual({ projectRoot: projectDir });
    });
  });
});

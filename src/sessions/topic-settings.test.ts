import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  loadTopicSettings,
  loadCanonicalTopicSettingsForMigration,
  saveTopicSettings,
  getProjectRoot,
  bindProjectRoot,
  getModelName,
  getSkillPolicy,
  getThinkingLevel,
  setModelName,
  setSkillPolicy,
  setThinkingLevel,
  type TopicSettingsFile,
} from "./topic-settings.ts";
import { topicSettingsPath } from "./paths.ts";
import { dmSurface, supergroupSurface, topicSurface, surfaceId } from "../surface.ts";
import { DEFAULT_SKILL_POLICY, type SkillPolicy } from "../agent/skills/mod.ts";

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

  function makeProjectDir(name: string): string {
    const dir = join(tmpDir, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  describe("loadTopicSettings", () => {
    it("returns default when file is missing", () => {
      const settings = loadTopicSettings(tmpDir);
      expect(settings).toEqual({ version: 1, surfaces: {} });
    });

    it("returns parsed settings when file exists", () => {
      const surfaceKey = surfaceId(topicSurface("supergroup", 123, 7));
      const projectRoot = makeProjectDir("parsed-project");
      const data: TopicSettingsFile = {
        version: 1,
        surfaces: {
          [surfaceKey]: { projectRoot },
        },
      };
      mkdirSync(dirname(topicSettingsPath(tmpDir)), { recursive: true });
      writeFileSync(topicSettingsPath(tmpDir), JSON.stringify(data), "utf-8");

      const settings = loadTopicSettings(tmpDir);
      expect(settings.surfaces[surfaceKey]?.projectRoot).toBe(projectRoot);
    });

    it("rejects malformed JSON rather than replacing settings authority", () => {
      mkdirSync(dirname(topicSettingsPath(tmpDir)), { recursive: true });
      writeFileSync(topicSettingsPath(tmpDir), "not json {{{", "utf-8");

      expect(() => loadTopicSettings(tmpDir)).toThrow(SyntaxError);
    });

    it("rejects a current-version root that is missing or not canonical", () => {
      mkdirSync(dirname(topicSettingsPath(tmpDir)), { recursive: true });
      writeFileSync(topicSettingsPath(tmpDir), JSON.stringify({
        version: 1,
        surfaces: { [topicKey]: { projectRoot: join(tmpDir, "missing") } },
      }));
      expect(() => loadTopicSettings(tmpDir)).toThrow(/existing canonical directory/);

      const real = makeProjectDir("real");
      const alias = join(tmpDir, "alias");
      symlinkSync(real, alias);
      writeFileSync(topicSettingsPath(tmpDir), JSON.stringify({
        version: 1,
        surfaces: { [topicKey]: { projectRoot: alias } },
      }));
      expect(() => loadTopicSettings(tmpDir)).toThrow(/existing canonical directory/);
    });

    it("rejects a legacy file until the offline migration runs", () => {
      mkdirSync(dirname(topicSettingsPath(tmpDir)), { recursive: true });
      writeFileSync(topicSettingsPath(tmpDir), JSON.stringify({ dm: { "7": { modelName: "legacy" } } }), "utf-8");

      expect(() => loadTopicSettings(tmpDir)).toThrow(/requires offline migration/);
    });

    it("lets the offline migration read a legacy file as absent canonical state", () => {
      mkdirSync(dirname(topicSettingsPath(tmpDir)), { recursive: true });
      writeFileSync(topicSettingsPath(tmpDir), JSON.stringify({ dm: { "7": { modelName: "legacy" } } }), "utf-8");

      expect(loadCanonicalTopicSettingsForMigration(tmpDir)).toEqual({ version: 1, surfaces: {} });
    });

    it("lets the offline migration normalize a noncanonical historical projectRoot", () => {
      const real = makeProjectDir("real");
      const alias = join(tmpDir, "alias");
      symlinkSync(real, alias);
      mkdirSync(dirname(topicSettingsPath(tmpDir)), { recursive: true });
      writeFileSync(topicSettingsPath(tmpDir), JSON.stringify({
        version: 1,
        surfaces: { [topicKey]: { projectRoot: alias } },
      }));

      expect(loadCanonicalTopicSettingsForMigration(tmpDir).surfaces[topicKey]).toEqual({ projectRoot: alias });
      expect(() => loadTopicSettings(tmpDir)).toThrow(/existing canonical directory/);
    });
  });

  describe("saveTopicSettings", () => {
    it("writes and reads back a roundtrip", () => {
      const data: TopicSettingsFile = {
        version: 1,
        surfaces: {
          [topicKey]: { projectRoot: makeProjectDir("topic-project") },
          [dmKey]: { projectRoot: makeProjectDir("dm-project") },
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
      const projectRoot = makeProjectDir("topic-project");
      saveTopicSettings(tmpDir, {
        version: 1,
        surfaces: { [topicKey]: { projectRoot } },
      });

      expect(getProjectRoot(tmpDir, topic)).toBe(projectRoot);
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
      const projectRoot = makeProjectDir("dm-project");
      saveTopicSettings(tmpDir, {
        version: 1,
        surfaces: { [dmKey]: { projectRoot } },
      });
      expect(getProjectRoot(tmpDir, dm)).toBe(projectRoot);
    });

    it("returns undefined for DM without projectRoot", () => {
      saveTopicSettings(tmpDir, emptyTopicSettings());
      expect(getProjectRoot(tmpDir, dm)).toBeUndefined();
    });

    it("returns projectRoot for a supergroup surface", () => {
      const projectRoot = makeProjectDir("sg-project");
      saveTopicSettings(tmpDir, {
        version: 1,
        surfaces: { [sgKey]: { projectRoot } },
      });
      expect(getProjectRoot(tmpDir, sg)).toBe(projectRoot);
    });

    it("keeps similar numeric surfaces separate", () => {
      const dmWithSgNumber = dmSurface(-1003958530002);
      const dmWithSgNumberKey = surfaceId(dmWithSgNumber);
      const sgRoot = makeProjectDir("sg-project");
      const dmRoot = makeProjectDir("dm-project");
      saveTopicSettings(tmpDir, {
        version: 1,
        surfaces: {
          [sgKey]: { projectRoot: sgRoot },
          [dmWithSgNumberKey]: { projectRoot: dmRoot },
        },
      });
      expect(getProjectRoot(tmpDir, sg)).toBe(sgRoot);
      expect(getProjectRoot(tmpDir, dmWithSgNumber)).toBe(dmRoot);
    });

    it("rejects legacy projectDir in current-version settings", () => {
      mkdirSync(dirname(topicSettingsPath(tmpDir)), { recursive: true });
      writeFileSync(topicSettingsPath(tmpDir), JSON.stringify({ version: 1, surfaces: { [topicKey]: { projectDir: "/legacy" } } }));
      expect(() => getProjectRoot(tmpDir, topic)).toThrow(/invalid settings field projectDir/);
    });
  });

  describe("bindProjectRoot", () => {
    it("stores a canonical projectRoot", () => {
      const projectDir = makeProjectDir("project");
      bindProjectRoot(tmpDir, topic, projectDir);

      const loaded = loadTopicSettings(tmpDir);
      expect(loaded.surfaces[topicKey]).toEqual({ projectRoot: projectDir });
      expect(getProjectRoot(tmpDir, topic)).toBe(projectDir);
    });

    it("rejects a missing or noncanonical root before writing", () => {
      expect(() => bindProjectRoot(tmpDir, topic, join(tmpDir, "missing"))).toThrow(/existing accessible canonical/);

      const real = makeProjectDir("real");
      const alias = join(tmpDir, "alias");
      symlinkSync(real, alias);
      expect(() => bindProjectRoot(tmpDir, topic, alias)).toThrow(/existing accessible canonical/);
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

    it("rejects legacy projectDir when asked to write current-version settings", () => {
      const projectDir = makeProjectDir("project");
      const legacy: TopicSettingsFile = {
        version: 1,
        surfaces: {
          [topicKey]: {
            projectDir,
          },
        },
      };
      expect(() => saveTopicSettings(tmpDir, legacy)).toThrow(/invalid settings field projectDir/);
    });
  });

  describe("model and thinking preferences", () => {
    it("stores and reads a surface model override", () => {
      setModelName(tmpDir, topic, "anthropic/claude-sonnet-4.6");
      expect(getModelName(tmpDir, topic)).toBe("anthropic/claude-sonnet-4.6");

      const loaded = loadTopicSettings(tmpDir);
      expect(loaded.surfaces[topicKey]).toEqual({ modelName: "anthropic/claude-sonnet-4.6" });
    });

    it("clears a surface model override", () => {
      setModelName(tmpDir, topic, "anthropic/claude-sonnet-4.6");
      setModelName(tmpDir, topic, undefined);
      expect(getModelName(tmpDir, topic)).toBeUndefined();
    });

    it("stores and validates a surface thinking override", () => {
      setThinkingLevel(tmpDir, topic, "high");
      expect(getThinkingLevel(tmpDir, topic)).toBe("high");

      const loaded = loadTopicSettings(tmpDir);
      expect(loaded.surfaces[topicKey]).toEqual({ thinkingLevel: "high" });
    });

    it("rejects an invalid thinking level before it reaches settings authority", () => {
      expect(() => setThinkingLevel(tmpDir, topic, "invalid" as never)).toThrow(/invalid thinkingLevel/);
    });

    it("keeps model and thinking isolated per surface", () => {
      setModelName(tmpDir, topic, "poe/TopicModel");
      setModelName(tmpDir, dm, "poe/DmModel");
      setThinkingLevel(tmpDir, topic, "high");

      expect(getModelName(tmpDir, topic)).toBe("poe/TopicModel");
      expect(getModelName(tmpDir, dm)).toBe("poe/DmModel");
      expect(getThinkingLevel(tmpDir, dm)).toBeUndefined();
    });
  });

  describe("skill policy", () => {
    it("returns defaults without eagerly writing a Surface record", () => {
      expect(getSkillPolicy(tmpDir, topic)).toEqual(DEFAULT_SKILL_POLICY);
      expect(loadTopicSettings(tmpDir)).toEqual(emptyTopicSettings());
    });

    it("persists a complete canonical policy and keeps Surfaces isolated", () => {
      const policy: SkillPolicy = {
        goblin: { mode: "none" },
        environment: { mode: "selected", names: ["alpha", "zeta"] },
        host: { mode: "all" },
      };
      setSkillPolicy(tmpDir, topic, policy);
      setSkillPolicy(tmpDir, dm, { ...DEFAULT_SKILL_POLICY, goblin: { mode: "none" } });

      expect(getSkillPolicy(tmpDir, topic)).toEqual(policy);
      expect(getSkillPolicy(tmpDir, dm)).toEqual({ ...DEFAULT_SKILL_POLICY, goblin: { mode: "none" } });
      expect(loadTopicSettings(tmpDir).surfaces[topicKey]?.skillPolicy).toEqual(policy);
    });

    it("rejects empty, duplicate, and unsorted persisted selections", () => {
      const invalidPolicies: unknown[] = [
        {
          goblin: { mode: "all" },
          environment: { mode: "selected", names: [] },
          host: { mode: "none" },
        },
        {
          goblin: { mode: "all" },
          environment: { mode: "selected", names: ["alpha", "alpha"] },
          host: { mode: "none" },
        },
        {
          goblin: { mode: "all" },
          environment: { mode: "selected", names: ["zeta", "alpha"] },
          host: { mode: "none" },
        },
      ];

      for (const skillPolicy of invalidPolicies) {
        expect(() => saveTopicSettings(tmpDir, {
          version: 1,
          surfaces: { [topicKey]: { skillPolicy: skillPolicy as SkillPolicy } },
        })).toThrow();
      }
      expect(loadTopicSettings(tmpDir)).toEqual(emptyTopicSettings());
    });
  });
});

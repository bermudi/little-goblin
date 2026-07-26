import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { migrateSurfaceState } from "./surface-migration.ts";
import { configPath, schedulesPath, topicSettingsPath } from "./paths.ts";
import { loadBindings } from "./bindings.ts";
import { loadTopicSettings } from "./topic-settings.ts";
import { dmSurface, guestSurface, supergroupSurface, topicSurface, surfaceId } from "../surface.ts";

const CHAT_ID = 123456;
const TOPIC_ID = 7;
const SG_ID = -100123456;
const SESSION_ID = "a1b2c3d4e5";

describe("migrateSurfaceState", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-migration-"));
    mkdirSync(dirname(configPath(tmpDir)), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeLegacyBindings(data: unknown): void {
    writeFileSync(configPath(tmpDir), JSON.stringify(data), "utf-8");
  }

  function writeLegacyTopicSettings(data: unknown): void {
    writeFileSync(topicSettingsPath(tmpDir), JSON.stringify(data), "utf-8");
  }

  function writeSchedules(data: unknown): void {
    writeFileSync(schedulesPath(tmpDir), JSON.stringify(data), "utf-8");
  }

  it("migrates legacy DM, supergroup, and guest bindings", () => {
    writeLegacyBindings({
      dm: { [CHAT_ID]: SESSION_ID },
      supergroups: { [SG_ID]: SESSION_ID },
      guest: { [789]: SESSION_ID },
      topics: {},
    });
    writeLegacyTopicSettings({ dm: {}, supergroups: {}, topics: {} });

    migrateSurfaceState(tmpDir);

    const bindings = loadBindings(tmpDir);
    expect(bindings.version).toBe(1);
    expect(bindings.surfaces[surfaceId(dmSurface(CHAT_ID))]).toBe(SESSION_ID);
    expect(bindings.surfaces[surfaceId(supergroupSurface(SG_ID))]).toBe(SESSION_ID);
    expect(bindings.surfaces[surfaceId(guestSurface(789))]).toBe(SESSION_ID);
  });

  it("migrates a legacy topic binding using private schedule evidence", () => {
    writeLegacyBindings({ topics: { [CHAT_ID]: { [TOPIC_ID]: SESSION_ID } } });
    writeLegacyTopicSettings({ topics: {}, dm: {}, supergroups: {} });
    writeSchedules({
      schedules: [{ id: "s1", sessionId: SESSION_ID, locator: { chatId: CHAT_ID, topicId: TOPIC_ID, isPrivate: true } }],
    });

    migrateSurfaceState(tmpDir);

    const bindings = loadBindings(tmpDir);
    expect(bindings.surfaces[surfaceId(topicSurface("private", CHAT_ID, TOPIC_ID))]).toBe(SESSION_ID);
  });

  it("migrates a legacy topic binding using supergroup schedule evidence", () => {
    writeLegacyBindings({ topics: { [CHAT_ID]: { [TOPIC_ID]: SESSION_ID } } });
    writeLegacyTopicSettings({ topics: {}, dm: {}, supergroups: {} });
    writeSchedules({
      schedules: [{ id: "s1", sessionId: SESSION_ID, locator: { chatId: CHAT_ID, topicId: TOPIC_ID, isPrivate: false } }],
    });

    migrateSurfaceState(tmpDir);

    const bindings = loadBindings(tmpDir);
    expect(bindings.surfaces[surfaceId(topicSurface("supergroup", CHAT_ID, TOPIC_ID))]).toBe(SESSION_ID);
  });

  it("fails before writes when topic evidence is missing", () => {
    writeLegacyBindings({ topics: { [CHAT_ID]: { [TOPIC_ID]: SESSION_ID } } });
    writeLegacyTopicSettings({ topics: {}, dm: {}, supergroups: {} });
    writeSchedules({ schedules: [] });

    expect(() => migrateSurfaceState(tmpDir)).toThrow(/missing container evidence/);

    // No migration output should be written.
    expect(existsSync(configPath(tmpDir))).toBe(true);
    const raw = readFileSync(configPath(tmpDir), "utf-8");
    expect(JSON.parse(raw)).toEqual({ topics: { [CHAT_ID]: { [TOPIC_ID]: SESSION_ID } } });
  });

  it("fails before writes when topic evidence is conflicting", () => {
    writeLegacyBindings({ topics: { [CHAT_ID]: { [TOPIC_ID]: SESSION_ID } } });
    writeLegacyTopicSettings({ topics: {}, dm: {}, supergroups: {} });
    writeSchedules({
      schedules: [
        { id: "s1", sessionId: SESSION_ID, locator: { chatId: CHAT_ID, topicId: TOPIC_ID, isPrivate: true } },
        { id: "s2", sessionId: SESSION_ID, locator: { chatId: CHAT_ID, topicId: TOPIC_ID, isPrivate: false } },
      ],
    });

    expect(() => migrateSurfaceState(tmpDir)).toThrow(/conflicting container evidence/);
  });

  it("migrates legacy topic settings using schedule evidence", () => {
    writeLegacyBindings({ topics: { [CHAT_ID]: { [TOPIC_ID]: SESSION_ID } } });
    writeLegacyTopicSettings({
      topics: { [CHAT_ID]: { [TOPIC_ID]: { projectDir: "/home/daniel/project" } } },
      dm: {},
      supergroups: {},
    });
    writeSchedules({
      schedules: [{ id: "s1", sessionId: SESSION_ID, locator: { chatId: CHAT_ID, topicId: TOPIC_ID, isPrivate: false } }],
    });

    migrateSurfaceState(tmpDir);

    const bindings = loadBindings(tmpDir);
    const settings = loadTopicSettings(tmpDir);
    const key = surfaceId(topicSurface("supergroup", CHAT_ID, TOPIC_ID));
    expect(bindings.surfaces[key]).toBe(SESSION_ID);
    expect(settings.surfaces[key]?.projectDir).toBe("/home/daniel/project");
  });

  it("keeps numerically similar surfaces separate", () => {
    const sameChatId = 111;
    writeLegacyBindings({
      dm: { [sameChatId]: "dm-session" },
      supergroups: { [sameChatId]: "sg-session" },
      guest: { [sameChatId]: "guest-session" },
      topics: {},
    });
    writeLegacyTopicSettings({ dm: {}, supergroups: {}, topics: {} });

    migrateSurfaceState(tmpDir);

    const bindings = loadBindings(tmpDir);
    expect(Object.keys(bindings.surfaces)).toHaveLength(3);
    expect(bindings.surfaces[surfaceId(dmSurface(sameChatId))]).toBe("dm-session");
    expect(bindings.surfaces[surfaceId(supergroupSurface(sameChatId))]).toBe("sg-session");
    expect(bindings.surfaces[surfaceId(guestSurface(sameChatId))]).toBe("guest-session");
  });

  it("is idempotent: canonical files are accepted and unchanged", () => {
    const canonicalBindings: import("./types.ts").BindingsFile = {
      version: 1,
      surfaces: { [surfaceId(dmSurface(CHAT_ID))]: SESSION_ID },
    };
    const canonicalSettings: import("./types.ts").TopicSettingsFile = { version: 1, surfaces: {} };
    writeLegacyBindings(canonicalBindings);
    writeLegacyTopicSettings(canonicalSettings);

    migrateSurfaceState(tmpDir);

    expect(loadBindings(tmpDir)).toEqual(canonicalBindings);
    expect(loadTopicSettings(tmpDir)).toEqual(canonicalSettings);
  });

  it("resumes a mixed-generation migration (bindings canonical, settings legacy)", () => {
    const canonicalBindings: import("./types.ts").BindingsFile = {
      version: 1,
      surfaces: { [surfaceId(dmSurface(CHAT_ID))]: SESSION_ID },
    };
    writeLegacyBindings(canonicalBindings);
    writeLegacyTopicSettings({
      dm: { [CHAT_ID]: { projectDir: "/home/daniel/project" } },
      supergroups: {},
      topics: {},
    });

    migrateSurfaceState(tmpDir);

    expect(loadBindings(tmpDir)).toEqual(canonicalBindings);
    const settings = loadTopicSettings(tmpDir);
    expect(settings.surfaces[surfaceId(dmSurface(CHAT_ID))]?.projectDir).toBe("/home/daniel/project");
  });

  it("throws on invalid chat id zero before any write", () => {
    writeLegacyBindings({ dm: { "0": SESSION_ID }, supergroups: {}, topics: {} });
    writeLegacyTopicSettings({ dm: {}, supergroups: {}, topics: {} });

    expect(() => migrateSurfaceState(tmpDir)).toThrow(/invalid chat id/);
  });
});

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  sessionsDir,
  sessionDir,
  statePath,
  transcriptPath,
  metricsPath,
  configPath,
  topicSettingsPath,
  schedulesPath,
  heartbeatMdPathForSession,
  surfaceHeartbeatPath,
} from "./paths.ts";
import type { SurfaceId } from "../surface.ts";

const VALID_HEX_ID = "abc123def0";
const VALID_DM_SURFACE_ID = "tg:v1:dm:123" as SurfaceId;

describe("sessions paths", () => {
  const home = "/tmp/goblin";

  it("resolves the sessions root under state/", () => {
    expect(sessionsDir(home)).toBe(join(home, "state", "sessions"));
  });

  it("resolves a session directory by id", () => {
    expect(sessionDir(home, VALID_HEX_ID)).toBe(
      join(home, "state", "sessions", VALID_HEX_ID),
    );
  });

  it("resolves a session state.json by id", () => {
    expect(statePath(home, VALID_HEX_ID)).toBe(
      join(home, "state", "sessions", VALID_HEX_ID, "state.json"),
    );
  });

  it("resolves a session transcript.jsonl by id", () => {
    expect(transcriptPath(home, VALID_HEX_ID)).toBe(
      join(home, "state", "sessions", VALID_HEX_ID, "transcript.jsonl"),
    );
  });

  it("resolves a session metrics.jsonl by id", () => {
    expect(metricsPath(home, VALID_HEX_ID)).toBe(
      join(home, "state", "sessions", VALID_HEX_ID, "metrics.jsonl"),
    );
  });

  it("resolves bindings.json under state/", () => {
    expect(configPath(home)).toBe(join(home, "state", "bindings.json"));
  });

  it("resolves topic-settings.json under state/", () => {
    expect(topicSettingsPath(home)).toBe(join(home, "state", "topic-settings.json"));
  });

  it("resolves schedules.json under state/", () => {
    expect(schedulesPath(home)).toBe(join(home, "state", "schedules.json"));
  });

  it("resolves a session-scoped HEARTBEAT.md by id", () => {
    expect(heartbeatMdPathForSession(home, VALID_HEX_ID)).toBe(
      join(home, "state", "sessions", VALID_HEX_ID, "HEARTBEAT.md"),
    );
  });

  it("rejects path traversal in session ids", () => {
    expect(() => heartbeatMdPathForSession(home, "../escape")).toThrow();
    expect(() => heartbeatMdPathForSession(home, "abc/123")).toThrow();
    expect(() => heartbeatMdPathForSession(home, "abc\\123")).toThrow();
  });

  it("resolves a surface-owned HEARTBEAT.md by canonical SurfaceId", () => {
    expect(surfaceHeartbeatPath(home, VALID_DM_SURFACE_ID)).toBe(
      join(home, "state", "surfaces", VALID_DM_SURFACE_ID, "HEARTBEAT.md"),
    );
  });

  it("rejects invalid or non-canonical SurfaceIds for heartbeat path", () => {
    expect(() => surfaceHeartbeatPath(home, "../escape" as SurfaceId)).toThrow();
    expect(() => surfaceHeartbeatPath(home, "tg:v1:dm:abc" as SurfaceId)).toThrow();
    expect(() => surfaceHeartbeatPath(home, "tg:v1:dm:0123" as SurfaceId)).toThrow();
    expect(() => surfaceHeartbeatPath(home, "not:a:surface" as SurfaceId)).toThrow();
  });

  it("rejects unsafe session id characters", () => {
    expect(() => heartbeatMdPathForSession(home, "abc\0def")).toThrow();
    expect(() => sessionDir(home, "abc\0def")).toThrow();
  });
});

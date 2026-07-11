import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  sessionsDir,
  sessionDir,
  statePath,
  transcriptPath,
  configPath,
  topicSettingsPath,
  schedulesPath,
  heartbeatMdPathForSession,
} from "./paths.ts";

const VALID_HEX_ID = "abc123def0";

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

  it("rejects non-hex session ids for HEARTBEAT.md", () => {
    expect(() => heartbeatMdPathForSession(home, "abc")).toThrow();
    expect(() => heartbeatMdPathForSession(home, "sess-001")).toThrow();
    expect(() => heartbeatMdPathForSession(home, "ABCDEF1234")).toThrow();
  });

  it("rejects non-hex session ids for all session-id path helpers", () => {
    expect(() => sessionDir(home, "abc")).toThrow();
    expect(() => statePath(home, "abc")).toThrow();
    expect(() => transcriptPath(home, "abc")).toThrow();
  });
});

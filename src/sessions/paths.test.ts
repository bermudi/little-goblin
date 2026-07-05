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
} from "./paths.ts";

describe("sessions paths", () => {
  const home = "/tmp/goblin";

  it("resolves the sessions root under state/", () => {
    expect(sessionsDir(home)).toBe(join(home, "state", "sessions"));
  });

  it("resolves a session directory by id", () => {
    expect(sessionDir(home, "abc")).toBe(join(home, "state", "sessions", "abc"));
  });

  it("resolves a session state.json by id", () => {
    expect(statePath(home, "abc")).toBe(
      join(home, "state", "sessions", "abc", "state.json"),
    );
  });

  it("resolves a session transcript.jsonl by id", () => {
    expect(transcriptPath(home, "abc")).toBe(
      join(home, "state", "sessions", "abc", "transcript.jsonl"),
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
});

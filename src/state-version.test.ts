import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_STATE_VERSION, readStateVersion, writeStateVersion, stateVersionPath } from "./state-version.ts";

describe("state-version", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "goblin-state-version-"));
    mkdirSync(join(home, "state"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns 0 when the version file is missing", () => {
    expect(readStateVersion(home)).toBe(0);
  });

  it("returns the persisted version", () => {
    writeStateVersion(home, 3);
    expect(readStateVersion(home)).toBe(3);
    expect(stateVersionPath(home)).toBe(join(home, "state", "state-version.json"));
  });

  it("recovers from a malformed file", () => {
    writeFileSync(stateVersionPath(home), "not json");
    expect(readStateVersion(home)).toBe(0);
  });

  it("recovers from a negative or non-integer value", () => {
    writeFileSync(stateVersionPath(home), JSON.stringify({ version: -1 }));
    expect(readStateVersion(home)).toBe(0);
  });

  it("exposes the current target version", () => {
    expect(CURRENT_STATE_VERSION).toBeGreaterThan(0);
  });
});

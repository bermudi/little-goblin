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
    writeStateVersion(home, 1);
    expect(readStateVersion(home)).toBe(1);
    expect(stateVersionPath(home)).toBe(join(home, "state", "state-version.json"));
  });

  it("rejects a malformed JSON file", () => {
    writeFileSync(stateVersionPath(home), "not json");
    expect(() => readStateVersion(home)).toThrow(/malformed state version file/);
  });

  it("rejects an invalid schema", () => {
    writeFileSync(stateVersionPath(home), JSON.stringify({ foo: 1 }));
    expect(() => readStateVersion(home)).toThrow(/invalid state version schema/);
  });

  it("rejects a negative version", () => {
    writeFileSync(stateVersionPath(home), JSON.stringify({ version: -1 }));
    expect(() => readStateVersion(home)).toThrow(/negative/);
  });

  it("rejects a non-integer version", () => {
    writeFileSync(stateVersionPath(home), JSON.stringify({ version: 1.5 }));
    expect(() => readStateVersion(home)).toThrow(/safe integer/);
  });

  for (const [label, version] of [
    ["null", null],
    ["boolean", true],
    ["string", "3"],
    ["array", [3]],
  ] as const) {
    it(`rejects a non-number version: ${label}`, () => {
      writeFileSync(stateVersionPath(home), JSON.stringify({ version }));
      expect(() => readStateVersion(home)).toThrow(/safe integer/);
    });
  }

  it("rejects a version newer than the running code", () => {
    writeFileSync(stateVersionPath(home), JSON.stringify({ version: CURRENT_STATE_VERSION + 10 }));
    expect(() => readStateVersion(home)).toThrow(/newer than supported/);
  });

  it("exposes the current target version", () => {
    expect(CURRENT_STATE_VERSION).toBeGreaterThan(0);
  });
});

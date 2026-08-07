import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  SAFE_RUN_ID_RE,
  delegatedWorkRecordPath,
  delegatedWorkRunDir,
} from "./paths.ts";

const home = "/tmp/goblin";
const VALID_ID = "run-1";

describe("delegated-work paths", () => {
  it("resolves a run directory and record path for a valid id", () => {
    expect(delegatedWorkRunDir(home, VALID_ID)).toBe(
      join(home, "state", "delegated-work", "runs", VALID_ID),
    );
    expect(delegatedWorkRecordPath(home, VALID_ID)).toBe(
      join(home, "state", "delegated-work", "runs", VALID_ID, "record.json"),
    );
  });

  it("rejects an empty id", () => {
    expect(() => delegatedWorkRunDir(home, "")).toThrow(
      /must be a non-empty single safe path segment/,
    );
    expect(() => delegatedWorkRecordPath(home, "")).toThrow(
      /must be a non-empty single safe path segment/,
    );
  });

  it("rejects path traversal with ..", () => {
    expect(() => delegatedWorkRunDir(home, "..")).toThrow(
      /must be a non-empty single safe path segment/,
    );
    expect(() => delegatedWorkRecordPath(home, "../../../../tmp/run")).toThrow(
      /must be a non-empty single safe path segment/,
    );
  });

  it("rejects path separators in the id", () => {
    expect(() => delegatedWorkRunDir(home, "foo/bar")).toThrow(
      /must be a non-empty single safe path segment/,
    );
    expect(() => delegatedWorkRecordPath(home, "foo\\bar")).toThrow(
      /must be a non-empty single safe path segment/,
    );
  });

  it("rejects shell-special characters in the id", () => {
    expect(() => delegatedWorkRunDir(home, "run;id")).toThrow(
      /must be a non-empty single safe path segment/,
    );
    expect(() => delegatedWorkRecordPath(home, "run$id")).toThrow(
      /must be a non-empty single safe path segment/,
    );
  });

  it("rejects trailing line terminators in a run id", () => {
    for (const bad of [
      "run-1\n",
      "run-1\r",
      "run-1\u2028",
      "run-1\u2029",
      "run-1\nrun-2",
    ]) {
      expect(SAFE_RUN_ID_RE.test(bad)).toBe(false);
      expect(() => delegatedWorkRunDir(home, bad)).toThrow(
        /must be a non-empty single safe path segment/,
      );
      expect(() => delegatedWorkRecordPath(home, bad)).toThrow(
        /must be a non-empty single safe path segment/,
      );
    }
  });

  it("accepts valid safe run id characters", () => {
    for (const good of ["run-1", "a", "A-B_C"]) {
      expect(SAFE_RUN_ID_RE.test(good)).toBe(true);
      expect(delegatedWorkRunDir(home, good)).toBe(
        join(home, "state", "delegated-work", "runs", good),
      );
      expect(delegatedWorkRecordPath(home, good)).toBe(
        join(
          home,
          "state",
          "delegated-work",
          "runs",
          good,
          "record.json",
        ),
      );
    }
  });
});

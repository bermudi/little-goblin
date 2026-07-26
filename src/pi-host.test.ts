import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findMostRecentCompatiblePiSession,
  IncompatiblePiHistoryError,
  MalformedPiHistoryError,
  piAgentDir,
  readPiSessionHeader,
  validatePiSessionHeaders,
} from "./pi-host.ts";

describe("pi-host", () => {
  describe("path helpers", () => {
    it("piAgentDir returns state/pi subdirectory", () => {
      const home = "/home/goblin";
      expect(piAgentDir(home)).toBe(join(home, "state", "pi"));
    });
  });

  describe("pi session header compatibility", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "goblin-pi-host-test-"));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("readPiSessionHeader returns the cwd from the first line", () => {
      const file = join(tmpDir, "history.jsonl");
      writeFileSync(file, JSON.stringify({ cwd: "/workspace" }) + "\n{}");
      expect(readPiSessionHeader(file)).toEqual({ cwd: "/workspace" });
    });

    it("readPiSessionHeader throws for malformed JSON", () => {
      const file = join(tmpDir, "history.jsonl");
      writeFileSync(file, "not json\n{}");
      expect(() => readPiSessionHeader(file)).toThrow(MalformedPiHistoryError);
    });

    it("readPiSessionHeader throws for a missing cwd", () => {
      const file = join(tmpDir, "history.jsonl");
      writeFileSync(file, JSON.stringify({ foo: "bar" }) + "\n{}");
      expect(() => readPiSessionHeader(file)).toThrow(MalformedPiHistoryError);
    });

    it("findMostRecentCompatiblePiSession returns the most recent compatible file", () => {
      const piDir = join(tmpDir, "pi");
      mkdirSync(piDir, { recursive: true });
      const older = join(piDir, "a.jsonl");
      const newer = join(piDir, "b.jsonl");
      writeFileSync(older, JSON.stringify({ cwd: "/workspace" }) + "\n");
      // Ensure mtime differs by at least 10ms.
      const start = Date.now();
      while (Date.now() - start < 15) {
        // busy wait
      }
      writeFileSync(newer, JSON.stringify({ cwd: "/workspace" }) + "\n");

      expect(findMostRecentCompatiblePiSession(piDir, "/workspace")).toBe(newer);
    });

    it("findMostRecentCompatiblePiSession throws on incompatible cwd", () => {
      const piDir = join(tmpDir, "pi");
      mkdirSync(piDir, { recursive: true });
      const file = join(piDir, "history.jsonl");
      writeFileSync(file, JSON.stringify({ cwd: "/other" }) + "\n");

      expect(() => findMostRecentCompatiblePiSession(piDir, "/workspace")).toThrow(IncompatiblePiHistoryError);
    });

    it("validatePiSessionHeaders returns incompatible files", () => {
      const piDir = join(tmpDir, "pi");
      mkdirSync(piDir, { recursive: true });
      writeFileSync(join(piDir, "good.jsonl"), JSON.stringify({ cwd: "/workspace" }) + "\n");
      writeFileSync(join(piDir, "bad.jsonl"), JSON.stringify({ cwd: "/other" }) + "\n");

      const incompatible = validatePiSessionHeaders(piDir, "/workspace");
      expect(incompatible).toHaveLength(1);
      expect(incompatible[0]?.headerCwd).toBe("/other");
    });

    it("validatePiSessionHeaders throws on malformed headers", () => {
      const piDir = join(tmpDir, "pi");
      mkdirSync(piDir, { recursive: true });
      writeFileSync(join(piDir, "bad.jsonl"), "not json\n");

      expect(() => validatePiSessionHeaders(piDir, "/workspace")).toThrow(MalformedPiHistoryError);
    });
  });
});

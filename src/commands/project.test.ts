/**
 * Tests for /project command logic.
 */

import { describe, it, expect, mock } from "bun:test";
import { homedir } from "node:os";
import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeProject,
  NO_SESSION_REPLY,
  MISSING_ARG_REPLY,
  BAD_PATH_REPLY,
} from "./project.ts";

describe("executeProject", () => {
  it("returns no-session when there is no session", () => {
    const setProjectDir = mock();
    const result = executeProject({
      hasSession: false,
      rawText: "/project /tmp/foo",
      setProjectDir,
    });
    expect(result.kind).toBe("no-session");
    expect(result.reply).toBe(NO_SESSION_REPLY);
    expect(setProjectDir).not.toHaveBeenCalled();
  });

  it("returns missing-arg when no path is provided", () => {
    const setProjectDir = mock();
    const result = executeProject({
      hasSession: true,
      rawText: "/project",
      setProjectDir,
    });
    expect(result.kind).toBe("missing-arg");
    expect(result.reply).toBe(MISSING_ARG_REPLY);
    expect(setProjectDir).not.toHaveBeenCalled();
  });

  it("returns missing-arg when only whitespace follows the command", () => {
    const setProjectDir = mock();
    const result = executeProject({
      hasSession: true,
      rawText: "/project   ",
      setProjectDir,
    });
    expect(result.kind).toBe("missing-arg");
    expect(result.reply).toBe(MISSING_ARG_REPLY);
    expect(setProjectDir).not.toHaveBeenCalled();
  });

  it("sets the project directory when path exists", () => {
    const setProjectDir = mock();
    const result = executeProject({
      hasSession: true,
      rawText: "/project /tmp",
      setProjectDir,
    });
    expect(result.kind).toBe("set");
    if (result.kind === "set") {
      expect(result.projectDir).toBe("/tmp");
    }
    expect(setProjectDir).toHaveBeenCalledWith("/tmp");
  });

  it("expands tilde to home directory", () => {
    const setProjectDir = mock();
    const result = executeProject({
      hasSession: true,
      rawText: "/project ~/",
      setProjectDir,
    });
    expect(result.kind).toBe("set");
    if (result.kind === "set") {
      expect(result.projectDir).toBe(homedir());
      expect(result.projectDir.startsWith("/")).toBe(true);
    }
    expect(setProjectDir).toHaveBeenCalledWith(homedir());
  });

  it("expands bare tilde to home directory", () => {
    const setProjectDir = mock();
    const result = executeProject({
      hasSession: true,
      rawText: "/project ~",
      setProjectDir,
    });
    expect(result.kind).toBe("set");
    if (result.kind === "set") {
      expect(result.projectDir).toBe(homedir());
    }
    expect(setProjectDir).toHaveBeenCalledWith(homedir());
  });

  it("handles paths with spaces", () => {
    const dir = mkdtempSync(join(tmpdir(), "project test "));
    const setProjectDir = mock();
    const result = executeProject({
      hasSession: true,
      rawText: `/project ${dir}`,
      setProjectDir,
    });
    expect(result.kind).toBe("set");
    if (result.kind === "set") {
      expect(result.projectDir).toBe(dir);
    }
    expect(setProjectDir).toHaveBeenCalledWith(dir);
    rmdirSync(dir);
  });

  it("resolves relative paths to absolute", () => {
    const setProjectDir = mock();
    const result = executeProject({
      hasSession: true,
      rawText: "/project ./src",
      setProjectDir,
    });
    expect(result.kind).toBe("set");
    if (result.kind === "set") {
      expect(result.projectDir.startsWith("/")).toBe(true);
      expect(result.projectDir.endsWith("/src")).toBe(true);
    }
  });

  it("rejects nonexistent paths", () => {
    const setProjectDir = mock();
    const result = executeProject({
      hasSession: true,
      rawText: "/project /tmp/this-does-not-exist-12345",
      setProjectDir,
    });
    expect(result.kind).toBe("bad-path");
    expect(result.reply).toBe(BAD_PATH_REPLY);
    expect(setProjectDir).not.toHaveBeenCalled();
  });

  it("rejects files (must be a directory)", () => {
    const setProjectDir = mock();
    const result = executeProject({
      hasSession: true,
      rawText: "/project /etc/passwd",
      setProjectDir,
    });
    expect(result.kind).toBe("bad-path");
    expect(result.reply).toBe(BAD_PATH_REPLY);
    expect(setProjectDir).not.toHaveBeenCalled();
  });

  it("clears project directory when arg is 'none'", () => {
    const setProjectDir = mock();
    const result = executeProject({
      hasSession: true,
      rawText: "/project none",
      setProjectDir,
    });
    expect(result.kind).toBe("cleared");
    expect(setProjectDir).toHaveBeenCalledWith(undefined);
  });

  it("clears project directory when arg is 'clear'", () => {
    const setProjectDir = mock();
    const result = executeProject({
      hasSession: true,
      rawText: "/project clear",
      setProjectDir,
    });
    expect(result.kind).toBe("cleared");
    expect(setProjectDir).toHaveBeenCalledWith(undefined);
  });
});

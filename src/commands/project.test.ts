/**
 * Tests for /project command logic.
 */

import { describe, it, expect, mock } from "bun:test";
import { homedir } from "node:os";
import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { executeProject, MISSING_ARG_REPLY, BAD_PATH_REPLY } from "./project.ts";
import type { SessionState } from "../sessions/types.ts";
import { personalEnvironment, projectEnvironment } from "../sessions/environment.ts";

function stubSession(id = "new-sess-01", root?: string): SessionState {
  return {
    id,
    createdAt: new Date().toISOString(),
    chatId: 1,
    executionEnvironment: root ? projectEnvironment(root) : personalEnvironment(),
  };
}

function makeAssignProject(root: string) {
  return mock(async (canonicalRoot: string) => {
    if (canonicalRoot !== root) {
      throw new Error(`expected ${root}, got ${canonicalRoot}`);
    }
    return { kind: "assigned" as const, projectRoot: root, session: stubSession("new-sess-01", root) };
  });
}

describe("executeProject", () => {
  it("returns missing-arg when no path is provided", async () => {
    const assignProject = mock();
    const result = await executeProject({ rawText: "/project", assignProject });
    expect(result.kind).toBe("missing-arg");
    expect(result.reply).toBe(MISSING_ARG_REPLY);
    expect(assignProject).not.toHaveBeenCalled();
  });

  it("returns missing-arg when only whitespace follows the command", async () => {
    const assignProject = mock();
    const result = await executeProject({ rawText: "/project   ", assignProject });
    expect(result.kind).toBe("missing-arg");
    expect(result.reply).toBe(MISSING_ARG_REPLY);
    expect(assignProject).not.toHaveBeenCalled();
  });

  it("assigns the canonical project directory when path exists", async () => {
    const root = resolvePath("/tmp");
    const assignProject = makeAssignProject(root);
    const result = await executeProject({ rawText: "/project /tmp", assignProject });
    expect(result.kind).toBe("assigned");
    if (result.kind === "assigned") {
      expect(result.projectRoot).toBe(root);
      expect(result.sessionId).toBe("new-sess-01");
    }
    expect(assignProject).toHaveBeenCalledWith(root);
  });

  it("expands tilde to home directory", async () => {
    const home = resolvePath(homedir());
    const assignProject = makeAssignProject(home);
    const result = await executeProject({ rawText: "/project ~/", assignProject });
    expect(result.kind).toBe("assigned");
    if (result.kind === "assigned") {
      expect(result.projectRoot).toBe(home);
      expect(result.projectRoot.startsWith("/")).toBe(true);
    }
    expect(assignProject).toHaveBeenCalledWith(home);
  });

  it("expands bare tilde to home directory", async () => {
    const home = resolvePath(homedir());
    const assignProject = makeAssignProject(home);
    const result = await executeProject({ rawText: "/project ~", assignProject });
    expect(result.kind).toBe("assigned");
    if (result.kind === "assigned") {
      expect(result.projectRoot).toBe(home);
    }
    expect(assignProject).toHaveBeenCalledWith(home);
  });

  it("handles paths with spaces", async () => {
    const dir = mkdtempSync(join(tmpdir(), "project test "));
    const root = resolvePath(dir);
    const assignProject = makeAssignProject(root);
    const result = await executeProject({ rawText: `/project ${dir}`, assignProject });
    expect(result.kind).toBe("assigned");
    if (result.kind === "assigned") {
      expect(result.projectRoot).toBe(root);
    }
    expect(assignProject).toHaveBeenCalledWith(root);
    rmdirSync(dir);
  });

  it("resolves relative paths to absolute", async () => {
    // The repository root contains a `src/` directory; resolve it canonically.
    const root = resolvePath("src");
    const assignProject = makeAssignProject(root);
    const result = await executeProject({ rawText: "/project ./src", assignProject });
    expect(result.kind).toBe("assigned");
    if (result.kind === "assigned") {
      expect(result.projectRoot.startsWith("/")).toBe(true);
      expect(result.projectRoot.endsWith("/src")).toBe(true);
    }
  });

  it("rejects nonexistent paths", async () => {
    const assignProject = mock();
    const result = await executeProject({ rawText: "/project /tmp/this-does-not-exist-12345", assignProject });
    expect(result.kind).toBe("bad-path");
    expect(result.reply).toBe(BAD_PATH_REPLY);
    expect(assignProject).not.toHaveBeenCalled();
  });

  it("rejects files (must be a directory)", async () => {
    const assignProject = mock();
    const result = await executeProject({ rawText: "/project /etc/passwd", assignProject });
    expect(result.kind).toBe("bad-path");
    expect(result.reply).toBe(BAD_PATH_REPLY);
    expect(assignProject).not.toHaveBeenCalled();
  });

  it("rejects clearing project assignment", async () => {
    const assignProject = mock();
    const result = await executeProject({ rawText: "/project none", assignProject });
    expect(result.kind).toBe("rejected");
    expect(assignProject).not.toHaveBeenCalled();

    const result2 = await executeProject({ rawText: "/project clear", assignProject });
    expect(result2.kind).toBe("rejected");
    expect(assignProject).not.toHaveBeenCalled();
  });

  it("returns conflict when already assigned to a different project", async () => {
    const assignProject = mock(async () => ({ kind: "conflict" as const, currentRoot: "/existing/project" }));
    const result = await executeProject({ rawText: "/project /tmp", assignProject });
    expect(result.kind).toBe("conflict");
    expect(result.reply).toContain("/existing/project");
    expect(assignProject).toHaveBeenCalledWith(resolvePath("/tmp"));
  });

  it("returns already-assigned when binding matches", async () => {
    const root = resolvePath("/tmp");
    const assignProject = mock(async () => ({
      kind: "already-assigned" as const,
      projectRoot: root,
      session: stubSession("existing-sess", root),
    }));
    const result = await executeProject({ rawText: "/project /tmp", assignProject });
    expect(result.kind).toBe("already-assigned");
    if (result.kind === "already-assigned") {
      expect(result.projectRoot).toBe(root);
    }
  });
});

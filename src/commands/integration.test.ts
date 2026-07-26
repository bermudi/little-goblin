/**
 * Integration tests for command sequences.
 *
 * These tests exercise multiple commands in sequence through the real
 * SessionManager and command helpers, verifying the end-to-end state changes
 * that unit tests on individual helpers cannot catch.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../sessions/manager.ts";
import type { Config } from "../config.ts";
import { dmSurface } from "../surface.ts";
import { executeNew } from "./new.ts";
import { executeArchive } from "./archive.ts";
import { executeName } from "./name.ts";
import { executeResume } from "./resume.ts";
import { sessionDir, sessionsDir } from "../sessions/paths.ts";

function makeTestConfig(home: string): Config {
  return {
    botToken: "test-token",
    allowedTgUserIds: new Set([123]),
    modelName: "poe/Claude-Sonnet-4.6",
    poeApiKey: "test-key",
    goblinHome: home,
    logLevel: "info",
    toolVisibility: "standard",
    skillSources: "goblin-only",
    voiceName: "en-US-AriaNeural",
    favorites: [],
  };
}

describe("rapid command spam integration", () => {
  let tmpDir: string;
  let manager: SessionManager;
  let cfg: Config;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-cmd-int-"));
    cfg = makeTestConfig(tmpDir);
    manager = new SessionManager(cfg);
    await manager.init();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("/new then /archive leaves session archived and binding cleared (W2)", async () => {
    const surface = dmSurface(123456);

    // Step 1: /new creates a session
    const newResult = await executeNew({
      createSession: () => manager.createForSurface(surface),
    });
    expect(newResult.kind).toBe("created");
    const sessionId = newResult.session.id;
    expect(existsSync(sessionDir(cfg.goblinHome, sessionId))).toBe(true);

    // Verify binding exists
    const afterNew = await manager.resolve(surface);
    expect(afterNew).not.toBeNull();
    expect(afterNew?.id).toBe(sessionId);

    // Step 2: /archive moves it and clears binding
    const archiveResult = await executeArchive({
      hasSession: true,
      sessionExists: true,
      archive: async () => {
        await manager.archive(sessionId);
      },
    });
    expect(archiveResult.kind).toBe("archived");

    // Final state: session is in archive/
    expect(existsSync(sessionDir(cfg.goblinHome, sessionId))).toBe(false);
    expect(existsSync(join(sessionsDir(cfg.goblinHome), "archive", sessionId))).toBe(true);

    // Final state: binding is cleared (DM returns null on resolve)
    const afterArchive = await manager.resolve(surface);
    expect(afterArchive).toBeNull();
  });

  it("rapid /new → /new → /archive leaves prior sessions resumable and archives only the last", async () => {
    const surface = dmSurface(123456);

    // First /new
    const first = await executeNew({
      createSession: () => manager.createForSurface(surface),
    });
    const firstId = first.session.id;

    // Second /new switches to a fresh session without archiving the prior one.
    const second = await executeNew({
      createSession: () => manager.createForSurface(surface),
    });
    const secondId = second.session.id;
    expect(secondId).not.toBe(firstId);

    // First is unbound but still resumable, second is bound.
    expect(existsSync(sessionDir(cfg.goblinHome, firstId))).toBe(true);
    expect(existsSync(join(sessionsDir(cfg.goblinHome), "archive", firstId))).toBe(false);
    expect(existsSync(sessionDir(cfg.goblinHome, secondId))).toBe(true);
    expect((await manager.resolve(surface))?.id).toBe(secondId);

    // Archive second
    const archiveResult = await executeArchive({
      hasSession: true,
      sessionExists: true,
      archive: async () => manager.archive(secondId),
    });
    expect(archiveResult.kind).toBe("archived");

    // Only second is archived; first remains resumable but unbound.
    expect(existsSync(sessionDir(cfg.goblinHome, firstId))).toBe(true);
    expect(existsSync(join(sessionsDir(cfg.goblinHome), "archive", secondId))).toBe(true);
    expect(await manager.resolve(surface)).toBeNull();
  });

  it("/name → /new → /resume switches back to the named prior session", async () => {
    const surface = dmSurface(123456);

    const first = await executeNew({
      createSession: () => manager.createForSurface(surface),
    });
    const firstId = first.session.id;

    const nameResult = executeName({
      hasSession: true,
      rawText: "/name ttt",
      session: first.session,
      setTitle: (title) => manager.setTitle(firstId, title),
    });
    expect(nameResult.kind).toBe("renamed");

    const second = await executeNew({
      createSession: () => manager.createForSurface(surface),
    });
    const secondId = second.session.id;
    expect(secondId).not.toBe(firstId);
    expect((await manager.resolve(surface))?.id).toBe(secondId);
    expect(existsSync(sessionDir(cfg.goblinHome, firstId))).toBe(true);

    const resumeResult = await executeResume({
      rawText: "/resume ttt",
      sessions: manager.list(),
      bindSession: (sessionId) => manager.bindExistingToSurface(sessionId, surface),
    });

    expect(resumeResult.kind).toBe("resumed");
    expect((await manager.resolve(surface))?.id).toBe(firstId);
    expect(existsSync(sessionDir(cfg.goblinHome, secondId))).toBe(true);
  });
});

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
import type { ChatLocator } from "../sessions/types.ts";
import { executeNew } from "./new.ts";
import { executeArchive } from "./archive.ts";
import { sessionDir } from "../sessions/paths.ts";

function makeTestConfig(home: string): Config {
  return {
    botToken: "test-token",
    allowedTgUserIds: new Set([123]),
    modelName: "poe/Claude-Sonnet-4.6",
    poeApiKey: "test-key",
    goblinHome: home,
    logLevel: "info",
    toolVisibility: "standard",
  };
}

describe("rapid command spam integration", () => {
  let tmpDir: string;
  let manager: SessionManager;
  let cfg: Config;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-cmd-int-"));
    cfg = makeTestConfig(tmpDir);
    manager = new SessionManager(cfg);
    manager.init();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("/new then /archive leaves session archived and binding cleared (W2)", () => {
    const locator: ChatLocator = { chatId: 123456 };

    // Step 1: /new creates a session
    const newResult = executeNew({
      createSession: () => manager.createForChat(locator, { isSupergroup: false }),
    });
    expect(newResult.kind).toBe("created");
    const sessionId = newResult.session.id;
    expect(existsSync(sessionDir(cfg.goblinHome, sessionId))).toBe(true);

    // Verify binding exists
    const afterNew = manager.resolve(locator);
    expect(afterNew).not.toBeNull();
    expect(afterNew?.id).toBe(sessionId);

    // Step 2: /archive moves it and clears binding
    const archiveResult = executeArchive({
      hasSession: true,
      sessionExists: true,
      archive: () => {
        manager.archive(sessionId);
      },
    });
    expect(archiveResult.kind).toBe("archived");

    // Final state: session is in archive/
    expect(existsSync(sessionDir(cfg.goblinHome, sessionId))).toBe(false);
    expect(existsSync(join(cfg.goblinHome, "sessions", "archive", sessionId))).toBe(true);

    // Final state: binding is cleared (DM returns null on resolve)
    const afterArchive = manager.resolve(locator);
    expect(afterArchive).toBeNull();
  });

  it("rapid /new → /new → /archive leaves only last session archived", () => {
    const locator: ChatLocator = { chatId: 123456 };

    // First /new
    const first = executeNew({
      createSession: () => manager.createForChat(locator, { isSupergroup: false }),
    });
    const firstId = first.session.id;

    // Second /new (with archive of prior)
    const second = executeNew({
      archivePrior: () => manager.archive(firstId),
      createSession: () => manager.createForChat(locator, { isSupergroup: false }),
    });
    const secondId = second.session.id;
    expect(secondId).not.toBe(firstId);

    // First is archived, second is active
    expect(existsSync(join(cfg.goblinHome, "sessions", "archive", firstId))).toBe(true);
    expect(existsSync(sessionDir(cfg.goblinHome, secondId))).toBe(true);

    // Archive second
    const archiveResult = executeArchive({
      hasSession: true,
      sessionExists: true,
      archive: () => manager.archive(secondId),
    });
    expect(archiveResult.kind).toBe("archived");

    // Both archived, no active session
    expect(existsSync(join(cfg.goblinHome, "sessions", "archive", firstId))).toBe(true);
    expect(existsSync(join(cfg.goblinHome, "sessions", "archive", secondId))).toBe(true);
    expect(manager.resolve(locator)).toBeNull();
  });
});

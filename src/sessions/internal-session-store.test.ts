import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { personalEnvironment } from "./environment.ts";
import { InternalSessionStore } from "./internal-session-store.ts";
import { metricsPath, sessionDir, statePath, transcriptPath } from "./paths.ts";

describe("InternalSessionStore", () => {
  let home: string;
  let store: InternalSessionStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "goblin-internal-session-"));
    store = new InternalSessionStore(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("creates exact internal state and every runtime artifact", () => {
    const state = store.ensure("__internal_test__");

    expect(state).toMatchObject({
      id: "__internal_test__",
      chatId: 0,
      executionEnvironment: personalEnvironment(),
    });
    expect(existsSync(statePath(home, state.id))).toBe(true);
    expect(existsSync(transcriptPath(home, state.id))).toBe(true);
    expect(existsSync(metricsPath(home, state.id))).toBe(true);
    expect(existsSync(join(sessionDir(home, state.id), "events.jsonl"))).toBe(true);
  });

  it("returns existing state without truncating artifacts and restores missing artifacts", () => {
    const first = store.ensure("__internal_test__");
    writeFileSync(transcriptPath(home, first.id), "kept\n", "utf-8");
    const events = join(sessionDir(home, first.id), "events.jsonl");
    rmSync(events);

    const second = store.ensure("__internal_test__");

    expect(second).toEqual(first);
    expect(readFileSync(transcriptPath(home, first.id), "utf-8")).toBe("kept\n");
    expect(existsSync(events)).toBe(true);
  });

  it("rejects a Surface-backed record at a reserved internal identity", () => {
    const id = "__internal_test__";
    mkdirSync(sessionDir(home, id), { recursive: true });
    writeFileSync(statePath(home, id), JSON.stringify({
      id,
      createdAt: new Date().toISOString(),
      chatId: 123,
      executionEnvironment: personalEnvironment(),
    }));

    expect(() => store.ensure(id)).toThrow(/chatId: 0/);
  });

  it("rejects a non-reserved identity before touching state paths", () => {
    expect(() => store.ensure("abc123def0" as `__${string}__`)).toThrow(/reserved __…__ identity/);
    expect(existsSync(sessionDir(home, "abc123def0"))).toBe(false);
  });

  it("rejects malformed current-version internal records", () => {
    const invalidRecords = [
      {
        id: "__invalid_timestamp__",
        state: {
          id: "__invalid_timestamp__",
          createdAt: "not-a-date",
          chatId: 0,
          executionEnvironment: personalEnvironment(),
        },
        error: /invalid createdAt/,
      },
      {
        id: "__legacy_title__",
        state: {
          id: "__legacy_title__",
          createdAt: new Date().toISOString(),
          chatId: 0,
          title: "must not be a Conversation",
          executionEnvironment: personalEnvironment(),
        },
        error: /forbidden field: title/,
      },
      {
        id: "__legacy_topic__",
        state: {
          id: "__legacy_topic__",
          createdAt: new Date().toISOString(),
          chatId: 0,
          topicId: 7,
          executionEnvironment: personalEnvironment(),
        },
        error: /forbidden field: topicId/,
      },
      {
        id: "__invalid_environment__",
        state: {
          id: "__invalid_environment__",
          createdAt: new Date().toISOString(),
          chatId: 0,
          executionEnvironment: { kind: "personal", legacy: true },
        },
        error: /exact personal executionEnvironment/,
      },
    ];

    for (const invalid of invalidRecords) {
      mkdirSync(sessionDir(home, invalid.id), { recursive: true });
      writeFileSync(statePath(home, invalid.id), JSON.stringify(invalid.state));
      expect(() => store.ensure(invalid.id as `__${string}__`)).toThrow(invalid.error);
    }
  });
});

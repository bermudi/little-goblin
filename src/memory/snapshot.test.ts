import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./store.ts";
import { formatSnapshot } from "./snapshot.ts";
import { memoryDir } from "./paths.ts";

describe("formatSnapshot", () => {
  let tmp: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "goblin-memory-snap-"));
    mkdirSync(memoryDir(tmp), { recursive: true });
    store = new MemoryStore(tmp);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns null when both files are empty/absent", () => {
    expect(formatSnapshot(store)).toBeNull();
  });

  it("renders both sections when only memory.md is populated; user.md → (empty)", () => {
    store.add("memory", "fact-A");
    const snap = formatSnapshot(store);
    expect(snap).not.toBeNull();
    expect(snap!.customType).toBe("goblin.memory.snapshot");
    expect(typeof snap!.content).toBe("string");
    const text = snap!.content;
    expect(text.startsWith("[goblin memory snapshot]")).toBe(true);
    expect(text).toContain("## memory.md\nfact-A");
    expect(text).toContain("## user.md\n(empty)");
    // Order: memory first, then user.
    expect(text.indexOf("## memory.md")).toBeLessThan(text.indexOf("## user.md"));
  });

  it("renders both sections when only user.md is populated; memory.md → (empty)", () => {
    store.add("user", "pref-1");
    const snap = formatSnapshot(store);
    expect(snap).not.toBeNull();
    const text = snap!.content;
    expect(text).toContain("## memory.md\n(empty)");
    expect(text).toContain("## user.md\npref-1");
  });

  it("renders both files when both are populated, no (empty) placeholder", () => {
    store.add("memory", "m-1");
    store.add("user", "u-1");
    const snap = formatSnapshot(store);
    expect(snap).not.toBeNull();
    const text = snap!.content;
    expect(text).toContain("## memory.md\nm-1");
    expect(text).toContain("## user.md\nu-1");
    expect(text).not.toContain("(empty)");
  });

  it("payload shape matches sendCustomMessage Pick", () => {
    store.add("memory", "x");
    const snap = formatSnapshot(store)!;
    // display=false ensures the aside doesn't render in any TUI.
    expect(snap.display).toBe(false);
    expect(snap.details).toBeUndefined();
  });
});

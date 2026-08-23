import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryArtifactStore } from "./artifacts.ts";
import { dreamDiaryPath, dreamsDir, memoryDir, quarantinePath, quarantineRotatedPath } from "./paths.ts";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "goblin-artifacts-"));
}

function isoDay(offsetDays: number, from = Date.UTC(2026, 0, 15)): number {
  return from + offsetDays * 24 * 60 * 60 * 1000;
}

function ensureMemoryDirs(home: string): void {
  mkdirSync(memoryDir(home), { recursive: true });
  mkdirSync(dreamsDir(home), { recursive: true });
}

describe("MemoryArtifactStore", () => {
  it("appends quarantine records one per line", () => {
    const home = tempHome();
    const store = new MemoryArtifactStore(home);
    store.appendQuarantine({ timestamp: "2026-01-15T00:00:00.000Z", reason: "low_confidence" });
    store.appendQuarantine({ timestamp: "2026-01-15T00:01:00.000Z", reason: "unsafe" });
    const lines = readFileSync(quarantinePath(home), "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!).reason).toBe("low_confidence");
    expect(JSON.parse(lines[1]!).reason).toBe("unsafe");
    rmSync(home, { recursive: true, force: true });
  });

  it("appends dream-diary lines one per write", () => {
    const home = tempHome();
    const now = isoDay(0);
    const day = "2026-01-15";
    const store = new MemoryArtifactStore(home, () => now);
    store.appendDreamDiary("- 2026-01-15T00:00:00.000Z [deep] promoted 1 entries\n");
    store.appendDreamDiary("- 2026-01-15T00:00:01.000Z [light] promoted 0 entries\n");
    const content = readFileSync(dreamDiaryPath(home, day), "utf-8");
    expect(content).toContain("[deep] promoted 1 entries");
    expect(content).toContain("[light] promoted 0 entries");
    rmSync(home, { recursive: true, force: true });
  });

  it("rotates quarantine when the UTC day changes", () => {
    const home = tempHome();
    const day1 = isoDay(0);
    const day2 = isoDay(1);
    const store1 = new MemoryArtifactStore(home);
    store1.appendQuarantine({ timestamp: "2026-01-15T00:00:00.000Z", reason: "low_confidence" }, day1);
    utimesSync(quarantinePath(home), new Date(day1), new Date(day1));
    const store2 = new MemoryArtifactStore(home);
    store2.appendQuarantine({ timestamp: "2026-01-16T00:00:00.000Z", reason: "unsafe" }, day2);

    const active = readFileSync(quarantinePath(home), "utf-8").trim().split("\n");
    expect(active.length).toBe(1);
    expect(JSON.parse(active[0]!).reason).toBe("unsafe");

    const rotated = quarantineRotatedPath(home, "2026-01-15");
    const rotatedLines = readFileSync(rotated, "utf-8").trim().split("\n");
    expect(rotatedLines.length).toBe(1);
    expect(JSON.parse(rotatedLines[0]!).reason).toBe("low_confidence");

    rmSync(home, { recursive: true, force: true });
  });

  it("does not overwrite existing rotated quarantine files", () => {
    const home = tempHome();
    const day1 = isoDay(0);
    const day2 = isoDay(1);
    const date = "2026-01-15";

    ensureMemoryDirs(home);
    writeFileSync(quarantineRotatedPath(home, date, 0), JSON.stringify({ timestamp: "pre", reason: "pre" }) + "\n", "utf-8");

    const store1 = new MemoryArtifactStore(home);
    store1.appendQuarantine({ timestamp: "2026-01-15T00:00:00.000Z", reason: "first" }, day1);
    utimesSync(quarantinePath(home), new Date(day1), new Date(day1));

    const store2 = new MemoryArtifactStore(home);
    store2.appendQuarantine({ timestamp: "2026-01-16T00:00:00.000Z", reason: "second" }, day2);

    utimesSync(quarantinePath(home), new Date(day1), new Date(day1));
    const store3 = new MemoryArtifactStore(home);
    store3.appendQuarantine({ timestamp: "2026-01-16T00:00:01.000Z", reason: "third" }, day2);

    const base = readFileSync(quarantineRotatedPath(home, date, 0), "utf-8");
    expect(JSON.parse(base.trim()).reason).toBe("pre");

    const rotated1 = readFileSync(quarantineRotatedPath(home, date, 1), "utf-8").trim().split("\n");
    expect(rotated1.length).toBe(1);
    expect(JSON.parse(rotated1[0]!).reason).toBe("first");

    const rotated2 = readFileSync(quarantineRotatedPath(home, date, 2), "utf-8").trim().split("\n");
    expect(rotated2.length).toBe(1);
    expect(JSON.parse(rotated2[0]!).reason).toBe("second");

    const active = readFileSync(quarantinePath(home), "utf-8").trim().split("\n");
    expect(active.length).toBe(1);
    expect(JSON.parse(active[0]!).reason).toBe("third");

    rmSync(home, { recursive: true, force: true });
  });

  it("prunes rotated quarantine and daily diary files older than 45 days", () => {
    const home = tempHome();
    const now = isoDay(0);
    const old = now - 46 * 24 * 60 * 60 * 1000;
    const oldDate = "2025-11-30";

    ensureMemoryDirs(home);
    writeFileSync(quarantineRotatedPath(home, oldDate, 0), JSON.stringify({ reason: "old" }) + "\n", "utf-8");
    utimesSync(quarantineRotatedPath(home, oldDate, 0), new Date(old), new Date(old));
    writeFileSync(dreamDiaryPath(home, oldDate), "- old diary\n", "utf-8");
    utimesSync(dreamDiaryPath(home, oldDate), new Date(old), new Date(old));

    const currentDate = "2026-01-15";
    writeFileSync(quarantineRotatedPath(home, currentDate, 0), JSON.stringify({ reason: "current" }) + "\n", "utf-8");
    writeFileSync(dreamDiaryPath(home, currentDate), "- current diary\n", "utf-8");

    const store = new MemoryArtifactStore(home, () => now);
    const pruned = store.pruneAuditArtifacts(now);
    expect(pruned.quarantine).toBe(1);
    expect(pruned.diary).toBe(1);

    expect(() => statSync(quarantineRotatedPath(home, oldDate, 0))).toThrow();
    expect(() => statSync(dreamDiaryPath(home, oldDate))).toThrow();
    expect(statSync(quarantineRotatedPath(home, currentDate, 0)).isFile()).toBe(true);
    expect(statSync(dreamDiaryPath(home, currentDate)).isFile()).toBe(true);

    rmSync(home, { recursive: true, force: true });
  });

  it("prunes old audit artifacts after a diary append", () => {
    const home = tempHome();
    const now = isoDay(0);
    const old = now - 46 * 24 * 60 * 60 * 1000;
    const oldDate = "2025-11-30";
    ensureMemoryDirs(home);
    writeFileSync(dreamDiaryPath(home, oldDate), "- old diary\n", "utf-8");
    utimesSync(dreamDiaryPath(home, oldDate), new Date(old), new Date(old));

    const store = new MemoryArtifactStore(home, () => now);
    store.appendDreamDiary("- 2026-01-15T00:00:00.000Z [deep] summary\n");
    expect(() => statSync(dreamDiaryPath(home, oldDate))).toThrow();
    expect(statSync(dreamDiaryPath(home, "2026-01-15")).isFile()).toBe(true);

    rmSync(home, { recursive: true, force: true });
  });

  it("fails loudly on non-ENOENT filesystem errors", () => {
    const home = tempHome();
    writeFileSync(join(home, "state"), "not a directory");
    const store = new MemoryArtifactStore(home);
    expect(() => store.appendQuarantine({ reason: "fail" })).toThrow();
    rmSync(home, { recursive: true, force: true });
  });
});

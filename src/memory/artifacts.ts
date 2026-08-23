import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  dreamDiaryPath,
  dreamsDir,
  memoryDir,
  quarantinePath,
  quarantineRotatedPath,
} from "./paths.ts";

const AUDIT_RETENTION_DAYS = 45;

function toUtcIsoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

export class MemoryArtifactStore {
  private readonly home: string;
  private readonly clock: () => number;

  constructor(home: string, clock: () => number = () => Date.now()) {
    this.home = home;
    this.clock = clock;
  }

  appendQuarantine(record: object, now = this.clock()): void {
    this.rotateQuarantineIfNeeded(now);
    this.pruneAuditArtifacts(now);
    const path = quarantinePath(this.home);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(record) + "\n", "utf-8");
  }

  appendDreamDiary(line: string, now = this.clock()): void {
    this.pruneAuditArtifacts(now);
    const date = toUtcIsoDay(now);
    const path = dreamDiaryPath(this.home, date);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line, "utf-8");
  }

  pruneAuditArtifacts(now = this.clock()): { quarantine: number; diary: number } {
    const cutoff = now - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let quarantine = 0;
    let diary = 0;

    const quarantinePattern = /^quarantine-\d{4}-\d{2}-\d{2}(?:-\d+)?\.jsonl$/;
    try {
      for (const name of readdirSync(memoryDir(this.home))) {
        if (!quarantinePattern.test(name)) continue;
        const file = join(memoryDir(this.home), name);
        const stats = statSync(file);
        if (stats.mtimeMs < cutoff) {
          rmSync(file);
          quarantine++;
        }
      }
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }

    const diaryPattern = /^\d{4}-\d{2}-\d{2}\.md$/;
    try {
      for (const name of readdirSync(dreamsDir(this.home))) {
        if (!diaryPattern.test(name)) continue;
        const file = join(dreamsDir(this.home), name);
        const stats = statSync(file);
        if (stats.mtimeMs < cutoff) {
          rmSync(file);
          diary++;
        }
      }
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }

    return { quarantine, diary };
  }

  private activeQuarantineDate(): string | null {
    const path = quarantinePath(this.home);
    try {
      const stats = statSync(path);
      return toUtcIsoDay(stats.mtimeMs);
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  private rotateQuarantineIfNeeded(now: number): void {
    const path = quarantinePath(this.home);
    const activeDate = this.activeQuarantineDate();
    const today = toUtcIsoDay(now);
    if (activeDate === null || activeDate === today) return;

    let seq = 0;
    while (true) {
      const rotated = quarantineRotatedPath(this.home, activeDate, seq);
      if (!existsSync(rotated)) {
        try {
          renameSync(path, rotated);
        } catch (err) {
          if (isEnoent(err)) return;
          throw err;
        }
        return;
      }
      seq++;
      if (seq > 10_000) {
        throw new Error(`could not find a unique rotated quarantine name for ${activeDate}`);
      }
    }
  }
}

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { memoryDir, memoryFilePath, type MemoryTarget } from "./paths.ts";

/**
 * MemoryStore — file-backed curated memory at $GOBLIN_HOME/memory/.
 *
 * Two files: memory.md (4000 char cap) and user.md (2000 char cap).
 * Entries within each file are separated by the `\n§\n` delimiter.
 * All mutations are atomic (tmp + rename).
 */

const MEMORY_CAP = 4000;
const USER_CAP = 2000;
const DELIMITER = "\n§\n";

export type StoreResult = { ok: true } | { ok: false; error: string };

function capFor(target: MemoryTarget): number {
  return target === "memory" ? MEMORY_CAP : USER_CAP;
}

export class MemoryStore {
  private home: string;

  constructor(goblinHome: string) {
    this.home = goblinHome;
  }

  /**
   * Read raw file contents. Returns "" if the file does not exist.
   */
  read(target: MemoryTarget): string {
    const path = memoryFilePath(this.home, target);
    try {
      return readFileSync(path, "utf-8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw e;
    }
  }

  /**
   * Append a new entry to the target file.
   * Empty file → entry becomes the file's only contents (no delimiter).
   * Non-empty file → DELIMITER + entry is appended.
   */
  add(target: MemoryTarget, content: string): StoreResult {
    const current = this.read(target);
    const next = current.length === 0 ? content : current + DELIMITER + content;
    const overflow = this.checkCap(target, next);
    if (overflow) return overflow;
    this.write(target, next);
    return { ok: true };
  }

  /**
   * Replace a unique substring `oldText` with `content`.
   * Fails on zero or multiple matches.
   */
  replace(target: MemoryTarget, oldText: string, content: string): StoreResult {
    const current = this.read(target);
    const match = this.findUnique(current, oldText);
    if (!match.ok) return match;
    const next =
      current.slice(0, match.index) +
      content +
      current.slice(match.index + oldText.length);
    const overflow = this.checkCap(target, next);
    if (overflow) return overflow;
    this.write(target, next);
    return { ok: true };
  }

  /**
   * Remove the entry whose text uniquely matches `oldText` (substring).
   * The full enclosing entry (between delimiters) is removed, along with
   * one adjacent delimiter so the file remains well-formed.
   */
  remove(target: MemoryTarget, oldText: string): StoreResult {
    const current = this.read(target);
    const match = this.findUnique(current, oldText);
    if (!match.ok) return match;
    const next = removeEnclosingEntry(current, match.index, oldText.length);
    this.write(target, next);
    return { ok: true };
  }

  /**
   * Locate `needle` in `hay`. Succeeds only on exactly one occurrence.
   */
  private findUnique(
    hay: string,
    needle: string,
  ): { ok: true; index: number } | { ok: false; error: string } {
    if (needle.length === 0) {
      return { ok: false, error: "old_text must not be empty" };
    }
    const parts = hay.split(needle);
    const count = parts.length - 1;
    if (count === 0) {
      return { ok: false, error: `old_text not found in target` };
    }
    if (count > 1) {
      return {
        ok: false,
        error: `old_text matched ${count} locations; must be unique`,
      };
    }
    return { ok: true, index: parts[0]!.length };
  }

  private checkCap(target: MemoryTarget, next: string): StoreResult | null {
    const cap = capFor(target);
    if (next.length > cap) {
      return {
        ok: false,
        error: `${target}.md would be ${next.length} chars (cap ${cap}, overflow ${next.length - cap}); consolidate before retrying`,
      };
    }
    return null;
  }

  /**
   * Atomic write: tmp file in memoryDir + rename to final path.
   */
  private write(target: MemoryTarget, contents: string): void {
    const dir = memoryDir(this.home);
    mkdirSync(dir, { recursive: true });
    const finalPath = memoryFilePath(this.home, target);
    const tmpPath = join(dir, `.${target}.md.${randomBytes(6).toString("hex")}.tmp`);
    writeFileSync(tmpPath, contents, "utf-8");
    renameSync(tmpPath, finalPath);
  }
}

/**
 * Given a match at `index` of length `len`, remove the entry containing it
 * along with one neighboring delimiter (preferring the preceding one) so the
 * file remains a clean delimiter-joined sequence.
 */
function removeEnclosingEntry(
  current: string,
  index: number,
  len: number,
): string {
  // Find entry boundaries: scan for nearest DELIMITER on each side.
  // Entry start: index of last DELIMITER at or before `index`, plus its length.
  // Entry end: index of next DELIMITER at or after `index + len`.
  const before = current.lastIndexOf(DELIMITER, index);
  const entryStart = before === -1 ? 0 : before + DELIMITER.length;
  const after = current.indexOf(DELIMITER, index + len);
  const entryEnd = after === -1 ? current.length : after;

  // Remove entry plus exactly one delimiter (to keep file well-formed).
  if (before !== -1) {
    // Remove preceding delimiter + entry.
    return current.slice(0, before) + current.slice(entryEnd);
  }
  if (after !== -1) {
    // First entry: remove entry + following delimiter.
    return current.slice(0, entryStart) + current.slice(after + DELIMITER.length);
  }
  // Sole entry: clear file.
  return "";
}

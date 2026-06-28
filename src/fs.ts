import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Atomically write `data` to `filePath`.
 *
 * Writes to a temp file in the same directory, fsyncs it, then renames it
 * into place. If `filePath` already exists and is a symlink, the rename
 * targets the resolved real path so we never replace the symlink itself
 * (only the file it points at).
 *
 * POSIX rename is atomic, so readers either see the old or the new file,
 * never a partial write.
 */
export function atomicWrite(filePath: string, data: string): void {
  const dir = dirname(filePath);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    // EEXIST is expected when `dir` already exists — including the bun
    // quirk where a recursive mkdir throws EEXIST if `dir` is itself a
    // symlink to an existing directory. Anything else propagates.
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }

  const tmpPath = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmpPath, "w");
  try {
    try {
      writeFileSync(fd, data, "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    // Resolve symlinks on the existing target so we replace the real file,
    // not the symlink itself. If the file doesn't exist yet, write to the
    // given path as-is (preserving any symlinked parent directories).
    const finalPath = existsSync(filePath) ? realpathSync(filePath) : filePath;
    renameSync(tmpPath, finalPath);
  } catch (err) {
    // Write, fsync, or rename failed — remove the tmp file so it doesn't
    // leak. Matters for subagent/meta dirs: archiveOrphan in
    // memory/store.ts aborts on any `.tmp` file present in a scope
    // directory, so a leaked tmp here could later block a memory archive.
    try { rmSync(tmpPath, { force: true }); } catch { /* already gone */ }
    throw err;
  }
}

import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
 *
 * Permission preservation: when the target already exists, the replacement
 * inherits the existing file's mode (e.g. a hardened `0600` goblin.json5
 * stays `0600` instead of downgrading to `0644` under a typical umask).
 * Pass `options.mode` to force a mode for a new file; otherwise new files
 * use the process default (`0666 & ~umask`).
 */
export function atomicWrite(filePath: string, data: string, options?: { mode?: number }): void {
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
  // Capture the existing mode before creating the tmp file so a sensitive
  // file (e.g. goblin.json5 with credentials) keeps its permissions across
  // replacement. `statSync` follows the symlink target, matching the
  // realpath resolution used for the final rename below.
  let targetMode: number | undefined = options?.mode;
  if (targetMode === undefined) {
    try {
      targetMode = statSync(filePath).mode & 0o777;
    } catch {
      targetMode = undefined;
    }
  }
  const fd = openSync(tmpPath, "w");
  try {
    try {
      writeFileSync(fd, data, "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    if (targetMode !== undefined) {
      chmodSync(tmpPath, targetMode);
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

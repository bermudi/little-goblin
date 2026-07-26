/**
 * Attachment destination and reservation helpers for Telegram intake.
 *
 * Documents, voice, and audio are saved to a destination derived from the
 * Conversation's immutable ExecutionEnvironment:
 *  - personal -> $GOBLIN_HOME/workspace/attachments/
 *  - project  -> canonical project root
 *
 * Names are reduced with `basename`, trimmed, and rejected when empty, `.`,
 * or `..`.  Existing files are never overwritten: `saveAttachment` atomically
 * reserves a collision-free name by creating with `O_EXCL` and, when the
 * original name is taken, appends a numeric suffix before the extension.
 */

import { basename, join, parse } from "node:path";
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { attachmentsPath } from "../workspace/paths.ts";
import { isProjectEnvironment, type ExecutionEnvironment } from "../sessions/environment.ts";

/** Thrown when a supplied attachment filename is empty, `.`, `..`, or otherwise unsafe. */
export class UnsafeAttachmentNameError extends Error {
  constructor(public readonly fileName: string) {
    super(`unsafe attachment filename: ${fileName}`);
  }
}

/** Thrown when an attachment cannot be written to its reserved destination. */
export class AttachmentSaveError extends Error {
  constructor(
    public readonly destination: string,
    cause?: unknown,
  ) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`failed to save attachment at ${destination}${msg ? `: ${msg}` : ""}`);
  }
}

/** The result of a successful attachment save. */
export interface SavedAttachment {
  /** Reserved filename (basename), e.g. `notes.md` or `notes-2.md`. */
  fileName: string;
  /** Path relative to the runner's CWD, e.g. `attachments/notes.md` or `notes.md`. */
  relativePath: string;
  /** Absolute filesystem path where the file was written. */
  absolutePath: string;
}

const MAX_RESERVATION_ATTEMPTS = 1000;

function isEEXIST(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST";
}

function sanitizeAttachmentName(desiredName: string): string {
  const safeName = basename(desiredName).trim();
  if (!safeName || safeName === "." || safeName === "..") {
    throw new UnsafeAttachmentNameError(desiredName);
  }
  return safeName;
}

function attachmentBaseDir(env: ExecutionEnvironment, home: string): string {
  return isProjectEnvironment(env) ? env.projectRoot : attachmentsPath(home);
}

function relativeAttachmentPath(env: ExecutionEnvironment, fileName: string): string {
  return isProjectEnvironment(env) ? fileName : `attachments/${fileName}`;
}

function nextUniqueName(original: string, index: number): string {
  const parsed = parse(original);
  if (parsed.name) {
    return `${parsed.name}-${index}${parsed.ext}`;
  }
  // Dotfile or extension-only name: append the suffix to the whole base.
  return `${parsed.base}-${index}`;
}

/**
 * Save an attachment to the environment-derived destination.
 *
 * The directory is created lazily. The name is sanitized and, if already
 * present, a numeric suffix is inserted before the extension until a free name
 * is reserved atomically with `O_EXCL`. On failure the file is cleaned up when
 * it was newly created by this call.
 */
export function saveAttachment(
  env: ExecutionEnvironment,
  home: string,
  desiredName: string,
  bytes: Uint8Array,
): SavedAttachment {
  const safeName = sanitizeAttachmentName(desiredName);
  const dir = attachmentBaseDir(env, home);
  mkdirSync(dir, { recursive: true });

  let fileName = safeName;
  for (let attempt = 1; attempt <= MAX_RESERVATION_ATTEMPTS; attempt += 1) {
    const absolutePath = join(dir, fileName);
    let fd: number | undefined;
    try {
      fd = openSync(absolutePath, "wx");
      try {
        writeFileSync(fd, bytes);
      } catch (err) {
        try {
          closeSync(fd);
        } catch {
          // fd may already be invalid; ignore.
        }
        try {
          rmSync(absolutePath, { force: true });
        } catch {
          // Cleanup best-effort.
        }
        throw new AttachmentSaveError(absolutePath, err);
      }
      closeSync(fd);
      return {
        fileName,
        relativePath: relativeAttachmentPath(env, fileName),
        absolutePath,
      };
    } catch (err) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // ignore
        }
      }
      if (isEEXIST(err)) {
        fileName = nextUniqueName(safeName, attempt + 1);
        continue;
      }
      throw err instanceof AttachmentSaveError ? err : new AttachmentSaveError(absolutePath, err);
    }
  }

  throw new AttachmentSaveError(join(dir, safeName), "could not reserve a collision-free name");
}

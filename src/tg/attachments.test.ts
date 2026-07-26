import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveAttachment, UnsafeAttachmentNameError, AttachmentSaveError } from "./attachments.ts";
import { attachmentsPath } from "../workspace/paths.ts";
import { personalEnvironment, projectEnvironment } from "../sessions/environment.ts";

const dirs: string[] = [];

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "goblin-attachments-test-"));
  dirs.push(dir);
  return dir;
}

function makeProjectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "goblin-project-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("saveAttachment", () => {
  it("saves personal uploads under workspace/attachments/", () => {
    const home = makeHome();
    const env = personalEnvironment();
    const bytes = new TextEncoder().encode("hello");

    const saved = saveAttachment(env, home, "notes.md", bytes);

    expect(saved.fileName).toBe("notes.md");
    expect(saved.relativePath).toBe("attachments/notes.md");
    expect(saved.absolutePath).toBe(join(attachmentsPath(home), "notes.md"));
    expect(existsSync(saved.absolutePath)).toBe(true);
    expect(readFileSync(saved.absolutePath, "utf-8")).toBe("hello");
  });

  it("saves project uploads at the project root", () => {
    const home = makeHome();
    const projectRoot = makeProjectRoot();
    const env = projectEnvironment(projectRoot);
    const bytes = new TextEncoder().encode("project data");

    const saved = saveAttachment(env, home, "notes.md", bytes);

    expect(saved.fileName).toBe("notes.md");
    expect(saved.relativePath).toBe("notes.md");
    expect(saved.absolutePath).toBe(join(projectRoot, "notes.md"));
    expect(existsSync(saved.absolutePath)).toBe(true);
    expect(readFileSync(saved.absolutePath, "utf-8")).toBe("project data");
  });

  it("rejects empty, dot, and dot-dot filenames", () => {
    const home = makeHome();
    const env = personalEnvironment();
    const bytes = new TextEncoder().encode("x");

    expect(() => saveAttachment(env, home, "", bytes)).toThrow(UnsafeAttachmentNameError);
    expect(() => saveAttachment(env, home, "  ", bytes)).toThrow(UnsafeAttachmentNameError);
    expect(() => saveAttachment(env, home, ".", bytes)).toThrow(UnsafeAttachmentNameError);
    expect(() => saveAttachment(env, home, "..", bytes)).toThrow(UnsafeAttachmentNameError);
    expect(() => saveAttachment(env, home, "foo/../..", bytes)).toThrow(UnsafeAttachmentNameError);
  });

  it("strips directory components from supplied names", () => {
    const home = makeHome();
    const env = personalEnvironment();
    const bytes = new TextEncoder().encode("safe");

    const saved = saveAttachment(env, home, "../../etc/passwd", bytes);

    expect(saved.fileName).toBe("passwd");
    expect(saved.relativePath).toBe("attachments/passwd");
    expect(existsSync(saved.absolutePath)).toBe(true);
  });

  it("does not overwrite existing files and appends a numeric suffix", () => {
    const home = makeHome();
    const env = personalEnvironment();
    const first = saveAttachment(env, home, "notes.md", new TextEncoder().encode("first"));
    const second = saveAttachment(env, home, "notes.md", new TextEncoder().encode("second"));

    expect(first.fileName).toBe("notes.md");
    expect(second.fileName).toBe("notes-2.md");
    expect(second.relativePath).toBe("attachments/notes-2.md");

    expect(readFileSync(first.absolutePath, "utf-8")).toBe("first");
    expect(readFileSync(second.absolutePath, "utf-8")).toBe("second");
  });

  it("keeps suffixing for names without an extension", () => {
    const home = makeHome();
    const env = personalEnvironment();

    saveAttachment(env, home, "README", new TextEncoder().encode("first"));
    const second = saveAttachment(env, home, "README", new TextEncoder().encode("second"));

    expect(second.fileName).toBe("README-2");
    expect(readFileSync(second.absolutePath, "utf-8")).toBe("second");
  });

  it("throws AttachmentSaveError when the destination directory is not writable", () => {
    const home = makeHome();
    const env = personalEnvironment();
    // Make attachments dir but remove write permission.
    const dir = attachmentsPath(home);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o000);
    try {
      expect(() => saveAttachment(env, home, "notes.md", new TextEncoder().encode("x"))).toThrow(
        AttachmentSaveError,
      );
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});

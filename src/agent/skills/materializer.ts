import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  SkillResolutionError,
  type ResolvedSkillSnapshot,
} from "./types.ts";

function isContainedPath(root: string, target: string): boolean {
  const escaped = relative(root, target);
  return escaped !== ".." &&
    !escaped.startsWith(`..${sep}`) &&
    !isAbsolute(escaped);
}

/**
 * Materialize one captured skill without using its display name as a path
 * component. The root is a private temporary directory owned by the caller;
 * the index makes each selected skill's directory unique within that root.
 */
export function materializeSkillSnapshot(
  snapshot: ResolvedSkillSnapshot,
  index: number,
  root: string,
): string {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new SkillResolutionError(`invalid skill snapshot index: ${index}`);
  }

  const resolvedRoot = resolve(root);
  const skillDirectory = resolve(resolvedRoot, String(index));
  if (!isContainedPath(resolvedRoot, skillDirectory)) {
    throw new SkillResolutionError(`skill snapshot directory escapes root: ${index}`);
  }

  mkdirSync(skillDirectory, { recursive: true });
  for (const file of snapshot.files) {
    if (isAbsolute(file.relativePath)) {
      throw new SkillResolutionError(`invalid relative path in skill snapshot: ${file.relativePath}`);
    }
    const target = resolve(skillDirectory, file.relativePath);
    if (!isContainedPath(skillDirectory, target)) {
      throw new SkillResolutionError(`invalid relative path in skill snapshot: ${file.relativePath}`);
    }
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, Buffer.from(file.base64, "base64"), { flag: "wx" });
  }

  if (isAbsolute(snapshot.entryPath)) {
    throw new SkillResolutionError(`invalid entry path in skill snapshot: ${snapshot.entryPath}`);
  }
  const entryPath = resolve(skillDirectory, snapshot.entryPath);
  if (!isContainedPath(skillDirectory, entryPath)) {
    throw new SkillResolutionError(`invalid entry path in skill snapshot: ${snapshot.entryPath}`);
  }
  return entryPath;
}

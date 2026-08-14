/**
 * Skill catalog resolver.
 *
 * Maps a {@link SkillPolicy} and an {@link ExecutionEnvironment} to exact
 * filesystem roots, loads each root with pi's Agent Skills parser, applies
 * source-level selection, deduplicates same-file selections, fails on
 * distinct-file name conflicts, and returns a frozen {@link ResolvedSkillSet}.
 *
 * Per decision 0034: no ambient pi discovery. Every selected skill has an
 * explicit source and canonical path. Project roots do not walk ancestors.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { opendir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
  loadSourcedSkills,
  type Skill,
  type SkillDiagnostic,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { ExecutionEnvironment } from "../../sessions/environment.ts";
import { goblinSkillsPath, personalEnvironmentSkillsPath } from "../../workspace/paths.ts";
import {
  DEFAULT_SKILL_POLICY,
  ResolvedSkill,
  ResolvedSkillDiagnostic,
  ResolvedSkillSet,
  SkillResolutionError,
  SkillSource,
  SkillPolicy,
  SourceSelection,
  normalizeSkillPolicy,
} from "./types.ts";

/** Maximum raw size of one captured skill resource. */
export const MAX_SKILL_FILE_BYTES = 1 * 1024 * 1024;
/** Maximum UTF-8 size of one serialized captured skill directory. */
export const MAX_SKILL_SNAPSHOT_BYTES = 8 * 1024 * 1024;
/** Maximum UTF-8 size of all serialized captured skill directories in one plan. */
export const MAX_TOTAL_SKILL_SNAPSHOT_BYTES = 32 * 1024 * 1024;
/** Maximum directory entries visited while capturing one skill directory. */
export const MAX_SKILL_SNAPSHOT_ENTRIES = 4096;
/** Maximum number of skill directories captured concurrently. */
export const MAX_SKILL_SNAPSHOT_CONCURRENCY = 4;

/**
 * Map a source to its exact filesystem root(s) for the given environment.
 * Returns an empty array when the source has no roots for this environment.
 */
function sourceRoots(
  source: SkillSource,
  environment: ExecutionEnvironment,
  home: string,
): string[] {
  switch (source) {
    case "goblin":
      return [goblinSkillsPath(home)];
    case "environment":
      if (environment.kind === "personal") {
        return [personalEnvironmentSkillsPath(home)];
      }
      // Project environment: exact project root catalogs, no ancestor walk.
      return [
        join(environment.projectRoot, ".agents", "skills"),
        join(environment.projectRoot, ".pi", "skills"),
      ];
    case "host":
      return [join(homedir(), ".agents", "skills")];
  }
}

/** Apply a SourceSelection to a list of loaded skills from one source. */
function applySelection(
  selection: SourceSelection,
  skills: Array<{ skill: Skill; source: SkillSource }>,
): Array<{ skill: Skill; source: SkillSource }> {
  if (selection.mode === "none") return [];
  if (selection.mode === "all") return skills;
  // selected: keep only skills whose name is in the selection set.
  const wanted = new Set(selection.names);
  return skills.filter((entry) => wanted.has(entry.skill.name));
}

/**
 * Resolve skill catalogs into a frozen {@link ResolvedSkillSet}.
 *
 * Missing optional roots are empty catalogs. The same canonical file selected
 * through two roots is deduplicated. Distinct files with the same declared name
 * after policy filtering are an error. A selected name absent from its source
 * is also an error.
 */
export async function resolveSkillSet(
  environment: ExecutionEnvironment,
  policy: SkillPolicy = DEFAULT_SKILL_POLICY,
  home: string,
): Promise<ResolvedSkillSet> {
  const env = new NodeExecutionEnv({ cwd: home });
  try {
    return await resolveWithEnv(env, environment, policy, home);
  } finally {
    await env.cleanup();
  }
}

async function resolveWithEnv(
  env: NodeExecutionEnv,
  environment: ExecutionEnvironment,
  policy: SkillPolicy,
  home: string,
): Promise<ResolvedSkillSet> {
  const canonicalPolicy = normalizeSkillPolicy(policy);

  // Build the list of (path, source) inputs for pi's loader. Only sources
  // whose selection is not `none` are loaded; `none` sources contribute no
  // skills and no diagnostics.
  const sources: SkillSource[] = ["goblin", "environment", "host"];
  const inputs: Array<{ path: string; source: SkillSource }> = [];
  for (const source of sources) {
    if (canonicalPolicy[source].mode === "none") continue;
    for (const root of sourceRoots(source, environment, home)) {
      inputs.push({ path: root, source });
    }
  }

  const loaded = await loadSourcedSkills<SkillSource>(env, inputs);

  // Group skills by source for selection and missing-name detection.
  const bySource = new Map<SkillSource, Array<{ skill: Skill; source: SkillSource }>>();
  for (const source of sources) {
    bySource.set(source, []);
  }
  for (const entry of loaded.skills) {
    bySource.get(entry.source)!.push(entry);
  }

  // Apply policy per source and detect missing selected names.
  const selected: Array<{ skill: Skill; source: SkillSource }> = [];
  for (const source of sources) {
    const selection = canonicalPolicy[source];
    const skillsForSource = bySource.get(source)!;

    if (selection.mode === "selected") {
      const normalized = [...selection.names];
      const loadedNames = new Set(skillsForSource.map((e) => e.skill.name));
      const missing = normalized.filter((n) => !loadedNames.has(n));
      if (missing.length > 0) {
        throw new SkillResolutionError(
          `selected skill name(s) not found in ${source} catalog: ${missing.join(", ")}`,
        );
      }
    }

    selected.push(...applySelection(selection, skillsForSource));
  }

  // Deduplicate same canonical file selected through different roots, and
  // detect distinct files with the same name (a conflict). Use realpathSync
  // so that two paths through a symlink to the same file are recognized as
  // the same canonical file.
  const byCanonicalPath = new Map<string, { skill: Skill; source: SkillSource }>();
  const byName = new Map<string, Array<{ skill: Skill; source: SkillSource }>>();

  for (const entry of selected) {
    const canonical = realpathSync(entry.skill.filePath);
    const existing = byCanonicalPath.get(canonical);
    if (existing !== undefined) {
      // Same file already selected; deduplicate by keeping the first occurrence.
      continue;
    }
    byCanonicalPath.set(canonical, entry);
    const named = byName.get(entry.skill.name);
    if (named === undefined) {
      byName.set(entry.skill.name, [entry]);
    } else {
      named.push(entry);
    }
  }

  // Conflict detection: distinct files with the same name after policy filtering.
  const conflicts: string[] = [];
  for (const [name, entries] of byName) {
    if (entries.length > 1) {
      const paths = entries.map((e) => `${e.source}:${e.skill.filePath}`).join(", ");
      conflicts.push(`skill name "${name}" selected from distinct files: ${paths}`);
    }
  }
  if (conflicts.length > 0) {
    throw new SkillResolutionError(conflicts.join("; "));
  }

  // Build the immutable DTO list in stable order: source, then name, then path.
  // Use the realpath for filePath so two paths through a symlink produce the
  // same canonical output, matching the dedup key.
  const resolvedSkills: ResolvedSkill[] = [...byCanonicalPath.values()]
    .map((entry) => ({
      source: entry.source,
      name: entry.skill.name,
      filePath: realpathSync(entry.skill.filePath),
    }))
    .sort((a, b) =>
      a.source === b.source
        ? a.name === b.name
          ? a.filePath.localeCompare(b.filePath)
          : a.name.localeCompare(b.name)
        : a.source.localeCompare(b.source),
    );

  const snapshottedSkills = await captureSkillSnapshots(resolvedSkills);

  const resolvedDiagnostics: ResolvedSkillDiagnostic[] = loaded.diagnostics.map(
    (d: SkillDiagnostic & { source: SkillSource }) => ({
      source: d.source,
      code: d.code,
      message: d.message,
      path: d.path,
    }),
  );

  const fingerprint = computeFingerprint(environment, canonicalPolicy, snapshottedSkills);
  return { skills: snapshottedSkills, diagnostics: resolvedDiagnostics, fingerprint };
}

interface CapturedSkillSnapshot {
  readonly snapshot: NonNullable<ResolvedSkill["snapshot"]>;
  readonly bytes: number;
}

/**
 * Capture selected skills with both a concurrency limit and an aggregate
 * serialized-size limit. The pool keeps filesystem and base64 work bounded;
 * the byte total keeps the resulting runtime plan bounded even when every
 * individual skill is within its per-skill limit.
 */
async function captureSkillSnapshots(
  skills: readonly ResolvedSkill[],
): Promise<ResolvedSkill[]> {
  const captured = new Array<ResolvedSkill | undefined>(skills.length);
  let nextIndex = 0;
  let totalBytes = 0;
  let failed = false;
  let failure: unknown;

  const captureOne = async (): Promise<void> => {
    while (!failed) {
      const index = nextIndex;
      nextIndex += 1;
      const skill = skills[index];
      if (skill === undefined) return;

      try {
        const result = await captureSkillSnapshot(skill.filePath);
        if (failed) return;
        const nextTotalBytes = totalBytes + result.bytes;
        if (nextTotalBytes > MAX_TOTAL_SKILL_SNAPSHOT_BYTES) {
          failed = true;
          failure = new SkillResolutionError(
            `skill snapshots exceed ${MAX_TOTAL_SKILL_SNAPSHOT_BYTES} bytes`,
          );
          return;
        }
        totalBytes = nextTotalBytes;
        captured[index] = { ...skill, snapshot: result.snapshot };
      } catch (error) {
        failed = true;
        failure = error;
        return;
      }
    }
  };

  const workerCount = Math.min(MAX_SKILL_SNAPSHOT_CONCURRENCY, skills.length);
  await Promise.all(Array.from({ length: workerCount }, () => captureOne()));
  if (failed) throw failure;
  return captured.map((skill) => {
    if (skill === undefined) {
      throw new Error("skill snapshot capture completed without a result");
    }
    return skill;
  });
}

async function captureSkillSnapshot(filePath: string): Promise<CapturedSkillSnapshot> {
  const skillDirectory = dirname(filePath);
  const entryPath = relative(skillDirectory, filePath);
  const files: { relativePath: string; base64: string }[] = [];
  // Count the exact JSON representation incrementally. This includes the
  // entry path, file paths, base64 payloads, and JSON separators, rather than
  // budgeting only file contents.
  let snapshotBytes = Buffer.byteLength(
    `{"entryPath":${JSON.stringify(entryPath)},"files":[]}`,
  );
  if (snapshotBytes > MAX_SKILL_SNAPSHOT_BYTES) {
    throw new SkillResolutionError(
      `skill snapshot exceeds ${MAX_SKILL_SNAPSHOT_BYTES} bytes: ${skillDirectory}`,
    );
  }
  let visitedEntries = 0;

  async function visit(directory: string): Promise<void> {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      visitedEntries += 1;
      if (visitedEntries > MAX_SKILL_SNAPSHOT_ENTRIES) {
        throw new SkillResolutionError(
          `skill snapshot exceeds ${MAX_SKILL_SNAPSHOT_ENTRIES} entries: ${skillDirectory}`,
        );
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      // Skill resources are ordinary files. Resolve symlink targets before
      // reading so directory links are skipped while file links are copied.
      let targetStats: Awaited<ReturnType<typeof stat>>;
      if (entry.isSymbolicLink()) {
        try {
          targetStats = await stat(path);
        } catch (error) {
          // A broken link is not a usable resource.
          if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
          throw error;
        }
        if (!targetStats.isFile()) continue;
      } else {
        if (!entry.isFile()) continue;
        targetStats = await stat(path);
      }
      if (targetStats.size > MAX_SKILL_FILE_BYTES) {
        throw new SkillResolutionError(
          `skill resource exceeds ${MAX_SKILL_FILE_BYTES} bytes: ${path}`,
        );
      }
      const relativePath = relative(skillDirectory, path);
      const bytes = await readFile(path);
      if (bytes.byteLength > MAX_SKILL_FILE_BYTES) {
        throw new SkillResolutionError(
          `skill resource exceeds ${MAX_SKILL_FILE_BYTES} bytes: ${path}`,
        );
      }
      const base64 = bytes.toString("base64");
      const serializedFile = JSON.stringify({ relativePath, base64 });
      const nextBytes = snapshotBytes +
        (files.length === 0 ? 0 : Buffer.byteLength(",")) +
        Buffer.byteLength(serializedFile);
      if (nextBytes > MAX_SKILL_SNAPSHOT_BYTES) {
        throw new SkillResolutionError(
          `skill snapshot exceeds ${MAX_SKILL_SNAPSHOT_BYTES} bytes: ${skillDirectory}`,
        );
      }
      snapshotBytes = nextBytes;
      files.push({
        relativePath,
        base64,
      });
    }
  }

  await visit(skillDirectory);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return {
    snapshot: {
      entryPath,
      files,
    },
    bytes: snapshotBytes,
  };
}

/**
 * Stable fingerprint: SHA-256 over canonical environment identity, canonical
 * policy, and selected `{source,name,filePath}` tuples. Skill bodies are not
 * hashed; filesystem edits require runtime recreation or an explicit reload.
 */
function computeFingerprint(
  environment: ExecutionEnvironment,
  policy: SkillPolicy,
  skills: readonly ResolvedSkill[],
): string {
  const envIdentity =
    environment.kind === "personal"
      ? { kind: "personal" }
      : { kind: "project", projectRoot: environment.projectRoot };

  const policyIdentity = {
    goblin: policy.goblin,
    environment: policy.environment,
    host: policy.host,
  };

  const skillTuples = skills.map((s) => ({
    source: s.source,
    name: s.name,
    filePath: s.filePath,
  }));

  const stable = JSON.stringify({
    environment: envIdentity,
    policy: policyIdentity,
    skills: skillTuples,
  });

  return createHash("sha256").update(stable).digest("hex");
}

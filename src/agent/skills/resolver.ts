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
import { join } from "node:path";
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

  const resolvedDiagnostics: ResolvedSkillDiagnostic[] = loaded.diagnostics.map(
    (d: SkillDiagnostic & { source: SkillSource }) => ({
      source: d.source,
      code: d.code,
      message: d.message,
      path: d.path,
    }),
  );

  const fingerprint = computeFingerprint(environment, canonicalPolicy, resolvedSkills);
  return { skills: resolvedSkills, diagnostics: resolvedDiagnostics, fingerprint };
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

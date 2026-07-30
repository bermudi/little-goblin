/**
 * Named-agent definition loading and resource-loader construction.
 *
 * A "named agent" is a curated subagent recipe at `~/goblin/agents/<name>/`
 * with its own `AGENTS.md` (system prompt) and `skills/` directory. Spawning
 * one uses a custom pi `ResourceLoader` that pins skill discovery to the
 * agent's own tree — strict isolation from goblin and from other agents.
 *
 * Generic subagents (no name) run in the parent runtime's inherited Execution
 * Environment and get a loader that pins exactly its frozen resolved skill
 * manifest — selected SKILL.md files and nothing else — so no ambient pi
 * discovery occurs (decision 0034 chain).
 */

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  DefaultResourceLoader,
  type ResourceLoader,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { SkillResolutionError, type ResolvedSkillSet } from "../agent/skills/mod.ts";
import { piAgentDir } from "../pi-host.ts";
import { agentsMdPath, heartbeatMdPath, soulMdPath } from "../workspace/paths.ts";
import { namedAgentAgentsMdPath, namedAgentDir, namedAgentSkillsDir } from "./paths.ts";
import type { NamedAgentDefinition, SubagentRole } from "./types.ts";

/** Valid characters for a named agent: alphanumeric, hyphens, underscores. */
export const VALID_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Load a named agent definition from `~/goblin/agents/<name>/`.
 *
 * `AGENTS.md` is required. The `skills/` directory is optional — its path
 * is recorded so the resource loader can pin to it for strict isolation,
 * regardless of whether the agent has any skills yet.
 */
export function loadNamedAgent(home: string, name: string): NamedAgentDefinition {
  const agentsMdPath = namedAgentAgentsMdPath(home, name);
  let agentsMd: string;
  try {
    agentsMd = readFileSync(agentsMdPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Named agent '${name}' not found`);
    }
    throw err;
  }
  return {
    name,
    dir: namedAgentDir(home, name),
    agentsMd,
    skillsDir: namedAgentSkillsDir(home, name),
  };
}

/**
 * Resolved paths of the three goblin deployment prompt files. Any context
 * file discovered by pi whose absolute path matches one of these is filtered
 * out of a subagent's bootstrap so subagents do not receive deployment
 * identity or operating rules.
 */
function deploymentPromptFilePaths(home: string): Set<string> {
  return new Set([
    resolve(soulMdPath(home)),
    resolve(agentsMdPath(home)),
    resolve(heartbeatMdPath(home)),
  ]);
}

/**
 * Build the pi `ResourceLoader` for a subagent.
 *
 * Named subagents get strict isolation: goblin's project AGENTS.md is not
 * auto-discovered, the named agent's AGENTS.md is the system prompt verbatim,
 * and skill discovery is pinned to the agent's own `skills/` directory.
 *
 * Generic subagents pin `additionalSkillPaths` to exactly the inherited
 * manifest's SKILL.md files with `noSkills: true`, mirroring the main
 * backend (decision 0034: no ambient pi discovery). They also filter
 * goblin's deployment prompt files (`SOUL.md`, `AGENTS.md`, `HEARTBEAT.md`)
 * out of any context-file discovery.
 *
 * A generic invocation without a manifest, with an unavailable selected file,
 * or whose loader omits a selected file fails visibly. Pi otherwise records a
 * diagnostic and silently continues, so this module enforces the postcondition.
 */
export async function buildResourceLoader(opts: {
  home: string;
  cwd: string;
  role: SubagentRole;
  definition: NamedAgentDefinition | null;
  /** Frozen manifest inherited by a generic subagent; ignored for named. */
  inheritedSkills: ResolvedSkillSet | null;
  settingsManager: SettingsManager;
  /** Optional memory summary to append to the system prompt. */
  memorySystemPrompt?: string;
}): Promise<ResourceLoader | undefined> {
  const { home, cwd, role, definition, inheritedSkills, settingsManager, memorySystemPrompt } = opts;

  if (role === "named" && definition !== null) {
    const systemPrompt = memorySystemPrompt
      ? `${definition.agentsMd}\n\n${memorySystemPrompt}`
      : definition.agentsMd;
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: piAgentDir(home),
      settingsManager,
      noContextFiles: true,
      noSkills: true,
      additionalSkillPaths: [definition.skillsDir],
      systemPrompt,
    });
    await loader.reload();
    return loader;
  }

  if (role === "generic") {
    if (inheritedSkills === null) {
      throw new SkillResolutionError(
        "generic subagent requires an inherited resolved skill manifest",
      );
    }
    const skillPaths = inheritedSkills.skills.map((s) => s.filePath);
    const missing: string[] = [];
    for (const skillPath of skillPaths) {
      try {
        if (!statSync(skillPath).isFile()) {
          throw new SkillResolutionError(
            `inherited skill path is not a file: ${skillPath}`,
          );
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          missing.push(skillPath);
          continue;
        }
        throw err;
      }
    }
    if (missing.length > 0) {
      throw new SkillResolutionError(
        `inherited skill file(s) missing: ${missing.join(", ")}`,
      );
    }
    const deploymentFiles = deploymentPromptFilePaths(home);
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: piAgentDir(home),
      settingsManager,
      noSkills: true,
      additionalSkillPaths: skillPaths,
      ...(memorySystemPrompt ? { systemPrompt: memorySystemPrompt } : {}),
      agentsFilesOverride: ({ agentsFiles }) => ({
        agentsFiles: agentsFiles.filter((f) => !deploymentFiles.has(resolve(f.path))),
      }),
    });
    await loader.reload();
    const loadedPaths = new Set(loader.getSkills().skills.map((skill) => resolve(skill.filePath)));
    const notLoaded = skillPaths.filter((skillPath) => !loadedPaths.has(resolve(skillPath)));
    if (notLoaded.length > 0) {
      throw new SkillResolutionError(
        `inherited skill file(s) failed to load: ${notLoaded.join(", ")}`,
      );
    }
    return loader;
  }

  return undefined;
}

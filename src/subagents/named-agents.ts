/**
 * Named-agent definition loading and resource-loader construction.
 *
 * A "named agent" is a curated subagent recipe at `~/goblin/agents/<name>/`
 * with its own `AGENTS.md` (system prompt) and `skills/` directory. Spawning
 * one uses a custom pi `ResourceLoader` that pins skill discovery to the
 * agent's own tree — strict isolation from goblin and from other agents.
 *
 * Generic subagents (no name) get a different loader that explicitly pins
 * `$GOBLIN_HOME/.agents/skills/` so they always see Goblin's skills regardless of pi's
 * default traversal behaviour.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DefaultResourceLoader,
  type ResourceLoader,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { piAgentDir } from "../pi-host.ts";
import { agentsMdPath, goblinSkillsPath, heartbeatMdPath, soulMdPath } from "../workspace/paths.ts";
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
 * Generic subagents use pi's defaults but explicitly pin
 * `additionalSkillPaths` to `$GOBLIN_HOME/.agents/skills/` so they always
 * discover Goblin's skills regardless of pi's default traversal behaviour. They also
 * filter goblin's deployment prompt files (`SOUL.md`, `AGENTS.md`,
 * `HEARTBEAT.md`) out of any context-file discovery.
 */
export async function buildResourceLoader(opts: {
  home: string;
  cwd: string;
  role: SubagentRole;
  definition: NamedAgentDefinition | null;
  settingsManager: SettingsManager;
  /** Optional memory summary to append to the system prompt. */
  memorySystemPrompt?: string;
}): Promise<ResourceLoader | undefined> {
  const { home, cwd, role, definition, settingsManager, memorySystemPrompt } = opts;

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
    const deploymentFiles = deploymentPromptFilePaths(home);
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: piAgentDir(home),
      settingsManager,
      additionalSkillPaths: [goblinSkillsPath(home)],
      ...(memorySystemPrompt ? { systemPrompt: memorySystemPrompt } : {}),
      agentsFilesOverride: ({ agentsFiles }) => ({
        agentsFiles: agentsFiles.filter((f) => !deploymentFiles.has(resolve(f.path))),
      }),
    });
    await loader.reload();
    return loader;
  }

  return undefined;
}

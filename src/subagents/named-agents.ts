/**
 * Named-agent definition loading and resource-loader construction.
 *
 * A "named agent" is a curated subagent recipe at `~/goblin/agents/<name>/`
 * with its own `AGENTS.md` (system prompt) and `skills/` directory. Spawning
 * one uses a custom pi `ResourceLoader` that pins skill discovery to the
 * agent's own tree — strict isolation from goblin and from other agents.
 *
 * Generic subagents (no name) get a different loader that explicitly pins
 * `~/goblin/skills/` so they always see goblin's skills regardless of pi's
 * default traversal behaviour.
 */

import { readFileSync } from "node:fs";
import {
  DefaultResourceLoader,
  type ResourceLoader,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { piAgentDir } from "../pi-host.ts";
import { skillsPath } from "../workspace/paths.ts";
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
 * Build the pi `ResourceLoader` for a subagent.
 *
 * Named subagents get strict isolation: goblin's project AGENTS.md is not
 * auto-discovered, the named agent's AGENTS.md is the system prompt verbatim,
 * and skill discovery is pinned to the agent's own `skills/` directory.
 *
 * Generic subagents use pi's defaults but explicitly pin
 * `additionalSkillPaths` to `~/goblin/skills/` so they always discover
 * goblin's skills regardless of pi's default traversal behaviour.
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
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: piAgentDir(home),
      settingsManager,
      additionalSkillPaths: [skillsPath(home)],
      ...(memorySystemPrompt ? { systemPrompt: memorySystemPrompt } : {}),
    });
    await loader.reload();
    return loader;
  }

  return undefined;
}

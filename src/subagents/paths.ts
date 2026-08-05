/**
 * Filesystem layout for named-agent definitions.
 *
 *   ~/goblin/workspace/agents/<name>/
 *   ├── AGENTS.md
 *   └── .agents/skills/
 *
 * Machine-managed instance state lives under
 * `state/delegated-work/runs/<id>/` (see `src/delegated-work/paths.ts`).
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function namedAgentsRoot(home: string): string {
  return join(home, "workspace", "agents");
}

export function namedAgentDir(home: string, name: string): string {
  return join(namedAgentsRoot(home), name);
}

export function namedAgentAgentsMdPath(home: string, name: string): string {
  return join(namedAgentDir(home, name), "AGENTS.md");
}

export function namedAgentSkillsDir(home: string, name: string): string {
  return join(namedAgentDir(home, name), ".agents", "skills");
}

/**
 * List all valid named agents in ~/goblin/workspace/agents/.
 * A directory is considered a named agent if it contains AGENTS.md.
 */
function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

export function listNamedAgents(home: string): string[] {
  const root = namedAgentsRoot(home);
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === "ENOENT") return [];
    throw err;
  }

  const agents: string[] = [];
  for (const entry of entries) {
    const agentDir = join(root, entry);
    try {
      if (!statSync(agentDir).isDirectory()) continue;
    } catch (err) {
      if (isNodeErrnoException(err) && err.code === "ENOENT") continue;
      throw err;
    }

    try {
      if (statSync(join(agentDir, "AGENTS.md")).isFile()) {
        agents.push(entry);
      }
    } catch (err) {
      if (isNodeErrnoException(err) && err.code === "ENOENT") continue;
      throw err;
    }
  }
  return agents.sort();
}

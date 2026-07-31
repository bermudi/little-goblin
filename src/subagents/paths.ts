/**
 * Filesystem layout for the subagent runtime.
 *
 *   ~/goblin/
 *   ├── scratch/
 *   │   └── subagents/            # generic subagent instances
 *   │       └── <id>/
 *   │           ├── session.jsonl # pi session (filename actually timestamped)
 *   │           └── meta.json
 *   └── workspace/
 *       └── agents/               # named agent definitions (phase 3)
 *           └── <name>/
 *               ├── AGENTS.md
 *               ├── .agents/
 *               │   └── skills/
 *               └── instances/
 *                   └── <id>/
 *                       ├── session.jsonl
 *                       └── meta.json
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function subagentsRoot(home: string): string {
  return join(home, "scratch", "subagents");
}

export function genericSubagentDir(home: string, id: string): string {
  return join(subagentsRoot(home), id);
}

export function genericSubagentMetaPath(home: string, id: string): string {
  return join(genericSubagentDir(home, id), "meta.json");
}

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

export function namedAgentInstanceDir(home: string, name: string, id: string): string {
  return join(namedAgentDir(home, name), "instances", id);
}

export function namedAgentInstanceMetaPath(home: string, name: string, id: string): string {
  return join(namedAgentInstanceDir(home, name, id), "meta.json");
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

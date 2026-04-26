/**
 * Filesystem layout for the subagent runtime.
 *
 *   ~/goblin/
 *   ├── subagents/                # generic subagent instances
 *   │   └── <id>/
 *   │       ├── session.jsonl     # pi session (filename actually timestamped)
 *   │       └── meta.json
 *   └── agents/                   # named agent definitions (phase 3)
 *       └── <name>/
 *           ├── AGENTS.md
 *           ├── skills/
 *           └── instances/
 *               └── <id>/
 *                   ├── session.jsonl
 *                   └── meta.json
 */

import { join } from "node:path";

export function subagentsRoot(home: string): string {
  return join(home, "subagents");
}

export function genericSubagentDir(home: string, id: string): string {
  return join(subagentsRoot(home), id);
}

export function genericSubagentMetaPath(home: string, id: string): string {
  return join(genericSubagentDir(home, id), "meta.json");
}

export function namedAgentsRoot(home: string): string {
  return join(home, "agents");
}

export function namedAgentDir(home: string, name: string): string {
  return join(namedAgentsRoot(home), name);
}

export function namedAgentAgentsMdPath(home: string, name: string): string {
  return join(namedAgentDir(home, name), "AGENTS.md");
}

export function namedAgentSkillsDir(home: string, name: string): string {
  return join(namedAgentDir(home, name), "skills");
}

export function namedAgentInstanceDir(home: string, name: string, id: string): string {
  return join(namedAgentDir(home, name), "instances", id);
}

export function namedAgentInstanceMetaPath(home: string, name: string, id: string): string {
  return join(namedAgentInstanceDir(home, name, id), "meta.json");
}

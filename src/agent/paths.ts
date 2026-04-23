import { join } from "node:path";

/**
 * Pure path utilities for the agent runner filesystem layout.
 */

/**
 * Path to the workdir directory for sandboxed execution.
 */
export function workdirPath(home: string): string {
  return join(home, "workdir");
}

/**
 * Path to the pi-agent directory for pi-ai configuration.
 */
export function piAgentDir(home: string): string {
  return join(home, "pi-agent");
}

/**
 * Path to the AGENTS.md file at goblin home root.
 */
export function agentsMdPath(home: string): string {
  return join(home, "AGENTS.md");
}

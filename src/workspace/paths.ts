/**
 * Goblin workspace path helpers.
 *
 * Resolves user-authored prompt files and goblin-curated skills under
 * `$GOBLIN_HOME/workspace/`, plus the ephemeral scratch workdir.
 */

import { join } from "node:path";

/** Path to the workdir directory for sandboxed execution. */
export function workdirPath(home: string): string {
  return join(home, "scratch", "workdir");
}

/** Path to the AGENTS.md file in the goblin workspace. */
export function agentsMdPath(home: string): string {
  return join(home, "workspace", "AGENTS.md");
}

/** Path to goblin's skills directory in the goblin workspace. */
export function skillsPath(home: string): string {
  return join(home, "workspace", "skills");
}

/** Path to the SOUL.md file in the goblin workspace. */
export function soulMdPath(home: string): string {
  return join(home, "workspace", "SOUL.md");
}

/** Path to the optional HEARTBEAT.md file in the goblin workspace. */
export function heartbeatMdPath(home: string): string {
  return join(home, "workspace", "HEARTBEAT.md");
}

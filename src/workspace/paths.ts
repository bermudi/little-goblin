/**
 * Goblin workspace path helpers.
 *
 * Resolves the persistent personal workspace, attachments, user-authored
 * prompt files, and scoped Agent Skills catalogs.
 * The retired scratch workdir helper remains only for offline migration.
 */

import { join } from "node:path";

/**
 * Path to the persistent workspace root. User-authored prompt files live here;
 * personal Execution Environments use this directory as CWD.
 */
export function workspacePath(home: string): string {
  return join(home, "workspace");
}

/** Retired personal-workdir location; offline migration compatibility only. */
export function workdirPath(home: string): string {
  return join(home, "scratch", "workdir");
}

/** Path to the personal attachment upload directory. */
export function attachmentsPath(home: string): string {
  return join(home, "workspace", "attachments");
}

/** Path to the AGENTS.md file in the goblin workspace. */
export function agentsMdPath(home: string): string {
  return join(home, "workspace", "AGENTS.md");
}

/** Path to Goblin-wide skills eligible across Execution Environments. */
export function goblinSkillsPath(home: string): string {
  return join(home, ".agents", "skills");
}

/** Path to skills authored for the personal Execution Environment. */
export function personalEnvironmentSkillsPath(home: string): string {
  return join(home, "workspace", ".agents", "skills");
}

/** Path to the SOUL.md file in the goblin workspace. */
export function soulMdPath(home: string): string {
  return join(home, "workspace", "SOUL.md");
}

/** Path to the optional HEARTBEAT.md file in the goblin workspace. */
export function heartbeatMdPath(home: string): string {
  return join(home, "workspace", "HEARTBEAT.md");
}

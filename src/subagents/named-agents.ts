/**
 * Named-agent definition loading.
 *
 * A named agent is user-authored under
 * `$GOBLIN_HOME/workspace/agents/<name>/`. Pi resource-loader construction
 * lives in `host.ts`; keeping this module loader-free prevents metadata
 * validation from importing Pi construction transitively.
 */

import { readFileSync } from "node:fs";
import { namedAgentAgentsMdPath, namedAgentDir, namedAgentSkillsDir } from "./paths.ts";
import type { NamedAgentDefinition } from "./types.ts";

// Preserve the historical module export while keeping validation loader-free.
export { VALID_NAME_RE } from "./validation.ts";

export class NamedAgentNotFoundError extends Error {
  constructor(name: string) {
    super(`Named agent '${name}' not found`);
    this.name = "NamedAgentNotFoundError";
  }
}

function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/**
 * Load a named agent's identity and canonical skill catalog path. The caller
 * remains the authority for when this definition is used; this module does
 * not construct or reload Pi resources.
 */
export function loadNamedAgent(home: string, name: string): NamedAgentDefinition {
  const agentsMdPath = namedAgentAgentsMdPath(home, name);
  let agentsMd: string;
  try {
    agentsMd = readFileSync(agentsMdPath, "utf-8");
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === "ENOENT") {
      throw new NamedAgentNotFoundError(name);
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

/**
 * /project command logic.
 *
 * Binds the current session to a project directory, which becomes the
 * agent's cwd and agentDir. The next message will recreate the runner
 * with the new directory.
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseCommandArg } from "./parse.ts";

export interface ProjectCommandDeps {
  /** True iff a session was resolvable for this chat. */
  hasSession: boolean;
  /** The raw command text, e.g. "/project ~/foo". */
  rawText: string;
  /** Sets (or clears) the project directory on the session. */
  setProjectDir: (dir: string | undefined) => void;
}

export type ProjectCommandResult =
  | { kind: "no-session"; reply: string }
  | { kind: "missing-arg"; reply: string }
  | { kind: "bad-path"; reply: string }
  | { kind: "set"; reply: string; projectDir: string }
  | { kind: "cleared"; reply: string };

export const NO_SESSION_REPLY = "No active session. Start a conversation first.";
export const MISSING_ARG_REPLY = "Usage: `/project <path>` or `/project none` to clear.";
export const BAD_PATH_REPLY = "Path does not exist or is not a directory.";

function expandTilde(raw: string): string {
  if (raw.startsWith("~/")) {
    return raw.replace(/^~\//, `${homedir()}/`);
  }
  if (raw === "~") {
    return homedir();
  }
  return raw;
}

function resolveProjectDir(raw: string): string {
  return resolve(expandTilde(raw));
}

export function executeProject(deps: ProjectCommandDeps): ProjectCommandResult {
  if (!deps.hasSession) {
    return { kind: "no-session", reply: NO_SESSION_REPLY };
  }

  // Argument string (after `/project` or `/project@bot`), with internal
  // spaces preserved for paths that contain them.
  const arg = parseCommandArg(deps.rawText);
  if (arg === "") {
    return { kind: "missing-arg", reply: MISSING_ARG_REPLY };
  }

  if (arg.toLowerCase() === "none" || arg.toLowerCase() === "clear") {
    deps.setProjectDir(undefined);
    return { kind: "cleared", reply: "Project directory cleared." };
  }

  const projectDir = resolveProjectDir(arg);
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    return { kind: "bad-path", reply: BAD_PATH_REPLY };
  }

  deps.setProjectDir(projectDir);
  return { kind: "set", reply: `Project bound to \`${projectDir}\``, projectDir };
}

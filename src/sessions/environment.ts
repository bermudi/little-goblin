/**
 * Execution environment value model.
 *
 * An execution environment is the immutable filesystem authority captured when
 * a Conversation is created. It is either the deployment's personal workspace
 * (`$GOBLIN_HOME/workspace`) or a canonical project root directory.
 */

import { existsSync, realpathSync, statSync, accessSync, constants } from "node:fs";
import { resolve } from "node:path";
import { workspacePath } from "../workspace/paths.ts";

export type ExecutionEnvironment =
  | { kind: "personal" }
  | { kind: "project"; projectRoot: string };

/**
 * Resolve a user-supplied project path to a canonical absolute directory.
 *
 * - Expands a leading `~` to the user's home directory.
 * - Resolves relative paths against the current working directory.
 * - Resolves symlinks to their real path so two spellings of the same root
 *   compare equal.
 * - Throws if the path does not exist, is not a directory, or is not both
 *   readable and searchable by the Goblin process.
 */
export function resolveProjectRoot(input: string): string {
  const expanded = expandTilde(input);
  const absolute = resolve(expanded);
  if (!existsSync(absolute)) {
    throw new Error(`Project root does not exist: ${input}`);
  }
  const canonical = realpathSync(absolute);
  if (!existsSync(canonical) || !isDirectorySync(canonical)) {
    throw new Error(`Project root is not a directory: ${input}`);
  }
  try {
    accessSync(canonical, constants.R_OK | constants.X_OK);
  } catch {
    throw new Error(`Project root is not accessible: ${input}`);
  }
  return canonical;
}

function expandTilde(input: string): string {
  if (input.startsWith("~/")) {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    if (!home) throw new Error("Cannot expand ~: HOME not set");
    return home + input.slice(1);
  }
  if (input === "~") {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    if (!home) throw new Error("Cannot expand ~: HOME not set");
    return home;
  }
  return input;
}

function isDirectorySync(path: string): boolean {
  return statSync(path).isDirectory();
}

/** Return the CWD for an environment: workspace for personal, projectRoot for project. */
export function environmentCwd(env: ExecutionEnvironment, home: string): string {
  return env.kind === "personal" ? workspacePath(home) : env.projectRoot;
}

/** True when two environments are the same canonical authority. */
export function environmentsEqual(a: ExecutionEnvironment, b: ExecutionEnvironment): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "personal") return true;
  return a.projectRoot === (b as { kind: "project"; projectRoot: string }).projectRoot;
}

/** Personal environment constant factory. */
export function personalEnvironment(): ExecutionEnvironment {
  return { kind: "personal" };
}

/** Project environment constant factory for an already-canonical root. */
export function projectEnvironment(projectRoot: string): ExecutionEnvironment {
  return { kind: "project", projectRoot };
}

/** True when the environment is a project environment. */
export function isProjectEnvironment(env: ExecutionEnvironment): env is { kind: "project"; projectRoot: string } {
  return env.kind === "project";
}

/** Return the project root for a project environment, or undefined for personal. */
export function projectRootOf(env: ExecutionEnvironment): string | undefined {
  return env.kind === "project" ? env.projectRoot : undefined;
}

/**
 * Derive an execution environment from an optional stored project root.
 * A missing root means personal; a present root is assumed canonical.
 */
export function environmentFromProjectRoot(projectRoot: string | undefined): ExecutionEnvironment {
  if (projectRoot === undefined || projectRoot.length === 0) return personalEnvironment();
  return projectEnvironment(projectRoot);
}

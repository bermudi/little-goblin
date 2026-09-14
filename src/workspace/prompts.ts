/**
 * WorkspacePrompts — the deployment prompt-file authority.
 *
 * Stub for the verifier-only commit: the exported surface is complete so the
 * standard gates pass, but every entry point fails fast with an explicit
 * not-implemented error until the unit implementation lands.
 */

export class MissingSoulError extends Error {
  readonly code = "GOBLIN_MISSING_SOUL";
  readonly path: string;

  constructor(path: string) {
    super(
      `Missing required Goblin prompt file: ${path}. Run onboarding or create SOUL.md in $GOBLIN_HOME/workspace/.`,
    );
    this.name = "MissingSoulError";
    this.path = path;
  }
}

export type WorkspacePromptFileName = "SOUL.md" | "AGENTS.md" | "HEARTBEAT.md";
export type WorkspacePromptFileRequirement = "required" | "optional";

export interface WorkspacePromptFile {
  readonly name: WorkspacePromptFileName;
  readonly requirement: WorkspacePromptFileRequirement;
  readonly path: string;
  readonly missingNote?: string;
}

export interface PreflightWorkspacePromptFilesOptions {
  home: string;
  warn: (message: string, extra?: unknown) => void;
}

function notImplemented(name: string): never {
  throw new Error(`WorkspacePrompts.${name}: not implemented`);
}

export function workspacePromptCatalog(_home: string): readonly WorkspacePromptFile[] {
  return notImplemented("workspacePromptCatalog");
}

export function workspacePromptFile(
  _home: string,
  _name: WorkspacePromptFileName,
): WorkspacePromptFile {
  return notImplemented("workspacePromptFile");
}

export function readRequiredPromptFile(_path: string): Promise<string> {
  return notImplemented("readRequiredPromptFile");
}

export function readOptionalPromptFile(_path: string): Promise<string | null> {
  return notImplemented("readOptionalPromptFile");
}

export function preflightWorkspacePromptFiles(
  _opts: PreflightWorkspacePromptFilesOptions,
): Promise<void> {
  return notImplemented("preflightWorkspacePromptFiles");
}

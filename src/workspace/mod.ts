/** Workspace module barrel: the WorkspacePrompts prompt-file authority. */

export {
  HEARTBEAT_PROMPT,
  MissingSoulError,
  preflightWorkspacePromptFiles,
  readOptionalPromptFile,
  readRequiredPromptFile,
  resolveHeartbeatPrompt,
  workspacePromptCatalog,
  workspacePromptFile,
  type PreflightWorkspacePromptFilesOptions,
  type WorkspacePromptFile,
  type WorkspacePromptFileName,
  type WorkspacePromptFileRequirement,
} from "./prompts.ts";

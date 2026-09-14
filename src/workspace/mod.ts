/** Workspace module barrel: the WorkspacePrompts prompt-file authority. */

export {
  deploymentPromptFilePaths,
  HEARTBEAT_PROMPT,
  inspectPromptFile,
  MissingSoulError,
  preflightWorkspacePromptFiles,
  readOptionalPromptFile,
  readRequiredPromptFile,
  reservedPromptFilePaths,
  resolveHeartbeatPrompt,
  workspacePromptCatalog,
  workspacePromptFile,
  type PreflightWorkspacePromptFilesOptions,
  type PromptFilePresence,
  type WorkspacePromptFile,
  type WorkspacePromptFileName,
  type WorkspacePromptFileRequirement,
} from "./prompts.ts";

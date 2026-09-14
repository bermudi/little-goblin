/** Workspace module barrel: the WorkspacePrompts prompt-file authority. */

export {
  buildSoulTemplate,
  DEFAULT_AGENTS_TEMPLATE,
  deploymentPromptFilePaths,
  HEARTBEAT_PROMPT,
  inspectPromptFile,
  materializePromptFiles,
  MissingSoulError,
  preflightWorkspacePromptFiles,
  readOptionalPromptFile,
  readRequiredPromptFile,
  reservedPromptFilePaths,
  resolveHeartbeatPrompt,
  workspacePromptCatalog,
  workspacePromptFile,
  type MaterializePromptFilesResult,
  type PreflightWorkspacePromptFilesOptions,
  type PromptFilePresence,
  type WorkspacePromptFile,
  type WorkspacePromptFileName,
  type WorkspacePromptFileRequirement,
} from "./prompts.ts";

export { ExternalAgentRunner } from "./runner.ts";
export {
  continueExternalRun,
  ContinuationRefusedError,
  type ContinuedExternalRun,
  type ContinueExternalRunRequest,
} from "./continuation.ts";
export { createDelegatedExternalAgentTool, createExternalAgentTool, type DelegatedExternalAgentToolOptions } from "./tool.ts";
export { runExternalAgentsPreflight } from "./preflight.ts";
export {
  AcpAgentConnection,
  AcpHostError,
  BACKEND_CONTRACTS,
  CLAUDE_ACP_BRIDGE_PACKAGE,
  CLAUDE_ACP_BRIDGE_PIN,
  ExternalAgentHost,
  claudeBridgeEntryPath,
  resolveClaudeBridge,
} from "./host.ts";
export type {
  AcpConnectSpec,
  AcpHostErrorReason,
  AcpHostEvent,
  AcpPromptOutcome,
  BackendContract,
  PermissionProfile,
  QualifiedBackend,
  ResolvedBridge,
} from "./host.ts";
export type {
  ExternalAgentBackend,
  ExternalAgentEvent,
  ExternalAgentHandle,
  ExternalAgentPermissionProfile,
  ExternalAgentRunRecord,
  ExternalAgentRunSummary,
  ExternalAgentStatus,
  ExternalRunDetail,
  ProcessHandle,
  ProcessHost,
} from "./types.ts";

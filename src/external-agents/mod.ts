export {
  continueExternalRun,
  ContinuationRefusedError,
  type ContinuedExternalRun,
  type ContinueExternalRunRequest,
} from "./continuation.ts";
export { createDelegatedExternalAgentTool, type DelegatedExternalAgentToolOptions } from "./tool.ts";
export { checkQualifiedBackend, runExternalAgentsPreflight } from "./preflight.ts";
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
  ExternalAgentRunSummary,
  ExternalAgentStatus,
  ProcessHandle,
  ProcessHost,
} from "./types.ts";

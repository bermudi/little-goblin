export {
  UpdateGate,
  completed,
  runtimeAdmission,
  type AdmissionKind,
  type AdmissionResult,
  type RuntimeAdmissionResult,
  type AdapterAdmissionResult,
  type UpdateClaim,
  type TransferredAdmission,
  type UpdateGateCoalescerCallbacks,
} from "./update-gate.ts";
export {
  ShutdownCoordinator,
  SHUTDOWN_PHASE_NAMES,
  type ShutdownPhaseName,
  type ShutdownCoordinatorOptions,
  type ShutdownResult,
} from "./coordinator.ts";

// The responsibility domain contract as a leaf: record types, the
// understanding schema, refusal names, operation-state edges, and the
// errors the store throws. The store (responsibilities.ts) and the row
// layer (responsibility-schema.ts) build on it; type-only readers
// import it directly instead of reaching through the store module.

import { z } from "zod";
import type { ResponsibilityFollowup } from "./responsibility-followup.ts";

// Lifecycle only. Whom the work waits for (the operator, goblin, a
// worker) is derived from reports — responsibility-stage.ts — never
// stored twice (design/programs.md → Reports and stages).
export type ResponsibilityStatus = "active" | "paused" | "completed" | "cancelled";

export type AttachmentHealth = "attached" | "missing" | "identity_changed" | "detached";

/** Consecutive failed polls of one Herdr target before its attachments
 *  surface as unreachable — observation availability, not agent state:
 *  health keeps its last sighted value while polling is down. */
export const UNREACHABLE_POLLS = 3;

export type OperationState =
	| "prepared"
	| "sent"
	| "acknowledged"
	| "uncertain"
	| "refused"
	| "superseded";

// The correctable understanding — what the operator edits. `outcome`
// is denormalized onto the row for listing; the json carries the rest.
export const understandingSchema = z.object({
	outcome: z.string(),
	situation: z.string(),
	nextAction: z.string(),
	checkpoints: z.array(z.string()),
	completionEvidence: z.array(z.string()),
});
export type Understanding = z.infer<typeof understandingSchema>;

export interface Responsibility {
	responsibilityId: string;
	projectId: string;
	status: ResponsibilityStatus;
	revision: number;
	understanding: Understanding;
	outcome: string;
	coordinationConversationId: string;
	handoverKey: string | null;
	followupProgramId: string | null;
	followup: ResponsibilityFollowup;
	armed: boolean;
	notArmedReason: string | null;
	createdAt: string;
	updatedAt: string;
	closedAt: string | null;
}

export interface AttachmentTarget {
	/** Herdr target grouping: the server/session the operator session lives under. */
	server: string;
	session: string;
	agentName: string;
	paneId: string | null;
	terminalId: string | null;
	agentSession: string | null;
	kind: string | null;
	cwd: string | null;
}

export interface Attachment {
	attachmentId: number;
	responsibilityId: string;
	generation: number;
	target: AttachmentTarget;
	/** Observed state at bind — the reference the observer diffs against. */
	baseline: unknown;
	health: AttachmentHealth;
	/** Outage start once the target has been unreachable for
	 *  UNREACHABLE_POLLS consecutive polls, else null — the next
	 *  successful reconcile clears it. */
	unreachableSince: string | null;
	/** Persisted observation cursor — sequence keys namespaced by generation. */
	cursor: unknown;
	createdAt: string;
	detachedAt: string | null;
}

/** The five fields that decide "same destination" — server, session,
 *  terminal, harness session, kind. A prompt operation snapshots them
 *  at prepare because the attachment row's own copies are mutable: a
 *  reattach to a replacement rewrites them, and the unresolved-
 *  delivery fence must still name where the ambiguous send actually
 *  went. */
export interface DispatchIdentity {
	server: string;
	session: string;
	terminalId: string | null;
	agentSession: string | null;
	kind: string | null;
}

export interface PromptOperation {
	operationId: string;
	responsibilityId: string;
	attachmentId: number;
	attachmentGeneration: number;
	responsibilityRevision: number;
	/** Prepare-time snapshot of the destination's dispatch identity;
	 *  null only on rows predating the column backfill. */
	dispatch: DispatchIdentity | null;
	brief: string;
	state: OperationState;
	refusal: string | null;
	journalRunId: string | null;
	toolCallId: string | null;
	sentAt: string | null;
	outcome: unknown;
	createdAt: string;
}

export type SendRefusal =
	| "responsibility-missing"
	| "responsibility-inactive"
	| "attachment-detached"
	| "attachment-mismatch"
	| "stale-generation"
	| "stale-revision"
	| "already-terminal"
	| "operation-missing"
	| "delivery-uncertain";

// Reconcile-vs-record collision: the operation already carries a
// terminal disposition (or a recorded reconciliation) that disagrees
// with the one being asserted. Never overwrite evidence — refuse by
// name and let the caller inspect the record. `unresolved` carries the
// blocking operation when the conflict is an unfenced delivery.
export class ReconciliationConflict extends Error {
	constructor(
		message: string,
		readonly unresolved?: PromptOperation,
	) {
		super(message);
	}
}

// A reattach whose caller snapshotted the attachment before an await
// (the live-agent listing) found the row moved underneath it — a
// detach, another reattach's generation bump, or a health change.
// Refusing preserves the winner's write instead of overwriting it
// with a snapshot that is no longer true.
export class StaleAttachmentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StaleAttachmentError";
	}
}

// Uncertain has NO public terminal transitions: only
// reconcileOperation's evidence-gated CAS (a private write, not an
// edge) may close an ambiguous delivery.
export const OP_EDGES: Readonly<Record<OperationState, ReadonlySet<OperationState>>> = {
	prepared: new Set(["sent", "refused", "superseded"]),
	sent: new Set(["acknowledged", "uncertain", "refused"]),
	acknowledged: new Set(),
	uncertain: new Set(),
	refused: new Set(),
	superseded: new Set(),
};

export const OPEN_STATUSES: ReadonlySet<ResponsibilityStatus> = new Set(["active", "paused"]);

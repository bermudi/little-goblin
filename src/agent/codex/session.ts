// Cache-affinity identity for the Codex backend: the raw conversation
// id never leaves the process — requests carry a derived, stable id so
// the backend's cache router sees one session per conversation across
// model switches, compactions, and restarts.

import { createHash } from "node:crypto";

// sha256("goblin-codex-session:<conversationId>") rendered as a UUID
// (8-4-4-4-12) — deterministic, unguessable from the conversation id
// alone, and shaped the way session-id consumers expect.
export function codexSessionId(conversationId: string): string {
	const hex = createHash("sha256")
		.update(`goblin-codex-session:${conversationId}`)
		.digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

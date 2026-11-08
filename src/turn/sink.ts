// The sink contract — what a submitting channel owes the turn and what
// the turn owes it back. Channel-agnostic: Telegram sinks, app sinks,
// and test sinks implement the same interface.

import type { FallbackNote } from "../agent/model-fallback.ts";
import type { OutgoingFile } from "../agent/tools/send.ts";
import type { UIMessageChunk } from "ai";
import type { ForcedKind } from "./state.ts";

export type TurnDone =
	| { kind: "completed"; forced?: ForcedKind; fallback?: FallbackNote }
	// shutdown: the process is going down (deploy/restart), not a /stop.
	| { kind: "fenced"; shutdown?: true }
	// modelCalls/transient are stamped only where the runtime can
	// know them — the terminal failure path. Absent means unknown, and
	// consumers must treat unknown as not-retryable.
	| { kind: "error"; message: string; modelCalls?: number; transient?: boolean };

// Exactly one terminal notification per submitted sink, including work
// dropped from the queue — channel sinks release typing and stream
// resources on completed, fenced, and failed turns alike.
export interface TurnSink {
	onTextDelta(delta: string): void;
	onReasoningDelta(delta: string): void;
	onToolCall(toolName: string, input: unknown): void;
	// The head receives emitted UIMessage chunks after authority checks. Overflow
	// recovery withholds its error chunk and successors, not prior partial output;
	// terminal status reaches sinks through onDone.
	onStreamChunk?(chunk: UIMessageChunk): void;
	onVoiceNote?(audio: Uint8Array): Promise<void>;
	// The sink owns file delivery, so it remains on the serialized,
	// authority-fenced delivery path. Both sides of its await re-check
	// authority; `asFile` preserves exact document bytes.
	onFile?(file: OutgoingFile): Promise<void>;
	// Voice synthesis exposes a visible wait and returns its stopper. Starting
	// that indicator is a side effect and is fenced by the running turn.
	onVoiceSynthesisStart?(): () => void;
	setAuthorityCheck?(
		check: () => boolean,
		anchorSeq?: number | null,
		memoryExcluded?: () => boolean,
	): void;
	onDone(done: TurnDone): void | Promise<void>;
}

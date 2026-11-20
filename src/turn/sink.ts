import type { FallbackNote } from "../agent/model-fallback.ts";
import type { OutgoingFile } from "../agent/tools/send.ts";
import type { MessageChunk } from "../message.ts";
import type { ForcedKind } from "./state.ts";

export type TurnDone =
	| { kind: "completed"; forced?: ForcedKind; fallback?: FallbackNote }
	| { kind: "fenced"; shutdown?: true }
	| { kind: "error"; message: string; modelCalls?: number; transient?: boolean };

interface SinkCore {
	onTextDelta(delta: string): void;
	onReasoningDelta(delta: string): void;
	onToolCall(toolName: string, input: unknown): void;
	onVoiceNote?(audio: Uint8Array): Promise<void>;
	onFile?(file: OutgoingFile): Promise<void>;
	onVoiceSynthesisStart?(): () => void;
	setAuthorityCheck?(
		check: () => boolean,
		anchorSeq?: number | null,
		memoryExcluded?: () => boolean,
	): void;
	onDone(done: TurnDone): void | Promise<void>;
}

export interface HeadlessSink extends SinkCore {
	readonly delivery: "headless";
	onStreamChunk?: never;
}

export interface StreamingSink extends SinkCore {
	readonly delivery: "stream";
	onStreamChunk(chunk: MessageChunk): void;
}

export type TurnSink = HeadlessSink | StreamingSink;

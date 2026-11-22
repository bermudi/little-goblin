import type { OutgoingFile } from "../agent/tools/send.ts";
import type { TurnSink } from "./sink.ts";

export interface SinkDelivery {
	deliverVoice?: ((audio: Uint8Array, toolCallId: string) => Promise<void>) | undefined;
	deliverFile?: ((file: OutgoingFile, toolCallId: string) => Promise<void>) | undefined;
	recording?: (() => () => void) | undefined;
}

export function sinkDelivery(sink: TurnSink, assertAuthority: () => void): SinkDelivery {
	return {
		deliverVoice:
			sink.onVoiceNote === undefined
				? undefined
				: async (audio, toolCallId) => {
						assertAuthority();
						await sink.onVoiceNote!(audio, toolCallId);
						assertAuthority();
					},
		deliverFile:
			sink.onFile === undefined
				? undefined
				: async (file, toolCallId) => {
						assertAuthority();
						await sink.onFile!(file, toolCallId);
						assertAuthority();
					},
		recording:
			sink.onVoiceSynthesisStart === undefined
				? undefined
				: () => {
						assertAuthority();
						return sink.onVoiceSynthesisStart!();
					},
	};
}

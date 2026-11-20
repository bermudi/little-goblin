import type { OutgoingFile } from "../agent/tools/send.ts";
import type { TurnSink } from "./sink.ts";

export interface SinkDelivery {
	deliverVoice?: ((audio: Uint8Array) => Promise<void>) | undefined;
	deliverFile?: ((file: OutgoingFile) => Promise<void>) | undefined;
	recording?: (() => () => void) | undefined;
}

export function sinkDelivery(sink: TurnSink, assertAuthority: () => void): SinkDelivery {
	return {
		deliverVoice:
			sink.onVoiceNote === undefined
				? undefined
				: async (audio) => {
						assertAuthority();
						await sink.onVoiceNote!(audio);
						assertAuthority();
					},
		deliverFile:
			sink.onFile === undefined
				? undefined
				: async (file) => {
						assertAuthority();
						await sink.onFile!(file);
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

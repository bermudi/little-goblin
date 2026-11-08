// The turn's fenced sink-delivery hooks: voice notes, files, and the
// synthesis indicator all re-check authority on both sides of their
// await (design/runtime-turn.md → the authority rule). One seam, so the
// delivery policy is owned here instead of living inline in runAttempt.

import type { OutgoingFile } from "../agent/tools/send.ts";
import type { TurnSink } from "./sink.ts";

export interface SinkDelivery {
	/** Voice delivery, fenced before and after its await. */
	deliverVoice?: ((audio: Uint8Array) => Promise<void>) | undefined;
	/** File delivery, fenced before and after its await. */
	deliverFile?: ((file: OutgoingFile) => Promise<void>) | undefined;
	/** Fences the chat action that starts synthesis; the sink's stopper
	 *  can resume its delivery UI after synthesis. */
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

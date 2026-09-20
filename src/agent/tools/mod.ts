// The four tools. Hand-rolled, zod-validated, bound to the deployment
// workspace. Telegram send is delivery, not a tool. Nothing else exists
// until a feature needs it.

import type { ToolSet } from "ai";
import { bashTool } from "./bash.ts";
import { editFileTool } from "./edit.ts";
import { readFileTool } from "./read.ts";
import { speakTool } from "./speak.ts";
import { writeFileTool } from "./write.ts";

export interface VoiceToolDeps {
	synthesize(text: string): Promise<Uint8Array[]>;
	deliver(audio: Uint8Array): Promise<void>;
	/** Starts a record_voice chat action; returns the stopper. */
	recording?(): () => void;
}

export function makeTools(cwd: string, voice?: VoiceToolDeps): ToolSet {
	return {
		read_file: readFileTool(cwd),
		write_file: writeFileTool(cwd),
		edit_file: editFileTool(cwd),
		bash: bashTool(cwd),
		...(voice
			? { speak: speakTool(cwd, voice.synthesize, voice.deliver, voice.recording) }
			: {}),
	};
}

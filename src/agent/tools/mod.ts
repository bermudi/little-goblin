// The tools. Hand-rolled, zod-validated, bound to the deployment
// workspace. Telegram send is delivery, not a tool. Nothing else exists
// until a feature needs it.

import type { ToolSet } from "ai";
import type { JobsStore } from "../../jobs.ts";
import { bashTool } from "./bash.ts";
import { editFileTool } from "./edit.ts";
import { readFileTool } from "./read.ts";
import { scheduleTool } from "./schedule.ts";
import { type OutgoingFile, sendFileTool } from "./send.ts";
import { speakTool } from "./speak.ts";
import { writeFileTool } from "./write.ts";

export interface VoiceToolDeps {
	synthesize(text: string): Promise<Uint8Array[]>;
	deliver(audio: Uint8Array): Promise<void>;
	/** Starts a record_voice chat action; returns the stopper. */
	recording?(): () => void;
}

export interface ScheduleToolDeps {
	jobs: JobsStore;
	chatId: number;
	threadId: number | null;
}

export interface FileToolDeps {
	deliver(file: OutgoingFile): Promise<void>;
}

// The prompt-facing tool list, in makeTools' registration order.
// speak rides only when TTS is configured — the same rule that gates
// the voice deps below; everything else is wired on every live turn.
// The composition root passes this to buildSystemPrompt so the
// advertised list can never drift from the registered one (a test in
// mod.test.ts pins them together).
export function toolNames(ttsConfigured: boolean): string[] {
	return [
		"read_file",
		"write_file",
		"edit_file",
		"bash",
		...(ttsConfigured ? ["speak"] : []),
		"schedule",
		"send_file",
	];
}

export function makeTools(
	cwd: string,
	voice?: VoiceToolDeps,
	schedule?: ScheduleToolDeps,
	file?: FileToolDeps,
): ToolSet {
	return {
		read_file: readFileTool(cwd),
		write_file: writeFileTool(cwd),
		edit_file: editFileTool(cwd),
		bash: bashTool(cwd),
		...(voice
			? { speak: speakTool(cwd, voice.synthesize, voice.deliver, voice.recording) }
			: {}),
		...(schedule ? { schedule: scheduleTool(schedule) } : {}),
		...(file ? { send_file: sendFileTool(cwd, file.deliver) } : {}),
	};
}

// The tools. Hand-rolled, zod-validated, bound to the deployment
// workspace. Telegram send is delivery, not a tool. Nothing else exists
// until a feature needs it.

import type { ToolSet } from "ai";
import type { HindsightClient } from "../../hindsight.ts";
import type { JobsStore } from "../../jobs.ts";
import { bashTool } from "./bash.ts";
import { editFileTool } from "./edit.ts";
import { fetchTool } from "./fetch.ts";
import { memorySearchTool } from "./memory.ts";
import { readFileTool } from "./read.ts";
import { scheduleTool } from "./schedule.ts";
import { type OutgoingFile, sendFileTool } from "./send.ts";
import { speakTool } from "./speak.ts";
import { searchTool } from "./search.ts";
import { writeFileTool } from "./write.ts";
import type { WebToolDeps } from "./web.ts";

export interface VoiceToolDeps {
	synthesize(text: string, voice?: string): Promise<Uint8Array[]>;
	deliver(audio: Uint8Array): Promise<void>;
	/** Starts a record_voice chat action; returns the stopper. */
	recording?(): () => void;
	/** Allowlist (default included) the speak tool may pick from per call. */
	voices?: readonly string[];
}

export interface ScheduleToolDeps {
	jobs: JobsStore;
	chatId: number;
	threadId: number | null;
}

export interface FileToolDeps {
	deliver(file: OutgoingFile): Promise<void>;
}

export interface MemoryToolDeps {
	client: HindsightClient;
	maxTokens: number;
	budget: "low" | "mid" | "high";
	isExcluded: () => boolean;
	noteRecall: (ok: boolean) => void;
}

// Use the registered set as the availability source, rather than
// duplicating its dependency gates in the prompt.
export function toolNames(tools: ToolSet): string[] {
	return Object.keys(tools);
}

export function makeTools(
	cwd: string,
	voice?: VoiceToolDeps,
	schedule?: ScheduleToolDeps,
	file?: FileToolDeps,
	memory?: MemoryToolDeps,
	web?: WebToolDeps,
): ToolSet {
	return {
		read_file: readFileTool(cwd),
		write_file: writeFileTool(cwd),
		edit_file: editFileTool(cwd),
		bash: bashTool(cwd),
		...(voice
			? { speak: speakTool(cwd, voice.synthesize, voice.deliver, voice.recording, voice.voices) }
			: {}),
		...(schedule ? { schedule: scheduleTool(schedule) } : {}),
		...(file ? { send_file: sendFileTool(cwd, file.deliver) } : {}),
		...(memory ? { memory_search: memorySearchTool(memory) } : {}),
		// Fetch is always in the set (local extraction needs no config);
		// search rides its config block. This runs per turn against
		// configRef, so a mini-app save — the one writer that swaps the
		// ref in place — applies next turn: provider switch and search
		// add/remove alike (its flip is logged at the save boundary). A
		// hand edit to goblin.json5 is only seen on restart.
		...(web ? { fetch: fetchTool(web) } : {}),
		...(web?.configRef.current.search ? { search: searchTool(web) } : {}),
	};
}

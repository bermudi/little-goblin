// The tools. Hand-rolled, zod-validated, bound to the deployment
// workspace. Telegram send is delivery, not a tool. Nothing else exists
// until a feature needs it.

import type { ToolSet } from "ai";
import type { HindsightClient } from "../../hindsight.ts";
import { delegateTool, type DelegateToolDeps } from "./delegate.ts";
import { programTool, type ProgramToolDeps } from "./program.ts";
import type { SpeechFile } from "../transcribe.ts";
import { bashTool } from "./bash.ts";
import { editFileTool } from "./edit.ts";
import { fetchTool } from "./fetch.ts";
import { historySearchTool, type HistorySearchDeps } from "./history.ts";
import { mailTool } from "./mail.ts";
import { memorySearchTool } from "./memory.ts";
import { readFileTool } from "./read.ts";
import { type OutgoingFile, sendFileTool } from "./send.ts";
import { speakTool } from "./speak.ts";
import { searchTool } from "./search.ts";
import { transcribeTool } from "./transcribe.ts";
import { writeFileTool } from "./write.ts";
import type { MailToolDeps } from "./mail.ts";
import type { WebToolDeps } from "./web.ts";

export interface VoiceToolDeps {
	synthesize(text: string, voice?: string): Promise<Uint8Array[]>;
	deliver(audio: Uint8Array): Promise<void>;
	/** Starts a record_voice chat action; returns the stopper. */
	recording?(): () => void;
	/** Allowlist (default included) the speak tool may pick from per call. */
	voices?: readonly string[];
}

export type { ProgramToolDeps };

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

export interface TranscribeToolDeps {
	// Same seam intake uses — the composition root reads the
	// transcription block per call. null = unconfigured or no speech.
	transcribe(file: SpeechFile): Promise<string | null>;
}

export type { DelegateToolDeps };
export type { HistorySearchDeps };
export type { MailToolDeps };

// Use the registered set as the availability source, rather than
// duplicating its dependency gates in the prompt.
export function toolNames(tools: ToolSet): string[] {
	return Object.keys(tools);
}

export function makeTools(
	cwd: string,
	voice?: VoiceToolDeps,
	program?: ProgramToolDeps,
	file?: FileToolDeps,
	memory?: MemoryToolDeps,
	web?: WebToolDeps,
	transcribe?: TranscribeToolDeps,
	delegate?: DelegateToolDeps,
	mail?: MailToolDeps,
	history?: HistorySearchDeps,
): ToolSet {
	return {
		read_file: readFileTool(cwd),
		write_file: writeFileTool(cwd),
		edit_file: editFileTool(cwd),
		bash: bashTool(cwd),
		...(voice
			? { speak: speakTool(cwd, voice.synthesize, voice.deliver, voice.recording, voice.voices) }
			: {}),
		// The speech-in twin of speak: gated on the transcription block
		// like search is on its own config — presence is decided per turn
		// by the caller, which reads configRef live.
		...(transcribe ? { transcribe: transcribeTool(cwd, transcribe.transcribe) } : {}),
		...(program ? { program: programTool(program) } : {}),
		// Same per-turn gate as search/transcribe: the caller passes deps
		// only when the delegation block exists in the live config.
		...(delegate ? { delegate: delegateTool(delegate) } : {}),
		// Same live gate on the mail block — the reader closure inside
		// resolves the read credential per call; the send credential is
		// never in this dep tree.
		...(mail ? { mail: mailTool(mail) } : {}),
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
		// Past-chat search is local state, not a config block — always in
		// the set (the store dep is unconditional at the composition root).
		...(history ? { history_search: historySearchTool(history) } : {}),
	};
}

import type { ToolSet } from "ai";
import { MEMORY_DEFAULTS } from "../../memory/policy.ts";
import type { SpeechFile } from "../transcribe.ts";
import { bashTool } from "./bash.ts";
import { type DelegateToolDeps, delegateTool } from "./delegate.ts";
import { type DesktopToolDeps, desktopTool } from "./desktop.ts";
import { editFileTool } from "./edit.ts";
import { fetchTool } from "./fetch.ts";
import { type HerdrToolDeps, herdrTool } from "./herdr.ts";
import { type HistorySearchDeps, historySearchTool } from "./history.ts";
import { type ImageToolDeps, imageTool } from "./image.ts";
import type { MailToolDeps } from "./mail.ts";
import { mailTool } from "./mail.ts";
import type { MemorySearchDeps } from "./memory.ts";
import { memorySearchTool } from "./memory.ts";
import { memoryReflectTool } from "./memory-reflect.ts";
import { type NoteToolDeps, noteTool } from "./note.ts";
import { type ProgramToolDeps, programTool } from "./program.ts";
import { readFileTool } from "./read.ts";
import { type SandboxToolDeps, sandboxTool } from "./sandbox.ts";
import { searchTool } from "./search.ts";
import { type OutgoingFile, sendFileTool } from "./send.ts";
import { speakTool } from "./speak.ts";
import { type SubagentToolDeps, subagentTool } from "./subagent.ts";
import { transcribeTool } from "./transcribe.ts";
import { uiTool } from "./ui.ts";
import { type VisionToolDeps, visionTool } from "./vision.ts";
import type { WebToolDeps } from "./web.ts";
import { writeFileTool } from "./write.ts";

export interface VoiceToolDeps {
	synthesize(text: string, voice?: string): Promise<Uint8Array[]>;
	deliver(audio: Uint8Array): Promise<void>;
	recording?(): () => void;
	voices?: readonly string[];
}

export type { ProgramToolDeps };

export interface FileToolDeps {
	deliver(file: OutgoingFile): Promise<void>;
}

export interface MemoryToolDeps extends MemorySearchDeps {
	reflection?: {
		maxTokens: number;
		budget: "low" | "mid" | "high";
		timeoutMs: number;
	};
}

export interface TranscribeToolDeps {
	transcribe(file: SpeechFile): Promise<string | null>;
}

export type {
	DelegateToolDeps,
	DesktopToolDeps,
	HerdrToolDeps,
	HistorySearchDeps,
	ImageToolDeps,
	MailToolDeps,
	NoteToolDeps,
	SandboxToolDeps,
	SubagentToolDeps,
	VisionToolDeps,
};

export function toolNames(tools: ToolSet): string[] {
	return Object.keys(tools);
}

export interface MakeToolsOptions {
	cwd: string;
	voice?: VoiceToolDeps | undefined;
	program?: ProgramToolDeps | undefined;
	file?: FileToolDeps | undefined;
	memory?: MemoryToolDeps | undefined;
	web?: WebToolDeps | undefined;
	transcribe?: TranscribeToolDeps | undefined;
	delegate?: DelegateToolDeps | undefined;
	herdr?: HerdrToolDeps | undefined;
	mail?: MailToolDeps | undefined;
	history?: HistorySearchDeps | undefined;
	note?: NoteToolDeps | undefined;
	vision?: VisionToolDeps | undefined;
	image?: ImageToolDeps | undefined;
	sandbox?: SandboxToolDeps | undefined;
	subagent?: SubagentToolDeps | undefined;
	desktop?: DesktopToolDeps | undefined;
	ui?: boolean | undefined;
}

export function makeTools(options: MakeToolsOptions): ToolSet {
	const {
		cwd,
		voice,
		program,
		file,
		memory,
		web,
		transcribe,
		delegate,
		herdr,
		mail,
		history,
		note,
		vision,
		image,
		sandbox,
		subagent,
		desktop,
		ui,
	} = options;
	return {
		read_file: readFileTool(cwd, vision !== undefined),
		write_file: writeFileTool(cwd),
		edit_file: editFileTool(cwd),
		bash: bashTool(cwd),
		...(voice
			? { speak: speakTool(cwd, voice.synthesize, voice.deliver, voice.recording, voice.voices) }
			: {}),
		...(transcribe ? { transcribe: transcribeTool(cwd, transcribe.transcribe) } : {}),
		...(vision ? { vision: visionTool(cwd, vision) } : {}),
		...(image ? { generate_image: imageTool(image) } : {}),
		...(program ? { program: programTool(program) } : {}),
		...(delegate ? { delegate: delegateTool(delegate) } : {}),
		...(herdr ? { herdr: herdrTool(herdr) } : {}),
		...(mail ? { mail: mailTool(mail) } : {}),
		...(file ? { send_file: sendFileTool(cwd, file.deliver) } : {}),
		...(memory
			? {
					memory_search: memorySearchTool(memory),
					memory_reflect: memoryReflectTool({
						client: memory.client,
						isExcluded: memory.isExcluded,
						...(memory.reflection ?? {
							maxTokens: MEMORY_DEFAULTS.reflectMaxTokens,
							budget: MEMORY_DEFAULTS.reflectBudget,
							timeoutMs: MEMORY_DEFAULTS.reflectTimeoutMs,
						}),
					}),
				}
			: {}),
		...(web ? { fetch: fetchTool(web) } : {}),
		...(web?.configRef.current.search ? { search: searchTool(web) } : {}),
		...(history ? { history_search: historySearchTool(history) } : {}),
		...(note ? { note: noteTool(note) } : {}),
		...(sandbox ? { sandbox: sandboxTool(sandbox) } : {}),
		...(subagent ? { subagent: subagentTool(subagent) } : {}),
		...(desktop ? { desktop: desktopTool(desktop) } : {}),
		...(ui === true ? { ui: uiTool() } : {}),
	};
}

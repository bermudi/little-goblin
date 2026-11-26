import type { Tools } from "../../tool.ts";
import { MEMORY_DEFAULTS } from "../../memory/policy.ts";
import type { SpeechFile } from "../transcribe.ts";
import { type ArtifactToolDeps, artifactTool } from "./artifact.ts";
import { type AskToolDeps, askTool } from "./ask.ts";
import { type AskOperatorToolDeps, askOperatorTool } from "./ask-operator.ts";
import { bashTool } from "./bash.ts";
import { type ComputerToolDeps, computerTools } from "./computer.ts";
import { type DelegateToolDeps, delegateTool } from "./delegate.ts";
import { type DesktopToolDeps, desktopTool } from "./desktop.ts";
import { editFileTool } from "./edit.ts";
import { fetchTool } from "./fetch.ts";
import { type HistorySearchDeps, historySearchTool } from "./history.ts";
import { type ImageToolDeps, imageTool } from "./image.ts";
import type { MailToolDeps } from "./mail.ts";
import { mailTool } from "./mail.ts";
import type { MemorySearchDeps } from "./memory.ts";
import { memorySearchTool } from "./memory.ts";
import { memoryReflectTool } from "./memory-reflect.ts";
import { type NoteToolDeps, noteTool } from "./note.ts";
import { type ProgramToolDeps, programTool } from "./program.ts";
import { type WatchToolDeps, watchTool } from "./watch.ts";
import { type PostToolDeps, postTool } from "./post.ts";
import { readFileTool } from "./read.ts";
import type { ContextFill } from "./read.ts";
import { type SandboxToolDeps, sandboxTool } from "./sandbox.ts";
import { searchTool } from "./search.ts";
import { type OutgoingFile, sendFileTool } from "./send.ts";
import { speakTool } from "./speak.ts";
import { transcribeTool } from "./transcribe.ts";
import { uiTool } from "./ui.ts";
import { type VisionToolDeps, visionTool } from "./vision.ts";
import type { WebToolDeps } from "./web.ts";
import { writeFileTool } from "./write.ts";

export interface VoiceToolDeps {
	synthesize(text: string, voice?: string): Promise<Uint8Array[]>;
	deliver(audio: Uint8Array, toolCallId: string): Promise<void>;
	recording?(): () => void;
	voices?: readonly string[];
}

export type { ProgramToolDeps };

export interface FileToolDeps {
	deliver(file: OutgoingFile, toolCallId: string): Promise<void>;
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
	ArtifactToolDeps,
	AskToolDeps,
	AskOperatorToolDeps,
	ComputerToolDeps,
	DelegateToolDeps,
	DesktopToolDeps,
	HistorySearchDeps,
	ImageToolDeps,
	MailToolDeps,
	NoteToolDeps,
	SandboxToolDeps,
	VisionToolDeps,
};

export function toolNames(tools: Tools): string[] {
	return Object.keys(tools);
}

export interface MakeToolsOptions {
	cwd: string;
	bashDescriptionCwd?: string;
	voice?: VoiceToolDeps | undefined;
	program?: ProgramToolDeps | undefined;
	watch?: WatchToolDeps | undefined;
	post?: PostToolDeps | undefined;
	ask?: AskToolDeps | undefined;
	file?: FileToolDeps | undefined;
	artifact?: ArtifactToolDeps | undefined;
	memory?: MemoryToolDeps | undefined;
	web?: WebToolDeps | undefined;
	transcribe?: TranscribeToolDeps | undefined;
	delegate?: DelegateToolDeps | undefined;
	mail?: MailToolDeps | undefined;
	history?: HistorySearchDeps | undefined;
	note?: NoteToolDeps | undefined;
	vision?: VisionToolDeps | undefined;
	image?: ImageToolDeps | undefined;
	sandbox?: SandboxToolDeps | undefined;
	desktop?: DesktopToolDeps | undefined;
	// Agent-type children only (design/agents.md → Computer use): the
	// desktop tools and ask_operator mount for a child conversation and
	// reach the model only through its spawn-time allowlist — a parent
	// turn never carries them.
	computer?: ComputerToolDeps | undefined;
	askOperator?: AskOperatorToolDeps | undefined;
	ui?: boolean | undefined;
	// Codex conversations mount the backend's hosted web_search instead of
	// the local search tool — the mode only decides external_web_access.
	hostedSearch?: { externalWebAccess: boolean } | undefined;
	/** Fires with the resolved absolute path on every successful
	 *  read_file — the skill-usage watch (read_file of a catalog SKILL.md
	 *  is a use; design/skills.md → Self-authoring, /learn, curator). */
	onRead?: (abs: string) => void;
	contextFill?: ContextFill;
}

// The codex provider tool — args travel as the wire tool's
// configuration (external_web_access), never a model-chosen input.
// Exported for tests/live checks — the adapter's own provider tool id.
export function makeTools(options: MakeToolsOptions): Tools {
	const {
		cwd,
		bashDescriptionCwd = cwd,
		voice,
		program,
		watch,
		post,
		ask,
		file,
		artifact,
		memory,
		web,
		hostedSearch,
		transcribe,
		delegate,
		mail,
		history,
		note,
		vision,
		image,
		sandbox,
		desktop,
		computer,
		askOperator,
		ui,
		onRead,
		contextFill,
	} = options;
	return {
		read_file: readFileTool(cwd, vision !== undefined, onRead, contextFill),
		write_file: writeFileTool(cwd),
		edit_file: editFileTool(cwd),
		bash: bashTool(cwd, bashDescriptionCwd),
		...(voice
			? { speak: speakTool(cwd, voice.synthesize, voice.deliver, voice.recording, voice.voices) }
			: {}),
		...(transcribe ? { transcribe: transcribeTool(cwd, transcribe.transcribe) } : {}),
		...(vision ? { vision: visionTool(cwd, vision) } : {}),
		...(image ? { generate_image: imageTool(image) } : {}),
		...(program ? { program: programTool(program) } : {}),
		...(watch ? { watch: watchTool(watch) } : {}),
		...(post ? { post: postTool(post) } : {}),
		...(ask ? { ask: askTool(ask) } : {}),
		...(delegate ? { delegate: delegateTool(delegate) } : {}),
		...(mail ? { mail: mailTool(mail) } : {}),
		...(file ? { send_file: sendFileTool(cwd, file.deliver) } : {}),
		...(artifact ? { artifact: artifactTool(artifact) } : {}),
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
		...(hostedSearch !== undefined
			? {
					web_search: {
						hosted: "codex.web_search",
						args: { externalWebAccess: hostedSearch.externalWebAccess },
					},
				}
			: web?.configRef.current.search
				? { search: searchTool(web) }
				: {}),
		...(history ? { history_search: historySearchTool(history) } : {}),
		...(note ? { note: noteTool(note) } : {}),
		...(sandbox ? { sandbox: sandboxTool(sandbox) } : {}),
		...(desktop ? { desktop: desktopTool(desktop) } : {}),
		...(computer ? computerTools(computer) : {}),
		...(askOperator ? { ask_operator: askOperatorTool(askOperator) } : {}),
		...(ui === true ? { ui: uiTool() } : {}),
	};
}

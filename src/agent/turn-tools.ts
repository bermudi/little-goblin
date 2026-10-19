// Per-turn tool-surface mount policy (DESIGN.md → Tools). makeTools
// assembles whatever deps it's handed — an absent field mounts nothing;
// this factory owns WHICH fields are present per conversation: the
// channel gates (Telegram-bound tools don't register on app turns),
// the live-config reads (search, transcription, sandbox, image hide or
// show next turn), and the boot-frozen blocks (subagent/desktop mount
// only while the boot snapshot said so). index.ts binds the seams it
// can't own — the tg send, the guest filter, the per-conv seams
// (delegate/vision/transcribe) — and hands the result to the runtime
// as RuntimeDeps["makeTools"]; the resume contract check rebuilds the
// surface through the same function so the drift comparison reads the
// set the resumed attempt would actually get.

import type { RuntimeDeps } from "../runtime.ts";
import type { Config, ConfigRef } from "../config.ts";
import { channelOf, type Conversation, type ConversationStore } from "../conversation.ts";
import type { AuthStore } from "../auth.ts";
import type { NoteStore } from "../notes.ts";
import { projectWorkdir, type ProjectStore } from "../projects.ts";
import type { ProgramsStore } from "../programs.ts";
import type { Sandboxes } from "../sandboxes.ts";
import type { Desktops } from "../desktops.ts";
import type { Subagents } from "../subagents/mod.ts";
import type { MailApproval } from "../tg/mail-approval.ts";
import { synthesizeSpeech } from "./tts.ts";
import type { HindsightClient } from "../memory/hindsight.ts";
import {
	type DelegateToolDeps,
	makeTools,
	type TranscribeToolDeps,
	type VisionToolDeps,
} from "./tools/mod.ts";
import { withScript } from "./tools/script.ts";
import type { OperatorAgent, OperatorHerdr } from "../herdr.ts";
import type { ResponsibilityStore } from "../responsibilities.ts";
import { makeManagedSendEdge, type ResponsibilityService } from "../responsibility-service.ts";

// Boot-frozen or boot-bound values the per-turn function closes over.
// Anything that decides "does this tool slot exist" is a dep here; the
// decision itself lives below, not in boot().
export interface TurnToolsDeps {
	configRef: ConfigRef;
	auth: AuthStore;
	store: ConversationStore;
	projects: ProjectStore;
	notes: NoteStore;
	programs: ProgramsStore;
	// DM-per-operator send for program hooks — built once at boot (the
	// chat-id list reads live); conv-independent by construction.
	sendPrivate(text: string): Promise<void>;
	// Boot snapshot pair — a live config read can only hide the memory
	// tools, never swap the endpoint mid-run (same freeze as subagents).
	memory: {
		client: HindsightClient;
		config: NonNullable<Config["memory"]>;
		noteRecall(ok: boolean): void;
	} | null;
	transcribe: TranscribeToolDeps["transcribe"];
	delegateDeps(conv: Conversation, workdir: string): DelegateToolDeps | undefined;
	// The operator's own `default` session — unconditional here; guest
	// surfaces lose it in filterGuests.
	operatorHerdr: OperatorHerdr;
	// Only the approval gate's request closure — the send credential
	// lives behind the taps.
	mail(): Pick<MailApproval, "requestDraft">;
	visionDepsFor(conv: Conversation): VisionToolDeps | undefined;
	sandboxes: Sandboxes;
	// Late-bound: the subagent owner awaits past Runtime's construction,
	// and the boot snapshot/desktops/mail gate bind after it too — the
	// getters preserve the closure's call-time reads.
	subagents(): Subagents | null;
	desktops(): Desktops | null;
	subagentsBoot(): Config["subagents"];
	// Late-bound like subagents — the responsibility service is built
	// after Runtime's construction. null = the tool never mounts.
	responsibility(): {
		resps: ResponsibilityStore;
		service: ResponsibilityService;
		listFor(): Promise<OperatorAgent[]>;
	} | null;
	// Channel/persona exclusion — tg/guest.ts owns the policy, injected
	// so tools never imports back into tg/.
	filterGuests<T extends Record<string, unknown>>(conv: Conversation, tools: T): T;
}

export function makeTurnTools(deps: TurnToolsDeps): RuntimeDeps["makeTools"] {
	const {
		configRef,
		auth,
		store,
		projects,
		notes,
		programs,
		sendPrivate,
		memory,
		transcribe,
		delegateDeps,
		operatorHerdr,
		visionDepsFor,
		sandboxes,
		filterGuests,
	} = deps;
	return (conv, deliverVoice, recording, deliverFile, accepts) => {
		// Late-bound seams — resolved per call (they bind after Runtime
		// construction), never at factory time.
		const mail = deps.mail();
		const subagents = deps.subagents();
		const desktops = deps.desktops();
		const subagentsBoot = deps.subagentsBoot();
		const responsibilitySvc = deps.responsibility();
		const tts = configRef.current.tts;
		// Telegram-bound tools don't register on app turns — disjoint
		// pools (DESIGN.md → App channel); delegate is the exception
		// since the spin-off.
		const telegram = channelOf(conv.id) === "telegram";
		// One resolution feeds bash/fetch/read_file's cwd, the sandbox's
		// relative-path anchor, and delegation's workspaceDir — a
		// project conversation works in its dir end to end; a vanished
		// dir throws here and the turn fails at admission.
		const workdir = projectWorkdir(projects, conv);
		const tools = makeTools({
			cwd: workdir,
			voice:
				tts && !configRef.ttsDown && deliverVoice
					? {
							// A per-call voice replaces the config voice outright — Edge
							// derives the language from the voice name; the allowlist
							// always carries the default. The cast is edge-only:
							// openrouter voice ids carry no language to match on.
							synthesize: (text, voice) =>
								synthesizeSpeech(
									text,
									voice !== undefined && tts.kind === "edge" ? { ...tts, voice, voices: [] } : tts,
									{ auth },
								),
							deliver: deliverVoice,
							...(recording ? { recording } : {}),
							...(tts.kind === "edge" && tts.voices?.length
								? { voices: [...new Set([tts.voice, ...tts.voices])] }
								: {}),
						}
					: undefined,
			// sendPrivate keeps hook URLs out of model context — a DM per
			// operator, never in history. publicUrl reads live. App
			// project turns get the responsibility-destination arm —
			// programs bound to this project's handed-over work.
			program: telegram
				? {
						programs,
						chatId: conv.chatId,
						threadId: conv.threadId,
						publicUrl: () => configRef.current.publicUrl,
						sendPrivate,
					}
				: conv.projectId !== null && responsibilitySvc !== null
					? {
							programs,
							project: {
								projectId: conv.projectId,
								resps: responsibilitySvc.resps,
							},
							publicUrl: () => configRef.current.publicUrl,
							sendPrivate,
						}
					: undefined,
			file: deliverFile ? { deliver: deliverFile } : undefined,
			memory: memory
				? {
						client: memory.client,
						maxTokens: memory.config.searchMaxTokens,
						budget: memory.config.searchBudget,
						timeoutMs: memory.config.searchTimeoutMs,
						minScores: memory.config.searchMinScores,
						preferObservations: memory.config.preferObservations,
						reflection: {
							maxTokens: memory.config.reflectMaxTokens,
							budget: memory.config.reflectBudget,
							timeoutMs: memory.config.reflectTimeoutMs,
						},
						isExcluded: () => conv.memoryExcluded,
						noteRecall: memory.noteRecall,
					}
				: undefined,
			// fetch is local (always on), search behind its config block —
			// both read configRef live; the accepts ref rides for PDF rendering.
			web: { configRef, auth, ...(accepts ? { accepts } : {}) },
			transcribe: configRef.current.transcription !== undefined ? { transcribe } : undefined,
			// Boot fixtures under a live gate (see delegateDeps above).
			delegate: delegateDeps(conv, workdir),
			// Unconditional — the operator's session isn't config-gated
			// (guests are filtered below, script's allowlist excludes it).
			herdr: { herdr: operatorHerdr },
			// Only the approval gate's request closure — the send credential lives behind the taps.
			mail:
				telegram && configRef.current.mail !== undefined
					? {
							requestDraft: (input) =>
								mail.requestDraft(input, {
									chatId: conv.chatId,
									threadId: conv.threadId,
								}),
						}
					: undefined,
			history: { store, conversationId: conv.id, isExcluded: () => conv.memoryExcluded },
			// Notes mount for every operator conversation — guests are
			// excluded by the filter below, never by dep absence.
			note: { notes, projects, conversation: conv.id, projectId: conv.projectId },
			// Threads are process-global; a model change drops them on the next call.
			vision: visionDepsFor(conv),
			// Same live-read gate as vision — the image block mounts
			// generate_image; Telegram channels deliver each image
			// inline, other channels save + report paths.
			image:
				configRef.current.image !== undefined
					? {
							configRef,
							auth,
							conversation: conv.id,
							...(deliverFile ? { deliver: deliverFile } : {}),
						}
					: undefined,
			// Live-read like vision/search: the sandbox block mounts the
			// tool for any channel (guest personas are filtered out below).
			sandbox:
				configRef.current.sandbox !== undefined
					? {
							conversation: conv.id,
							workspace: workdir,
							sandboxes,
						}
					: undefined,
			// The subagents block is boot-frozen — a live config read
			// can only hide the tools, never swap models mid-run.
			subagent:
				subagents !== null && configRef.current.subagents !== undefined
					? {
							conversation: conv.id,
							workspace: workdir,
							subagents,
							workerEnabled:
								subagentsBoot?.worker !== undefined && configRef.current.sandbox !== undefined,
							computerEnabled: subagentsBoot?.computer !== undefined,
						}
					: undefined,
			desktop:
				subagents !== null && desktops !== null && configRef.current.subagents !== undefined
					? { conversation: conv.id, workspace: workdir, desktops }
					: undefined,
			// Project-bound turns only: the coordination surface the
			// handover loop lives on. The handover key is the project
			// conversation — one acceptance per coordination conversation.
			responsibility:
				conv.projectId !== null && responsibilitySvc !== null
					? {
							resps: responsibilitySvc.resps,
							service: responsibilitySvc.service,
							projectId: conv.projectId,
							coordinationConversationId: conv.id,
							handoverKey: `handover:${conv.id}`,
							listFor: responsibilitySvc.listFor,
							// The accepted-risk send edge (responsibility-service):
							// preflight binds pane + kind; post-send identity is
							// compared to the bound session — a crossed send lands
							// as uncertain, loudly logged, never a resend.
							guardedSend: makeManagedSendEdge(operatorHerdr),
						}
					: undefined,
			// The interface tool mounts on app turns only — Telegram
			// and guests render plain text (design/app.md → Intelligent UI).
			ui: channelOf(conv.id) === "app",
		});
		// Guest mode: hard toolset exclusion after assembly (design/telegram.md → Guest mode).
		const filtered = filterGuests(conv, tools);
		// script composes the filtered set; refiltering keeps it out of the guest persona's allowlist.
		const scripting = configRef.current.scripting;
		return scripting
			? filterGuests(
					conv,
					withScript(filtered, {
						conversation: conv.id,
						maxCalls: scripting.maxCalls ?? 50,
					}),
				)
			: filtered;
	};
}

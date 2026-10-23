// Per-turn mount policy: an absent dep field mounts nothing, so this
// factory owns which fields exist per conversation — channel gates
// (Telegram-bound tools don't register on app turns), live-config reads
// (search, transcription, sandbox, image hide or show next turn), and
// boot-frozen blocks (subagent/desktop mount only while the boot
// snapshot said so). The resume contract check rebuilds the surface
// through this same function so the drift comparison reads the set the
// resumed attempt would actually get.

import { FencedError, type RuntimeDeps } from "../runtime.ts";
import type { Config, ConfigRef } from "../config.ts";
import { channelOf, type Conversation, type ConversationStore } from "../conversation.ts";
import type { AuthStore } from "../auth.ts";
import type { NoteStore } from "../notes.ts";
import { projectWorkdir, type ProjectStore } from "../projects.ts";
import type { ProgramsStore } from "../programs.ts";
import type { Sandboxes } from "../sandboxes.ts";
import type { Desktops } from "../desktops.ts";
import type { Subagents } from "../subagents/mod.ts";
import type { MailApproval } from "../mail-approval.ts";
import type { ProgramApproval } from "../program-approval.ts";
import { targetOf } from "../targets.ts";
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

// Anything deciding "does this tool slot exist" is a dep here; the
// decision itself lives in makeTurnTools, not boot().
export interface TurnToolsDeps {
	configRef: ConfigRef;
	auth: AuthStore;
	store: ConversationStore;
	projects: ProjectStore;
	notes: NoteStore;
	programs: ProgramsStore;
	// DM-per-operator send for program hooks; conv-independent by
	// construction. Absent when Telegram is disabled.
	sendPrivate?(text: string): Promise<void>;
	// Boot snapshot pair — a live config read can only hide the memory
	// tools, never swap the endpoint mid-run (same freeze as subagents).
	memory: {
		client: HindsightClient;
		config: NonNullable<Config["memory"]>;
		noteRecall(ok: boolean): void;
	} | null;
	transcribe: TranscribeToolDeps["transcribe"];
	delegateDeps(conv: Conversation, workdir: string): DelegateToolDeps | undefined;
	// The operator's own `default` session — guest surfaces lose it in
	// filterGuests.
	operatorHerdr: OperatorHerdr;
	// Only the approval gate's request closure — the send credential
	// lives behind the taps.
	mail(): Pick<MailApproval, "requestDraft"> | undefined;
	// Same late binding as mail — the adapter starts after the bot, so
	// the getter may be absent for a turn that somehow runs first; the
	// request closure then throws and the tool reports the pending
	// proposal rather than losing it.
	programApproval(): Pick<ProgramApproval, "requestApproval"> | undefined;
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
	// tg/guest.ts owns the exclusion policy — injected so tools never
	// imports back into tg/.
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
	return (conv, deliverVoice, recording, deliverFile, accepts, context) => {
		const epoch = conv.epoch;
		// Late-bound seams — resolved per call, never at factory time.
		const mail = deps.mail();
		const subagents = deps.subagents();
		const desktops = deps.desktops();
		const subagentsBoot = deps.subagentsBoot();
		const responsibilitySvc = deps.responsibility();
		const tts = configRef.current.tts;
		// Guests get a reduced set below; app and Telegram turns share the
		// approval-capable operator tools through canonical targets.
		const channel = channelOf(conv.id);
		// One resolution feeds bash/fetch/read_file's cwd, the sandbox's
		// relative-path anchor, and delegation's workspaceDir — a
		// vanished dir throws here and the turn fails at admission.
		const workdir = projectWorkdir(projects, conv);
		const tools = makeTools({
			cwd: workdir,
			voice:
				tts && !configRef.ttsDown && deliverVoice
					? {
							// A per-call voice replaces the config voice outright — Edge
							// derives the language from the voice name; the allowlist
							// always carries the default. Edge-only: openrouter voice
							// ids carry no language to match on.
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
			program:
				channel === "app" || channel === "telegram"
					? {
							programs,
							target: targetOf(conv),
							...(conv.projectId !== null && responsibilitySvc !== null
								? {
										project: {
											projectId: conv.projectId,
											resps: responsibilitySvc.resps,
										},
									}
								: {}),
							publicUrl: () => configRef.current.publicUrl,
							...(sendPrivate === undefined ? {} : { sendPrivate }),
							requestApproval: async (proposal, signal) => {
								const gate = deps.programApproval();
								if (gate === undefined) throw new Error("program approvals are not wired yet");
								await gate.requestApproval(proposal, signal);
							},
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
			// fetch is local (always on), search behind its config block;
			// the accepts ref rides for PDF rendering.
			web: { configRef, auth, ...(accepts ? { accepts } : {}) },
			transcribe: configRef.current.transcription !== undefined ? { transcribe } : undefined,
			// Boot fixtures under a live gate.
			delegate: delegateDeps(conv, workdir),
			// Unconditional — guests are filtered below and script's
			// allowlist excludes it.
			herdr: { herdr: operatorHerdr },
			// Only the approval gate's request closure — the send credential lives behind the taps.
			mail:
				(channel === "app" || channel === "telegram") && configRef.current.mail !== undefined
					? {
							requestDraft: (input) => {
								if (mail === undefined) throw new Error("mail approvals are not wired yet");
								return mail.requestDraft(input, { target: targetOf(conv) });
							},
						}
					: undefined,
			history: { store, conversationId: conv.id, isExcluded: () => conv.memoryExcluded },
			// Guests are excluded by the filter below, never by dep absence.
			note: { notes, projects, conversation: conv.id, projectId: conv.projectId },
			// Threads are process-global; a model change drops them on the next call.
			vision: visionDepsFor(conv),
			// Live-read like vision — mounts generate_image; Telegram
			// delivers each image inline, other channels save + report paths.
			image:
				configRef.current.image !== undefined
					? {
							configRef,
							auth,
							conversation: conv.id,
							...(deliverFile ? { deliver: deliverFile } : {}),
						}
					: undefined,
			// Live-read like vision/search; guest personas are filtered
			// out below.
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
							journalRunId: context?.runId,
							assertAuthority: () => {
								if (store.get(conv.id)?.epoch !== epoch) throw new FencedError(conv.id);
							},
							handoverKey: () => {
								if (context === undefined) {
									throw new Error("responsibility accept needs a turn run context");
								}
								const seq = context.sourceInputSeq();
								if (seq === null) {
									throw new Error(
										"responsibility accept has no durable source input — a client message id never keys a handover",
									);
								}
								return `handover:${conv.id}:seq:${seq}`;
							},
							listFor: responsibilitySvc.listFor,
							// The accepted-risk send edge (responsibility-service):
							// preflight binds pane + kind; post-send identity is
							// compared to the bound session — a crossed send lands
							// as uncertain, loudly logged, never a resend.
							guardedSend: makeManagedSendEdge(operatorHerdr),
						}
					: undefined,
			// App turns only — Telegram and guests render plain text.
			ui: channelOf(conv.id) === "app",
		});
		// Guest mode: hard toolset exclusion after assembly.
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

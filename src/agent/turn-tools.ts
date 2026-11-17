// Per-turn mount policy: an absent dep field mounts nothing, so this
// factory owns which fields exist per conversation — channel gates
// (Telegram-bound tools don't register on app turns), live-config reads
// (search, transcription, sandbox, image hide or show next turn), and
// boot-frozen blocks (the desktop pool mounts only while the boot
// snapshot said so). The resume contract check rebuilds the surface
// through this same function so the drift comparison reads the set the
// resumed attempt would actually get.

import { FencedError, type RuntimeDeps } from "../runtime.ts";

import type { ConfigRef } from "../config.ts";
import { splitModelRef, type Config } from "../config-schema.ts";
import type { AgentChildren } from "../agent-children.ts";
import { loadAgentTypes } from "../agent-types.ts";
import type { Conversation } from "../conversation-read.ts";
import type { ConversationStore } from "../conversation.ts";
import { channelOf } from "../conversation-address.ts";
import { paths } from "../home-layout.ts";
import type { AuthStore } from "../auth.ts";
import type { NoteStore } from "../notes.ts";
import { projectWorkdir, type ProjectStore } from "../projects.ts";
import type { ProgramsStore } from "../programs.ts";
import type { Sandboxes } from "../sandboxes.ts";
import type { Desktops } from "../desktops.ts";
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
import { withAgent } from "./tools/agent.ts";
import { agentChildToolNames } from "./tools/computer.ts";
import { inputModalitiesCached } from "./models-dev.ts";
import { carriesMedia } from "./providers.ts";
import { withScript } from "./tools/script.ts";
import type { T3 } from "../t3.ts";
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
	// tools, never swap the endpoint mid-run (same freeze as delegation).
	memory: {
		client: HindsightClient;
		config: NonNullable<Config["memory"]>;
		noteRecall(ok: boolean): void;
	} | null;
	transcribe: TranscribeToolDeps["transcribe"];
	delegateDeps(
		conv: Conversation,
		workdir: string,
	): DelegateToolDeps | undefined;
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
	// Late-bound: the desktop pool binds past Runtime's construction —
	// the getter preserves the closure's call-time read.
	desktops(): Desktops | null;
	// The t3 adapter — one boot-frozen instance for the handover seams
	// (thread discovery and managed sends).
	t3: T3;
	// Late-bound — the responsibility service is built
	// after Runtime's construction. null = the tool never mounts.
	responsibility(): {
		resps: ResponsibilityStore;
		service: ResponsibilityService;
	} | null;
	// Late-bound — the agent-children engine needs the
	// wake dispatcher, which is built after Runtime. null = the agent
	// tool never mounts and child conversations cannot run.
	agents(): AgentChildren | null;
	// tg/guest.ts owns the exclusion policy — injected so tools never
	// imports back into tg/.
	filterGuests<T extends Record<string, unknown>>(conv: Conversation, tools: T): T;
}

// The screenshot tool mounts only when BOTH gates pass (issue #606):
// the child's model lists image input (models.dev catalog — a cold
// catalog answers null and the tool stays absent until the next turn
// warms it) and the provider pipe carries image tool results
// (carriesMedia's tool-result position — openai-compatible stringifies
// them away, codex is text-only there). Either failing means the tool
// simply does not exist for this child. Exported for tests.
export function screenshotCapable(conv: Conversation, cfg: Config): boolean {
	if (conv.model === null) return false;
	const { provider, modelId } = splitModelRef(conv.model);
	const p = cfg.providers[provider];
	if (p === undefined) return false;
	const baseUrl = "baseUrl" in p ? p.baseUrl : undefined;
	if (!carriesMedia(p.kind, "image/png", "tool-result", baseUrl)) return false;
	const modalities = inputModalitiesCached(provider, modelId);
	return modalities !== null && modalities.has("image");
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
		visionDepsFor,
		sandboxes,
		filterGuests,
	} = deps;
	return (conv, deliverVoice, recording, deliverFile, context) => {
		const epoch = conv.epoch;
		// Narrowed once so the handover closures below type-check as
		// project-bound.
		const projectId = conv.projectId;
		// Late-bound seams — resolved per call, never at factory time.
		const mail = deps.mail();
		const desktops = deps.desktops();
		const responsibilitySvc = deps.responsibility();
		// One gate for every executor that can link work to what goblin owes.
		const checkResponsibility =
			conv.projectId !== null && responsibilitySvc !== null
				? (id: string) => {
						const resp = responsibilitySvc.resps.get(id);
						if (resp === null || resp.projectId !== conv.projectId)
							return `responsibility ${id} not found in this project`;
						if (resp.status !== "active" && resp.status !== "paused")
							return `responsibility ${id} is ${resp.status} — resume it before linking a run`;
						return null;
					}
				: undefined;
		const tts = configRef.current.tts;
		// Guests get a reduced set below; app and Telegram turns share the
		// approval-capable operator tools through canonical targets.
		const channel = channelOf(conv.id);
		// One resolution feeds bash/fetch/read_file's cwd, the sandbox's
		// relative-path anchor, and delegation's workspaceDir — a
		// vanished dir throws here and the turn fails at admission.
		const workdir = projectWorkdir(projects, conv);
		const delegate = delegateDeps(conv, workdir);
		// A child conversation's bound desktop (computer type) — the
		// engine's row is the source; null for parents and other types.
		const childDesktop =
			conv.agentType !== null ? (deps.agents()?.desktopFor(conv.id) ?? null) : null;
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
						// Live flag: a mid-turn exclusion stops the next
						// memory call without fencing the running turn.
						isExcluded: () => store.get(conv.id)?.memoryExcluded ?? conv.memoryExcluded,
						noteRecall: memory.noteRecall,
					}
				: undefined,
			// fetch is local (always on), search behind its config block.
			web: { configRef, auth },
			// Codex conversations swap local search for the hosted
			// web_search unless the provider parks it off.
			hostedSearch: (() => {
				if (conv.model === null) return undefined;
				const { provider } = splitModelRef(conv.model);
				const p = configRef.current.providers?.[provider];
				if (p?.kind !== "codex" || p.webSearch === "off") return undefined;
				return { externalWebAccess: p.webSearch === "live" };
			})(),
			transcribe: configRef.current.transcription !== undefined ? { transcribe } : undefined,
			// Boot fixtures under a live gate.
			delegate:
				delegate === undefined
					? undefined
					: {
							...delegate,
							checkResponsibility,
						},
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
			history: {
				store,
				conversationId: conv.id,
				isExcluded: () => store.get(conv.id)?.memoryExcluded ?? conv.memoryExcluded,
			},
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
			// The desktop pool is boot-frozen — the pool exists or the
			// tool doesn't, whatever a mid-run save says.
			desktop:
				desktops !== null
					? { conversation: conv.id, workspace: workdir, desktops }
					: undefined,
			// Agent-type children only (design/agents.md → Computer use):
			// the desktop tools and ask_operator mount into the pool a
			// child's allowlist picks from. A parent turn never carries
			// them — withAgent would capture them into every child's
			// inherited set.
			computer:
				conv.agentType !== null && desktops !== null && childDesktop !== null
					? {
							conversation: conv.id,
							desktop: childDesktop,
							desktops,
							screenshots: screenshotCapable(conv, configRef.current),
						}
					: undefined,
			askOperator:
				conv.agentType !== null
					? {
							recordAsk: (question: string) => {
								const engine = deps.agents();
								if (engine === null) {
									return { error: "no agent-children engine is wired" };
								}
								return engine.askOperator(conv.id, question);
							},
						}
					: undefined,
			// App turns only, like ui — the artifact card is an app surface.
			// The sandbox source follows the sandbox feature's live gate.
			artifact:
				channel === "app"
					? {
							conversation: conv.id,
							workspace: workdir,
							...(configRef.current.sandbox !== undefined ? { sandboxes } : {}),
						}
					: undefined,
			// Project-bound turns only: the coordination surface the
			// handover loop lives on. The handover key is the project
			// conversation — one acceptance per coordination conversation.
			responsibility:
				projectId !== null && responsibilitySvc !== null
					? {
							resps: responsibilitySvc.resps,
							service: responsibilitySvc.service,
							projectId,
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
							// The project's own dir names the T3 project the
							// handover threads live in; the thread list is
							// read-only discovery, resolved live per call.
							listFor: () => {
								const dir = projects.get(projectId)?.dir;
								if (dir === undefined) {
									throw new Error(
										`project ${projectId} has no dir — cannot list its T3 threads`,
									);
								}
								return deps.t3.listThreads(dir);
							},
							// The managed send edge (responsibility-service):
							// the bound thread id is the identity — CLI
							// failures refuse (nothing was sent), only the
							// tool's own kill lands uncertain.
							guardedSend: makeManagedSendEdge(deps.t3),
						}
					: undefined,
			// App turns only — Telegram and guests render plain text.
			ui: channel === "app",
		});
		// Native subagents (design/agents.md → agent). A child
		// conversation gets its spawn-time allowlist instead of the agent
		// tool — depth is 1. A parent gets the tool with the types read
		// at this turn's start: a malformed type file fails the turn
		// here, loud, naming the file.
		const agents = deps.agents();
		let surfaced = tools;
		if (conv.agentType !== null) {
			if (agents === null) {
				throw new Error(
					`agent child ${conv.id} cannot mount tools — no agent-children engine is wired`,
				);
			}
			const allow = agents.allowlistFor(conv.id);
			if (allow === null) {
				throw new Error(
					`conversation ${conv.id} is marked agent type "${conv.agentType}" but has no registry row — spawn it through the agent tool`,
				);
			}
			const picked: Record<string, (typeof tools)[string]> = {};
			for (const name of allow) {
				const tool = tools[name];
				if (tool !== undefined) picked[name] = tool;
			}
			surfaced = picked as typeof tools;
		} else if (agents !== null) {
			surfaced = withAgent(tools, {
				engine: agents,
				types: loadAgentTypes(paths.agentTypes()),
				conversation: conv,
				// The names the child mount provides that no parent turn
				// carries — the computer type's desktop tools plus
				// ask_operator (agent.ts childToolAllowlist).
				intrinsicTools: agentChildToolNames(desktops !== null),
			});
		}
		// Guest mode: hard toolset exclusion after assembly.
		const filtered = filterGuests(conv, surfaced);
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

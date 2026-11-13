import { appendAuthRecord, type WritableAuthStore } from "../auth.ts";
import type { Config } from "../config-schema.ts";
import { type ConversationStore, prepareAppSettingsForConfig } from "../conversation.ts";
import { flatLine } from "../conversation-events.ts";
import type { DelegationsStore } from "../delegations.ts";
import type { MemoryWiring } from "../memory/mod.ts";
import type { OutageTracker } from "../memory/outage.ts";
import type { ProgramsStore } from "../programs.ts";
import { resolveSkillProposal, type SkillAction } from "../skill-decisions.ts";
import type { SkillSources } from "../skill-provenance.ts";
import { configRoute } from "./operator-config.ts";
import type { OperatorActor, OperatorDeps, OperatorRequest } from "./operator-deps.ts";
import { memoryRoute } from "./operator-memory.ts";
import { programsRoute } from "./operator-programs.ts";
import { skillsRoute } from "./operator-skills.ts";
import { stateviewRoute } from "./operator-stateview.ts";
import { statusRoute } from "./operator-status.ts";

export interface OperatorSeamsDeps {
	store: ConversationStore;
	memory: MemoryWiring;
	/** The worker's tracker — read-only here; the outage row is the
	 *  state the Telegram outage notice fires from. */
	memoryOutage?: Pick<OutageTracker, "current">;
	programs: ProgramsStore;
	delegations: DelegationsStore | null;
	skillSources: SkillSources;
	skillFetch?: OperatorDeps["skillFetch"];
	auth: WritableAuthStore;
	paths: {
		auth(): string;
		skills(): string;
		skillsProposed(): string;
		workspace(): string;
	};
	version: string;
	startedAt: string;
	restartHints(): string[];
}

export function makeOperatorSeams(
	deps: OperatorSeamsDeps,
): Omit<OperatorDeps, "configRef" | "onConfigWritten"> {
	const { store, memory, memoryOutage, programs, delegations, skillSources, auth, paths } = deps;
	const surfaces = memory.surfaces;
	const bootConfig = memory.config;
	return {
		beforeConfigWritten: (previous: Config, next: Config) =>
			prepareAppSettingsForConfig(store, previous, next),
		...(surfaces
			? {
					memory: {
						...surfaces,
						...(memoryOutage === undefined
							? {}
							: { outage: () => memoryOutage.current() }),
						...(bootConfig
							? {
									target: {
										baseUrl: bootConfig.baseUrl,
										bankId: bootConfig.bankId,
									},
								}
							: {}),
						counts: () => store.memoryQueue.counts(surfaces.client.target),
						deletingAll: () => store.memoryQueue.deletingCount(),
						blockedDetail: () => store.memoryQueue.blockedDetail(surfaces.client.target),
						conversationTitle: (id: string) => {
							const conv = store.get(id);
							if (conv === null) return null;
							return {
								title: conv.title === null ? null : flatLine(conv.title) || null,
							};
						},
					},
				}
			: {}),
		programs,
		delegations,
		service: {
			version: deps.version,
			startedAt: deps.startedAt,
			restartHints: deps.restartHints,
		},
		authNames: () => auth.names(),
		secrets: {
			has: (name: string) => auth.has(name),
			isCommand: (name: string) => auth.isCommand(name),
			store: (name: string, value: string) => {
				appendAuthRecord(paths.auth(), name, value);
				auth.put(name, value);
			},
		},
		skillSources: {
			forConversation: (conversationId: string) => skillSources.forConversation(conversationId),
			forgetConversation: (conversationId: string) =>
				skillSources.forgetConversation(conversationId),
			skillsDir: paths.skills(),
			proposedDir: paths.skillsProposed(),
		},
		skillDecisions: {
			decide: (skill: string, action: SkillAction) =>
				resolveSkillProposal(
					{
						workspaceDir: paths.workspace(),
						skillsDir: paths.skills(),
						proposedDir: paths.skillsProposed(),
						forSkill: (s: string) => skillSources.forSkill(s),
						store,
					},
					skill,
					action,
				),
		},
		...(deps.skillFetch !== undefined ? { skillFetch: deps.skillFetch } : {}),
	};
}

// Every operator tail belongs to exactly one family module; the first
// non-null answer is the only one.
export async function handleOperatorRoute(
	deps: OperatorDeps,
	actor: OperatorActor,
	req: Request,
	tail: string,
	url: URL,
): Promise<Response | null> {
	const r: OperatorRequest = {
		deps,
		actor,
		who: actor.via === "mini-app" ? { userId: actor.userId } : {},
		req,
		tail,
		url,
	};
	return (
		(await configRoute(r)) ??
		(await memoryRoute(r)) ??
		(await skillsRoute(r)) ??
		(await programsRoute(r)) ??
		(await stateviewRoute(r)) ??
		(await statusRoute(r))
	);
}

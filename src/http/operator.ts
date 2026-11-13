import { z } from "zod";
import { thinkingLevelsFor } from "../agent/thinking.ts";
import { appendAuthRecord, type WritableAuthStore } from "../auth.ts";
import { type Config, paths } from "../config.ts";
import { type ConversationStore, prepareAppSettingsForConfig } from "../conversation.ts";
import { flatLine } from "../conversation-events.ts";
import type { Delegation, DelegationsStore } from "../delegations.ts";
import { log } from "../log.ts";
import type { MemoryWiring } from "../memory/mod.ts";
import type { Program, ProgramsStore } from "../programs.ts";
import { resolveSkillProposal, type SkillAction } from "../skill-decisions.ts";
import type { SkillSources } from "../skill-provenance.ts";
import {
	AttachmentTooLargeError,
	identityFiles,
	listAttachments,
	readAttachmentBytes,
	tailLog,
} from "../stateview.ts";
import { configRoute } from "./operator-config.ts";
import type { OperatorActor, OperatorDeps, OperatorRequest } from "./operator-deps.ts";
import { fail, json, methodNotAllowed, NO_STORE, SEGMENT_SCHEMA } from "./operator-http.ts";
import { memoryRoute, memoryStatusResponse } from "./operator-memory.ts";
import { skillsRoute } from "./operator-skills.ts";
import type {
	OperatorDelegationItem,
	OperatorDelegationStopResponse,
	OperatorDelegationsResponse,
	OperatorProgramItem,
	OperatorProgramsResponse,
	OperatorStatusResponse,
} from "./operator-wire.ts";

const ATTACHMENT_SERVE_CAP = 32 * 1024 * 1024;

export interface OperatorSeamsDeps {
	store: ConversationStore;
	memory: MemoryWiring;
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
	const { store, memory, programs, delegations, skillSources, auth, paths } = deps;
	const surfaces = memory.surfaces;
	const bootConfig = memory.config;
	return {
		beforeConfigWritten: (previous: Config, next: Config) =>
			prepareAppSettingsForConfig(store, previous, next),
		...(surfaces
			? {
					memory: {
						...surfaces,
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
		(await serviceRoute(r))
	);
}

// Thinking levels, programs, delegations, status, attachments, identity, log.
async function serviceRoute({
	deps,
	actor,
	who,
	req,
	tail,
	url,
}: OperatorRequest): Promise<Response | null> {
	if (tail === "thinking-levels") {
		const levels = thinkingLevelsFor(
			url.searchParams.get("kind") ?? "",
			url.searchParams.get("model") ?? "",
			url.searchParams.get("base") ?? undefined,
		);
		return json({ levels });
	}

	if (tail === "programs") {
		if (req.method !== "GET") return methodNotAllowed();
		if (!deps.programs) {
			return fail("programs are not wired", 503);
		}
		const body: OperatorProgramsResponse = {
			programs: deps.programs.list().map(programItem),
			serverTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		};
		return json(body);
	}

	if (tail === "delegations") {
		if (req.method !== "GET") return methodNotAllowed();
		if (!deps.delegations) {
			return fail("delegation is not configured", 503);
		}
		const rows = deps.delegations.list();
		const body: OperatorDelegationsResponse = {
			delegations: rows.map(delegationItem),
		};
		return json(body);
	}

	const stopMatch = /^delegations\/(\d{1,9})\/stop$/.exec(tail);
	if (stopMatch !== null) {
		if (req.method !== "POST") return methodNotAllowed();
		if (!deps.stopDelegation) {
			return fail("delegation is not configured", 503);
		}
		const id = Number(stopMatch[1]);
		log.info(`delegation stop via ${actor.via}`, { ...who, delegation: id });
		const out = await deps.stopDelegation(id);
		if (out.kind === "no row") {
			return fail("no such delegation", 404);
		}
		const body: OperatorDelegationStopResponse = {
			outcome: out.kind,
			delegation: delegationItem(out.delegation),
			notes: out.notes,
		};
		return Response.json(body, {
			status: out.kind === "stopped" ? 200 : 409,
			headers: NO_STORE,
		});
	}

	if (tail === "status") {
		if (req.method !== "GET") return methodNotAllowed();
		const svc = deps.service;
		if (!svc) {
			return fail("status is not wired", 503);
		}
		const programs = deps.programs?.list();
		const delegations = deps.delegations?.list();
		const active = deps.delegations?.active();
		const body: OperatorStatusResponse = {
			version: svc.version,
			startedAt: svc.startedAt,
			uptimeSec: Math.max(0, Math.floor((Date.now() - Date.parse(svc.startedAt)) / 1000)),
			restartHints: svc.restartHints(),
			memory: memoryStatusResponse(deps),
			programs: programs
				? {
						total: programs.length,
						enabled: programs.filter((p) => p.enabled).length,
					}
				: null,
			delegations:
				delegations !== undefined && active !== undefined
					? { total: delegations.length, active: active.length }
					: null,
		};
		return json(body);
	}

	if (tail === "attachments") {
		if (req.method !== "GET") return methodNotAllowed();
		const body = listAttachments(paths.attachments());
		return json(body);
	}

	if (tail === "attachments/file") {
		if (req.method !== "GET") return methodNotAllowed();
		const name = SEGMENT_SCHEMA.safeParse(url.searchParams.get("name") ?? "");
		if (!name.success || name.data.startsWith(".")) return fail("bad name", 400);
		let served: ReturnType<typeof readAttachmentBytes>;
		try {
			served = readAttachmentBytes(paths.attachments(), name.data, ATTACHMENT_SERVE_CAP);
		} catch (e) {
			if (e instanceof AttachmentTooLargeError) {
				return fail("attachment too large", 413);
			}
			throw e;
		}
		if (served === null) return fail("not found", 404);
		const inline = /^(image|audio|video)\//.test(served.contentType);
		return new Response(served.bytes, {
			headers: {
				...NO_STORE,
				"content-type": served.contentType,
				"x-content-type-options": "nosniff",
				"content-security-policy": "sandbox",
				...(inline ? {} : { "content-disposition": "attachment" }),
			},
		});
	}

	if (tail === "identity") {
		if (req.method !== "GET") return methodNotAllowed();
		const body = identityFiles(paths.workspace());
		return json(body);
	}

	if (tail === "log") {
		if (req.method !== "GET") return methodNotAllowed();
		const limitRaw = url.searchParams.get("limit");
		const limit =
			limitRaw === null
				? { success: true as const, data: 200 }
				: z.coerce.number().int().min(1).max(1000).safeParse(limitRaw);
		if (!limit.success) return fail("bad limit", 400);
		const levelRaw = url.searchParams.get("level");
		const level =
			levelRaw === null || levelRaw === ""
				? { success: true as const, data: null }
				: z.enum(["debug", "info", "warn", "error"]).safeParse(levelRaw);
		if (!level.success) return fail("bad level", 400);
		const qRaw = url.searchParams.get("q");
		const q =
			qRaw === null || qRaw === ""
				? { success: true as const, data: null }
				: z.string().max(300).safeParse(qRaw);
		if (!q.success) return fail("bad q", 400);
		const body = tailLog(paths.logFile(), {
			limit: limit.data,
			level: level.data,
			q: q.data,
		});
		return json(body);
	}

	return null;
}

function programItem(program: Program): OperatorProgramItem {
	return {
		id: program.id,
		name: program.name,
		charter: program.charter,
		cron: program.cron,
		maxLatenessMinutes: program.maxLatenessMinutes,
		hasHook: program.hookHash !== null,
		mailFilter: program.mailFilter,
		enabled: program.enabled,
		target: program.target,
		chatId: program.chatId,
		threadId: program.threadId,
		createdAt: program.createdAt,
		lastRun: program.lastRun,
		nextRun: program.nextRun,
	};
}

function delegationItem(row: Delegation): OperatorDelegationItem {
	return {
		id: row.id,
		name: row.name,
		harness: row.harness,
		status: row.status,
		target: row.target,
		task: row.task,
		cwd: row.cwd,
		appConversation: row.appConversation,
		chatId: row.chatId,
		threadId: row.threadId,
		createdAt: row.createdAt,
		promptedAt: row.promptedAt,
		finishedAt: row.finishedAt,
	};
}

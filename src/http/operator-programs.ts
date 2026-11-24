// The programs and delegations listings plus the operator's delegation
// stop.

import { log } from "../log.ts";
import type { Delegation } from "../delegations.ts";
import type { Program } from "../programs.ts";
import type { OperatorDeps, OperatorRequest } from "./operator-deps.ts";
import { fail, methodNotAllowed, NO_STORE } from "./operator-http.ts";
import type {
	OperatorDelegationItem,
	OperatorDelegationStopResponse,
	OperatorDelegationsResponse,
	OperatorProgramItem,
	OperatorProgramsResponse,
} from "./operator-wire.ts";
import { versionedJson } from "./live-version.ts";

export function programsBody(
	deps: Pick<OperatorDeps, "programs">,
): OperatorProgramsResponse | null {
	if (!deps.programs) return null;
	return {
		programs: deps.programs.list().map(programItem),
		serverTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
	};
}

export function delegationsBody(
	deps: Pick<OperatorDeps, "delegations">,
): OperatorDelegationsResponse | null {
	if (!deps.delegations) return null;
	return { delegations: deps.delegations.list().map(delegationItem) };
}

export async function programsRoute(r: OperatorRequest): Promise<Response | null> {
	const { deps, actor, who, req, tail } = r;

	if (tail === "programs") {
		if (req.method !== "GET") return methodNotAllowed();
		const body = programsBody(deps);
		if (body === null) {
			return fail("programs are not wired", 503);
		}
		return versionedJson(body);
	}

	if (tail === "delegations") {
		if (req.method !== "GET") return methodNotAllowed();
		const body = delegationsBody(deps);
		if (body === null) {
			return fail("delegation is not configured", 503);
		}
		return versionedJson(body);
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
		lastSkippedAt: program.lastSkippedAt,
		lastSkipReason: program.lastSkipReason,
	};
}

function delegationItem(row: Delegation): OperatorDelegationItem {
	return {
		id: row.id,
		name: row.name,
		harness: row.harness,
		status: row.status,
		// Local hc only — machine targets are out (issue #728), so the
		// field the view renders for remote rows is always null.
		target: null,
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

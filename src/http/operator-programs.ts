// The programs and delegations listings plus the operator's delegation
// stop.

import { log } from "../log.ts";
import type { Delegation } from "../delegations.ts";
import type { Program } from "../programs.ts";
import type { OperatorRequest } from "./operator-deps.ts";
import { fail, json, methodNotAllowed, NO_STORE } from "./operator-http.ts";
import type {
	OperatorDelegationItem,
	OperatorDelegationStopResponse,
	OperatorDelegationsResponse,
	OperatorProgramItem,
	OperatorProgramsResponse,
} from "./operator-wire.ts";

export async function programsRoute(r: OperatorRequest): Promise<Response | null> {
	const { deps, actor, who, req, tail } = r;

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

// The status page's aggregate: service info plus memory, program and
// delegation counts.

import type { OperatorRequest } from "./operator-deps.ts";
import { fail, json, methodNotAllowed } from "./operator-http.ts";
import { memoryStatusResponse } from "./operator-memory.ts";
import type { OperatorStatusResponse } from "./operator-wire.ts";

export async function statusRoute(r: OperatorRequest): Promise<Response | null> {
	const { deps, req, tail } = r;

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

	return null;
}

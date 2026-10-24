import { z } from "zod";
import { log } from "../log.ts";
import { PROPOSAL_CHARTER_MAX } from "../program-proposals.ts";
import type { ProgramOpResult } from "../program-ops.ts";
import type { Program, ProgramAddress } from "../programs.ts";
import { targetOf } from "../targets.ts";
import { type AppChannelDeps, jsonBodyRefusal, NO_STORE } from "./app-shared.ts";
import type { AppProgramMutationResponse, AppProgramView } from "./app-wire.ts";

const patchBody = z
	.object({
		name: z.string().min(1).max(100).optional(),
		charter: z.string().min(1).max(PROPOSAL_CHARTER_MAX).optional(),
		cron: z.string().min(5).nullable().optional(),
		maxLatenessMinutes: z
			.number()
			.int()
			.positive()
			.max(Number.MAX_SAFE_INTEGER)
			.nullable()
			.optional(),
		mailFilter: z.string().min(1).max(500).nullable().optional(),
	})
	.strict();

const hookBody = z.object({ op: z.enum(["enable", "rotate", "disable"]) }).strict();

function programUnavailable(): Response {
	return Response.json(
		{ error: "program operations are not configured" },
		{ status: 503, headers: NO_STORE },
	);
}

async function parsedJson<T>(req: Request, schema: z.ZodType<T>): Promise<T | Response> {
	const refusedJson = jsonBodyRefusal(req);
	if (refusedJson !== null) return refusedJson;
	let json: unknown;
	try {
		json = await req.json();
	} catch {
		return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
	}
	const parsed = schema.safeParse(json);
	if (!parsed.success) {
		return Response.json(
			{ error: z.prettifyError(parsed.error) },
			{ status: 422, headers: NO_STORE },
		);
	}
	return parsed.data;
}

function programView(program: Program): AppProgramView {
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
		lastRun: program.lastRun,
		nextRun: program.nextRun,
	};
}

function resultResponse(result: ProgramOpResult): Response {
	switch (result.kind) {
		case "program": {
			const body: AppProgramMutationResponse = {
				status: "updated",
				message: `program "${result.program.name}" updated`,
				program: programView(result.program),
			};
			return Response.json(body, { headers: NO_STORE });
		}
		case "deleted": {
			const body: AppProgramMutationResponse = {
				status: "deleted",
				message: `program #${result.id} deleted`,
			};
			return Response.json(body, { headers: NO_STORE });
		}
		case "proposal": {
			const body: AppProgramMutationResponse = {
				status: "proposal",
				message: result.posted
					? `proposal #${result.proposal.id} is pending approval`
					: (result.error ?? `proposal #${result.proposal.id} is pending approval`),
				proposalId: result.proposal.id,
			};
			return Response.json(body, { headers: NO_STORE });
		}
		case "rotated": {
			const body: AppProgramMutationResponse = {
				status: "rotated",
				message: "webhook rotated — copy the URL now; it is shown once",
				hookUrl: result.url,
			};
			return Response.json(body, { headers: NO_STORE });
		}
		case "error": {
			const body: AppProgramMutationResponse = { status: "error", message: result.message };
			const status = result.message.startsWith("no program") ? 404 : 422;
			return Response.json(body, { status, headers: NO_STORE });
		}
	}
}

// The lane a staged approval presents in: a conversation-target
// program presents at its own target; a responsibility-destination
// program presents at the responsibility's coordination conversation —
// its `resp:<id>` pseudo-address is a destination, never a lane a
// proposal can pin (validTarget refuses it). Resolution is
// presentation-only: a missing wire or row refuses the grant-shaped
// op (ProgramOps' normal no-destination answer), never fabricates a
// fallback, and never blocks the addressless paths ProgramOps permits
// (safe edits, hook disable).
function approvalAddress(current: Program, deps: AppChannelDeps): ProgramAddress | undefined {
	if (current.responsibilityId === null) return { target: current.target };
	const resp = deps.responsibilities?.resps.get(current.responsibilityId);
	if (resp === null || resp === undefined) {
		log.warn("program approval target refused — responsibility not resolvable", {
			program: current.id,
			responsibility: current.responsibilityId,
		});
		return undefined;
	}
	const conv = deps.store.get(resp.coordinationConversationId);
	if (conv === null) {
		log.warn("program approval target refused — coordination conversation missing", {
			program: current.id,
			responsibility: resp.responsibilityId,
			conversation: resp.coordinationConversationId,
		});
		return undefined;
	}
	return { target: targetOf(conv) };
}

export async function handleProgramRoutes(
	req: Request,
	url: URL,
	deps: AppChannelDeps,
): Promise<Response | null> {
	const match = url.pathname.match(/^\/api\/app\/programs\/(\d+)(\/toggle|\/hook)?$/);
	if (match === null) return null;
	const ops = deps.programOps;
	if (ops === undefined) return programUnavailable();
	const id = Number(match[1]);
	const action = match[2] ?? "";

	if (req.method === "GET" && action === "") {
		const program = ops.get(id);
		if (program === null) {
			return Response.json({ error: `no program ${id}` }, { status: 404, headers: NO_STORE });
		}
		return Response.json(programView(program), { headers: NO_STORE });
	}

	if (req.method === "DELETE" && action === "") return resultResponse(ops.remove(id));
	if (req.method === "POST" && action === "/toggle") return resultResponse(ops.toggle(id));

	if (req.method === "PATCH" && action === "") {
		const current = ops.get(id);
		if (current === null) {
			return resultResponse({ kind: "error", message: `no program ${id}` });
		}
		const body = await parsedJson(req, patchBody);
		if (body instanceof Response) return body;
		return resultResponse(await ops.update(id, body, approvalAddress(current, deps)));
	}

	if (req.method === "POST" && action === "/hook") {
		const current = ops.get(id);
		if (current === null) {
			return resultResponse({ kind: "error", message: `no program ${id}` });
		}
		const body = await parsedJson(req, hookBody);
		if (body instanceof Response) return body;
		return resultResponse(await ops.hook(id, body.op, approvalAddress(current, deps)));
	}

	return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
}

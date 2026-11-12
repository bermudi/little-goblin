import { z } from "zod";
import { describeMailDecision } from "../mail-approval.ts";
import { refusalText } from "../program-approval.ts";
import { APP_ACTOR } from "../targets.ts";
import { programChanges } from "./app-program-diff.ts";
import { type AppChannelDeps, NO_STORE, parsedJson } from "./app-shared.ts";
import type { AppApprovalDecisionResponse, AppApprovalsResponse } from "./app-wire.ts";

const programDecisionBody = z.object({
	action: z.enum(["approve", "reject"]),
});

const mailDecisionBody = z.object({
	action: z.enum(["send", "cancel"]),
});

function approvalUnavailable(): Response {
	return Response.json(
		{ error: "approvals are not configured" },
		{ status: 503, headers: NO_STORE },
	);
}

export async function handleApprovalsRoute(
	req: Request,
	url: URL,
	deps: AppChannelDeps,
): Promise<Response | null> {
	const path = url.pathname;

	if (path === "/api/app/approvals") {
		if (req.method !== "GET") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		if (deps.approvals === undefined) return approvalUnavailable();
		const owner = deps.approvals.program;
		const body: AppApprovalsResponse = {
			programs: owner.pending().map((proposal) => {
				const candidate = owner.candidate(proposal);
				const base = owner.base(proposal);
				return {
					id: proposal.id,
					kind: proposal.kind,
					targetId: proposal.targetId,
					target: proposal.target,
					state: proposal.state,
					createdAt: proposal.createdAt,
					decidedAt: proposal.decidedAt,
					decidedBy: proposal.decidedBy,
					activatedId: proposal.activatedId,
					candidate,
					changes: candidate !== null && base !== null ? programChanges(base, candidate) : null,
				};
			}),
			mail: deps.approvals.mail.pending().map((row) => ({
				id: row.id,
				to: row.to,
				cc: row.cc,
				subject: row.subject,
				body: row.body,
				replyToId: row.replyToId,
				target: row.target,
				status: row.status,
				createdAt: row.createdAt,
				expiresAt: row.expiresAt,
				decidedAt: row.decidedAt,
				decidedBy: row.decidedBy,
				sentId: row.sentId,
			})),
		};
		return Response.json(body, { headers: NO_STORE });
	}

	const programApprovalMatch = path.match(/^\/api\/app\/approvals\/program\/(\d+)$/);
	if (programApprovalMatch) {
		if (req.method !== "POST") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		if (deps.approvals === undefined) return approvalUnavailable();
		const body = await parsedJson(req, programDecisionBody);
		if (body instanceof Response) return body;
		const outcome = await deps.approvals.program.decide(
			Number(programApprovalMatch[1]),
			body.action,
			APP_ACTOR,
		);
		const response: AppApprovalDecisionResponse =
			outcome.kind === "activated"
				? {
						status: "activated",
						message: `program "${outcome.program.name}" is active`,
						...(outcome.hookUrl !== undefined ? { hookUrl: outcome.hookUrl } : {}),
					}
				: outcome.kind === "rejected"
					? { status: "rejected", message: "proposal rejected — nothing was granted" }
					: outcome.kind === "needs-public-url"
						? {
								status: "needs-public-url",
								message:
									"publicUrl isn't set — set it in settings, then approve again; the proposal stays pending",
							}
						: {
								status: "refused",
								message: refusalText(outcome.refusal),
							};
		return Response.json(response, {
			status: outcome.kind === "needs-public-url" ? 422 : 200,
			headers: NO_STORE,
		});
	}

	const mailApprovalMatch = path.match(/^\/api\/app\/approvals\/mail\/(\d+)$/);
	if (mailApprovalMatch) {
		if (req.method !== "POST") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		if (deps.approvals === undefined) return approvalUnavailable();
		const body = await parsedJson(req, mailDecisionBody);
		if (body instanceof Response) return body;
		const outcome = await deps.approvals.mail.decide(
			Number(mailApprovalMatch[1]),
			body.action,
			APP_ACTOR,
		);
		const response: AppApprovalDecisionResponse = {
			status: outcome.kind,
			message: describeMailDecision(outcome),
		};
		return Response.json(response, { headers: NO_STORE });
	}

	return null;
}

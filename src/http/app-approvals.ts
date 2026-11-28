import { z } from "zod";
import { describeMailDecision } from "../mail-approval.ts";
import { refusalText } from "../program-approval.ts";
import { APP_ACTOR } from "../targets.ts";
import { log } from "../log.ts";
import { programChanges } from "./app-program-diff.ts";
import { type AppChannelDeps, NO_STORE, parsedJson } from "./app-shared.ts";
import type { AppApprovalDecisionResponse, AppApprovalsResponse } from "./app-wire.ts";
import { versionedJson } from "./live-version.ts";

const programDecisionBody = z.object({
	action: z.enum(["approve", "reject"]),
});

const mailDecisionBody = z.object({
	action: z.enum(["send", "cancel"]),
});
const botDecisionBody = z.strictObject({ action: z.enum(["approve", "decline"]) });

const askCloseBody = z.object({ by: z.enum(["tap", "dismiss"]) }).strict();

function approvalUnavailable(): Response {
	return Response.json(
		{ error: "approvals are not configured" },
		{ status: 503, headers: NO_STORE },
	);
}

export function approvalsBody(
	deps: Pick<AppChannelDeps, "approvals">,
): AppApprovalsResponse | null {
	if (deps.approvals === undefined) return null;
	const owner = deps.approvals.program;
	return {
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
		bots: deps.approvals.bot?.pending() ?? [],
		serverTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
	};
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
		const body = approvalsBody(deps);
		if (body === null) return approvalUnavailable();
		return versionedJson(body);
	}

	const askCloseMatch = path.match(/^\/api\/app\/asks\/([^/]+)\/close$/);
	if (askCloseMatch !== null) {
		if (req.method !== "POST") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		if (deps.asks === undefined) {
			return Response.json({ error: "asks are not configured" }, { status: 503, headers: NO_STORE });
		}
		const idText = askCloseMatch[1]!;
		if (!/^\d+$/.test(idText) || !Number.isSafeInteger(Number(idText)) || Number(idText) < 1) {
			return Response.json({ error: "bad id" }, { status: 400, headers: NO_STORE });
		}
		const mediaType = (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
		if (mediaType !== "application/json") {
			return Response.json({ error: "expected application/json" }, { status: 415, headers: NO_STORE });
		}
		let input: unknown;
		try {
			input = await req.json();
		} catch {
			return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
		}
		const parsed = askCloseBody.safeParse(input);
		if (!parsed.success) return Response.json({ error: "bad body" }, { status: 400, headers: NO_STORE });
		const id = Number(idText);
		const outcome = deps.asks.close(id, parsed.data.by);
		if (outcome === "missing") {
			return Response.json({ error: "question not found" }, { status: 404, headers: NO_STORE });
		}
		if (outcome === "out-of-scope") {
			return Response.json({ error: "question is outside this chat" }, { status: 404, headers: NO_STORE });
		}
		log.info("ask closed from app card", { ask: id, by: parsed.data.by, outcome });
		return Response.json({ ok: true, closed: outcome === "closed" }, { headers: NO_STORE });
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

	const botApprovalMatch = path.match(/^\/api\/app\/approvals\/bot\/(\d+)$/);
	if (botApprovalMatch !== null) {
		if (req.method !== "POST") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		if (deps.approvals?.bot === undefined) return approvalUnavailable();
		const body = await parsedJson(req, botDecisionBody);
		if (body instanceof Response) return body;
		const id = Number(botApprovalMatch[1]);
		const outcome = body.action === "approve"
			? deps.approvals.bot.approve(id)
			: deps.approvals.bot.decline(id);
		log.info("app bot proposal decision", { proposal: id, action: body.action, outcome: outcome.kind });
		const response: AppApprovalDecisionResponse =
			outcome.kind === "approved"
				? { status: "activated", message: `Bot "${outcome.proposal.name}" was created.` }
				: outcome.kind === "declined"
					? { status: "rejected", message: `Bot proposal "${outcome.proposal.name}" was declined.` }
					: outcome.kind === "settled"
						? { status: "settled", message: `Bot proposal "${outcome.proposal.name}" was already decided.` }
						: { status: "gone", message: "Bot proposal not found." };
		return Response.json(response, { headers: NO_STORE });
	}

	return null;
}

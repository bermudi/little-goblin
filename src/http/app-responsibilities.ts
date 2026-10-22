// Responsibility routes — the project feed and its controls. GETs
// serve the durable read model (responsibility-feed.ts); POSTs are
// the same verbs the coordination tool exposes, direct from the app.
// A correction is a durable operator event that steers the next wake;
// pause/cancel disarm follow-through by status, never by hiding rows.
// Detach/reattach only change the binding — the Herdr workspace is
// never touched (adoption grants no cleanup ownership).

import { z } from "zod";
import { log } from "../log.ts";
import type { OperatorAgent } from "../herdr.ts";
import { feedForProject, feedOpen, type FeedDeps } from "../responsibility-feed.ts";
import { cursorFromAgent } from "../responsibility-observer.ts";
import {
	ReconciliationConflict,
	understandingSchema,
	type Attachment,
	type AttachmentTarget,
	type ResponsibilityStore,
} from "../responsibilities.ts";
import type { ResponsibilityService } from "../responsibility-service.ts";
import { type AppChannelDeps, jsonBodyRefusal, NO_STORE } from "./app-shared.ts";

export interface AppResponsibilityDeps {
	feed: FeedDeps;
	resps: ResponsibilityStore;
	/** Record + pump — the correction lands durable, then wakes. */
	service: Pick<ResponsibilityService, "ensureFollowup" | "correct">;
	/** The live operator read reattach binds fresh identity from. */
	listAgents(): Promise<OperatorAgent[]>;
}

const correctBody = z
	.object({
		text: z.string().trim().min(1).max(20_000).optional(),
		understanding: understandingSchema.optional(),
	})
	.strict()
	.refine((b) => b.text !== undefined || b.understanding !== undefined, {
		message: "nothing to correct",
	});

async function readJson(req: Request): Promise<unknown | Response> {
	const refusedJson = jsonBodyRefusal(req);
	if (refusedJson !== null) return refusedJson;
	try {
		return await req.json();
	} catch (err) {
		// Malformed client JSON is a protocol refusal, not a successful
		// mutation. Stream/I/O failures still reach the HTTP error boundary.
		if (!(err instanceof SyntaxError)) throw err;
		return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
	}
}

function notFound(): Response {
	return Response.json({ error: "no such responsibility" }, { status: 404, headers: NO_STORE });
}

export async function handleResponsibilitiesRoute(
	req: Request,
	url: URL,
	deps: AppChannelDeps,
): Promise<Response | null> {
	const path = url.pathname;
	const respsDeps = deps.responsibilities;
	if (respsDeps === undefined) {
		// Mounted-or-refused like every other optional surface.
		if (
			path === "/api/app/responsibilities" ||
			path.startsWith("/api/app/responsibilities/") ||
			path.match(/^\/api\/app\/projects\/[^/]+\/responsibilities$/)
		) {
			log.warn("app responsibility route refused — not wired", { path });
			return Response.json(
				{ error: "responsibility surface is not wired" },
				{ status: 503, headers: NO_STORE },
			);
		}
		return null;
	}

	// Home aggregation — open responsibilities across projects.
	if (path === "/api/app/responsibilities" && req.method === "GET") {
		return Response.json({ items: feedOpen(respsDeps.feed) }, { headers: NO_STORE });
	}

	// Project feed — every responsibility under the project.
	const projectFeed = path.match(/^\/api\/app\/projects\/([^/]+)\/responsibilities$/);
	if (projectFeed && req.method === "GET") {
		const project = deps.projects.get(decodeURIComponent(projectFeed[1]!));
		if (project === null) {
			return Response.json({ error: "no such project" }, { status: 404, headers: NO_STORE });
		}
		return Response.json(
			{ items: feedForProject(respsDeps.feed, project.id) },
			{ headers: NO_STORE },
		);
	}

	// Responsibility controls.
	const respMatch = path.match(/^\/api\/app\/responsibilities\/([^/]+)\/([a-z]+)$/);
	if (respMatch) {
		if (req.method !== "POST") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		const id = decodeURIComponent(respMatch[1]!);
		const action = respMatch[2]!;
		const resp = respsDeps.resps.get(id);
		if (resp === null) return notFound();
		switch (action) {
			case "correct": {
				const body = await readJson(req);
				if (body instanceof Response) return body;
				const parsed = correctBody.safeParse(body);
				if (!parsed.success) {
					return Response.json(
						{ error: z.prettifyError(parsed.error) },
						{ status: 422, headers: NO_STORE },
					);
				}
				// The correction is a durable operator development — it
				// steers the conversation's next wake like any other
				// intake, and it is itself feed-visible.
				respsDeps.service.correct(id, parsed.data);
				return Response.json({ ok: true }, { headers: NO_STORE });
			}
			case "pause":
				respsDeps.resps.setStatus(id, "paused");
				respsDeps.service.ensureFollowup(id);
				return Response.json({ ok: true }, { headers: NO_STORE });
			case "resume": {
				respsDeps.resps.setStatus(id, "active");
				respsDeps.service.ensureFollowup(id, { enable: true });
				return Response.json({ ok: true }, { headers: NO_STORE });
			}
			case "cancel": {
				respsDeps.resps.setStatus(id, "cancelled");
				// The follow-up goes quiet by disabling it — skip rules
				// would consume occurrences anyway, this is explicit.
				respsDeps.service.ensureFollowup(id, { enable: false });
				return Response.json({ ok: true }, { headers: NO_STORE });
			}
			default:
				return Response.json({ error: "not found" }, { status: 404, headers: NO_STORE });
		}
	}

	// Attachment controls — the binding only, never the workspace.
	// Scoped under the responsibility so this namespace can never
	// shadow the file-attachments route.
	const attMatch = path.match(
		/^\/api\/app\/responsibilities\/([^/]+)\/attachments\/(\d+)\/(detach|reattach)$/,
	);
	if (attMatch) {
		if (req.method !== "POST") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		const attachmentId = Number(attMatch[2]!);
		const att = respsDeps.resps.getAttachment(attachmentId);
		if (att === null || att.responsibilityId !== decodeURIComponent(attMatch[1]!)) {
			return notFound();
		}
		if (attMatch[3] === "detach") {
			respsDeps.resps.detach(attachmentId);
			log.info("attachment detached via app", { attachment: attachmentId });
			return Response.json({ ok: true }, { headers: NO_STORE });
		}
		// Reattach binds the CURRENT occupant — a same-pane replacement
		// gets a new generation with its new agent_session; never the
		// old binding revived. The live snapshot is also the new
		// generation's observation cursor: without it the observer
		// silently adopts its next poll as baseline and developments in
		// between are lost.
		const agents = await respsDeps.listAgents();
		// A stored pane is the identity selector; its former name may
		// now belong to another agent. Name lookup is legacy-only.
		const matches = agents.filter((a) =>
			att.target.paneId !== null
				? a.pane_id === att.target.paneId
				: a.name === att.target.agentName,
		);
		if (matches.length !== 1) {
			log.warn("app attachment reattach refused — target not unique", {
				attachment: attachmentId,
				pane: att.target.paneId,
				agentName: att.target.agentName,
				matches: matches.length,
			});
			return Response.json(
				{
					error:
						matches.length === 0
							? "no live agent at the attachment's target — list agents before reattaching"
							: "ambiguous attachment target — list agents and attach by pane instead",
				},
				{ status: 409, headers: NO_STORE },
			);
		}
		const live = matches[0]!;
		if (live.agent !== att.target.kind || live.terminal_id === null) {
			log.warn("app attachment reattach refused — identity mismatch", {
				attachment: attachmentId,
				pane: live.pane_id,
				expectedKind: att.target.kind,
				kind: live.agent,
				terminalId: live.terminal_id,
			});
			return Response.json(
				{
					error: "target kind changed or terminal identity missing — list agents before reattaching",
				},
				{ status: 409, headers: NO_STORE },
			);
		}
		const target: AttachmentTarget = {
			server: att.target.server,
			session: att.target.session,
			agentName: live.name ?? att.target.agentName,
			paneId: live.pane_id,
			terminalId: live.terminal_id,
			agentSession: live.agent_session,
			kind: live.agent ?? att.target.kind,
			cwd: live.cwd,
		};
		let rebound: Attachment;
		try {
			rebound = respsDeps.resps.reattach(attachmentId, target, live, cursorFromAgent(live));
		} catch (err) {
			if (err instanceof ReconciliationConflict) {
				log.warn("app attachment reattach refused — unresolved delivery", {
					attachment: attachmentId,
					unresolved: err.unresolved?.operationId,
				});
				return Response.json(
					{
						error: `reattach to the same agent is blocked by an unresolved delivery — reconcile ${err.unresolved?.operationId ?? "the pending operation"} first`,
						operation: err.unresolved,
					},
					{ status: 409, headers: NO_STORE },
				);
			}
			throw err;
		}
		log.info("attachment reattached via app", {
			attachment: attachmentId,
			generation: rebound.generation,
		});
		return Response.json({ generation: rebound.generation }, { headers: NO_STORE });
	}

	return null;
}

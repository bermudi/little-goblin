// Responsibility routes — the project feed and its controls. GETs
// serve the durable read model (responsibility-feed.ts); POSTs are
// the same verbs the coordination tool exposes, direct from the app.
// A correction is a durable operator event that steers the next wake;
// pause/cancel disarm follow-through by status, never by hiding rows.
// Detach/reattach only change the binding — the T3 thread is
// never touched (adoption grants no cleanup ownership).

import { z } from "zod";
import { log } from "../log.ts";
import type { T3Thread } from "../t3.ts";
import { feedForProject, feedOpen, type FeedDeps } from "../responsibility-feed.ts";
import { cursorFromThread } from "../responsibility-observer.ts";
import type { ResponsibilityStore } from "../responsibilities.ts";
import {
	ReconciliationConflict,
	StaleAttachmentError,
	understandingSchema,
	type Attachment,
	type AttachmentTarget,
} from "../responsibility-types.ts";
import type { ResponsibilityService } from "../responsibility-service.ts";
import { type AppChannelDeps, jsonBodyRefusal, NO_STORE } from "./app-shared.ts";
import type { AppResponsibilityFeed } from "./app-wire.ts";

export interface AppResponsibilityDeps {
	feed: FeedDeps;
	resps: ResponsibilityStore;
	/** Record + pump — the correction lands durable, then wakes. */
	service: Pick<ResponsibilityService, "ensureFollowup" | "correct">;
	/** The named T3 project's live threads — reattach binds the current
	 *  record of the bound thread id from this list. The argument is
	 *  the attachment's bound T3 project id (target.session). */
	listThreads(project: string): Promise<T3Thread[]>;
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
		return Response.json({ items: feedOpen(respsDeps.feed) } satisfies AppResponsibilityFeed, {
			headers: NO_STORE,
		});
	}

	// Project feed — every responsibility under the project.
	const projectFeed = path.match(/^\/api\/app\/projects\/([^/]+)\/responsibilities$/);
	if (projectFeed && req.method === "GET") {
		const project = deps.projects.get(decodeURIComponent(projectFeed[1]!));
		if (project === null) {
			return Response.json({ error: "no such project" }, { status: 404, headers: NO_STORE });
		}
		return Response.json(
			{ items: feedForProject(respsDeps.feed, project.id) } satisfies AppResponsibilityFeed,
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
		// Reattach rebinds the CURRENT record of the bound thread id —
		// a thread that was detached and has since moved on gets a new
		// generation with its fresh cursor; never the old binding
		// revived. The live snapshot is also the new generation's
		// observation cursor: without it the observer silently adopts
		// its next poll as baseline and developments in between are
		// lost.
		const threads = await respsDeps.listThreads(att.target.session);
		const threadId = att.target.agentSession ?? att.target.agentName;
		const live = threads.find((t) => t.threadId === threadId);
		if (live === undefined) {
			log.warn("app attachment reattach refused — thread not listed", {
				attachment: attachmentId,
				thread: threadId,
			});
			return Response.json(
				{
					error:
						"the bound T3 thread is not in the project's thread list — it may be gone; detach instead",
				},
				{ status: 409, headers: NO_STORE },
			);
		}
		const target: AttachmentTarget = {
			server: att.target.server,
			session: att.target.session,
			agentName: live.threadId,
			paneId: null,
			terminalId: null,
			agentSession: live.threadId,
			kind: live.providerInstanceId ?? att.target.kind,
			cwd: live.worktreePath ?? att.target.cwd,
		};
		let rebound: Attachment;
		try {
			// `att` is the pre-listing snapshot — the row must not have
			// moved (detach, another reattach, a health change) while the
			// live listing was in flight.
			rebound = respsDeps.resps.reattach(attachmentId, target, live, cursorFromThread({ thread: live, messages: [] }), att);
		} catch (err) {
			if (err instanceof StaleAttachmentError) {
				log.warn("app attachment reattach refused — binding moved mid-listing", {
					attachment: attachmentId,
					responsibility: att.responsibilityId,
				});
				return Response.json(
					{ error: "attachment changed while reattaching — reload and retry" },
					{ status: 409, headers: NO_STORE },
				);
			}
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

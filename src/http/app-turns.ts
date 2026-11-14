import { UI_MESSAGE_STREAM_HEADERS } from "ai";
import { z } from "zod";
import { log } from "../log.ts";
import type { TurnToolCall } from "../turn-journal.ts";
import type { InterruptedRunView, ResumeRefusalCode } from "../turn-resume.ts";
import { canAuthorizeRetry } from "../turn/retry-guard.ts";
import { appSseWriter } from "./app-sse.ts";
import {
	type AppChannelDeps,
	conversationFromSegment,
	jsonBodyRefusal,
	NO_STORE,
	parsedJson,
} from "./app-shared.ts";
import type {
	AppCompactResponse,
	AppDecideResponse,
	AppInterruptedList,
	AppInterruptedRun,
	AppResumeBlocked,
	AppResumeResponse,
	AppRunCall,
	AppStopResponse,
} from "./app-wire.ts";

const decideBody = z.object({
	callId: z.string().min(1).max(200),
	decision: z.enum(["record-result", "authorize-retry", "skip"]),
	note: z.string().max(4000).optional(),
});

const compactBody = z
	.object({
		focus: z.string().min(1).max(2000).optional(),
	})
	.strict();

// The /stop response waits this long for the stopped turn to settle
// (its unlanded-progress record lands in history before runTurn
// returns) — past it, 200 with settled:false, never a hang.
const STOP_SETTLE_TIMEOUT_MS = 5000;

function appRunCall(c: TurnToolCall): AppRunCall {
	return {
		toolCallId: c.toolCallId,
		name: c.name,
		args: c.args,
		state: c.state,
		result: c.result,
		error: c.error,
		resolutionNote: c.resolutionNote,
		resolvedMs: c.resolvedMs,
		canAuthorizeRetry: canAuthorizeRetry(c),
	};
}

function appInterruptedRun(view: InterruptedRunView): AppInterruptedRun {
	return {
		runId: view.run.runId,
		resumedFrom: view.run.resumedFrom,
		startedMs: view.run.startedMs,
		finishedMs: view.run.finishedMs,
		calls: view.run.calls,
		toolCalls: view.calls.map(appRunCall),
	};
}

function refusalStatus(code: ResumeRefusalCode): number {
	switch (code) {
		case "not-found":
			return 404;
		case "conflict":
			return 409;
		case "invalid":
			return 422;
		case "unavailable":
			return 503;
	}
}

// Turn controls: the per-conversation routes that observe or steer a
// running/stopped turn (interrupted, decide, resume, stop, compact,
// stream) — everything that goes through runtime or resumeOps rather
// than the conversation row itself.
export async function handleTurnsRoute(
	req: Request,
	url: URL,
	deps: AppChannelDeps,
): Promise<Response | null> {
	const path = url.pathname;
	const { store, runtime } = deps;

	const interruptedMatch = path.match(/^\/api\/app\/conversations\/([^/]+)\/interrupted$/);
	if (interruptedMatch) {
		if (req.method !== "GET") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		const convId = conversationFromSegment(interruptedMatch[1]!);
		if (convId instanceof Response) return convId;
		if (store.get(convId.id) === null) {
			return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
		}
		const ops = deps.resumeOps?.();
		if (ops === undefined) {
			return Response.json(
				{ error: "turn resume is not wired" },
				{ status: 503, headers: NO_STORE },
			);
		}
		const body: AppInterruptedList = {
			runs: ops.interrupted(convId.id).map(appInterruptedRun),
		};
		return Response.json(body, { headers: NO_STORE });
	}

	const decideMatch = path.match(/^\/api\/app\/conversations\/([^/]+)\/runs\/([^/]+)\/decide$/);
	if (decideMatch) {
		if (req.method !== "POST") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		const convId = conversationFromSegment(decideMatch[1]!);
		if (convId instanceof Response) return convId;
		if (store.get(convId.id) === null) {
			return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
		}
		const ops = deps.resumeOps?.();
		if (ops === undefined) {
			return Response.json(
				{ error: "turn resume is not wired" },
				{ status: 503, headers: NO_STORE },
			);
		}
		const refusedJson = jsonBodyRefusal(req);
		if (refusedJson !== null) return refusedJson;
		let json: unknown;
		try {
			json = await req.json();
		} catch {
			return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
		}
		const parsed = decideBody.safeParse(json);
		if (!parsed.success) {
			return Response.json(
				{ error: z.prettifyError(parsed.error) },
				{ status: 422, headers: NO_STORE },
			);
		}
		const outcome = ops.decide(
			convId.id,
			decideMatch[2]!,
			parsed.data.callId,
			parsed.data.decision,
			parsed.data.note,
		);
		if (outcome.kind === "ok") {
			const body: AppDecideResponse = { ok: true };
			return Response.json(body, { headers: NO_STORE });
		}
		log.info("app decide refused", {
			conversation: convId.id,
			run: decideMatch[2],
			reason: outcome.reason,
		});
		return Response.json(
			{ error: outcome.reason },
			{ status: refusalStatus(outcome.code), headers: NO_STORE },
		);
	}

	const resumeMatch = path.match(/^\/api\/app\/conversations\/([^/]+)\/runs\/([^/]+)\/resume$/);
	if (resumeMatch) {
		if (req.method !== "POST") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		const convId = conversationFromSegment(resumeMatch[1]!);
		if (convId instanceof Response) return convId;
		if (store.get(convId.id) === null) {
			return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
		}
		const ops = deps.resumeOps?.();
		if (ops === undefined) {
			return Response.json(
				{ error: "turn resume is not wired" },
				{ status: 503, headers: NO_STORE },
			);
		}
		const outcome = ops.resume(convId.id, resumeMatch[2]!);
		if (outcome.kind === "resumed") {
			log.info("app resume admitted", { conversation: convId.id, run: outcome.runId });
			const body: AppResumeResponse = { resumed: true, runId: outcome.runId };
			return Response.json(body, { headers: NO_STORE });
		}
		if (outcome.kind === "needs-decisions") {
			const body: AppResumeBlocked = {
				error: "undecided tool calls block resume",
				calls: outcome.calls.map(appRunCall),
			};
			return Response.json(body, { status: 409, headers: NO_STORE });
		}
		log.info("app resume refused", {
			conversation: convId.id,
			run: resumeMatch[2],
			reason: outcome.reason,
		});
		return Response.json(
			{ error: outcome.reason },
			{ status: refusalStatus(outcome.code), headers: NO_STORE },
		);
	}

	const stopMatch = path.match(/^\/api\/app\/conversations\/([^/]+)\/stop$/);
	if (stopMatch) {
		if (req.method !== "POST") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		const convId = conversationFromSegment(stopMatch[1]!);
		if (convId instanceof Response) return convId;
		if (store.get(convId.id) === null) {
			return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
		}
		const { stopped, active } = runtime.stop(convId.id);
		const started = Date.now();
		let settled = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<void>((resolve) => {
			timer = setTimeout(() => {
				settled = false;
				resolve();
			}, STOP_SETTLE_TIMEOUT_MS);
		});
		await Promise.race([active, timeout]);
		clearTimeout(timer);
		const waitedMs = Date.now() - started;
		log.info("app stop", { conversation: convId.id, stopped, settled, waitedMs });
		if (!settled) {
			log.warn("app stop settle timeout — the turn's record may land after this response", {
				conversation: convId.id,
				waitedMs,
			});
		}
		const body: AppStopResponse = { stopped, settled };
		return Response.json(body, { headers: NO_STORE });
	}

	const compactMatch = path.match(/^\/api\/app\/conversations\/([^/]+)\/compact$/);
	if (compactMatch) {
		if (req.method !== "POST") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		const convId = conversationFromSegment(compactMatch[1]!);
		if (convId instanceof Response) return convId;
		const conv = store.get(convId.id);
		if (conv === null) {
			return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
		}
		// The body is optional — the one-tap UI posts bare; a focus rides
		// as {"focus": "…"} when the surface offers it.
		let focus: string | undefined;
		if ((req.headers.get("content-type") ?? "").includes("application/json")) {
			const parsed = await parsedJson(req, compactBody);
			if (parsed instanceof Response) return parsed;
			focus = parsed.focus;
		}
		try {
			const outcome = await runtime.compact(conv, focus);
			const body: AppCompactResponse =
				outcome.kind === "compacted"
					? {
							compacted: true,
							eventsCompacted: outcome.eventsCompacted,
							tailEvents: outcome.tailEvents,
							tokensBefore: outcome.tokensBefore,
						}
					: { compacted: false, reason: outcome.reason };
			log.info("app compact", {
				conversation: convId.id,
				kind: outcome.kind,
				...(outcome.kind === "compacted"
					? { events: outcome.eventsCompacted, tokensBefore: outcome.tokensBefore }
					: { reason: outcome.reason }),
			});
			return Response.json(body, { headers: NO_STORE });
		} catch (err) {
			log.error("app compact failed", err, { conversation: convId.id });
			return Response.json(
				{ error: `compact failed: ${err instanceof Error ? err.message : String(err)}` },
				{ status: 500, headers: NO_STORE },
			);
		}
	}

	const streamMatch = path.match(/^\/api\/app\/conversations\/([^/]+)\/stream$/);
	if (streamMatch) {
		if (req.method !== "GET") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		const convId = conversationFromSegment(streamMatch[1]!);
		if (convId instanceof Response) return convId;
		if (store.get(convId.id) === null) {
			return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
		}
		const writer = appSseWriter(convId.id);
		const replay = runtime.subscribeLiveChunks(
			convId.id,
			(chunk) => writer.write(chunk),
			(done) => {
				writer.finish(done);
				log.info("app stream finish", {
					conversation: convId.id,
					outcome: done.kind,
					attach: true,
				});
			},
		);
		if (replay === null) {
			writer.dispose();
			return new Response(null, { status: 204, headers: NO_STORE });
		}
		for (const chunk of replay) writer.write(chunk);
		log.info("app stream attach", { conversation: convId.id, replay: replay.length });
		return new Response(writer.body, {
			headers: { ...UI_MESSAGE_STREAM_HEADERS, ...NO_STORE },
		});
	}

	return null;
}

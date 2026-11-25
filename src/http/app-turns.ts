import { UI_MESSAGE_STREAM_HEADERS } from "ai";
import { z } from "zod";
import { log } from "../log.ts";
import { within } from "../timing.ts";
import { appSseWriter, eventStream } from "./app-sse.ts";
import {
	type AppChannelDeps,
	conversationFromSegment,
	NO_STORE,
	parsedJson,
} from "./app-shared.ts";
import type { AppCompactResponse, AppStopResponse } from "./app-wire.ts";
import type { AppConversationEvent } from "./app-wire.ts";

const EVENT_KEEPALIVE_MS = 25_000;

const compactBody = z
	.object({
		focus: z.string().min(1).max(2000).optional(),
	})
	.strict();

// The /stop response waits this long for the stopped turn to settle
// (its unlanded-progress record lands in history before runTurn
// returns) — past it, 200 with settled:false, never a hang.
const STOP_SETTLE_TIMEOUT_MS = 5000;

// Turn controls: the per-conversation routes that observe or steer a
// running/stopped turn (stop, compact, stream) — everything that goes
// through runtime rather than the conversation row itself.
export async function handleTurnsRoute(
	req: Request,
	url: URL,
	deps: AppChannelDeps,
): Promise<Response | null> {
	const path = url.pathname;
	const { store, runtime } = deps;

	const eventsMatch = path.match(/^\/api\/app\/conversations\/([^/]+)\/events$/);
	if (eventsMatch) {
		if (req.method !== "GET") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		const convId = conversationFromSegment(eventsMatch[1]!);
		if (convId instanceof Response) return convId;
		if (store.get(convId.id) === null) {
			return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
		}
		return eventStream<AppConversationEvent>(req, {
			keepaliveMs: EVENT_KEEPALIVE_MS,
			label: "app conversation events",
			open(push) {
				const unsubscribe = runtime.subscribeConversation(convId.id, (event) => push(event));
				push({ type: "state", live: runtime.conversationLive(convId.id) });
				log.info("app conversation events attach", { conversation: convId.id });
				return unsubscribe;
			},
			onClose() {
				log.info("app conversation events detach", { conversation: convId.id });
			},
		});
	}

	const pendingMatch = path.match(/^\/api\/app\/conversations\/([^/]+)\/pending$/);
	if (pendingMatch) {
		if (req.method !== "GET") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		const convId = conversationFromSegment(pendingMatch[1]!);
		if (convId instanceof Response) return convId;
		if (store.get(convId.id) === null) {
			return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
		}
		return Response.json(
			{
				items: runtime.listPending(convId.id).map(({ id, mode, message, createdAt, status }) => ({
					id,
					mode,
					message,
					createdAt,
					status,
				})),
			},
			{ headers: NO_STORE },
		);
	}

	const dequeueMatch = path.match(
		/^\/api\/app\/conversations\/([^/]+)\/pending\/([^/]+)$/,
	);
	if (dequeueMatch) {
		if (req.method !== "DELETE") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		const convId = conversationFromSegment(dequeueMatch[1]!);
		if (convId instanceof Response) return convId;
		if (store.get(convId.id) === null) {
			return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
		}
		const pendingId = z.string().uuid().safeParse(dequeueMatch[2]!);
		if (!pendingId.success) {
			return Response.json({ error: "invalid pending id" }, { status: 400, headers: NO_STORE });
		}
		try {
			const message = runtime.dequeuePending(convId.id, pendingId.data);
			if (message === null) {
				return Response.json({ error: "already taken" }, { status: 409, headers: NO_STORE });
			}
			return Response.json({ message }, { headers: NO_STORE });
		} catch (err) {
			log.error("app pending dequeue failed", err, {
				conversation: convId.id,
				pendingId: pendingId.data,
			});
			return Response.json({ error: "could not remove pending input" }, { status: 500, headers: NO_STORE });
		}
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
		const { stopped, active, notSent } = runtime.stop(convId.id);
		const started = Date.now();
		const settled = (await within(active, STOP_SETTLE_TIMEOUT_MS)).kind === "settled";
		const waitedMs = Date.now() - started;
		log.info("app stop", { conversation: convId.id, stopped, settled, waitedMs });
		if (!settled) {
			log.warn("app stop settle timeout — the turn's record may land after this response", {
				conversation: convId.id,
				waitedMs,
			});
		}
		const body: AppStopResponse = { stopped, settled, notSent };
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
		let detach = () => {};
		const writer = appSseWriter(convId.id, undefined, () => detach());
		const attached = runtime.attachLiveChunks(
			convId.id,
			(chunk) => writer.write(chunk),
			(done) => {
				writer.finish(done);
				detach();
				log.info("app stream finish", {
					conversation: convId.id,
					outcome: done.kind,
					attach: true,
				});
			},
		);
		if (attached === null) {
			writer.dispose();
			return new Response(null, { status: 204, headers: NO_STORE });
		}
		detach = attached.detach;
		for (const chunk of attached.replay) writer.write(chunk);
		log.info("app stream attach", { conversation: convId.id, replay: attached.replay.length });
		return new Response(writer.body, {
			headers: { ...UI_MESSAGE_STREAM_HEADERS, ...NO_STORE },
		});
	}

	return null;
}

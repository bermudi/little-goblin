// Authenticated per-device Web Push controls. Raw subscription material is a
// send credential: it enters on register only, and GET returns endpoint hashes.

import { z } from "zod";
import { pushSubscriptionSchema, type AppPush } from "../app-push.ts";
import { log } from "../log.ts";
import { jsonBodyRefusal, NO_STORE, type AppChannelDeps } from "./app-shared.ts";

const unregisterBody = z.object({ endpoint: pushSubscriptionSchema.shape.endpoint });

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export async function handleAppPushRoute(
	req: Request,
	url: URL,
	deps: AppChannelDeps,
): Promise<Response | null> {
	const push = deps.push;
	if (!url.pathname.startsWith("/api/app/push")) return null;
	if (push === undefined) {
		return Response.json({ error: "app push is not wired" }, { status: 503, headers: NO_STORE });
	}

	try {
		if (req.method === "GET" && url.pathname === "/api/app/push") {
			return Response.json(await push.status(), { headers: NO_STORE });
		}

		if (req.method === "POST" && url.pathname === "/api/app/push/public-key") {
			const refused = jsonBodyRefusal(req);
			if (refused !== null) return refused;
			return Response.json({ publicKey: await push.ensurePublicKey() }, { headers: NO_STORE });
		}

		if (url.pathname === "/api/app/push/subscription" && req.method === "POST") {
			const refused = jsonBodyRefusal(req);
			if (refused !== null) return refused;
			const parsed = pushSubscriptionSchema.safeParse(await req.json());
			if (!parsed.success) {
				return Response.json(
					{ error: "invalid push subscription" },
					{ status: 400, headers: NO_STORE },
				);
			}
			const userAgent = req.headers.get("user-agent");
			return Response.json(
				await push.register(parsed.data, userAgent === null ? null : userAgent.slice(0, 256)),
				{ headers: NO_STORE },
			);
		}

		if (url.pathname === "/api/app/push/subscription" && req.method === "DELETE") {
			const refused = jsonBodyRefusal(req);
			if (refused !== null) return refused;
			const parsed = unregisterBody.safeParse(await req.json());
			if (!parsed.success) {
				return Response.json(
					{ error: "invalid push endpoint" },
					{ status: 400, headers: NO_STORE },
				);
			}
			return Response.json(
				{ removed: push.unregister(parsed.data.endpoint) },
				{ headers: NO_STORE },
			);
		}

		return Response.json({ error: "not found" }, { status: 404, headers: NO_STORE });
	} catch (err) {
		log.error("app push route failed", err, { path: url.pathname, method: req.method });
		return Response.json(
			{ error: `app push failed: ${errMessage(err)}` },
			{ status: 500, headers: NO_STORE },
		);
	}
}

export type { AppPush };

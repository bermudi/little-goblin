import { createHash } from "node:crypto";
import type { AuthStore } from "../auth.ts";
import type { ConfigRef } from "../config.ts";
import { log } from "../log.ts";
import { NO_STORE } from "./app-shared.ts";
import { isLoopbackHost } from "./check.ts";

export interface AppAuthDeps {
	auth: Pick<AuthStore, "resolve">;
	configRef: ConfigRef;
}

export function resolveAppAuth(appToken: string | undefined): string | undefined {
	if (appToken === undefined) {
		log.warn("app channel auth: trust mode (no token; tailnet only)");
		log.warn(
			"app channel trust mode must never sit behind a public URL (funnel) — set appToken first",
		);
	} else {
		log.info("app channel auth: token required", { record: appToken });
	}
	return appToken;
}

// Fixed-length digests so a wrong token's length leaks nothing.
function bearerMatches(presented: string, expected: string): boolean {
	if (presented === "") return false;
	const a = createHash("sha256").update(presented).digest();
	const b = createHash("sha256").update(expected).digest();
	return a.equals(b);
}

const OWN_FETCH_SITES = new Set(["same-origin", "none"]);

function allowedBrowserOrigins(req: Request, deps: AppAuthDeps): Set<string> {
	const origins = new Set<string>();
	const publicUrl = deps.configRef.current.publicUrl;
	if (publicUrl !== undefined && URL.canParse(publicUrl)) {
		origins.add(new URL(publicUrl).origin);
		return origins;
	}
	if (isLoopbackHost(req)) {
		const host = req.headers.get("host") ?? "";
		origins.add(`http://${host}`);
		origins.add(`https://${host}`);
	}
	return origins;
}

function browserMutationRefusal(
	req: Request,
	pathname: string,
	deps: AppAuthDeps,
): Response | null {
	const method = req.method.toUpperCase();
	if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;
	const site = req.headers.get("sec-fetch-site");
	if (site !== null && !OWN_FETCH_SITES.has(site)) {
		log.warn("app mutation refused — cross-site browser request", {
			path: pathname,
			site,
		});
		return Response.json(
			{ error: "cross-origin browser requests are refused" },
			{ status: 403, headers: NO_STORE },
		);
	}
	const origin = req.headers.get("origin");
	if (origin === null) return null;
	if (!allowedBrowserOrigins(req, deps).has(origin)) {
		log.warn("app mutation refused — foreign browser origin", { path: pathname, origin });
		return Response.json(
			{ error: "cross-origin browser requests are refused" },
			{ status: 403, headers: NO_STORE },
		);
	}
	return null;
}

function jsonBodyRefusal(req: Request): Response | null {
	const mediaType = (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
	if (mediaType === "application/json") return null;
	return Response.json({ error: "expected application/json" }, { status: 415, headers: NO_STORE });
}

export async function appAuth(
	req: Request,
	pathname: string,
	deps: AppAuthDeps,
	appToken: string | undefined,
): Promise<Response | null> {
	if (appToken === undefined) return browserMutationRefusal(req, pathname, deps);
	let expected: string;
	try {
		expected = await deps.auth.resolve(appToken);
	} catch (err) {
		log.error("app token resolution failed — refusing", err, { path: pathname });
		return Response.json(
			{ error: "app channel is misconfigured" },
			{ status: 503, headers: NO_STORE },
		);
	}
	const header = req.headers.get("authorization") ?? "";
	const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
	if (!bearerMatches(presented, expected)) {
		log.warn("app auth failed", { path: pathname, presented: presented !== "" });
		return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
	}
	return null;
}

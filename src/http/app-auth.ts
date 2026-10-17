// App-channel auth: boot-time mode resolution (resolveAppAuth) and the
// per-request gate (appAuth). Trust mode — token unset — runs the
// browser-origin CSRF line (#75) on mutations; bearer mode checks the
// token against the auth.jsonl record config.appToken names. Only the
// seams it reads (auth resolution, the live config) are typed in
// AppAuthDeps, so route modules can share this without AppChannelDeps.

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

// Boot-time auth mode resolution, called once by the composition root —
// never per request. The return is the auth.jsonl record name
// handleAppApi checks bearer tokens against; undefined means trust
// mode. Both lines are deliberate: the mode states the posture, and the
// funnel warn is the guardrail — trust mode behind a public URL is a
// misconfiguration this line exists to catch.
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

// Bearer equality without a timing oracle: fixed-length digests of both
// sides, so a wrong token's length leaks nothing.
function bearerMatches(presented: string, expected: string): boolean {
	if (presented === "") return false;
	const a = createHash("sha256").update(presented).digest();
	const b = createHash("sha256").update(expected).digest();
	return a.equals(b);
}

// Trust mode's CSRF line (#75): reachability proves the device, not
// the page — any site the operator's browser visits can fire a no-cors
// POST (text/plain body, no preflight, response never read) at these
// routes and spend operator authority on attacker-chosen input.
// Browsers stamp every mutation with Origin (always) and
// Sec-Fetch-Site, so the gate refuses mutations that arrive speaking
// any origin but ours. Non-browser clients send neither header and
// pass untouched — reachability stays their whole check, exactly as
// design/app.md documents. Bearer mode never runs this gate: the token
// is the check there, and a token-holding client (a future APK's
// webview) must not depend on browser headers.
const OWN_FETCH_SITES = new Set(["same-origin", "none"]);

// The origins a browser may legitimately speak for. The Host header is
// attacker-controlled — a rebound DNS name can point it at our endpoint
// while Origin names the same attacker host — so Host never mints its own
// match except for literal loopback (check.ts's spelling, one source):
// same-machine direct access, where there is no front to name. A
// configured publicUrl is the only browser origin (tailscale serve
// rewrites Host to the local upstream, so the public origin is the match
// that survives the proxy — the rewrite is observed in docs/security.md).
// Without publicUrl, tailnet-name browser origins refuse: set publicUrl.
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
	// Reads are never gated: no mutation to spend, and CORS already
	// keeps a page from reading the response.
	if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;
	// same-site is refused too, not just cross-site: tailscale fronts
	// share the ts.net suffix, so a sibling tailnet's page is site-same
	// but still not ours.
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
	// No Origin and no fetch-metadata: not a browser — reachability is
	// the lock trust mode already is.
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

// JSON-body mutations must say what they are (#75): application/json
// is beyond a no-cors form or fetch (those carry text/plain,
// urlencoded, or multipart), so the claim itself is a CSRF backstop
// behind the origin gate. Applies in both auth modes — wire contract,
// not trust. Multipart uploads and bodyless routes (stop, delete)
// never read JSON and never see this check.
function jsonBodyRefusal(req: Request): Response | null {
	const mediaType = (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
	if (mediaType === "application/json") return null;
	return Response.json({ error: "expected application/json" }, { status: 415, headers: NO_STORE });
}

// Every /api/app/* request passes here first. Returns null when the
// request may proceed; the Response is the refusal. Trust mode (the
// boot-resolved undefined) runs the browser-origin gate for mutations
// — the tailnet stays the lock for everything that is not a page
// riding the operator's browser.
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
		// `presented` is only whether a Bearer header arrived — never its value.
		log.warn("app auth failed", { path: pathname, presented: presented !== "" });
		return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
	}
	return null;
}

import { z } from "zod";
import { log } from "../log.ts";
import { type AppChannelDeps, NO_STORE } from "./app-shared.ts";
import type { AppSearchResponse } from "./app-wire.ts";

// Global history search across app conversations — not a subresource
// of any one conversation, so it lives outside app-conversations.ts.
export async function handleSearchRoute(
	req: Request,
	url: URL,
	deps: AppChannelDeps,
): Promise<Response | null> {
	if (url.pathname !== "/api/app/search") return null;
	if (req.method !== "GET") {
		return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
	}
	const q = z
		.string()
		.max(256)
		.safeParse(url.searchParams.get("q") ?? "");
	if (!q.success) return Response.json({ error: "bad q" }, { status: 400, headers: NO_STORE });
	const limitParam = Number(url.searchParams.get("limit") ?? "");
	const limit =
		Number.isFinite(limitParam) && limitParam >= 1 ? Math.min(25, Math.floor(limitParam)) : 10;
	const hits = deps.store.searchHistory(q.data, limit, "app/%");
	log.debug("app history search", { q: q.data, hits: hits.length });
	const body: AppSearchResponse = { hits };
	return Response.json(body, { headers: NO_STORE });
}

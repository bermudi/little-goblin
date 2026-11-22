import { APP_ID_PREFIX } from "../conversation-address.ts";
import type { AppActivityResponse } from "./app-wire.ts";
import { type AppChannelDeps, NO_STORE } from "./app-shared.ts";

export async function handleActivityRoute(
	req: Request,
	url: URL,
	deps: AppChannelDeps,
): Promise<Response | null> {
	if (url.pathname !== "/api/app/activity") return null;
	if (req.method !== "GET") {
		return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
	}
	const ids = deps.runtime.busyConversations();
	const appIds = ids.filter((id) => id.startsWith(APP_ID_PREFIX));
	const otherBusy = ids.length - appIds.length;
	const rows = new Map(
		(appIds.length === 0 ? [] : deps.store.listAppConversations()).map((row) => [row.id, row]),
	);
	const busy: AppActivityResponse["busy"] = [];
	for (const id of appIds) {
		if (deps.store.isAppRoll(id)) {
			busy.push({ id, title: null, parentId: null, rolling: true });
			continue;
		}
		const row = rows.get(id);
		if (row === undefined) continue;
		busy.push({ id, title: row.title, parentId: row.parentId, rolling: false });
	}
	return Response.json({ busy, otherBusy } satisfies AppActivityResponse, {
		headers: NO_STORE,
	});
}

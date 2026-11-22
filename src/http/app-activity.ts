import { APP_ID_PREFIX } from "../conversation-address.ts";
import type { AppActivityResponse, AppPost } from "./app-wire.ts";
import { type AppChannelDeps, NO_STORE } from "./app-shared.ts";

const POSTS_SHOWN = 20;

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
	const posts = deps.posts.recent(POSTS_SHOWN).map((post): AppPost => {
		const id = post.conversationId;
		const linked = id.startsWith(APP_ID_PREFIX) && deps.store.get(id) !== null;
		return {
			id: post.id,
			text: post.text,
			createdAt: post.createdAt,
			conversation: linked ? { id, rolling: deps.store.isAppRoll(id) } : null,
		};
	});
	return Response.json({ busy, otherBusy, posts } satisfies AppActivityResponse, {
		headers: NO_STORE,
	});
}

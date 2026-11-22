import { z } from "zod";
import { APP_ID_PREFIX } from "../conversation-address.ts";
import type { Post } from "../posts.ts";
import type { AppActivityResponse, AppPost, AppPostsResponse } from "./app-wire.ts";
import { type AppChannelDeps, NO_STORE } from "./app-shared.ts";

const POSTS_SHOWN = 20;
export const POSTS_PAGE = 50;

const beforeSchema = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

function appPost(post: Post, deps: AppChannelDeps): AppPost {
	const id = post.conversationId;
	const linked = id.startsWith(APP_ID_PREFIX) && deps.store.get(id) !== null;
	return {
		id: post.id,
		text: post.text,
		createdAt: post.createdAt,
		conversation: linked ? { id, rolling: deps.store.isAppRoll(id) } : null,
	};
}

function handlePostsRoute(req: Request, url: URL, deps: AppChannelDeps): Response {
	if (req.method !== "GET") {
		return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
	}
	const raw = url.searchParams.get("before");
	const before = raw === null ? undefined : beforeSchema.safeParse(raw);
	if (before !== undefined && !before.success) {
		return Response.json({ error: "before must be a post id" }, { status: 400, headers: NO_STORE });
	}
	const page = deps.posts.recent(POSTS_PAGE + 1, before?.data);
	return Response.json(
		{
			posts: page.slice(0, POSTS_PAGE).map((post) => appPost(post, deps)),
			more: page.length > POSTS_PAGE,
		} satisfies AppPostsResponse,
		{ headers: NO_STORE },
	);
}

export async function handleActivityRoute(
	req: Request,
	url: URL,
	deps: AppChannelDeps,
): Promise<Response | null> {
	if (url.pathname === "/api/app/posts") return handlePostsRoute(req, url, deps);
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
	const posts = deps.posts.recent(POSTS_SHOWN).map((post) => appPost(post, deps));
	return Response.json({ busy, otherBusy, posts } satisfies AppActivityResponse, {
		headers: NO_STORE,
	});
}

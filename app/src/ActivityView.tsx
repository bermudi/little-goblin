import { useCallback, useEffect, useRef, useState } from "react";
import type { AppConversationListItem, AppPost } from "../../src/http/app-wire.ts";
import type { AppPageKey } from "../../src/http/app-routes.ts";
import { listPosts } from "./api.ts";
import { ActivityRow, type ActivityData, activityRows, otherBusyRow } from "./GoblinPanel.tsx";
import { describe } from "./opsShared.tsx";

interface Paged {
	posts: AppPost[];
	more: boolean;
}

function mergePosts(known: readonly AppPost[], incoming: readonly AppPost[]): AppPost[] {
	const byId = new Map<number, AppPost>();
	for (const post of [...known, ...incoming]) byId.set(post.id, post);
	return [...byId.values()].sort((a, b) => b.id - a.id);
}

export function ActivityView({ token, data, conversations, rollingConversationIds, onOpenConversation, onOpenPage }: {
	token: string | null;
	data: ActivityData;
	conversations: readonly AppConversationListItem[];
	rollingConversationIds: readonly string[];
	onOpenConversation(id: string): void;
	onOpenPage(page: AppPageKey): void;
}) {
	const [paged, setPaged] = useState<Paged | null>(null);
	const [loading, setLoading] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const live = useRef(true);
	const loadPage = useCallback(
		async (before: number | null) => {
			setLoading(true);
			try {
				const page = await listPosts(token, before);
				if (!live.current) return;
				setPaged((prev) => ({
					posts: before === null || prev === null ? page.posts : mergePosts(prev.posts, page.posts),
					more: page.more,
				}));
				setErr(null);
			} catch (error) {
				if (live.current) setErr(describe(error));
			} finally {
				if (live.current) setLoading(false);
			}
		},
		[token],
	);
	useEffect(() => {
		live.current = true;
		void loadPage(null);
		return () => {
			live.current = false;
		};
	}, [loadPage]);

	const fillGap = useCallback(
		async (from: number, floor: number) => {
			let before = from;
			try {
				for (;;) {
					const page = await listPosts(token, before);
					if (!live.current) return;
					setPaged((prev) => (prev === null ? prev : { ...prev, posts: mergePosts(prev.posts, page.posts) }));
					const oldest = page.posts.at(-1);
					if (!page.more || oldest === undefined || oldest.id <= floor + 1) return;
					before = oldest.id;
				}
			} catch (error) {
				if (live.current) setErr(describe(error));
			}
		},
		[token],
	);
	const newest = useRef<number | null>(null);
	useEffect(() => {
		newest.current = paged?.posts[0]?.id ?? null;
	}, [paged]);
	const polled = data.activity?.posts;
	const loaded = paged !== null;
	useEffect(() => {
		if (!loaded || polled === undefined || polled.length === 0) return;
		const floor = newest.current ?? 0;
		setPaged((prev) => (prev === null ? prev : { ...prev, posts: mergePosts(prev.posts, polled) }));
		const oldestPolled = Math.min(...polled.map((post) => post.id));
		if (oldestPolled > floor + 1) void fillGap(oldestPolled, floor);
	}, [loaded, polled, fillGap]);

	if (paged === null)
		return (
			<div className="ops activity-page">
				<p className={err === null ? "empty" : "error"}>{err ?? "Loading…"}</p>
			</div>
		);

	const byId = new Map<number, AppPost>();
	for (const post of [...paged.posts, ...(data.activity?.posts ?? [])]) byId.set(post.id, post);
	const posts = [...byId.values()];
	const rows = activityRows(data, posts, { onOpenConversation, onOpenPage }, conversations, null, rollingConversationIds);
	const oldestPost = paged.posts.at(-1);
	const cutoff = paged.more && oldestPost !== undefined ? Date.parse(oldestPost.createdAt) : Number.NEGATIVE_INFINITY;
	const finished = rows.finished.filter((row) => row.at >= cutoff);
	const running = rows.running.length > 0 || rows.otherBusy > 0;

	return (
		<div className="ops activity-page">
			{running && (
				<>
					<h2 className="ops-h2">Running</h2>
					<div className="goblin-panel-rows">
						{rows.running.map((row) => (
							<ActivityRow key={row.key} row={row} />
						))}
						{rows.otherBusy > 0 && <ActivityRow row={otherBusyRow(rows.otherBusy)} />}
					</div>
				</>
			)}
			<h2 className="ops-h2">Earlier</h2>
			<div className="goblin-panel-rows">
				{finished.map((row) => (
					<ActivityRow key={row.key} row={row} />
				))}
				{finished.length === 0 && <p className="empty">No finished work or posts yet.</p>}
			</div>
			{err !== null && <p className="error">{err}</p>}
			{paged.more && oldestPost !== undefined && (
				<button
					type="button"
					className="ghost activity-more"
					disabled={loading}
					onClick={() => void loadPage(oldestPost.id)}
				>
					{loading ? "Loading…" : "Show older"}
				</button>
			)}
		</div>
	);
}

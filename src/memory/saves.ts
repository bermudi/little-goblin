import type { MemoryDocSummary } from "./hindsight.ts";

// The Memory page's split of retained exchanges: those that kept facts
// (the "Recent saves" list) and those that kept none (rolled up by
// conversation). Pure: the caller scans the bank and names conversations.

export interface SaveRow {
	doc: MemoryDocSummary;
	conversationId: string | null;
	name: string | null;
}

export interface NothingKeptGroup {
	conversationId: string | null;
	name: string | null;
	count: number;
	latestAt: string | null;
}

export interface SavesSplit {
	kept: SaveRow[];
	nothingKept: { total: number; conversations: NothingKeptGroup[] };
}

// exchange/<conversation>/<anchor>/<assistant> → the conversation. Its id
// may hold slashes, so only the last two segments are peeled off. The bank
// lists carry it as metadata too, but the single-document read does not.
export function conversationOfDocId(id: string): string | null {
	const match = /^exchange\/(.+)\/[^/]+\/[^/]+$/.exec(id);
	return match?.[1] ?? null;
}

function time(iso: string | null | undefined): number {
	if (iso === null || iso === undefined) return 0;
	const ts = Date.parse(iso);
	return Number.isNaN(ts) ? 0 : ts;
}

export function splitSaves(rows: SaveRow[], query: string | undefined): SavesSplit {
	const needle = query?.toLowerCase();
	const matching =
		needle === undefined
			? rows
			: rows.filter(
					(r) =>
						r.doc.id.toLowerCase().includes(needle) ||
						(r.name?.toLowerCase().includes(needle) ?? false),
				);
	const kept = matching
		.filter((r) => (r.doc.memory_unit_count ?? 0) > 0)
		.sort((a, b) => time(b.doc.created_at) - time(a.doc.created_at));
	const none = matching.filter((r) => (r.doc.memory_unit_count ?? 0) === 0);
	const groups = new Map<string | null, NothingKeptGroup>();
	for (const r of none) {
		const at = r.doc.created_at ?? null;
		const group = groups.get(r.conversationId);
		if (group === undefined) {
			groups.set(r.conversationId, {
				conversationId: r.conversationId,
				name: r.name,
				count: 1,
				latestAt: at,
			});
		} else {
			group.count++;
			if (time(at) > time(group.latestAt)) group.latestAt = at;
		}
	}
	return {
		kept,
		nothingKept: {
			total: none.length,
			conversations: [...groups.values()].sort((a, b) => time(b.latestAt) - time(a.latestAt)),
		},
	};
}

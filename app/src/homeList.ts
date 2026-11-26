import type { AppAttentionItem, AppConversationList } from "../../src/http/app-wire.ts";

type Conv = AppConversationList["conversations"][number];

export type Mark = "needs" | "new" | "working";
export interface Place {
	section: "active" | "chats";
	rank: number;
	at: number;
}
export interface Hold {
	id: string;
	place: Place;
}

export interface ChatRow {
	kind: "chat";
	id: string;
	conv: Conv;
	mark: Mark | null;
	line: string;
	projectName?: string;
	place: Place;
}

export interface LooseRow {
	kind: "loose";
	id: string;
	item: AppAttentionItem;
	mark: "needs";
	line: string;
	place: Place;
}

export interface RollingRow {
	mark: Mark | null;
	line: string;
	target: string | null;
	updatedAt: string | null;
}

export interface HomeList {
	rolling: RollingRow;
	active: (ChatRow | LooseRow)[];
	chats: ChatRow[];
}

export interface HomeInput {
	conversations: readonly Conv[];
	chain: readonly Conv[];
	projects: readonly { id: string; name: string; archivedAt: string | null }[];
	attention: readonly AppAttentionItem[];
	delegations: readonly { appConversation: string | null; status: string }[];
	open: string | null;
	seen: string | null;
}

interface Owner {
	row: string | null;
	roll: string | null;
}

interface MarkResult {
	mark: Mark | null;
	needsItem: AppAttentionItem | null;
}

const NEEDS_KINDS = new Set([
	"program-approval",
	"mail-approval",
	"skill-proposal",
	"delegation-input",
	"ask",
]);

export function buildHome(
	input: HomeInput,
	prev: Hold | null,
): { list: HomeList; hold: Hold | null } {
	const conversations = input.conversations.filter((conv) => conv.archivedAt === null);
	const chatsById = new Map(conversations.map((conv) => [conv.id, conv]));
	const rollIds = new Set(input.chain.map((conv) => conv.id));
	const owners = findOwners(conversations, chatsById, rollIds);
	const openOwner = input.open === null ? undefined : owners.get(input.open);
	const openRow = openOwner?.roll === null ? openOwner.row : null;
	const activeHold = prev?.id === openRow ? prev : null;
	const attentionByConversation = groupAttention(input.attention);
	const runningByConversation = groupRunning(input.delegations);
	const projects = new Map(input.projects.map((project) => [project.id, project.name]));
	const activeProjectIds = new Set(
		input.projects
			.filter((project) => project.archivedAt === null)
			.map((project) => project.id),
	);
	const rowById = new Map<string, ChatRow>();

	for (const conv of chatsById.values()) {
		const owner = owners.get(conv.id);
		if (owner?.row !== conv.id) continue;

		const descendants = conversations.filter(
			(candidate) => candidate.id !== conv.id && owners.get(candidate.id)?.row === conv.id,
		);
		const ids = new Set([conv.id, ...descendants.map((child) => child.id)]);
		const rawResult = getMark(
			conv,
			descendants,
			ids,
			attentionByConversation,
			runningByConversation,
			null,
		);
		const visibleResult = getMark(
			conv,
			descendants,
			ids,
			attentionByConversation,
			runningByConversation,
			input.seen,
		);
		const rawPlace = getRawPlace(conv, rawResult.mark, activeProjectIds);
		const place = getPlacedPlace(conv, rawPlace, activeProjectIds, activeHold);
		if (!place) continue;

		const line = getChatLine(conv, visibleResult);
		const projectName = conv.projectId == null ? undefined : projects.get(conv.projectId);

		rowById.set(conv.id, {
			kind: "chat",
			id: conv.id,
			conv,
			mark: visibleResult.mark,
			line,
			...(projectName === undefined ? {} : { projectName }),
			place,
		});
	}

	const active: (ChatRow | LooseRow)[] = [...rowById.values()]
		.filter((row) => row.place.section === "active");
	active.push(...makeLooseRows(input, owners, rollIds));
	active.sort((left, right) =>
		left.place.rank - right.place.rank || right.place.at - left.place.at
	);

	const chats = [...rowById.values()]
		.filter((row) => row.place.section === "chats")
		.sort((left, right) => {
			const pinOrder = Number(right.conv.pinnedAt != null) -
				Number(left.conv.pinnedAt != null);
			return pinOrder || right.place.at - left.place.at;
		});

	const rolling = makeRollingRow(
		input,
		conversations,
		owners,
		attentionByConversation,
		runningByConversation,
	);
	const hold = makeHold(openRow, rowById, prev);

	return { list: { rolling, active, chats }, hold };
}

function findOwners(
	conversations: readonly Conv[],
	chatsById: Map<string, Conv>,
	rollIds: Set<string>,
): Map<string, Owner> {
	const owners = new Map<string, Owner>();
	const visiting: string[] = [];

	const visit = (id: string): Owner => {
		const cached = owners.get(id);
		if (cached) return cached;

		const conv = chatsById.get(id);
		if (!conv) return { row: null, roll: null };
		if (conv.parentId == null) {
			const owner = { row: conv.id, roll: null };
			owners.set(id, owner);
			return owner;
		}
		if (rollIds.has(conv.parentId)) {
			const owner = { row: null, roll: conv.parentId };
			owners.set(id, owner);
			return owner;
		}

		const cycleIndex = visiting.indexOf(id);
		if (cycleIndex >= 0) {
			for (const cycleId of visiting.slice(cycleIndex)) {
				owners.set(cycleId, { row: null, roll: null });
			}
			return owners.get(id)!;
		}

		visiting.push(id);
		const parent = chatsById.get(conv.parentId);
		if (!parent) {
			visiting.pop();
			const owner = { row: null, roll: null };
			owners.set(id, owner);
			return owner;
		}

		const parentOwner = visit(parent.id);
		visiting.pop();
		const owner = owners.get(id) ?? (
			parentOwner.row !== null
				? { row: parentOwner.row, roll: null }
				: { row: null, roll: parentOwner.roll }
		);
		owners.set(id, owner);
		return owner;
	};

	for (const conv of conversations) {
		visit(conv.id);
	}
	return owners;
}

function groupAttention(items: readonly AppAttentionItem[]): Map<string, AppAttentionItem[]> {
	const grouped = new Map<string, AppAttentionItem[]>();
	for (const item of items) {
		if (!NEEDS_KINDS.has(item.kind) || item.conversationId === null) continue;
		const itemsForConversation = grouped.get(item.conversationId) ?? [];
		itemsForConversation.push(item);
		grouped.set(item.conversationId, itemsForConversation);
	}
	for (const rows of grouped.values()) {
		rows.sort((left, right) => timestamp(right.createdAt) - timestamp(left.createdAt));
	}
	return grouped;
}

function groupRunning(delegations: HomeInput["delegations"]): Set<string> {
	const running = new Set<string>();
	for (const delegation of delegations) {
		if (
			delegation.appConversation !== null &&
			(delegation.status === "starting" || delegation.status === "running")
		) {
			running.add(delegation.appConversation);
		}
	}
	return running;
}

function getMark(
	conv: Conv,
	descendants: readonly Conv[],
	ids: Set<string>,
	attention: Map<string, AppAttentionItem[]>,
	running: Set<string>,
	seen: string | null,
): MarkResult {
	const needsItem = newestAttention(ids, attention);
	if (needsItem) {
		return { mark: "needs", needsItem };
	}
	if (conv.busy) {
		return { mark: "working", needsItem: null };
	}
	if (conv.newReply != null && conv.id !== seen) {
		return { mark: "new", needsItem: null };
	}
	if (descendants.some((kid) => kid.busy || running.has(kid.id)) || running.has(conv.id)) {
		return { mark: "working", needsItem: null };
	}
	return { mark: null, needsItem: null };
}

function newestAttention(
	ids: Set<string>,
	attention: Map<string, AppAttentionItem[]>,
): AppAttentionItem | null {
	let newest: AppAttentionItem | null = null;
	for (const id of ids) {
		const item = attention.get(id)?.[0];
		if (!item) continue;
		if (newest === null || timestamp(item.createdAt) > timestamp(newest.createdAt)) {
			newest = item;
		}
	}
	return newest;
}

function getRawPlace(
	conv: Conv,
	mark: Mark | null,
	activeProjectIds: Set<string>,
): Place | null {
	if (mark !== null) {
		return { section: "active", rank: rankOf(mark), at: timestamp(conv.updatedAt) };
	}
	const hasNoProject = conv.projectId == null;
	const pinnedActiveProject =
		conv.pinnedAt != null &&
		conv.projectId != null &&
		activeProjectIds.has(conv.projectId);
	if (hasNoProject || pinnedActiveProject) {
		return { section: "chats", rank: 0, at: timestamp(conv.updatedAt) };
	}
	return null;
}

function getPlacedPlace(
	conv: Conv,
	raw: Place | null,
	activeProjectIds: Set<string>,
	prev: Hold | null,
): Place | null {
	if (prev?.id !== conv.id) return raw;
	if (
		prev.place.section === "chats" &&
		conv.projectId != null &&
		(conv.pinnedAt == null || !activeProjectIds.has(conv.projectId))
	) {
		return raw;
	}
	return prev.place;
}

function getChatLine(conv: Conv, result: MarkResult): string {
	if (result.mark === "needs") {
		return result.needsItem?.title ?? "";
	}
	if (result.mark === "working") {
		return "Working";
	}
	return conv.title === null ? "" : conv.preview;
}

function makeLooseRows(
	input: HomeInput,
	owners: Map<string, Owner>,
	rollIds: Set<string>,
): LooseRow[] {
	const rows: LooseRow[] = [];
	for (const item of input.attention) {
		if (!NEEDS_KINDS.has(item.kind)) continue;
		const conversationId = item.conversationId;
		if (
			conversationId !== null &&
			(owners.has(conversationId) || rollIds.has(conversationId))
		) {
			continue;
		}
		rows.push({
			kind: "loose",
			id: `attention:${item.id}`,
			item,
			mark: "needs",
			line: item.detail,
			place: { section: "active", rank: 0, at: timestamp(item.createdAt) },
		});
	}
	return rows;
}

function makeRollingRow(
	input: HomeInput,
	conversations: readonly Conv[],
	owners: Map<string, Owner>,
	attention: Map<string, AppAttentionItem[]>,
	running: Set<string>,
): RollingRow {
	const marked = input.chain.map((roll) => {
		const rollKids = conversations.filter((conv) => owners.get(conv.id)?.roll === roll.id);
		const ids = new Set([roll.id, ...rollKids.map((kid) => kid.id)]);
		return {
			roll,
			kids: rollKids,
			result: getMark(roll, rollKids, ids, attention, running, input.seen),
		};
	});
	const picked = marked.find((entry) => entry.result.mark === "needs") ??
		marked.find((entry) => entry.result.mark === "new") ??
		marked.find((entry) => entry.result.mark === "working");
	const newest = input.chain[0];
	let line = newest?.preview ?? "";
	if (picked?.result.mark === "needs") {
		line = picked.result.needsItem?.title ?? "";
	} else if (picked?.result.mark === "working") {
		line = "Working";
	}
	return {
		mark: picked?.result.mark ?? null,
		line,
		target: picked?.roll.id ?? newest?.id ?? null,
		updatedAt: newest?.updatedAt ?? null,
	};
}

function rankOf(mark: Mark): number {
	if (mark === "needs") return 0;
	if (mark === "new") return 1;
	return 2;
}

function timestamp(value: string | null): number {
	if (value === null) return 0;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? 0 : parsed;
}

function makeHold(
	openRow: string | null,
	rows: Map<string, ChatRow>,
	prev: Hold | null,
): Hold | null {
	if (openRow === null) return null;
	if (prev?.id === openRow) return prev;
	const place = rows.get(openRow)?.place;
	return place ? { id: openRow, place } : null;
}

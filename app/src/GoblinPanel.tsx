import { useId, useState } from "react";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@ui-sdk/react/tabs";
import type { AppAttentionTarget, AppConversationListItem, AppNoteSummary, AppPost } from "../../src/http/app-wire.ts";
import type { AppPageKey } from "../../src/http/app-routes.ts";
import type { OperatorDelegationItem } from "../../src/http/operator-wire.ts";
import { relTime as shortAge } from "./ConversationList.tsx";
import { GoblinAvatar } from "./GoblinAvatar.tsx";
import { relTime } from "./memoryShared.tsx";
import { ts } from "./opsShared.tsx";
import { triggerWords } from "./ProgramsView.tsx";
import type { useGoblinActivity } from "./useGoblinActivity.ts";
import { flatLine, flatTitle } from "./flatText.ts";

export type ActivityData = ReturnType<typeof useGoblinActivity>;
type GoblinPanelTab = "activity" | "scheduled" | "library";

const TAB_KEY = "goblin.panelTab";
const ACTIVE: readonly OperatorDelegationItem["status"][] = ["starting", "running", "needs_input"];
const FINISHED: readonly OperatorDelegationItem["status"][] = ["done", "failed", "stopped"];
const ACTIVITY_ROWS = 8;
const SCHEDULED_ROWS = 8;
const LIBRARY_ROWS = 6;
const NEEDS_ROWS = 3;

function loadTab(): GoblinPanelTab {
	try {
		const value = localStorage.getItem(TAB_KEY);
		return value === "scheduled" || value === "library" ? value : "activity";
	} catch {
		return "activity";
	}
}

function saveTab(value: GoblinPanelTab): void {
	try {
		localStorage.setItem(TAB_KEY, value);
	} catch {
		return;
	}
}

const OPEN_KEY = "goblin.panelOpen";

export function loadPanelOpen(): boolean {
	try {
		return localStorage.getItem(OPEN_KEY) !== "false";
	} catch {
		return true;
	}
}

export function savePanelOpen(open: boolean): void {
	try {
		localStorage.setItem(OPEN_KEY, String(open));
	} catch {
		return;
	}
}

export function goblinStatusText(working: number): string {
	if (working <= 0) return "Idle";
	return `Working · ${working} ${working === 1 ? "job" : "jobs"}`;
}

export function GoblinProfileHeader({ page, working, onPage }: {
	page: "status" | "memory" | "skills" | "log";
	working: number;
	onPage(page: AppPageKey): void;
}) {
	const pages = ["status", "memory", "skills", "log"] as const;
	return (
		<div className="goblin-profile-header">
			<GoblinAvatar size="md" working={working > 0} />
			<strong>Goblin</strong>
			<span>{goblinStatusText(working)}</span>
			<nav aria-label="Goblin's profile">
				{pages.map((key) => (
					<a
						key={key}
						href={`/app/${key}`}
						aria-current={page === key ? "page" : undefined}
						onClick={(event) => {
							if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
							event.preventDefault();
							onPage(key);
						}}
					>
						{key[0]?.toUpperCase()}{key.slice(1)}
					</a>
				))}
			</nav>
		</div>
	);
}

export interface GoblinPanelProps {
	data: ActivityData;
	conversations?: readonly AppConversationListItem[];
	openConversationId?: string | null;
	rollingConversationIds?: readonly string[];
	notes: AppNoteSummary[] | null;
	notesError?: boolean;
	variant: "column" | "sheet";
	onOpenTarget(target: AppAttentionTarget): void;
	onOpenConversation(id: string): void;
	onOpenPage(page: AppPageKey): void;
	onOpenNote(id: string): void;
	onOpenProfile(): void;
}

interface PanelRowData {
	key: string;
	label: string;
	detail: string;
	action?: () => void;
}

export interface ActivityItem {
	key: string;
	at: number;
	label: string;
	detail: string;
	time: string;
	iso: string | null;
	tone: "working" | "needs" | "failed" | "quiet" | "done";
	post?: boolean;
	action?: () => void;
	subagents?: ActivityItem[];
	expandedInitially?: boolean;
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

export function activityTime(iso: string, now = Date.now()): string {
	const timestamp = Date.parse(iso);
	if (Number.isNaN(timestamp)) return "";
	if (now - timestamp < 24 * 60 * 60 * 1000) return shortAge(iso, now);
	return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function at(iso: string | null): number {
	if (iso === null) return 0;
	const t = Date.parse(iso);
	return Number.isNaN(t) ? 0 : t;
}

export function PanelRow({ row }: { row: PanelRowData }) {
	const body = (
		<>
			<strong>{row.label}</strong>
			<span>{row.detail}</span>
		</>
	);
	if (row.action === undefined) return <div className="goblin-panel-row">{body}</div>;
	return (
		<button type="button" className="goblin-panel-row" onClick={row.action}>
			{body}
		</button>
	);
}

export function ActivityRow({ row }: { row: ActivityItem }) {
	const [expanded, setExpanded] = useState(row.expandedInitially ?? true);
	const listId = useId();
	const time = row.iso === null
		? <span className="activity-time">{row.time}</span>
		: <time className="activity-time" dateTime={row.iso} title={ts(row.iso)}>{row.time}</time>;
	const children = (
		<>
			<span className={`mark mark-${row.tone === "done" ? "done" : row.tone}`} aria-hidden="true">{row.tone === "needs" ? "!" : null}</span>
			<strong>{row.label}</strong>
			<span className="activity-detail">{row.detail}</span>
			{time}
		</>
	);
	const className = `goblin-panel-row activity-row${row.post === true ? " goblin-panel-post" : ""}${row.tone === "failed" ? " activity-failed" : ""}`;
	const body = row.action === undefined
		? <div className={className}>{children}</div>
		: <button type="button" className={className} onClick={row.action}>{children}</button>;
	return (
		<div className="activity-row-wrap">
			<div className="activity-row-main">
				{body}
				{row.subagents && row.subagents.length > 0 && (
					<button
						type="button"
						className="activity-expand"
						aria-expanded={expanded}
						aria-controls={listId}
						aria-label={`Subagents of ${row.label}`}
						onClick={() => setExpanded((value) => !value)}
					>›</button>
				)}
			</div>
			{row.subagents && row.subagents.length > 0 && (
				<div id={listId} className="activity-subagents" hidden={!expanded}>
					{row.subagents.map((subagent) => <ActivityRow key={subagent.key} row={subagent} />)}
				</div>
			)}
		</div>
	);
}

export interface ActivityOpeners {
	onOpenConversation(id: string): void;
	onOpenPage(page: AppPageKey): void;
}

export interface ActivityRows {
	running: ActivityItem[];
	otherBusy: number;
	finished: ActivityItem[];
	thisChat: ActivityItem | null;
}

export function activityRows(
	data: ActivityData,
	posts: readonly AppPost[],
	open: ActivityOpeners,
	conversations: readonly AppConversationListItem[] = [],
	openConversationId: string | null = null,
	rollingConversationIds: readonly string[] = [],
): ActivityRows {
	const delegations = data.delegations ?? [];
	const conversationsById = new Map(conversations.map((conversation) => [conversation.id, conversation]));
	const busyConversationIds = new Set((data.activity?.busy ?? []).map((conversation) => conversation.id));
	const rollingIds = new Set([
		...rollingConversationIds,
		...(data.activity?.busy ?? []).filter((conversation) => conversation.rolling).map((conversation) => conversation.id),
	]);
	const topParent = (conversation: AppConversationListItem): AppConversationListItem | null => {
		let current = conversation;
		const seen = new Set<string>();
		while (current.parentId !== null) {
			if (seen.has(current.id)) return null;
			seen.add(current.id);
			const parent = conversationsById.get(current.parentId);
			if (!parent) return null;
			current = parent;
		}
		return current;
	};
	const subagentItem = (conversation: AppConversationListItem): ActivityItem => ({
		key: `subagent:${conversation.id}`,
		at: at(conversation.updatedAt),
		label: flatTitle(conversation.title) ?? (flatLine(conversation.preview).slice(0, 60) || "Subagent"),
		detail: "",
		time: conversation.busy || busyConversationIds.has(conversation.id) ? "now" : activityTime(conversation.updatedAt),
		iso: conversation.busy || busyConversationIds.has(conversation.id) ? null : conversation.updatedAt,
		tone: conversation.busy || busyConversationIds.has(conversation.id)
			? "working"
			: (data.attention ?? []).some((item) => item.conversationId === conversation.id)
			? "needs"
			: "done",
		action: () => open.onOpenConversation(conversation.id),
	});
	const childGroups = new Map<string, AppConversationListItem[]>();
	for (const conversation of conversations) {
		if (conversation.parentId === null) continue;
		const parent = topParent(conversation);
		if (!parent) continue;
		const children = childGroups.get(parent.id) ?? [];
		children.push(conversation);
		childGroups.set(parent.id, children);
	}
	for (const children of childGroups.values()) {
		children.sort((left, right) =>
			Number(right.busy || busyConversationIds.has(right.id)) -
				Number(left.busy || busyConversationIds.has(left.id)) ||
			at(right.updatedAt) - at(left.updatedAt)
		);
	}
	const busyByParent = new Map<string, AppConversationListItem[]>();
	for (const busy of data.activity?.busy ?? []) {
		if (busy.parentId === null) continue;
		const child = conversationsById.get(busy.id);
		if (!child) continue;
		const parent = topParent(child);
		if (!parent) continue;
		const group = busyByParent.get(parent.id) ?? [];
		group.push(child);
		busyByParent.set(parent.id, group);
	}
	const parentRows = new Map<string, ActivityItem>();
	for (const [parentId, children] of busyByParent) {
		const parent = conversationsById.get(parentId);
		const busyParent = parent?.busy === true ||
			(data.activity?.busy ?? []).some((row) => row.id === parentId);
		const parentRow: ActivityItem = {
			key: `chat:${parentId}`,
			at: Number.POSITIVE_INFINITY,
			label: parent === undefined || rollingIds.has(parentId) ? "Rolling chat" : oneLine(parent.title ?? "Untitled"),
			detail: busyParent
				? `Replying · ${children.length} subagent${children.length === 1 ? "" : "s"}`
				: `Waiting on ${children.length} subagent${children.length === 1 ? "" : "s"}`,
			time: "now",
			iso: null,
			tone: "working",
			action: parent === undefined || rollingIds.has(parentId)
				? () => open.onOpenPage("rolling")
				: () => open.onOpenConversation(parent.id),
			subagents: children.map(subagentItem),
		};
		parentRows.set(parentId, parentRow);
	}
	const openDelegation = (d: OperatorDelegationItem) => () =>
		d.appConversation !== null
			? open.onOpenConversation(d.appConversation)
			: open.onOpenPage("delegations");
	const busyRows: ActivityItem[] = (data.activity?.busy ?? [])
		.filter((conversation) => conversation.parentId === null)
		.map((c) => ({
		key: `chat:${c.id}`,
		at: Number.POSITIVE_INFINITY,
		label: c.rolling ? "Rolling chat" : oneLine(c.title ?? "Untitled"),
		detail: parentRows.get(c.id)?.detail ?? "Replying",
		time: "now",
		iso: null,
		tone: "working",
			action: c.rolling || rollingIds.has(c.id)
				? () => open.onOpenPage("rolling")
				: () => open.onOpenConversation(c.id),
		...(parentRows.get(c.id)?.subagents === undefined
			? {}
			: { subagents: parentRows.get(c.id)!.subagents }),
	}));
	for (const [parentId, row] of parentRows) {
		if (!(data.activity?.busy ?? []).some((busy) => busy.id === parentId)) busyRows.push(row);
	}
	const openConversation = openConversationId === null ? null : conversationsById.get(openConversationId) ?? null;
	const openParent = openConversation === null ? null : topParent(openConversation);
	const openRunning = openParent === null ? undefined : busyRows.find((row) => row.key === `chat:${openParent.id}`);
	const thisChat = openParent && (childGroups.get(openParent.id)?.length ?? 0) > 0
		? {
				key: `this-chat:${openParent.id}`,
				at: 0,
				label: rollingIds.has(openParent.id) ? "Rolling chat" : flatTitle(openParent.title) ?? "Untitled",
				detail: openRunning?.detail ?? "",
				time: openRunning?.time ?? "",
				iso: null,
				tone: openRunning?.tone ?? ("quiet" as const),
				action: rollingIds.has(openParent.id)
					? () => open.onOpenPage("rolling")
					: () => open.onOpenConversation(openParent.id),
				subagents: (childGroups.get(openParent.id) ?? []).map(subagentItem),
				expandedInitially: true,
			}
		: null;
	const activeRows: ActivityItem[] = delegations
		.filter((d) => ACTIVE.includes(d.status))
		.map((d): ActivityItem => ({
			key: `delegation:${d.id}`,
			at: at(d.createdAt),
			label: oneLine(d.name) || "Untitled",
			detail: `${d.harness} · ${d.status === "needs_input" ? "needs input" : d.status}`,
			time: activityTime(d.createdAt),
			iso: d.createdAt,
			tone: d.status === "needs_input" ? "needs" : "working",
			action: openDelegation(d),
		}))
		.sort((a, b) => b.at - a.at);
	const finishedRows: ActivityItem[] = [
		...delegations
			.filter((d) => FINISHED.includes(d.status))
			.map((d): ActivityItem => ({
				key: `finished:${d.id}`,
				at: at(d.finishedAt ?? d.createdAt),
				label: oneLine(d.name) || "Untitled",
				detail: `${d.harness} · ${d.status}`,
				time: activityTime(d.finishedAt ?? d.createdAt),
				iso: d.finishedAt ?? d.createdAt,
				tone: d.status === "failed" ? "failed" : "quiet",
				action: openDelegation(d),
			})),
		...(data.programs ?? [])
			.filter((p): p is typeof p & { lastRun: string } => p.lastRun !== null)
			.map((p) => ({
				key: `program:${p.id}`,
				at: at(p.lastRun),
				label: oneLine(p.name),
				detail: "Program ran",
				time: activityTime(p.lastRun),
				iso: p.lastRun,
				tone: "quiet" as const,
				action: () => open.onOpenPage("programs"),
			})),
		...posts.map((post): ActivityItem => {
			const source = post.conversation;
			return {
				key: `post:${post.id}`,
				at: at(post.createdAt),
				label: post.text,
				detail: "Post",
				time: activityTime(post.createdAt),
				iso: post.createdAt,
				tone: "quiet",
				post: true,
				...(source === null
					? {}
					: {
							action: source.rolling
								? () => open.onOpenPage("rolling")
								: () => open.onOpenConversation(source.id),
						}),
			};
		}),
	].sort((a, b) => b.at - a.at);
	return {
		running: [
			...busyRows.filter((row) => thisChat === null || row.key !== `chat:${openParent?.id ?? ""}`),
			...activeRows,
		],
		otherBusy: data.activity?.otherBusy ?? 0,
		finished: finishedRows,
		thisChat,
	};
}

export function otherBusyRow(otherBusy: number): ActivityItem {
	return {
		key: "other",
		at: 0,
		label: `Working in ${otherBusy} other ${otherBusy === 1 ? "chat" : "chats"}`,
		detail: "outside the app",
		time: "now",
		iso: null,
		tone: "working",
	};
}

export function GoblinPanel(props: GoblinPanelProps) {
	const { data } = props;
	const [tab, setTab] = useState<GoblinPanelTab>(loadTab);
	const selectTab = (value: string | null) => {
		if (value !== "activity" && value !== "scheduled" && value !== "library") return;
		setTab(value);
		saveTab(value);
	};

	const all = activityRows(
		data,
		data.activity?.posts ?? [],
		props,
		props.conversations ?? [],
		props.openConversationId ?? null,
		props.rollingConversationIds ?? [],
	);
	const otherBusy = all.otherBusy;
	const running = all.running.slice(0, ACTIVITY_ROWS - (otherBusy > 0 ? 1 : 0));
	const finished = all.finished.slice(
		0,
		Math.max(0, ACTIVITY_ROWS - running.length - (otherBusy > 0 ? 1 : 0)),
	);
	const activityHidden = running.length < all.running.length || finished.length < all.finished.length;

	const scheduled = [...(data.programs ?? [])]
		.sort((a, b) => {
			if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
			if (!a.enabled) return 0;
			return (at(a.nextRun) || Number.MAX_SAFE_INTEGER) - (at(b.nextRun) || Number.MAX_SAFE_INTEGER);
		})
		.slice(0, SCHEDULED_ROWS);

	const notes = [...(props.notes ?? [])]
		.filter((n) => n.archivedAt === null)
		.sort(
			(a, b) =>
				Number(b.pinnedAt !== null) - Number(a.pinnedAt !== null) || at(b.updatedAt) - at(a.updatedAt),
		)
		.slice(0, LIBRARY_ROWS);

	const attention = data.attention ?? [];
	const showNeeds = attention.length > 0 || data.attentionError;

	return (
		<div className={`goblin-panel goblin-panel-${props.variant}`}>
			<header className="goblin-panel-header">
				<button
					type="button"
					className="goblin-profile-button"
					aria-label="Goblin's profile"
					onClick={props.onOpenProfile}
				>
					<GoblinAvatar size="lg" working={data.working > 0} />
				</button>
				<strong>Goblin</strong>
				<span>{goblinStatusText(data.working)}</span>
			</header>
			{showNeeds && (
				<section className="goblin-needs" aria-label="Needs you">
					<h2>
						{data.attentionError ? "Couldn't load what needs you." : `Needs you · ${attention.length}`}
					</h2>
					{attention.slice(0, NEEDS_ROWS).map((item) => (
						<button
							type="button"
							className="goblin-need-row"
							key={item.id}
							onClick={() => props.onOpenTarget(item.target)}
						>
							<strong>{item.title}</strong>
							<span>{item.detail}</span>
						</button>
					))}
					{attention.length > NEEDS_ROWS && (
						<button type="button" className="link" onClick={() => props.onOpenPage("attention")}>
							See all {attention.length}
						</button>
					)}
				</section>
			)}
			<Tabs value={tab} onValueChange={selectTab}>
				<TabsList aria-label="Goblin's work">
					<TabsTab value="activity">Activity</TabsTab>
					<TabsTab value="scheduled">Scheduled</TabsTab>
					<TabsTab value="library">Library</TabsTab>
				</TabsList>
				<TabsPanel value="activity">
					<div className="goblin-panel-rows">
						{all.thisChat !== null && (
							<>
								<h2 className="goblin-panel-group">This chat</h2>
								<ActivityRow row={all.thisChat} />
							</>
						)}
						{(running.length > 0 || otherBusy > 0) && <h2 className="goblin-panel-group">Running</h2>}
						{running.map((row) => (
							<ActivityRow key={row.key} row={row} />
						))}
						{otherBusy > 0 && <ActivityRow row={otherBusyRow(otherBusy)} />}
						{finished.length > 0 && <h2 className="goblin-panel-group">Earlier</h2>}
						{finished.map((row) => (
							<ActivityRow key={row.key} row={row} />
						))}
						{running.length === 0 && otherBusy === 0 && finished.length === 0 && (
							<p className="empty">Nothing running.</p>
						)}
					</div>
					<div className="goblin-panel-footer-group">
						{activityHidden && (
							<button
								type="button"
								className="goblin-panel-footer"
								onClick={() => props.onOpenPage("activity")}
							>
								See all
							</button>
						)}
						<button
							type="button"
							className="goblin-panel-footer"
							onClick={() => props.onOpenPage("delegations")}
						>
							All delegations
						</button>
					</div>
				</TabsPanel>
				<TabsPanel value="scheduled">
					<div className="goblin-panel-rows">
						{scheduled.map((p) => (
							<PanelRow
								key={p.id}
								row={{
									key: String(p.id),
									label: p.name,
									detail: p.enabled
										? `${triggerWords(p)}${p.nextRun !== null ? ` · next ${ts(p.nextRun)}` : ""}`
										: "paused",
									action: () => props.onOpenPage("programs"),
								}}
							/>
						))}
						{scheduled.length === 0 && <p className="empty">Nothing scheduled.</p>}
					</div>
					<button
						type="button"
						className="goblin-panel-footer"
						onClick={() => props.onOpenPage("programs")}
					>
						All programs
					</button>
				</TabsPanel>
				<TabsPanel value="library">
					<div className="goblin-panel-rows">
						{notes.map((n) => (
							<PanelRow
								key={n.id}
								row={{
									key: n.id,
									label: oneLine(n.title) || "Untitled note",
									detail: `note · ${relTime(n.updatedAt)}`,
									action: () => props.onOpenNote(n.id),
								}}
							/>
						))}
						{props.notesError ? (
							<p className="error">Couldn't load notes.</p>
						) : notes.length === 0 && (
							<p className="empty">No notes yet.</p>
						)}
					</div>
					<div className="goblin-panel-footer-group">
						<button
							type="button"
							className="goblin-panel-footer"
							onClick={() => props.onOpenPage("notes")}
						>
							All notes
						</button>
						<button
							type="button"
							className="goblin-panel-footer"
							onClick={() => props.onOpenPage("files")}
						>
							Files
						</button>
					</div>
				</TabsPanel>
			</Tabs>
		</div>
	);
}

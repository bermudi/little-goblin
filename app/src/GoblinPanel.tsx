import { useState } from "react";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@ui-sdk/react/tabs";
import type { AppAttentionTarget, AppNoteSummary } from "../../src/http/app-wire.ts";
import type { AppPageKey } from "../../src/http/app-routes.ts";
import type { OperatorDelegationItem } from "../../src/http/operator-wire.ts";
import { GoblinAvatar } from "./GoblinAvatar.tsx";
import { relTime } from "./memoryShared.tsx";
import { ts } from "./opsShared.tsx";
import { triggerWords } from "./ProgramsView.tsx";
import type { useGoblinActivity } from "./useGoblinActivity.ts";

type ActivityData = ReturnType<typeof useGoblinActivity>;
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

export function goblinStatusText(working: number): string {
	if (working <= 0) return "Idle";
	return `Working · ${working} ${working === 1 ? "job" : "jobs"}`;
}

export interface GoblinPanelProps {
	data: ActivityData;
	notes: AppNoteSummary[] | null;
	variant: "column" | "sheet";
	onOpenTarget(target: AppAttentionTarget): void;
	onOpenConversation(id: string): void;
	onOpenPage(page: AppPageKey): void;
	onOpenNote(id: string): void;
	onOpenProfile(): void;
}

interface Row {
	key: string;
	at: number;
	label: string;
	detail: string;
	action?: () => void;
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function at(iso: string | null): number {
	if (iso === null) return 0;
	const t = Date.parse(iso);
	return Number.isNaN(t) ? 0 : t;
}

function PanelRow({ row }: { row: Row }) {
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

export function GoblinPanel(props: GoblinPanelProps) {
	const { data } = props;
	const [tab, setTab] = useState<GoblinPanelTab>(loadTab);
	const selectTab = (value: string | null) => {
		if (value !== "activity" && value !== "scheduled" && value !== "library") return;
		setTab(value);
		saveTab(value);
	};

	const delegations = data.delegations ?? [];
	const openDelegation = (d: OperatorDelegationItem) => () =>
		d.appConversation !== null
			? props.onOpenConversation(d.appConversation)
			: props.onOpenPage("delegations");
	const busyRows: Row[] = (data.activity?.busy ?? []).map((c) => ({
		key: `chat:${c.id}`,
		at: Number.POSITIVE_INFINITY,
		label: c.parentId !== null ? `Subagent: ${c.title ?? "untitled"}` : `Replying in ${c.title ?? "a chat"}`,
		detail: "running",
		action: () => props.onOpenConversation(c.id),
	}));
	const activeRows: Row[] = delegations
		.filter((d) => ACTIVE.includes(d.status))
		.map((d) => ({
			key: `delegation:${d.id}`,
			at: at(d.createdAt),
			label: `${d.harness}: ${oneLine(d.task)}`,
			detail: d.status.replace("_", " "),
			action: openDelegation(d),
		}))
		.sort((a, b) => b.at - a.at);
	const finishedRows: Row[] = [
		...delegations
			.filter((d) => FINISHED.includes(d.status))
			.map((d) => ({
				key: `finished:${d.id}`,
				at: at(d.finishedAt ?? d.createdAt),
				label: `${d.harness}: ${oneLine(d.task)}`,
				detail: `${d.status} · ${relTime(d.finishedAt ?? d.createdAt)}`,
				action: openDelegation(d),
			})),
		...(data.programs ?? [])
			.filter((p) => p.lastRun !== null)
			.map((p) => ({
				key: `program:${p.id}`,
				at: at(p.lastRun),
				label: `Ran ${p.name}`,
				detail: relTime(p.lastRun),
			})),
	].sort((a, b) => b.at - a.at);
	const otherBusy = data.activity?.otherBusy ?? 0;
	const running = [...busyRows, ...activeRows].slice(0, ACTIVITY_ROWS - (otherBusy > 0 ? 1 : 0));
	const finished = finishedRows.slice(
		0,
		Math.max(0, ACTIVITY_ROWS - running.length - (otherBusy > 0 ? 1 : 0)),
	);

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
						{running.map((row) => (
							<PanelRow key={row.key} row={row} />
						))}
						{otherBusy > 0 && (
							<PanelRow
								row={{
									key: "other",
									at: 0,
									label: `Working in ${otherBusy} other ${otherBusy === 1 ? "chat" : "chats"}`,
									detail: "outside the app",
								}}
							/>
						)}
						{finished.map((row) => (
							<PanelRow key={row.key} row={row} />
						))}
						{running.length === 0 && otherBusy === 0 && finished.length === 0 && (
							<p className="empty">Nothing running.</p>
						)}
					</div>
					<button
						type="button"
						className="goblin-panel-footer"
						onClick={() => props.onOpenPage("delegations")}
					>
						All delegations
					</button>
				</TabsPanel>
				<TabsPanel value="scheduled">
					<div className="goblin-panel-rows">
						{scheduled.map((p) => (
							<PanelRow
								key={p.id}
								row={{
									key: String(p.id),
									at: 0,
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
									at: 0,
									label: oneLine(n.title) || "Untitled note",
									detail: `note · ${relTime(n.updatedAt)}`,
									action: () => props.onOpenNote(n.id),
								}}
							/>
						))}
						{notes.length === 0 && <p className="empty">No notes yet.</p>}
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

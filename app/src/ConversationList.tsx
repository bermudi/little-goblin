"use client";

import { createParts } from "@ui-sdk/react/primitive";
import { bindHold } from "@ui-sdk/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
	Drawer,
	DrawerBackdrop,
	DrawerContent,
	DrawerTitle,
} from "@ui-sdk/react/drawer";
import { Toolbar, ToolbarButton } from "@ui-sdk/react/toolbar";
import type { AppConversationList } from "../../src/http/app-wire.ts";
import { ConversationTitleEditor } from "./ConversationTitleEditor.tsx";
import { GoblinAvatar } from "./GoblinAvatar.tsx";
import { conversationActions } from "./conversationActions.ts";
import { flatLine, flatTitle } from "./flatText.ts";
import {
	ArchiveGlyph,
	MoveToProjectGlyph,
	PencilGlyph,
	PinActionGlyph,
	PinGlyph,
	TrashGlyph,
	UnarchiveGlyph,
	UnpinGlyph,
} from "./glyphs.tsx";
import { conversationNavigationPrimitive } from "./conversationNavigation.ts";

const navigationParts = createParts(conversationNavigationPrimitive, { root: "ul", link: "a" });
export const ConversationNav = navigationParts.Root;
export const ConversationNavLink = navigationParts.Link;

type ConversationSummary = AppConversationList["conversations"][number];

export function ConversationHierarchy({
	conversations,
	renderItem,
}: {
	conversations: ConversationSummary[];
	renderItem: (conversation: ConversationSummary, orphaned: boolean) => ReactNode;
}) {
	const ids = new Set(conversations.map((conversation) => conversation.id));
	const children = new Map<string, ConversationSummary[]>();
	for (const conversation of conversations) {
		if (conversation.parentId === null || !ids.has(conversation.parentId)) continue;
		const siblings = children.get(conversation.parentId) ?? [];
		siblings.push(conversation);
		children.set(conversation.parentId, siblings);
	}
	const renderTree = (conversation: ConversationSummary, ancestry: ReadonlySet<string>): ReactNode => {
		const nextAncestry = new Set(ancestry).add(conversation.id);
		const nested = (children.get(conversation.id) ?? []).filter(
			(child) => !nextAncestry.has(child.id),
		);
		return (
			<li key={conversation.id}>
				{renderItem(
					conversation,
					conversation.parentId !== null && !ids.has(conversation.parentId),
				)}
				{nested.length > 0 && (
					<ul className="conversation-children">
						{nested.map((child) => renderTree(child, nextAncestry))}
					</ul>
				)}
			</li>
		);
	};
	return conversations
		.filter((conversation) => conversation.parentId === null || !ids.has(conversation.parentId))
		.map((conversation) => renderTree(conversation, new Set()));
}

export function RollingRow({
	current,
	preview,
	updatedAt,
	working,
	onOpen,
}: {
	current: boolean;
	preview: string | null;
	updatedAt: string | null;
	working: boolean;
	onOpen: () => void;
}) {
	const line = flatLine(preview ?? "");
	return (
		<li className="rolling-row-item">
			<div className={`conv rolling-row${current ? " current" : ""}${line ? "" : " bare"}`}>
				<a
					className="conv-main"
					href="/app/rolling"
					aria-current={current ? "page" : undefined}
					onClick={(event) => {
						if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
							return;
						event.preventDefault();
						onOpen();
					}}
				>
					<GoblinAvatar size="md" working={working} />
					<span className="conv-head">
						<span className="conv-title">Goblin</span>
						{updatedAt !== null && <span className="conv-time">{relTime(updatedAt)}</span>}
					</span>
					<span className="conv-preview">{line || "Always here"}</span>
				</a>
			</div>
		</li>
	);
}

// The Open WebUI chat-list relative-time format.
export function relTime(iso: string): string {
	const ts = Date.parse(iso);
	if (Number.isNaN(ts)) return "";
	const diffSec = Math.floor((Date.now() - ts) / 1000);
	if (diffSec < 60) return "now";
	const diffMin = Math.floor(diffSec / 60);
	if (diffMin < 60) return `${diffMin}m`;
	const diffHr = Math.floor(diffMin / 60);
	if (diffHr < 24) return `${diffHr}h`;
	const diffDay = Math.floor(diffHr / 24);
	if (diffDay < 7) return `${diffDay}d`;
	return new Date(ts).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	});
}

// Archive and delete both skip the confirm: each raises an Undo toast
// instead (delete is held back for that window — see the App's
// deleteConversationHeld).
export function ConversationRow({
	conv,
	current,
	onOpen,
	onRenamed,
	onToggleArchived,
	onTogglePinned,
	onDelete,
	onError,
	moveTargets,
	onMove,
	onMoveToNewProject,
	token,
	orphaned = false,
	projectName,
}: {
	conv: AppConversationList["conversations"][number];
	current: string | null;
	onOpen: (id: string) => void;
	onRenamed: () => void;
	onToggleArchived: (id: string, archived: boolean) => void;
	onTogglePinned: (id: string, pinned: boolean) => void;
	onDelete: (conv: AppConversationList["conversations"][number]) => void;
	onError: (message: string) => void;
	moveTargets: { id: string; name: string }[];
	onMove: (conversationId: string, projectId: string) => void;
	onMoveToNewProject: (conversationId: string) => void;
	token: string | null;
	orphaned?: boolean;
	projectName?: string | undefined;
}) {
	const title = flatTitle(conv.title);
	const preview = flatLine(conv.preview);
	const archived = conv.archivedAt !== null;
	const pinned = conv.pinnedAt !== null;
	const [editing, setEditing] = useState(false);
	const [sheetOpen, setSheetOpen] = useState(false);
	const [sheetStep, setSheetStep] = useState<"actions" | "move">("actions");
	const firstSheetActionRef = useRef<HTMLButtonElement>(null);
	const moveActionRef = useRef<HTMLButtonElement>(null);
	const returningFromMove = useRef(false);
	const canMove = conv.projectId === null && conv.parentId === null && !archived;
	const linkRef = useRef<HTMLAnchorElement>(null);
	useEffect(() => {
		if (sheetOpen) {
			(returningFromMove.current ? moveActionRef.current : firstSheetActionRef.current)?.focus();
			returningFromMove.current = false;
		}
	}, [sheetOpen, sheetStep]);
	useEffect(() => {
		const link = linkRef.current;
		if (link === null) return;
		return bindHold(link, {
			keys: [],
			onPress: ({ input }) => input === "touch",
			onHold: () => {
				returningFromMove.current = false;
				setSheetStep("actions");
				setSheetOpen(true);
			},
		});
	}, [editing]);
	const actions = conversationActions(conv, {
		token,
		onToggleArchived,
		onTogglePinned,
		onDelete,
		onError,
	});
	const startRename = () => setEditing(true);
	const name = title ?? (preview || "new conversation");

	if (editing) {
		return (
			<div className="conv editing">
				<ConversationTitleEditor
					conv={conv}
					token={token}
					onRenamed={onRenamed}
					onError={onError}
					onClose={() => setEditing(false)}
				/>
			</div>
		);
	}
	const items = archived
		? [
				{ label: "Rename", icon: <PencilGlyph />, run: startRename },
				{ label: "Unarchive", icon: <UnarchiveGlyph />, run: () => void actions.toggleArchived() },
				{ label: "Delete", icon: <TrashGlyph />, run: actions.remove },
			]
		: [
				{
					label: pinned ? "Unpin" : "Pin",
					icon: pinned ? <UnpinGlyph /> : <PinActionGlyph />,
					run: () => void actions.togglePinned(),
				},
				{ label: "Rename", icon: <PencilGlyph />, run: startRename },
				{ label: "Archive", icon: <ArchiveGlyph />, run: () => void actions.toggleArchived() },
			];
	const hasPreviewLine = title !== null && preview !== "";
	const rowClass = ["conv", conv.id === current ? "current" : null, hasPreviewLine ? null : "bare"]
		.filter((c): c is string => c !== null)
		.join(" ");
	return (
		<div className={rowClass}>
			<ConversationNavLink
				ref={linkRef}
				id={conv.id}
				className="conv-main"
				href={`/app/c/${conv.id.slice("app/".length)}`}
				onClick={(e) => {
					if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
					e.preventDefault();
					onOpen(conv.id);
				}}
			>
				<span className="conv-head">
					{pinned && <PinGlyph />}
					<span className="conv-title">
						{title ?? (preview === "" ? "new conversation" : preview)}
					</span>
					{projectName !== undefined && <span className="conv-project">{projectName}</span>}
					{orphaned && <span className="conv-subagent-label">subagent</span>}
					<span className="conv-time">{relTime(conv.updatedAt)}</span>
				</span>
				{hasPreviewLine && <span className="conv-preview">{preview}</span>}
			</ConversationNavLink>
			<Toolbar className="conv-actions" aria-label={`Actions for ${name}`}>
				{items.map((item) => (
					<ToolbarButton
						key={item.label}
						title={item.label}
						aria-label={item.label}
						onClick={item.run}
					>
						{item.icon}
					</ToolbarButton>
				))}
			</Toolbar>
			{sheetOpen && (
				<Drawer open={sheetOpen} onOpenChange={setSheetOpen} modal side="bottom">
					<DrawerBackdrop className="row-sheet-backdrop" />
					<DrawerContent className="row-sheet">
						<div className="row-sheet-grip" aria-hidden="true" />
						<DrawerTitle className="row-sheet-title">{name}</DrawerTitle>
						{sheetStep === "actions" ? (
							<>
								{items.slice(0, 2).map((item, index) => (
									<button
										key={item.label}
										ref={index === 0 ? firstSheetActionRef : undefined}
										type="button"
										className="row-sheet-action"
										onClick={() => {
											setSheetOpen(false);
											item.run();
										}}
									>
										{item.icon}<span>{item.label}</span>
									</button>
								))}
								{canMove && (
									<button
										ref={moveActionRef}
										type="button"
										className="row-sheet-action"
										onClick={() => setSheetStep("move")}
									>
										<MoveToProjectGlyph />
										<span>Move to project</span>
									</button>
								)}
								{items.slice(2).map((item) => (
									<button
										key={item.label}
										type="button"
										className="row-sheet-action"
										onClick={() => {
											setSheetOpen(false);
											item.run();
										}}
									>
										{item.icon}<span>{item.label}</span>
									</button>
								))}
							</>
						) : (
							<>
								<button
									ref={firstSheetActionRef}
									type="button"
									className="row-sheet-action"
									onClick={() => {
										returningFromMove.current = true;
										setSheetStep("actions");
									}}
								>
									<span>Back</span>
								</button>
								{moveTargets.map((project) => (
									<button
										key={project.id}
										type="button"
										className="row-sheet-action"
										onClick={() => {
											setSheetOpen(false);
											onMove(conv.id, project.id);
										}}
									>
										<span>{project.name}</span>
									</button>
								))}
								<button
									type="button"
									className="row-sheet-action"
									onClick={() => {
										setSheetOpen(false);
										onMoveToNewProject(conv.id);
									}}
								>
									<span>New project…</span>
								</button>
							</>
						)}
					</DrawerContent>
				</Drawer>
			)}
		</div>
	);
}

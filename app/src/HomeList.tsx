import { useState, type ReactNode, type Ref } from "react";
import type { AppAttentionTarget, AppConversationList } from "../../src/http/app-wire.ts";
import { ChatMark } from "./ChatMark.tsx";
import { BotAvatar } from "./BotAvatar.tsx";
import { ConversationNav, ConversationNavLink, relTime, RollingRow } from "./ConversationList.tsx";
import {
	buildHome,
	mostUrgentChat,
	rankOf,
	type ChatRow,
	type HomeInput,
	type HomeList as HomeListModel,
	type Hold,
	type Mark,
} from "./homeList.ts";
import { flatLine, flatTitle } from "./flatText.ts";
import { NewProjectGlyph } from "./glyphs.tsx";
import { pathOfRoute } from "./routing.ts";

export interface RowOptions {
	mark?: Mark | null;
	line?: string;
	projectName?: string;
}

export type RenderRow = (
	conv: AppConversationList["conversations"][number],
	options?: RowOptions,
) => ReactNode;

const SIDE_CHAT_PAGE_ROWS = 5;

interface SideChatPage {
	rows: ChatRow[];
	hidden: number;
	showMore: () => void;
}

export interface Home {
	list: HomeListModel;
	orderSignature: string;
	sidePage: SideChatPage;
}

interface ProjectLink {
	id: string;
	name: string;
}

export function useHomeList(
	input: HomeInput,
	projects: readonly ProjectLink[],
	projectsOpen: boolean,
	expandedBotId: string | null,
): Home {
	const [hold, setHold] = useState<Hold | null>(null);
	const [sideRowLimit, setSideRowLimit] = useState(SIDE_CHAT_PAGE_ROWS);
	const built = buildHome(input, hold);
	if (built.hold !== hold) setHold(built.hold);

	const { active, side, bots } = built.list;
	const pagedSide = pageSideChats(side, sideRowLimit, input.open);
	const orderSignature = JSON.stringify([
		active.map((row) => row.id),
		projectsOpen ? projects.map((project) => project.id) : [],
		input.sideChatsOpen ? pagedSide.rows.map((row) => row.id) : [],
		bots.map(({ bot, side }) => [bot.id, ...(bot.id === expandedBotId ? side.map((row) => row.id) : [])]),
	]);

	return {
		list: built.list,
		orderSignature,
		sidePage: {
			...pagedSide,
			showMore: () => setSideRowLimit((limit) => limit + SIDE_CHAT_PAGE_ROWS),
		},
	};
}

function pageSideChats(
	rows: readonly ChatRow[],
	limit: number,
	open: string | null,
): { rows: ChatRow[]; hidden: number } {
	const base = new Set(rows.slice(0, limit).map((row) => row.id));
	const visible = rows.filter((row) =>
		base.has(row.id) || row.mark !== null || row.conv.pinnedAt !== null || row.id === open
	);
	return { rows: visible, hidden: rows.length - visible.length };
}

export function HomeList({
	home,
	projects,
	projectsOpen,
	currentFolderId,
	currentConversationId,
	expandedBotId,
	rollingCurrent,
	sideChatsOpen,
	onToggleProjects,
	onToggleSideChats,
	onNewSideChat,
	onNewProject,
	onOpenProject,
	onOpenTarget,
	onOpenRolling,
	onOpenConversation,
	onToggleBotSideChats,
	renderRow,
	navRef,
}: {
	home: Home;
	projects: readonly ProjectLink[];
	projectsOpen: boolean;
	currentFolderId: string | null;
	currentConversationId: string | null;
	expandedBotId: string | null;
	rollingCurrent: boolean;
	sideChatsOpen: boolean;
	onToggleProjects: () => void;
	onToggleSideChats: () => void;
	onNewSideChat: () => void;
	onNewProject: () => void;
	onOpenProject: (id: string) => void;
	onOpenTarget: (target: AppAttentionTarget) => void;
	onOpenRolling: () => void;
	onOpenConversation: (id: string) => void;
	onToggleBotSideChats: (id: string) => void;
	renderRow: RenderRow;
	navRef?: Ref<HTMLUListElement>;
}) {
	const { rolling, active, bots } = home.list;
	const { sidePage } = home;
	return (
		<ConversationNav ref={navRef} loop={false}>
			<RollingRow
				current={rollingCurrent}
				line={rolling.line}
				updatedAt={rolling.updatedAt}
				mark={rolling.mark}
				sideChatsOpen={sideChatsOpen}
				onToggleSideChats={onToggleSideChats}
				onOpen={onOpenRolling}
			/>
			{sideChatsOpen && sidePage.rows.map((row) => (
				<li key={row.id} data-flip={row.id} className="side-chat">
					{renderRow(row.conv, { mark: row.mark, line: row.line })}
				</li>
			))}
			{sideChatsOpen && sidePage.hidden > 0 && (
				<li className="side-chat side-chat-more">
					<button type="button" onClick={sidePage.showMore}>Show more ({sidePage.hidden} left)</button>
				</li>
			)}
			{sideChatsOpen && (
				<li className="side-chat new-side-chat">
					<button type="button" onClick={onNewSideChat}>New side chat</button>
				</li>
			)}
			{bots.length > 0 && <li className="rail-chats-label">Bots</li>}
			{bots.map(({ bot, main, side }) => {
				const open = bot.id === expandedBotId;
				const markedSide = open ? undefined : mostUrgentChat(side);
				const display = markedSide?.mark != null &&
					(main.mark === null || rankOf(markedSide.mark) < rankOf(main.mark))
					? markedSide : main;
				const current = currentConversationId === main.id;
				return (
					<BotListRows
						key={bot.id}
						name={bot.name}
						main={main}
						mark={display.mark}
						line={display.line}
						current={current}
						side={side}
						expanded={open}
						onToggleSideChats={() => onToggleBotSideChats(bot.id)}
						onOpen={() => onOpenConversation(main.id)}
						renderRow={renderRow}
					/>
				);
			})}
			{active.length > 0 && <li className="rail-chats-label">Active</li>}
			{active.map((row) => row.kind === "chat"
				? <ChatListItem key={row.id} row={row} renderRow={renderRow} />
				: <LooseListItem key={row.id} row={row} onOpenTarget={onOpenTarget} />)}
			<li className="rail-project-head">
				<button
					type="button"
					className="rail-section-toggle"
					aria-expanded={projectsOpen}
					onClick={onToggleProjects}
				>
					<ChevronGlyph />
					Projects
				</button>
				<button
					type="button"
					aria-label="New project"
					onClick={onNewProject}
				>
					<NewProjectGlyph />
				</button>
			</li>
			{projectsOpen && projects.map((project) => (
				<li
					key={project.id}
					data-flip={`project:${project.id}`}
					className={`conv rail-project${currentFolderId === project.id ? " current" : ""}`}
				>
					<a
						className="conv-main rail-project-main"
						href={`/app/p/${project.id}`}
						aria-current={currentFolderId === project.id ? "page" : undefined}
						onClick={(event) => {
							if (
								event.metaKey ||
								event.ctrlKey ||
								event.shiftKey ||
								event.altKey ||
								event.button !== 0
							) return;
							event.preventDefault();
							onOpenProject(project.id);
						}}
					>
						<span className="conv-gutter"><ChevronGlyph /></span>
						<span className="conv-copy">
							<span className="conv-head">
								<span className="conv-title">{project.name}</span>
							</span>
						</span>
					</a>
				</li>
			))}
		</ConversationNav>
	);
}

function BotListRows({ name, main, mark, line, current, side, expanded, onToggleSideChats, onOpen, renderRow }: {
	name: string;
	main: ChatRow;
	mark: Mark | null;
	line: string;
	current: boolean;
	side: ChatRow[];
	expanded: boolean;
	onToggleSideChats: () => void;
	onOpen: () => void;
	renderRow: RenderRow;
}) {
	return (
		<>
			<li data-flip={main.id}>
				<div className={`conv bot-row${current ? " current" : ""}`} data-mark={mark ?? undefined}>
					<ConversationNavLink
						id={main.id}
						className="conv-main"
						href={pathOfRoute({ kind: "conversation", id: main.id })}
						aria-current={current ? "page" : undefined}
						onClick={(event) => {
							if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
								return;
							event.preventDefault();
							onOpen();
						}}
					>
						<BotAvatar name={name} />
						<span className="conv-copy">
							<span className="conv-head">
								<span className="conv-title">{name}</span>
								{mark !== null && <span className="conv-mark"><ChatMark mark={mark} /></span>}
								<span className="conv-time">{relTime(main.conv.updatedAt)}</span>
							</span>
							{line !== "" && <span className="conv-preview">{flatLine(line)}</span>}
						</span>
					</ConversationNavLink>
					{side.length > 0 && (
						<button
							type="button"
							className={`rolling-disclosure${expanded ? " open" : ""}`}
							aria-expanded={expanded}
							aria-label={`Side chats for ${name}`}
							onClick={onToggleSideChats}
						>
							<ChevronGlyph />
						</button>
					)}
				</div>
			</li>
			{expanded && side.map((row) => (
				<li key={row.id} data-flip={row.id} className="side-chat">
					{renderRow(row.conv, { mark: row.mark, line: row.line })}
				</li>
			))}
		</>
	);
}

function ChatListItem({
	row,
	renderRow,
}: {
	row: ChatRow;
	renderRow: RenderRow;
}) {
	return (
		<li data-flip={row.id}>
			{renderRow(row.conv, {
				mark: row.mark,
				line: row.line,
				...(row.projectName === undefined ? {} : { projectName: row.projectName }),
			})}
		</li>
	);
}

function LooseListItem({
	row,
	onOpenTarget,
}: {
	row: Extract<HomeListModel["active"][number], { kind: "loose" }>;
	onOpenTarget: (target: AppAttentionTarget) => void;
}) {
	const title = flatTitle(row.item.title) ?? "Approval";
	const line = flatLine(row.line);
	const target = row.item.target;
	const href = pathOfRoute(
		target.kind === "page"
			? { kind: "page", page: target.page }
			: { kind: "conversation", id: target.conversationId },
	);
	return (
		<li data-flip={row.id}>
			<div className={`conv${line === "" ? " bare" : ""}`} data-mark="needs">
				<a
					className="conv-main"
					href={href}
					onClick={(event) => {
						if (
							event.metaKey ||
							event.ctrlKey ||
							event.shiftKey ||
							event.altKey ||
							event.button !== 0
						) return;
						event.preventDefault();
						onOpenTarget(target);
					}}
				>
					<span className="conv-copy">
						<span className="conv-head">
							<span className="conv-title">{title}</span>
							<span className="conv-mark"><ChatMark mark="needs" /></span>
						</span>
						{line !== "" && <span className="conv-preview">{line}</span>}
					</span>
				</a>
			</div>
		</li>
	);
}

function ChevronGlyph() {
	return (
		<svg
			className="chev"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.75"
			strokeLinecap="round"
			strokeLinejoin="round"
			width="12"
			height="12"
			aria-hidden="true"
		>
			<path d="M9 6l6 6-6 6" />
		</svg>
	);
}

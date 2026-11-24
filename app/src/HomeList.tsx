import { useId, useState, type ReactNode, type Ref } from "react";
import type { AppAttentionTarget, AppConversationList } from "../../src/http/app-wire.ts";
import { ChatMark } from "./ChatMark.tsx";
import { ConversationNav, RollingRow } from "./ConversationList.tsx";
import {
	buildHome,
	type ChatRow,
	type HomeInput,
	type HomeList as HomeListModel,
	type Hold,
	type Kid,
	type Mark,
} from "./homeList.ts";
import { flatLine, flatTitle } from "./flatText.ts";
import { NewProjectGlyph } from "./glyphs.tsx";
import { pathOfRoute } from "./routing.ts";

export interface RowOptions {
	mark?: Mark | null;
	line?: string;
	projectName?: string;
	subagent?: boolean;
	compact?: boolean;
}

export type RenderRow = (
	conv: AppConversationList["conversations"][number],
	options?: RowOptions,
) => ReactNode;

export interface Home {
	list: HomeListModel;
	orderSignature: string;
	isExpanded: (id: string, kids: readonly Kid[]) => boolean;
	toggle: (id: string, kids: readonly Kid[]) => void;
}

interface ProjectLink {
	id: string;
	name: string;
}

export function useHomeList(
	input: HomeInput,
	projects: readonly ProjectLink[],
	projectsOpen: boolean,
): Home {
	const [hold, setHold] = useState<Hold | null>(null);
	const [folds, setFolds] = useState<Map<string, boolean>>(() => new Map());
	const built = buildHome(input, hold);
	if (built.hold !== hold) setHold(built.hold);

	const isExpanded = (id: string, kids: readonly Kid[]) =>
		folds.get(id) ?? kids.some((kid) => kid.id === input.open);
	const toggle = (id: string, kids: readonly Kid[]) => {
		const expanded = isExpanded(id, kids);
		setFolds((previous) => new Map(previous).set(id, !expanded));
	};
	const { rolling, active, chats } = built.list;
	const expandedFolds = [
		{ id: "rolling", kids: rolling.kids, showKids: rolling.showKids },
		...active.filter((row) => row.kind === "chat"),
		...chats,
	]
		.filter((row) => row.showKids && isExpanded(row.id, row.kids))
		.map((row) => [row.id, row.kids.map((kid) => kid.id)]);
	const orderSignature = JSON.stringify([
		active.map((row) => row.id),
		projectsOpen ? projects.map((project) => project.id) : [],
		chats.map((row) => row.id),
		expandedFolds,
	]);

	return { list: built.list, orderSignature, isExpanded, toggle };
}

export function HomeList({
	home,
	projects,
	projectsOpen,
	currentFolderId,
	rollingCurrent,
	onToggleProjects,
	onNewProject,
	onOpenProject,
	onOpenTarget,
	onOpenRolling,
	renderRow,
	navRef,
}: {
	home: Home;
	projects: readonly ProjectLink[];
	projectsOpen: boolean;
	currentFolderId: string | null;
	rollingCurrent: boolean;
	onToggleProjects: () => void;
	onNewProject: () => void;
	onOpenProject: (id: string) => void;
	onOpenTarget: (target: AppAttentionTarget) => void;
	onOpenRolling: () => void;
	renderRow: RenderRow;
	navRef?: Ref<HTMLUListElement>;
}) {
	const { rolling, active, chats } = home.list;
	return (
		<ConversationNav ref={navRef} loop={false}>
			<RollingRow
				current={rollingCurrent}
				line={rolling.line}
				updatedAt={rolling.updatedAt}
				mark={rolling.mark}
				onOpen={onOpenRolling}
			/>
			{rolling.showKids && (
				<li>
					<KidFold id="rolling" kids={rolling.kids} home={home} renderRow={renderRow} />
				</li>
			)}
			{active.length > 0 && <li className="rail-chats-label">Active</li>}
			{active.map((row) => row.kind === "chat"
				? <ChatListItem key={row.id} row={row} home={home} renderRow={renderRow} />
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
			<li className="rail-chats-label">Chats</li>
			{chats.map((row) => (
				<ChatListItem key={row.id} row={row} home={home} renderRow={renderRow} />
			))}
		</ConversationNav>
	);
}

function ChatListItem({
	row,
	home,
	renderRow,
}: {
	row: ChatRow;
	home: Home;
	renderRow: RenderRow;
}) {
	return (
		<li data-flip={row.id}>
			{renderRow(row.conv, {
				mark: row.mark,
				line: row.line,
				subagent: row.subagent,
				...(row.projectName === undefined ? {} : { projectName: row.projectName }),
			})}
			{row.showKids && (
				<KidFold id={row.id} kids={row.kids} home={home} renderRow={renderRow} />
			)}
		</li>
	);
}

function KidFold({
	id,
	kids,
	home,
	renderRow,
}: {
	id: string;
	kids: readonly Kid[];
	home: Home;
	renderRow: RenderRow;
}) {
	const listId = useId();
	const expanded = home.isExpanded(id, kids);
	return (
		<div className="home-kids">
			<button
				type="button"
				className="kidtoggle"
				aria-expanded={expanded}
				aria-controls={expanded ? listId : undefined}
				onClick={() => home.toggle(id, kids)}
			>
				<ChevronGlyph />
				{kids.length} {kids.length === 1 ? "subagent" : "subagents"}
			</button>
			{expanded && (
				<ul id={listId} className="home-kid-list">
					{kids.map((kid) => (
						<li key={kid.id} data-flip={kid.id}>
							{renderRow(kid.conv, { mark: kid.mark, compact: true })}
						</li>
					))}
				</ul>
			)}
		</div>
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
					<span className="conv-gutter"><ChatMark mark="needs" /></span>
					<span className="conv-copy">
						<span className="conv-head">
							<span className="conv-title">{title}</span>
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

import { useState, type ReactNode, type Ref } from "react";
import type { AppAttentionTarget, AppConversationList } from "../../src/http/app-wire.ts";
import { ChatMark } from "./ChatMark.tsx";
import { ConversationNav, RollingRow } from "./ConversationList.tsx";
import {
	buildHome,
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

export interface Home {
	list: HomeListModel;
	orderSignature: string;
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
	const built = buildHome(input, hold);
	if (built.hold !== hold) setHold(built.hold);

	const { active, chats } = built.list;
	const orderSignature = JSON.stringify([
		active.map((row) => row.id),
		projectsOpen ? projects.map((project) => project.id) : [],
		chats.map((row) => row.id),
	]);

	return { list: built.list, orderSignature };
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
			<li className="rail-chats-label">Chats</li>
			{chats.map((row) => (
				<ChatListItem key={row.id} row={row} renderRow={renderRow} />
			))}
		</ConversationNav>
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

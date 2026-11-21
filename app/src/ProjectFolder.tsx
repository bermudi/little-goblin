"use client";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import type { ReactNode } from "react";

export function ProjectFolder({
	project,
	open,
	onOpenChange,
	current,
	onNewChat,
	children,
	empty,
}: {
	project: { id: string; name: string };
	open: boolean;
	onOpenChange: (open: boolean) => void;
	current: boolean;
	onNewChat: () => void;
	children: ReactNode;
	empty: boolean;
}) {
	return (
		<li className="proj-folder">
			<Collapsible open={open} onOpenChange={onOpenChange}>
				<div className={current ? "folder-head current" : "folder-head"}>
					<CollapsibleTrigger className="folder-toggle">
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
						<span className="folder-name">{project.name}</span>
					</CollapsibleTrigger>
					<span className="conv-actions folder-actions">
						<button
							type="button"
							title={`New chat in ${project.name}`}
							aria-label={`New chat in ${project.name}`}
							onClick={onNewChat}
						>
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="12" height="12" aria-hidden="true">
								<path d="M12 5v14M5 12h14" />
							</svg>
						</button>
					</span>
				</div>
				<CollapsiblePanel>
					{empty ? (
						<p className="empty folder-empty">No chats yet</p>
					) : (
						<ul className="conversation-children folder-chats">{children}</ul>
					)}
				</CollapsiblePanel>
			</Collapsible>
		</li>
	);
}

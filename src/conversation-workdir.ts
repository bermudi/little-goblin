import { statSync } from "node:fs";
import { promptHasProject, WORKDIR_SOURCE } from "./agent/prompt.ts";
import type { Conversation } from "./conversation-read.ts";
import type { ConversationStore } from "./conversation.ts";
import { paths } from "./home-layout.ts";
import { projectWorkdir, type ProjectStore } from "./projects.ts";

export function bashDeclarationWorkdir(
	workdir: string,
	snapshot: ReturnType<ConversationStore["promptSnapshot"]>,
): string {
	return snapshot === null || promptHasProject(snapshot) ||
		snapshot.sources.some((source) => source.startsWith(WORKDIR_SOURCE)) ? workdir : paths.workspace();
}

export function conversationWorkdir(
	store: Pick<ConversationStore, "fixedWorkdir" | "bots" | "promptSnapshot">,
	projects: Pick<ProjectStore, "get">,
	conv: Conversation,
	snapshot = store.promptSnapshot(conv.id),
): string {
	if (conv.projectId !== null) return projectWorkdir(projects, conv);
	const saved = snapshot?.sources.find((source) => source.startsWith(WORKDIR_SOURCE));
	const membership = snapshot === null ? store.bots.membership(conv.id) : null;
	const folder = membership === null ? null : store.bots.get(membership.botId)?.folder;
	const dir = saved?.slice(WORKDIR_SOURCE.length) ?? store.fixedWorkdir(conv.id) ?? folder;
	if (dir == null || dir === paths.workspace()) return paths.workspace();
	try {
		if (!statSync(dir).isDirectory()) throw new Error("not a directory");
	} catch (error) {
		throw new Error(`Conversation ${conv.id} working directory is not available: ${dir}`, { cause: error });
	}
	return dir;
}

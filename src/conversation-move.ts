import { randomUUID } from "node:crypto";
import { channelOf } from "./conversation-address.ts";
import type { ConversationStore } from "./conversation.ts";
import type { Conversation } from "./conversation-read.ts";
import { log } from "./log.ts";
import type { NoteStore } from "./notes.ts";
import type { ProjectStore } from "./projects.ts";
import { projectMoveNotice } from "./agent/prompt.ts";
import type { Runtime } from "./runtime.ts";

export type MoveOutcome =
	| { kind: "moved"; conv: Conversation }
	| { kind: "unchanged"; conv: Conversation }
	| { kind: "notFound" }
	| { kind: "noProject" }
	| { kind: "projectArchived" }
	| { kind: "alreadyBound"; projectId: string }
	| { kind: "busy" }
	| { kind: "notApp" }
	| { kind: "child" }
	| { kind: "rolling" };

export function moveIntoProject(
	deps: {
		store: Pick<
			ConversationStore,
			"db" | "get" | "bindProject" | "setMeta" | "append" | "memoryQueue" | "isAppRoll"
		>;
		projects: Pick<ProjectStore, "get">;
		runtime: Pick<Runtime, "busy">;
		notes: Pick<NoteStore, "index">;
		workspace: string;
	},
	conversationId: string,
	projectId: string,
): MoveOutcome {
	const conv = deps.store.get(conversationId);
	if (conv === null) return refused("notFound");
	if (channelOf(conv.id) !== "app") return refused("notApp");
	if (conv.parentId !== null) return refused("child");
	if (deps.store.isAppRoll(conv.id)) return refused("rolling");
	const project = deps.projects.get(projectId);
	if (project === null) return refused("noProject");
	if (project.archivedAt !== null) return refused("projectArchived");
	if (conv.projectId === projectId) {
		log.info("conversation move unchanged", { conversation: conv.id, project: projectId });
		return { kind: "unchanged", conv };
	}
	if (conv.projectId !== null) return refused("alreadyBound", conv.projectId);
	if (deps.runtime.busy(conv.id)) return refused("busy");

	const moved = deps.store.db.transaction(() => {
		deps.store.bindProject(conv.id, project.id);
		if (project.memory === "off") {
			deps.store.setMeta(conv.id, {
				memoryExcluded: true,
				memoryExcludedByProject: true,
			});
			deps.store.memoryQueue.cancelConversation(conv.id);
		}
		const text = projectMoveNotice(project, deps.notes.index(project.id), deps.workspace);
		deps.store.append(
			conv.id,
			[{ id: randomUUID(), role: "user", parts: [{ type: "text", text }] }],
			{ ...(project.memory === "off" ? { exclude: true } : {}) },
		);
		const current = deps.store.get(conv.id);
		if (current === null) throw new Error(`conversation ${conv.id} disappeared during project move`);
		return current;
	})();
	log.info("conversation moved into project", {
		conversation: moved.id,
		project: project.id,
		dir: project.dir,
		memoryExcluded: moved.memoryExcluded,
	});
	return { kind: "moved", conv: moved };

	function refused(kind: "notFound" | "noProject" | "projectArchived" | "busy" | "notApp" | "child" | "rolling"): MoveOutcome;
	function refused(kind: "alreadyBound", boundProjectId: string): MoveOutcome;
	function refused(
		kind: "notFound" | "noProject" | "projectArchived" | "busy" | "notApp" | "child" | "rolling" | "alreadyBound",
		boundProjectId?: string,
	): MoveOutcome {
		log.info("conversation move refused", {
			conversation: conversationId,
			project: projectId,
			reason: kind,
		});
		return kind === "alreadyBound"
			? { kind, projectId: boundProjectId! }
			: { kind };
	}
}

/**
 * /project command logic.
 *
 * Assigns a canonical project environment to the current Surface once. The
 * operation is immutable: a different project or `/project none` are rejected.
 * First assignment creates a fresh project Conversation, leaves any prior
 * personal Conversation stored and resumable, and disposes the prior runner.
 */

import { parseCommandArg } from "./parse.ts";
import { resolveProjectRoot } from "../sessions/environment.ts";
import type { ProjectAssignmentResult } from "../orchestration/conversation-lifecycle.ts";
import type { ConversationState } from "../sessions/types.ts";

export interface ProjectCommandDeps {
  /** The raw command text, e.g. "/project ~/foo". */
  rawText: string;
  /** Performs the durable first project assignment and returns the result. */
  assignProject: (canonicalRoot: string) => Promise<ProjectAssignmentResult>;
}

export type ProjectCommandResult =
  | { kind: "missing-arg"; reply: string }
  | { kind: "bad-path"; reply: string }
  | { kind: "assigned"; reply: string; projectRoot: string; conversationId: string; conversation: ConversationState; previousConversationId?: string }
  | { kind: "already-assigned"; reply: string; projectRoot: string; conversationId?: string; conversation?: ConversationState }
  | { kind: "conflict"; reply: string }
  | { kind: "rejected"; reply: string }
  | { kind: "error"; reply: string };

export const MISSING_ARG_REPLY = "Usage: `/project <path>`.";
export const BAD_PATH_REPLY = "Path does not exist or is not an accessible directory.";

export async function executeProject(deps: ProjectCommandDeps): Promise<ProjectCommandResult> {
  const arg = parseCommandArg(deps.rawText).trim();
  if (arg === "") {
    return { kind: "missing-arg", reply: MISSING_ARG_REPLY };
  }

  if (arg.toLowerCase() === "none" || arg.toLowerCase() === "clear") {
    return {
      kind: "rejected",
      reply:
        "Project assignment is one-time and cannot be cleared. Use `/new` within this chat to start a fresh Conversation, or use another chat/topic for a different project.",
    };
  }

  let projectRoot: string;
  try {
    projectRoot = resolveProjectRoot(arg);
  } catch {
    return { kind: "bad-path", reply: BAD_PATH_REPLY };
  }

  try {
    const result = await deps.assignProject(projectRoot);
    switch (result.kind) {
      case "assigned":
        return {
          kind: "assigned",
          projectRoot,
          conversationId: result.conversation.id,
          conversation: result.conversation,
          previousConversationId: result.previousConversationId,
          reply: result.previousConversationId
            ? `Project assigned to \`${projectRoot}\`. New conversation \`${result.conversation.id}\`; previous conversation \`${result.previousConversationId}\` is stored and resumable.`
            : `Project assigned to \`${projectRoot}\`. Conversation \`${result.conversation.id}\` is ready.`,
        };
      case "already-assigned":
        return {
          kind: "already-assigned",
          projectRoot: result.projectRoot ?? projectRoot,
          conversationId: result.conversation?.id,
          conversation: result.conversation,
          reply: `This chat is already assigned to project \`${result.projectRoot ?? projectRoot}\`.`,
        };
      case "conflict":
        return {
          kind: "conflict",
          reply: `Project assignment is one-time. This chat is already assigned to \`${result.currentRoot}\`. Use another chat or topic for a different project.`,
        };
      default:
        return { kind: "error", reply: "Unknown assignment result." };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: "error", reply: `Project assignment failed: ${msg}` };
  }
}

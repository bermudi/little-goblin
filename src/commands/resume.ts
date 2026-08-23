import type { ConversationState } from "../sessions/types.ts";

export interface ResumeCommandDeps {
  rawText: string;
  /** Conversations compatible with the invoking Surface's execution environment. */
  conversations: ConversationState[];
  /** Conversations that exist but are incompatible with the invoking Surface. */
  incompatibleConversations?: ConversationState[];
  bindConversation: (conversationId: string) => ConversationState | Promise<ConversationState>;
}

export type ResumeCommandResult =
  | { kind: "list"; reply: string }
  | { kind: "not-found"; reply: string }
  | { kind: "ambiguous"; reply: string }
  | { kind: "incompatible"; conversation: ConversationState; reply: string }
  | { kind: "resumed"; conversation: ConversationState; reply: string };

export type ResumeSelectionResult =
  | Exclude<ResumeCommandResult, { kind: "resumed" }>
  | { kind: "selected"; conversation: ConversationState };

export const NO_NAMED_SESSIONS_REPLY = "No named conversations yet. Use /name <conversation name> in an active conversation to name it.";

export function parseResumeTarget(rawText: string): string | undefined {
  const value = rawText.replace(/^\/resume(?:@\S+)?(?:\s+)?/u, "").trim();
  return value === "" ? undefined : value;
}

function matchesTarget(session: ConversationState, target: string): boolean {
  return session.id === target || session.id.startsWith(target) || session.title === target;
}

function formatSessionLine(session: ConversationState): string {
  return `- ${session.id}${session.title ? ` — ${session.title}` : ""}`;
}

export function formatNamedSessionsList(sessions: ConversationState[]): string {
  const named = sessions.filter((session) => session.title !== undefined && session.title.trim() !== "");
  if (named.length === 0) return NO_NAMED_SESSIONS_REPLY;
  return `Named conversations:\n${named.map(formatSessionLine).join("\n")}`;
}

function formatIncompatibleReply(session: ConversationState): string {
  const title = session.title ? ` — ${session.title}` : "";
  return `Conversation \`${session.id}\`${title} cannot be resumed on this surface: its execution environment is incompatible.`;
}

export function selectResumeConversation(
  deps: Pick<ResumeCommandDeps, "rawText" | "conversations" | "incompatibleConversations">,
): ResumeSelectionResult {
  const target = parseResumeTarget(deps.rawText);
  if (!target) return { kind: "list", reply: formatNamedSessionsList(deps.conversations) };

  const compatible = deps.conversations.filter((conversation) => matchesTarget(conversation, target));
  const incompatible = (deps.incompatibleConversations ?? []).filter((conversation) => matchesTarget(conversation, target));

  if (compatible.length === 0 && incompatible.length === 0) {
    return { kind: "not-found", reply: `No conversation found for \`${target}\`.` };
  }

  if (compatible.length + incompatible.length > 1) {
    const list = [...compatible, ...incompatible].map(formatSessionLine).join("\n");
    return { kind: "ambiguous", reply: `Multiple conversations match \`${target}\`:\n${list}` };
  }

  if (incompatible.length === 1) {
    const [session] = incompatible;
    return { kind: "incompatible", conversation: session!, reply: formatIncompatibleReply(session!) };
  }

  const [match] = compatible;
  return { kind: "selected", conversation: match! };
}

export async function executeResume(deps: ResumeCommandDeps): Promise<ResumeCommandResult> {
  const selection = selectResumeConversation(deps);
  if (selection.kind !== "selected") return selection;

  const conversation = await deps.bindConversation(selection.conversation.id);
  return {
    kind: "resumed",
    conversation,
    reply: `Resumed conversation \`${conversation.id}\`${conversation.title ? ` — ${conversation.title}` : ""}`,
  };
}

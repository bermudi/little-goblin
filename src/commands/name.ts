import type { NameTransition } from "../orchestration/conversation-lifecycle.ts";

export interface NameCommandDeps {
  rawText: string;
  /** Lifecycle-owned current-Conversation status and title mutation. */
  setTitle: (title: string | undefined) => Promise<NameTransition>;
}

export type NameCommandResult =
  | { kind: "missing-session"; reply: string }
  | { kind: "usage"; reply: string }
  | { kind: "renamed"; reply: string };

export const NO_ACTIVE_SESSION_TO_NAME_REPLY = "No active conversation to name.";
export const NAME_USAGE_REPLY = "Usage: /name <conversation name>";

export function parseSessionName(rawText: string): string | undefined {
  const value = rawText.replace(/^\/name(?:@\S+)?(?:\s+)?/u, "").trim();
  return value === "" ? undefined : value;
}

export async function executeName(deps: NameCommandDeps): Promise<NameCommandResult> {
  const title = parseSessionName(deps.rawText);
  const transition = await deps.setTitle(title);
  if (transition.kind === "no-session") {
    return { kind: "missing-session", reply: NO_ACTIVE_SESSION_TO_NAME_REPLY };
  }
  if (transition.kind === "missing-title") {
    return { kind: "usage", reply: NAME_USAGE_REPLY };
  }
  return {
    kind: "renamed",
    reply: `Named conversation \`${transition.conversation.id}\`: ${transition.conversation.title}`,
  };
}

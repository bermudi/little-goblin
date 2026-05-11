import type { SessionState } from "../sessions/types.ts";

export interface NameCommandDeps {
  hasSession: boolean;
  rawText: string;
  session: SessionState | null;
  setTitle: (title: string | undefined) => void;
}

export type NameCommandResult =
  | { kind: "missing-session"; reply: string }
  | { kind: "usage"; reply: string }
  | { kind: "renamed"; reply: string };

export const NO_ACTIVE_SESSION_TO_NAME_REPLY = "No active session to name.";
export const NAME_USAGE_REPLY = "Usage: /name <session name>";

export function parseSessionName(rawText: string): string | undefined {
  const value = rawText.replace(/^\/name(?:@\S+)?(?:\s+)?/u, "").trim();
  return value === "" ? undefined : value;
}

export function executeName(deps: NameCommandDeps): NameCommandResult {
  if (!deps.hasSession || !deps.session) {
    return { kind: "missing-session", reply: NO_ACTIVE_SESSION_TO_NAME_REPLY };
  }
  const title = parseSessionName(deps.rawText);
  if (!title) return { kind: "usage", reply: NAME_USAGE_REPLY };
  deps.setTitle(title);
  return { kind: "renamed", reply: `Named session \`${deps.session.id}\`: ${title}` };
}

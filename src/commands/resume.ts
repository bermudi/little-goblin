import type { SessionState } from "../sessions/types.ts";

export interface ResumeCommandDeps {
  rawText: string;
  /** Conversations compatible with the invoking Surface's execution environment. */
  sessions: SessionState[];
  /** Conversations that exist but are incompatible with the invoking Surface. */
  incompatibleSessions?: SessionState[];
  bindSession: (sessionId: string) => SessionState | Promise<SessionState>;
}

export type ResumeCommandResult =
  | { kind: "list"; reply: string }
  | { kind: "not-found"; reply: string }
  | { kind: "ambiguous"; reply: string }
  | { kind: "incompatible"; session: SessionState; reply: string }
  | { kind: "resumed"; session: SessionState; reply: string };

export const NO_NAMED_SESSIONS_REPLY = "No named conversations yet. Use /name <conversation name> in an active conversation to name it.";

export function parseResumeTarget(rawText: string): string | undefined {
  const value = rawText.replace(/^\/resume(?:@\S+)?(?:\s+)?/u, "").trim();
  return value === "" ? undefined : value;
}

function matchesTarget(session: SessionState, target: string): boolean {
  return session.id === target || session.id.startsWith(target) || session.title === target;
}

function formatSessionLine(session: SessionState): string {
  return `- ${session.id}${session.title ? ` — ${session.title}` : ""}`;
}

export function formatNamedSessionsList(sessions: SessionState[]): string {
  const named = sessions.filter((session) => session.title !== undefined && session.title.trim() !== "");
  if (named.length === 0) return NO_NAMED_SESSIONS_REPLY;
  return `Named conversations:\n${named.map(formatSessionLine).join("\n")}`;
}

function formatIncompatibleReply(session: SessionState): string {
  const title = session.title ? ` — ${session.title}` : "";
  return `Conversation \`${session.id}\`${title} cannot be resumed on this surface: its execution environment is incompatible.`;
}

export async function executeResume(deps: ResumeCommandDeps): Promise<ResumeCommandResult> {
  const target = parseResumeTarget(deps.rawText);
  if (!target) return { kind: "list", reply: formatNamedSessionsList(deps.sessions) };

  const compatible = deps.sessions.filter((session) => matchesTarget(session, target));
  const incompatible = (deps.incompatibleSessions ?? []).filter((session) => matchesTarget(session, target));

  if (compatible.length === 0 && incompatible.length === 0) {
    return { kind: "not-found", reply: `No conversation found for \`${target}\`.` };
  }

  if (compatible.length + incompatible.length > 1) {
    const list = [...compatible, ...incompatible].map(formatSessionLine).join("\n");
    return { kind: "ambiguous", reply: `Multiple conversations match \`${target}\`:\n${list}` };
  }

  if (incompatible.length === 1) {
    const [session] = incompatible;
    return { kind: "incompatible", session: session!, reply: formatIncompatibleReply(session!) };
  }

  const [match] = compatible;
  const session = await deps.bindSession(match!.id);
  return {
    kind: "resumed",
    session,
    reply: `Resumed conversation \`${session.id}\`${session.title ? ` — ${session.title}` : ""}`,
  };
}

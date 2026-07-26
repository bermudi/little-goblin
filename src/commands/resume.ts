import type { SessionState } from "../sessions/types.ts";

export interface ResumeCommandDeps {
  rawText: string;
  sessions: SessionState[];
  bindSession: (sessionId: string) => SessionState | Promise<SessionState>;
}

export type ResumeCommandResult =
  | { kind: "list"; reply: string }
  | { kind: "not-found"; reply: string }
  | { kind: "ambiguous"; reply: string }
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

export async function executeResume(deps: ResumeCommandDeps): Promise<ResumeCommandResult> {
  const target = parseResumeTarget(deps.rawText);
  if (!target) return { kind: "list", reply: formatNamedSessionsList(deps.sessions) };

  const matches = deps.sessions.filter((session) => matchesTarget(session, target));
  if (matches.length === 0) {
    return { kind: "not-found", reply: `No conversation found for \`${target}\`.` };
  }
  if (matches.length > 1) {
    const list = matches.map(formatSessionLine).join("\n");
    return { kind: "ambiguous", reply: `Multiple conversations match \`${target}\`:\n${list}` };
  }

  const [match] = matches;
  const session = await deps.bindSession(match!.id);
  return {
    kind: "resumed",
    session,
    reply: `Resumed conversation \`${session.id}\`${session.title ? ` — ${session.title}` : ""}`,
  };
}

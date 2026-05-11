import type { SessionState } from "../sessions/types.ts";

export interface ResumeCommandDeps {
  rawText: string;
  sessions: SessionState[];
  bindSession: (sessionId: string) => SessionState;
}

export type ResumeCommandResult =
  | { kind: "usage"; reply: string }
  | { kind: "not-found"; reply: string }
  | { kind: "ambiguous"; reply: string }
  | { kind: "resumed"; session: SessionState; reply: string };

export const RESUME_USAGE_REPLY = "Usage: /resume <session id or name>";

export function parseResumeTarget(rawText: string): string | undefined {
  const value = rawText.replace(/^\/resume(?:@\S+)?(?:\s+)?/u, "").trim();
  return value === "" ? undefined : value;
}

function matchesTarget(session: SessionState, target: string): boolean {
  return session.id === target || session.id.startsWith(target) || session.title === target;
}

export function executeResume(deps: ResumeCommandDeps): ResumeCommandResult {
  const target = parseResumeTarget(deps.rawText);
  if (!target) return { kind: "usage", reply: RESUME_USAGE_REPLY };

  const matches = deps.sessions.filter((session) => matchesTarget(session, target));
  if (matches.length === 0) {
    return { kind: "not-found", reply: `No session found for \`${target}\`.` };
  }
  if (matches.length > 1) {
    const list = matches.map((session) => `- ${session.id}${session.title ? ` — ${session.title}` : ""}`).join("\n");
    return { kind: "ambiguous", reply: `Multiple sessions match \`${target}\`:\n${list}` };
  }

  const [match] = matches;
  const session = deps.bindSession(match!.id);
  return {
    kind: "resumed",
    session,
    reply: `Resumed session \`${session.id}\`${session.title ? ` — ${session.title}` : ""}`,
  };
}

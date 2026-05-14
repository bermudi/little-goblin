/**
 * /think command logic.
 *
 * Shows the current thinking level or sets it for the next turn.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

const LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export interface ThinkCommandDeps {
  /** True iff a session was resolvable for this chat. */
  hasSession: boolean;
  /** The raw command text, e.g. "/think high". */
  rawText: string;
  /** Currently active thinking level (model default or override). */
  currentLevel: ThinkingLevel;
  /** Sets (or clears) the session-scoped thinking level override. */
  setThinkingLevel: (level: ThinkingLevel | undefined) => void;
}

export type ThinkCommandResult =
  | { kind: "no-session"; reply: string }
  | { kind: "list"; reply: string }
  | { kind: "bad-level"; reply: string }
  | { kind: "set"; reply: string; level: ThinkingLevel }
  | { kind: "cleared"; reply: string };

export const NO_SESSION_REPLY = "No active session. Start a conversation first.";

/**
 * Format the /think reply, showing the current level and available options
 * with a ✅ marker on the active entry.
 */
function formatList(currentLevel: ThinkingLevel): string {
  const lines = LEVELS.map((l) => {
    const marker = l === currentLevel ? " ✅" : "";
    return `${l}${marker}`;
  });
  return [
    `Current: \`${currentLevel}\``,
    "",
    "Levels:",
    ...lines,
    "",
    "Use `/think <level>` to switch.",
    "Use `/think clear` to use the model default.",
  ].join("\n");
}

function isValidLevel(level: string): level is ThinkingLevel {
  return LEVELS.includes(level as ThinkingLevel);
}

export function executeThink(deps: ThinkCommandDeps): ThinkCommandResult {
  if (!deps.hasSession) {
    return { kind: "no-session", reply: NO_SESSION_REPLY };
  }

  const arg = deps.rawText.replace(/^\/think\s+/, "").trim();

  // No argument → list levels
  if (arg === "" || arg === "/think") {
    return { kind: "list", reply: formatList(deps.currentLevel) };
  }

  // Clear override
  if (arg.toLowerCase() === "none" || arg.toLowerCase() === "clear") {
    deps.setThinkingLevel(undefined);
    return { kind: "cleared", reply: "Thinking level override cleared. Using model default." };
  }

  const level = arg.toLowerCase();
  if (!isValidLevel(level)) {
    return {
      kind: "bad-level",
      reply: `Unknown level "${arg}". Valid: ${LEVELS.join(", ")}.`,
    };
  }

  deps.setThinkingLevel(level);
  return { kind: "set", reply: `Thinking level set to \`${level}\``, level };
}

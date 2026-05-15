/**
 * /think command logic.
 *
 * Shows the current thinking level or sets it for the next turn.
 * Only lists levels supported by the active model.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** All known thinking levels in ascending order. */
export const ALL_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export interface ThinkCommandDeps {
  /** True iff a session was resolvable for this chat. */
  hasSession: boolean;
  /** The raw command text, e.g. "/think high". */
  rawText: string;
  /** Currently active thinking level (model default or override). */
  currentLevel: ThinkingLevel;
  /** Levels supported by the active model (may be fewer than ALL_LEVELS). */
  supportedLevels: readonly ThinkingLevel[];
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
 * Format the /think reply, showing only levels supported by the active model
 * with a ✅ marker on the active entry.
 */
function formatList(currentLevel: ThinkingLevel, supportedLevels: readonly ThinkingLevel[]): string {
  const lines = supportedLevels.map((l) => {
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

function isValidLevel(level: string, supportedLevels: readonly ThinkingLevel[]): level is ThinkingLevel {
  return supportedLevels.includes(level as ThinkingLevel);
}

export function executeThink(deps: ThinkCommandDeps): ThinkCommandResult {
  if (!deps.hasSession) {
    return { kind: "no-session", reply: NO_SESSION_REPLY };
  }

  const arg = deps.rawText.replace(/^\/think\s+/, "").trim();

  // No argument → list levels
  if (arg === "" || arg === "/think") {
    return { kind: "list", reply: formatList(deps.currentLevel, deps.supportedLevels) };
  }

  // Clear override
  if (arg.toLowerCase() === "none" || arg.toLowerCase() === "clear") {
    deps.setThinkingLevel(undefined);
    return { kind: "cleared", reply: "Thinking level override cleared. Using model default." };
  }

  const level = arg.toLowerCase();
  if (!isValidLevel(level, deps.supportedLevels)) {
    return {
      kind: "bad-level",
      reply: `Unknown level "${arg}". Valid for this model: ${deps.supportedLevels.join(", ")}.`,
    };
  }

  deps.setThinkingLevel(level);
  return { kind: "set", reply: `Thinking level set to \`${level}\``, level };
}

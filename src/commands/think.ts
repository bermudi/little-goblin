/**
 * /think command logic.
 *
 * Shows the current thinking level or sets it for the next turn.
 * Only lists levels supported by the active model.
 *
 * Command output carries the validated thinking level; the caller
 * (registry handler) applies it through `ConversationLifecycle.setSurfacePreferences`.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { parseCommandArg } from "./parse.ts";

/** All known thinking levels in ascending order. */
export const ALL_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface ThinkCommandDeps {
  /** The raw command text, e.g. "/think high". */
  rawText: string;
  /** Currently active thinking level (model default or override). */
  currentLevel: ThinkingLevel;
  /** Levels supported by the active model (may be fewer than ALL_LEVELS). */
  supportedLevels: readonly ThinkingLevel[];
}

export type ThinkCommandResult =
  | { kind: "list"; reply: string }
  | { kind: "bad-level"; reply: string }
  | { kind: "set"; reply: string; level: ThinkingLevel }
  | { kind: "cleared"; reply: string };

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
  const arg = parseCommandArg(deps.rawText);

  // No argument → list levels
  if (arg === "") {
    return { kind: "list", reply: formatList(deps.currentLevel, deps.supportedLevels) };
  }

  // Clear override
  if (arg.toLowerCase() === "none" || arg.toLowerCase() === "clear") {
    return { kind: "cleared", reply: "Thinking level override cleared. Using model default." };
  }

  const level = arg.toLowerCase();
  if (!isValidLevel(level, deps.supportedLevels)) {
    return {
      kind: "bad-level",
      reply: `Unknown level "${arg}". Valid for this model: ${deps.supportedLevels.join(", ")}.`,
    };
  }

  return { kind: "set", reply: `Thinking level set to \`${level}\``, level };
}

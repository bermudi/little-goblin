/**
 * /model command logic.
 *
 * Lists favorite models or switches the current session to one.
 * Surfaces thinking level clamping when switching models.
 */

import { resolveModel, type ResolvedModel } from "../agent/models.ts";
import type { Config } from "../config.ts";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { parseCommandArg } from "./parse.ts";

export interface ModelCommandDeps {
  /** True iff a session was resolvable for this chat. */
  hasSession: boolean;
  /** The raw command text, e.g. "/model 2". */
  rawText: string;
  /** Configured favorites list. */
  favorites: string[];
  /** Config object for resolving models. */
  cfg: Config;
  /** Currently active model (override or default). */
  currentModelName: string;
  /** Current thinking level override, or undefined if using model default. */
  currentThinkingLevel: ThinkingLevel | undefined;
  /** Resolved model for the current session (needed for thinking level clamp check). */
  currentResolvedModel: ResolvedModel | undefined;
  /** Sets (or clears) the session-scoped model override. */
  setModelName: (name: string | undefined) => void;
  /** Called with the clamped thinking level when a model switch changes the effective level. */
  onThinkingLevelClamped?: (newLevel: ThinkingLevel) => void;
}

export type ModelCommandResult =
  | { kind: "no-session"; reply: string }
  | { kind: "no-favorites"; reply: string }
  | { kind: "list"; reply: string }
  | { kind: "bad-index"; reply: string }
  | { kind: "bad-model"; reply: string }
  | { kind: "set"; reply: string; modelName: string; thinkingClamped?: ThinkingLevel }
  | { kind: "cleared"; reply: string; thinkingClamped?: ThinkingLevel };

export const NO_SESSION_REPLY = "No active session. Start a conversation first.";
export const NO_FAVORITES_REPLY = "No favorites configured. Add them to `goblin.json5`.";

/**
 * Format the /model reply, showing the current model and the favorites list
 * with a ✅ marker on the active entry.
 */
function formatList(favorites: string[], currentModelName: string): string {
  const lines = favorites.map((m, i) => {
    const marker = m === currentModelName ? " ✅" : "";
    return `${i + 1}. ${m}${marker}`;
  });
  return [
    `Current: \`${currentModelName}\``,
    "",
    "Favorites:",
    ...lines,
    "",
    "Use `/model <number>` or `/model <model-id>` to switch.",
    "Use `/model clear` to use the default.",
  ].join("\n");
}

/**
 * Check whether switching models would clamp the current thinking level.
 * Returns the clamped level if it differs from the current effective level,
 * or undefined if no clamping occurs.
 */
function computeThinkingClamp(
  newResolved: ResolvedModel,
  currentThinkingLevel: ThinkingLevel | undefined,
  currentResolvedModel: ResolvedModel | undefined,
): ThinkingLevel | undefined {
  // If the user has an explicit override, check whether the new model supports it.
  // If there's no override and we can't resolve the current model, we don't know the
  // effective level — skip the clamp check rather than guess.
  if (currentThinkingLevel !== undefined) {
    const clamped = clampThinkingLevel(newResolved.model, currentThinkingLevel);
    return clamped !== currentThinkingLevel ? clamped : undefined;
  }
  if (currentResolvedModel) {
    const effectiveLevel = currentResolvedModel.thinkingLevel;
    const clamped = clampThinkingLevel(newResolved.model, effectiveLevel);
    return clamped !== effectiveLevel ? clamped : undefined;
  }
  return undefined;
}

/**
 * Resolve, validate, and switch to a model. Returns the result with clamp info.
 */
function switchToModel(
  modelName: string,
  deps: ModelCommandDeps,
): { kind: "bad-model"; reply: string } | { kind: "set"; reply: string; modelName: string; thinkingClamped?: ThinkingLevel } {
  let newResolved: ResolvedModel;
  try {
    newResolved = resolveModel({ ...deps.cfg, modelName });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "bad-model", reply: message };
  }

  const thinkingClamped = computeThinkingClamp(
    newResolved,
    deps.currentThinkingLevel,
    deps.currentResolvedModel,
  );

  deps.setModelName(modelName);

  if (thinkingClamped) {
    deps.onThinkingLevelClamped?.(thinkingClamped);
  }

  const reply = thinkingClamped
    ? `Switched to \`${modelName}\`\nThinking level clamped to \`${thinkingClamped}\` (not supported by this model at previous level).`
    : `Switched to \`${modelName}\``;

  return { kind: "set", reply, modelName, thinkingClamped };
}

export function executeModel(deps: ModelCommandDeps): ModelCommandResult {
  if (!deps.hasSession) {
    return { kind: "no-session", reply: NO_SESSION_REPLY };
  }

  const arg = parseCommandArg(deps.rawText);

  // No argument → list favorites
  if (arg === "") {
    if (deps.favorites.length === 0) {
      return { kind: "no-favorites", reply: NO_FAVORITES_REPLY };
    }
    return { kind: "list", reply: formatList(deps.favorites, deps.currentModelName) };
  }

  // Clear override — revert to config default model.
  // Check whether the default model supports the current thinking level.
  if (arg.toLowerCase() === "none" || arg.toLowerCase() === "clear") {
    deps.setModelName(undefined);
    let thinkingClamped: ThinkingLevel | undefined;
    try {
      const defaultResolved = resolveModel(deps.cfg);
      thinkingClamped = computeThinkingClamp(
        defaultResolved,
        deps.currentThinkingLevel,
        deps.currentResolvedModel,
      );
      if (thinkingClamped) {
        deps.onThinkingLevelClamped?.(thinkingClamped);
      }
    } catch {
      // Can't resolve default model — skip clamp check.
    }
    const reply = thinkingClamped
      ? `Model override cleared. Using default.\nThinking level clamped to \`${thinkingClamped}\` (not supported by the default model at previous level).`
      : "Model override cleared. Using default.";
    return { kind: "cleared", reply, thinkingClamped };
  }

  // Parse 1-based index, or treat arg as raw model id
  const index = Number(arg);
  if (Number.isInteger(index) && index >= 1 && index <= deps.favorites.length) {
    const modelName = deps.favorites[index - 1]!;
    return switchToModel(modelName, deps);
  }

  // Purely numeric but out of range → helpful index error (only when favorites exist)
  if (Number.isInteger(index) && deps.favorites.length > 0) {
    return {
      kind: "bad-index",
      reply: `Invalid index. Use 1–${deps.favorites.length}.`,
    };
  }

  // Treat as raw model id
  return switchToModel(arg, deps);
}

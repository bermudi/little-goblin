/**
 * /model command logic.
 *
 * Lists favorite models or switches the current session to one.
 */

import { resolveModel } from "../agent/models.ts";
import type { Config } from "../config.ts";

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
  /** Sets (or clears) the session-scoped model override. */
  setModelName: (name: string | undefined) => void;
}

export type ModelCommandResult =
  | { kind: "no-session"; reply: string }
  | { kind: "no-favorites"; reply: string }
  | { kind: "list"; reply: string }
  | { kind: "bad-index"; reply: string }
  | { kind: "bad-model"; reply: string }
  | { kind: "set"; reply: string; modelName: string }
  | { kind: "cleared"; reply: string };

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

export function executeModel(deps: ModelCommandDeps): ModelCommandResult {
  if (!deps.hasSession) {
    return { kind: "no-session", reply: NO_SESSION_REPLY };
  }

  const arg = deps.rawText.replace(/^\/model\s+/, "").trim();

  // No argument → list favorites
  if (arg === "" || arg === "/model") {
    if (deps.favorites.length === 0) {
      return { kind: "no-favorites", reply: NO_FAVORITES_REPLY };
    }
    return { kind: "list", reply: formatList(deps.favorites, deps.currentModelName) };
  }

  // Clear override
  if (arg.toLowerCase() === "none" || arg.toLowerCase() === "clear") {
    deps.setModelName(undefined);
    return { kind: "cleared", reply: "Model override cleared. Using default." };
  }

  // Parse 1-based index, or treat arg as raw model id
  const index = Number(arg);
  if (Number.isInteger(index) && index >= 1 && index <= deps.favorites.length) {
    const modelName = deps.favorites[index - 1]!;
    try {
      resolveModel({ ...deps.cfg, modelName });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { kind: "bad-model", reply: message };
    }
    deps.setModelName(modelName);
    return { kind: "set", reply: `Switched to \`${modelName}\``, modelName };
  }

  // Purely numeric but out of range → helpful index error (only when favorites exist)
  if (Number.isInteger(index) && deps.favorites.length > 0) {
    return {
      kind: "bad-index",
      reply: `Invalid index. Use 1–${deps.favorites.length}.`,
    };
  }

  const modelName = arg;

  // Validate the model is resolvable (known model + API key present)
  try {
    resolveModel({ ...deps.cfg, modelName });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "bad-model", reply: message };
  }

  deps.setModelName(modelName);
  return { kind: "set", reply: `Switched to \`${modelName}\``, modelName };
}

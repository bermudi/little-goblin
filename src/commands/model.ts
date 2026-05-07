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

function formatList(favorites: string[]): string {
  const lines = favorites.map((m, i) => `${i + 1}. ${m}`);
  return ["Favorite models:", ...lines, "", "Use `/model <number>` to switch."].join("\n");
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
    return { kind: "list", reply: formatList(deps.favorites) };
  }

  // Clear override
  if (arg.toLowerCase() === "none" || arg.toLowerCase() === "clear") {
    deps.setModelName(undefined);
    return { kind: "cleared", reply: "Model override cleared. Using default." };
  }

  // Parse 1-based index
  const index = Number(arg);
  if (!Number.isInteger(index) || index < 1 || index > deps.favorites.length) {
    return {
      kind: "bad-index",
      reply:
        deps.favorites.length === 0
          ? NO_FAVORITES_REPLY
          : `Invalid index. Use 1–${deps.favorites.length}.`,
    };
  }

  const modelName = deps.favorites[index - 1]!;

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

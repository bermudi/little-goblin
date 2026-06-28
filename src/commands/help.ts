/**
 * /help command response.
 *
 * Derived from `COMMAND_REGISTRY` in `./registry.ts` — the single source of
 * truth for all slash commands. Adding a command to the registry automatically
 * updates this reply; no hand-maintained list to drift.
 */
import { helpReply } from "./registry.ts";

export const HELP_REPLY = helpReply();

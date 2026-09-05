import { parseCommandArg } from "./parse.ts";

/** What the operator asked `/mcp` to do. */
export type McpCommandIntent =
  | { kind: "inspect" }
  | { kind: "refresh" }
  | { kind: "enable"; server: string }
  | { kind: "disable"; server: string };

export class McpCommandSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpCommandSyntaxError";
  }
}

/**
 * mcporter server names as used by goblin's catalog: lowercase identifiers
 * without whitespace or shell-hostile characters. The name only ever flows
 * into an mcporter argv element (never a shell), but keeping the grammar
 * strict also keeps `/mcp enable` replies and config edits unambiguous.
 */
function isValidServerName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/u.test(name);
}

/** Parse the deliberately narrow `/mcp` grammar without touching state. */
export function parseMcpCommand(rawText: string): McpCommandIntent {
  const arg = parseCommandArg(rawText);
  if (arg === "") return { kind: "inspect" };

  const tokens = arg.split(/\s+/u);
  if (tokens.length === 1 && tokens[0] === "refresh") return { kind: "refresh" };

  const action = tokens[0];
  if ((action === "enable" || action === "disable") && tokens.length === 2) {
    const raw = tokens[1] ?? "";
    const server = raw.toLowerCase();
    if (!isValidServerName(server)) {
      throw new McpCommandSyntaxError(`Invalid server name: ${JSON.stringify(raw)}`);
    }
    return { kind: action, server };
  }

  throw new McpCommandSyntaxError("Usage: /mcp [refresh|enable <server>|disable <server>]");
}

import type { Context } from "grammy";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import { stripBotMention } from "./mention.ts";

/**
 * Format a sender prefix from the grammy context for LLM context.
 * Returns something like `[From: Daniel (@bermudi)]` or `[From: Daniel]`.
 */
function senderPrefix(ctx: Context): string {
  const from = ctx.from;
  if (!from) return "[From: unknown]";
  const parts: string[] = [];
  if (from.first_name) parts.push(from.first_name);
  if (from.last_name) parts.push(from.last_name);
  const name = parts.join(" ") || `User ${from.id}`;
  if (from.username) return `[From: ${name} (@${from.username})]`;
  return `[From: ${name}]`;
}

/**
 * Prepare user content for the LLM: prepend sender identity and strip
 * @mentions of the bot.
 *
 * - For text: returns `"[From: ...]\n<cleaned text>"`
 * - For content blocks: prepends a text block with the sender prefix
 *   and strips mentions from existing text blocks.
 */
export function prepareUserContent(
  ctx: Context,
  content: string,
): string;
export function prepareUserContent(
  ctx: Context,
  content: (TextContent | ImageContent)[],
): (TextContent | ImageContent)[];
export function prepareUserContent(
  ctx: Context,
  content: string | (TextContent | ImageContent)[],
): string | (TextContent | ImageContent)[] {
  const prefix = senderPrefix(ctx);

  if (typeof content === "string") {
    const cleaned = stripBotMention(ctx, content);
    return `${prefix}\n${cleaned}`;
  }

  // Content blocks: strip mentions from text blocks, prepend sender.
  const blocks: (TextContent | ImageContent)[] = [
    { type: "text", text: prefix },
  ];
  for (const block of content) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: stripBotMention(ctx, block.text) });
    } else {
      blocks.push(block);
    }
  }
  return blocks;
}

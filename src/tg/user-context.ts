import type { Context } from "grammy";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";

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
 * Strip @mentions of the bot from text. Matches `mention` entities,
 * `text_mention` entities, and — as a fallback when the client sent the
 * handle without resolving it into an entity — bare `@botusername`
 * substrings. Comparisons are case-insensitive. Handles both text
 * messages and captions.
 */
export function stripBotMention(ctx: Context, text: string): string {
  const username = ctx.me.username;
  if (!username) return text;

  const lowerUser = username.toLowerCase();
  const entities = ctx.msg?.entities ?? ctx.msg?.caption_entities ?? [];
  // Collect @mention offsets to strip (case-insensitive — Telegram
  // usernames are case-insensitive on the server side).
  const ranges: Array<[number, number]> = [];
  for (const e of entities) {
    if (e.type === "mention") {
      const mention = text.slice(e.offset, e.offset + e.length);
      if (mention.toLowerCase() === `@${lowerUser}`) {
        ranges.push([e.offset, e.offset + e.length]);
      }
    }
    if (e.type === "text_mention" && e.user?.id === ctx.me.id) {
      ranges.push([e.offset, e.offset + e.length]);
    }
  }

  // Remove ranges back-to-front to preserve offsets
  let result = text;
  if (ranges.length > 0) {
    for (let i = ranges.length - 1; i >= 0; i--) {
      const [start, end] = ranges[i]!;
      result = result.slice(0, start) + result.slice(end);
    }
  } else {
    // Plain-text fallback: strip bare @handle occurrences that the
    // client never resolved into entities. Same boundary rules as
    // isBotMentioned — @goblinbot doesn't match @goblinbot5000.
    const re = new RegExp(`@${lowerUser.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9A-Za-z_])`, "gi");
    result = result.replace(re, "");
  }

  return result.replace(/[ \t]+/g, " ").trim();
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

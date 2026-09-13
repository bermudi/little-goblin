import type { Context } from "grammy";

type MessageEntity = NonNullable<Context["msg"]>["entities"] extends (infer E)[] | undefined ? E : never;

/**
 * `[start, end)` ranges of bot mentions found in `entities` within `text`.
 *
 *   - `mention` entities (@username) match when the covered text equals
 *     `@<bot username>` — case-insensitive, since Telegram usernames are
 *     case-insensitive on the server side.
 *   - `text_mention` entities (inline user tags from Telegram's mention
 *     picker) match on the bot's user id.
 */
export function botMentionRanges(
  bot: { id: number; username?: string },
  text: string,
  entities: readonly MessageEntity[],
): Array<[number, number]> {
  const lowerUser = bot.username?.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const e of entities) {
    if (e.type === "mention") {
      if (lowerUser !== undefined && text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${lowerUser}`) {
        ranges.push([e.offset, e.offset + e.length]);
      }
    } else if (e.type === "text_mention" && e.user?.id === bot.id) {
      ranges.push([e.offset, e.offset + e.length]);
    }
  }
  return ranges;
}

/**
 * Escaped regex matching a bare `@username` — the fallback for clients
 * that sent the handle without resolving it into an entity (typed/pasted
 * fast, or a non-Telegram-native client). Word-boundary at the end so
 * @goblinbot doesn't match @goblinbot5000; start-anchored on the @ so we
 * don't pattern-match a mid-mention substring.
 */
export function botHandlePattern(username: string, flags = "i"): RegExp {
  const escaped = username.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@${escaped}(?![0-9A-Za-z_])`, flags);
}

// grammy only populates entities for text messages and caption_entities
// for media. Both passes need to check both.
function messageEntities(ctx: Context): readonly MessageEntity[] {
  return ctx.msg?.entities ?? ctx.msg?.caption_entities ?? [];
}

function messageText(ctx: Context): string {
  return ctx.msg?.text ?? ctx.msg?.caption ?? "";
}

/**
 * Whether the message (text or caption) contains an @mention of the bot.
 * Entity-derived ranges first, then the bare-@handle fallback so a real
 * @mention still wakes the bot.
 */
export function isBotMentioned(ctx: Context): boolean {
  const bot = ctx.me;
  if (!bot.username) return false;
  const text = messageText(ctx);
  if (botMentionRanges(bot, text, messageEntities(ctx)).length > 0) return true;
  return botHandlePattern(bot.username).test(text);
}

/**
 * Strip @mentions of the bot from text. Entity ranges are removed
 * back-to-front to preserve offsets; when no entity matched, the
 * bare-@handle fallback strips unresolved occurrences. Comparisons are
 * case-insensitive. Handles both text messages and captions.
 */
export function stripBotMention(ctx: Context, text: string): string {
  const bot = ctx.me;
  if (!bot.username) return text;

  const ranges = botMentionRanges(bot, text, messageEntities(ctx));
  let result = text;
  if (ranges.length > 0) {
    for (let i = ranges.length - 1; i >= 0; i--) {
      const [start, end] = ranges[i]!;
      result = result.slice(0, start) + result.slice(end);
    }
  } else {
    result = result.replace(botHandlePattern(bot.username, "gi"), "");
  }

  return result.replace(/[ \t]+/g, " ").trim();
}

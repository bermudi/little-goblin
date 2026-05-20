import type { Context, NextFunction } from "grammy";
import type { Config } from "../config.ts";
import { log } from "../log.ts";

/** TTL for cached member counts (5 minutes). */
const MEMBER_COUNT_TTL_MS = 5 * 60 * 1000;

/**
 * Whether the message (text or caption) contains an @mention of the bot.
 * Covers both `mention` entities (@username) and `text_mention` entities
 * (inline user tags from Telegram's mention picker).
 */
function isBotMentioned(ctx: Context): boolean {
  const botId = ctx.me.id;
  const botUsername = ctx.me.username;
  if (!botUsername) return false;

  // grammy only populates entities for text messages and caption_entities
  // for media. We need to check both.
  const entities = ctx.msg?.entities ?? ctx.msg?.caption_entities ?? [];
  const text = ctx.msg?.text ?? ctx.msg?.caption ?? "";

  return entities.some((e) => {
    if (e.type === "mention") {
      const mention = text.slice(e.offset, e.offset + e.length);
      return mention === `@${botUsername}`;
    }
    if (e.type === "text_mention") {
      return e.user?.id === botId;
    }
    return false;
  });
}

/**
 * Build allowlist middleware with group-aware routing:
 *
 *   - DMs: only allowed users.
 *   - Groups with ≤2 members (bot + one allowed user): respond to
 *     everything from that allowed user.
 *   - Groups with >2 members: only respond to @mentions (from anyone).
 *
 * Member counts are cached per chat with a 5-minute TTL.
 */
export function buildAllowlistMiddleware(cfg: Config) {
  const memberCountCache = new Map<number, { count: number; fetchedAt: number }>();

  async function getMemberCount(ctx: Context): Promise<number> {
    const chatId = ctx.chat!.id;
    const cached = memberCountCache.get(chatId);
    if (cached && Date.now() - cached.fetchedAt < MEMBER_COUNT_TTL_MS) {
      return cached.count;
    }
    try {
      const count = await ctx.api.getChatMemberCount(chatId);
      memberCountCache.set(chatId, { count, fetchedAt: Date.now() });
      return count;
    } catch (err) {
      log.warn("failed to get member count, assuming >2", { chatId, err });
      return Infinity;
    }
  }

  return async (ctx: Context, next: NextFunction): Promise<void> => {
    // Non-message updates (callback_query, inline_query, etc.) — pass through.
    // The middleware is installed via bot.use() so it sees all updates, but
    // the access control logic only makes sense for messages.
    if (!ctx.chat || !ctx.from) {
      await next();
      return;
    }

    const chatType = ctx.chat.type;

    // DMs: strict allowlist, no exceptions.
    if (chatType === "private") {
      const userId = ctx.from.id;
      if (cfg.allowedTgUserIds.has(userId)) {
        await next();
        return;
      }
      log.debug("dropping DM from non-allowed user", {
        userId,
        username: ctx.from.username,
      });
      return;
    }

    // Groups: check @mention first (works for anyone).
    if (isBotMentioned(ctx)) {
      log.debug("allowing @mention in group", {
        userId: ctx.from.id,
        username: ctx.from.username,
        chatId: ctx.chat.id,
        chatType,
      });
      await next();
      return;
    }

    // No @mention — allowed users get commands through regardless of
    // group size (slash commands are explicit bot interactions). For
    // non-command messages, only pass in small groups (≤2 members).
    const userId = ctx.from.id;
    if (cfg.allowedTgUserIds.has(userId)) {
      const isCommand = (ctx.msg?.entities ?? []).some((e) => e.type === "bot_command");
      if (isCommand) {
        await next();
        return;
      }
      const count = await getMemberCount(ctx);
      if (count <= 2) {
        await next();
        return;
      }
      log.debug("dropping non-mention from allowed user in multi-member group", {
        userId,
        chatId: ctx.chat.id,
        memberCount: count,
      });
      return;
    }

    log.debug("dropping non-mention from non-allowed user in group", {
      userId,
      username: ctx.from.username,
      chatId: ctx.chat.id,
    });
  };
}

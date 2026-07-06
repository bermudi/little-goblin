import type { Context, NextFunction } from "grammy";
import type { Config } from "../config.ts";
import { log } from "../log.ts";

/** TTL for cached member counts (5 minutes). */
const MEMBER_COUNT_TTL_MS = 5 * 60 * 1000;

/**
 * Whether the message (text or caption) contains an @mention of the bot.
 *
 * Two passes:
 *   1. Entity pass — `mention` entities (@username) and `text_mention`
 *      entities (inline user tags from Telegram's mention picker).
 *      Usernames are case-insensitive on Telegram's side, so we compare
 *      lowercased.
 *   2. Plain-text fallback — if the client never resolved the `@handle`
 *      into an entity (typed/pasted fast, or a non-Telegram-native
 *      client), there is no entity at all. Match the literal handle in
 *      the text so a real @mention still wakes the bot.
 */
function isBotMentioned(ctx: Context): boolean {
  const botId = ctx.me.id;
  const botUsername = ctx.me.username;
  if (!botUsername) return false;

  // grammy only populates entities for text messages and caption_entities
  // for media. We need to check both.
  const entities = ctx.msg?.entities ?? ctx.msg?.caption_entities ?? [];
  const text = ctx.msg?.text ?? ctx.msg?.caption ?? "";
  const lowerUser = botUsername.toLowerCase();

  if (entities.some((e) => {
    if (e.type === "mention") {
      return text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${lowerUser}`;
    }
    if (e.type === "text_mention") {
      return e.user?.id === botId;
    }
    return false;
  })) {
    return true;
  }

  // Plain-text fallback: @handle present in the text with no resolved
  // entity. Word-boundary at the end so @goblinbot doesn't match
  // @goblinbot5000; start-anchored on the @ so we don't pattern-match a
  // mid-mention substring.
  return new RegExp(`@${lowerUser.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9A-Za-z_])`, "i").test(text);
}

/**
 * Whether the message is a direct reply to a message sent by the bot.
 * In groups, replying to the bot is an explicit interaction — same as
 * an @mention — that wakes the bot regardless of who replies.
 *
 * In forum topics, Telegram sets `reply_to_message` to the topic's
 * anchor message even for non-reply messages. That anchor is a service
 * message (`forum_topic_created`), not a real reply — skip it so every
 * message in a bot-created topic doesn't accidentally wake the bot.
 */
function isReplyToBot(ctx: Context): boolean {
  const replyTo = ctx.msg?.reply_to_message;
  if (!replyTo) return false;
  if ("forum_topic_created" in replyTo) return false;
  return replyTo.from?.id === ctx.me.id;
}

/**
 * Build allowlist middleware with group-aware routing:
 *
 *   - DMs: only allowed users.
 *   - Groups with ≤2 members (bot + one allowed user): respond to
 *     everything from that allowed user.
 *   - Groups with >2 members: only respond to @mentions or direct
 *     replies to a bot message (from anyone).
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
    // guest_message: grammy does not populate ctx.chat/ctx.from for these, so
    // read the summoner id directly from the update. BotFather's "Restrict bot
    // usage" setting does NOT gate guest updates, so this code-level check is
    // load-bearing — without it anyone who knows the bot's username can summon
    // it and burn LLM credits. See telegram-guest-mode proposal.
    const guestFrom = ctx.update?.guest_message?.from;
    if (guestFrom) {
      if (cfg.allowedTgUserIds.has(guestFrom.id)) {
        await next();
        return;
      }
      log.debug("dropping guest_message from non-allowed user", {
        userId: guestFrom.id,
        username: guestFrom.username,
      });
      return;
    }

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

    // Reply to a bot message — explicit interaction, works for anyone.
    if (isReplyToBot(ctx)) {
      log.debug("allowing reply-to-bot in group", {
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
      const entTypes = (ctx.msg?.entities ?? ctx.msg?.caption_entities ?? []).map((e) => e.type);
      const rawText = ctx.msg?.text ?? ctx.msg?.caption ?? "";
      const handleInText = ctx.me.username
        ? rawText.toLowerCase().includes(`@${ctx.me.username.toLowerCase()}`)
        : false;
      log.debug("dropping non-mention from allowed user in multi-member group", {
        userId,
        chatId: ctx.chat.id,
        memberCount: count,
        entityTypes: entTypes,
        handleInText,
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

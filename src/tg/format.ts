import { log } from "../log.ts";
import type { TelegramMetricsEvent } from "../metrics/mod.ts";

/**
 * Send-options threaded through `TelegramIntakeMessage.reply`. Defined here so
 * `sendSystemReply` can type its calls without depending on `intake.ts`; the
 * `TelegramIntakeMessage.reply` signature is widened to accept this shape in a
 * later phase, making `TelegramIntakeMessage` structurally assignable to
 * {@link SystemMessageSender}.
 */
export interface ReplyOpts {
  parse_mode?: string;
  disable_notification?: boolean;
}

/**
 * Minimal structural view of a send surface that `sendSystemReply` needs. Any
 * object whose `reply` accepts `(text, opts?)` satisfies this — including the
 * current `TelegramIntakeMessage` (a function accepting fewer parameters is
 * assignable to one accepting more optional parameters).
 */
interface SystemMessageSender {
  reply: (text: string, opts?: ReplyOpts) => Promise<void>;
}

export type SystemTag = "ok" | "error" | "warn" | "info" | "queued";

const SPECIAL = new Set([
  "_", "*", "[", "]", "(", ")", "~", "`", ">", "#", "+", "-", "=", "|",
  "{", "}", ".", "!", "\\",
]);

function atLineStart(text: string, i: number): boolean {
  return i === 0 || text[i - 1] === "\n";
}

function findFenceClose(text: string, from: number): number {
  const n = text.length;
  for (let k = from; k + 2 < n; k++) {
    if (text[k] === "`" && text[k + 1] === "`" && text[k + 2] === "`" && atLineStart(text, k)) {
      return k;
    }
  }
  return -1;
}

/**
 * Escapes MarkdownV2-special characters outside fenced code blocks and inline
 * code spans. Balanced ```...``` fences and `...` spans are preserved verbatim
 * (Telegram renders their content literally). A stray backtick with no matching
 * close is escaped so it does not accidentally open a span.
 */
export function escapeMdV2(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text.charAt(i);
    // Fenced code block: ``` at line start with a matching close fence.
    if (ch === "`" && text[i + 1] === "`" && text[i + 2] === "`" && atLineStart(text, i)) {
      const closeStart = findFenceClose(text, i + 3);
      if (closeStart !== -1) {
        let closeLineEnd = text.indexOf("\n", closeStart);
        if (closeLineEnd === -1) closeLineEnd = n;
        else closeLineEnd += 1;
        out += text.slice(i, closeLineEnd);
        i = closeLineEnd;
        continue;
      }
      // No closing fence — escape the three backticks and move on.
      out += "\\`\\`\\`";
      i += 3;
      continue;
    }
    // Inline code span: ` ... ` with a matching close backtick.
    if (ch === "`") {
      const close = text.indexOf("`", i + 1);
      if (close !== -1) {
        out += text.slice(i, close + 1);
        i = close + 1;
        continue;
      }
      out += "\\`";
      i++;
      continue;
    }
    if (SPECIAL.has(ch)) {
      out += "\\" + ch;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Best-effort cleanup that removes MarkdownV2 formatting markers and escape
 * backslashes to produce readable plain text. Used as the plain-text fallback
 * when a MarkdownV2 send/edit returns a 400 parse error. Handles partial or
 * malformed markdown gracefully — unmatched markers are left as-is.
 */
export function stripMdV2(text: string): string {
  let out = text;
  // Drop fenced-code fence lines (``` optionally followed by a language tag).
  out = out.replace(/^```[^\n]*\n?/gm, "");
  // Links: [text](url) -> text
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Spoiler: ||text|| -> text
  out = out.replace(/\|\|([^|]*)\|\|/g, "$1");
  // Bold-italic / bold / underline / italic / strike — order matters.
  out = out.replace(/\*\*\*([^*]*)\*\*\*/g, "$1");
  out = out.replace(/\*\*([^*]*)\*\*/g, "$1");
  out = out.replace(/__([^_]*)__/g, "$1");
  out = out.replace(/\*([^*]*)\*/g, "$1");
  out = out.replace(/_([^_]*)_/g, "$1");
  out = out.replace(/~([^~]*)~/g, "$1");
  // Inline code: `code` -> code
  out = out.replace(/`([^`]*)`/g, "$1");
  // Strip escape backslashes before special chars.
  out = out.replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, "$1");
  return out;
}

/**
 * Wraps `text` as a MarkdownV2 system message with a monospaced tag prefix:
 * `` `[tag]` `` + space + escaped text. The result is ready to send with
 * `parse_mode: "MarkdownV2"`. The tag itself is ASCII-safe and needs no
 * escaping inside the backticks. If `tag` is omitted, no prefix is emitted
 * (the text is still escaped for MarkdownV2).
 */
export function systemReply(text: string, tag?: SystemTag): string {
  if (tag === undefined) return escapeMdV2(text);
  return "`[" + tag + "]` " + escapeMdV2(text);
}

export function isParseError(err: unknown): boolean {
  const e = err as { error_code?: number; description?: string } | undefined;
  if (e?.error_code !== 400) return false;
  const desc = e.description ?? "";
  return /parse|markdown/i.test(desc);
}

export interface TelegramApiErrorInfo {
  outcome: TelegramMetricsEvent["outcome"];
  errorCode?: number;
  errorDescription?: string;
  retryAfterSec?: number;
}

/**
 * Classify a Telegram API error into the outcome used for `telegram` metrics
 * events. 429s carry `retryAfterSec`; topic-not-found, message-gone, and
 * message-not-modified 400s are detected by their descriptions; everything else
 * is a generic `error`.
 */
export function classifyTelegramError(err: unknown): TelegramApiErrorInfo {
  const e = err as { error_code?: number; description?: string; parameters?: { retry_after?: number } } | undefined;
  const code = e?.error_code;
  const description = e?.description ?? String(err);

  if (code === 429) {
    return {
      outcome: "rate_limited",
      errorCode: code,
      errorDescription: description,
      retryAfterSec: e?.parameters?.retry_after,
    };
  }

  if (code === 400 && /topic not found|message thread not found|invalid message thread id/i.test(description)) {
    return { outcome: "topic_not_found", errorCode: code, errorDescription: description };
  }

  if (code === 400 && /not found|can't be edited|to edit/i.test(description)) {
    return { outcome: "message_gone", errorCode: code, errorDescription: description };
  }

  if (code === 400 && /message is not modified/i.test(description)) {
    return { outcome: "message_not_modified", errorCode: code, errorDescription: description };
  }

  return { outcome: "error", errorCode: code, errorDescription: description };
}

/**
 * Formats `text` via {@link systemReply} and sends it through `message.reply`
 * with `parse_mode: "MarkdownV2"` and `disable_notification: true` (unless
 * `opts.silent === false`). On a 400 parse error, retries once with plain text
 * (tag rendered as `[tag]` without backticks, markdown stripped). If the retry
 * also fails — or any non-parse error occurs — the error is logged and
 * swallowed; system replies must not crash the bot.
 */
export async function sendSystemReply(
  message: SystemMessageSender,
  text: string,
  tag?: SystemTag,
  opts: { silent?: boolean } = {},
): Promise<void> {
  const silent = opts.silent !== false;
  const formatted = systemReply(text, tag);
  const sendOpts: ReplyOpts = { parse_mode: "MarkdownV2" };
  if (silent) sendOpts.disable_notification = true;
  try {
    await message.reply(formatted, sendOpts);
  } catch (err) {
    if (isParseError(err)) {
      const plain = (tag ? `[${tag}] ` : "") + stripMdV2(text);
      // The plain-text retry keeps disable_notification (system replies stay
      // silent); only parse_mode is dropped since the text is no longer markdown.
      const retryOpts: ReplyOpts = {};
      if (silent) retryOpts.disable_notification = true;
      try {
        await message.reply(plain, retryOpts);
      } catch (retryErr) {
        log.warn("sendSystemReply plain-text retry failed", { error: String(retryErr) });
      }
    } else {
      log.warn("sendSystemReply failed", { error: String(err) });
    }
  }
}

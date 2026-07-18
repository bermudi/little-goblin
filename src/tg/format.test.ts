import { describe, it, expect, mock } from "bun:test";
import {
  escapeMdV2,
  stripMdV2,
  stripRichMarkdown,
  systemReply,
  sendSystemReply,
  classifyTelegramError,
  type ReplyOpts,
} from "./format.ts";

describe("escapeMdV2", () => {
  it("escapes plain-text special characters", () => {
    expect(escapeMdV2("Hello. World [test] (foo)")).toBe("Hello\\. World \\[test\\] \\(foo\\)");
  });

  it("escapes the full special set", () => {
    expect(escapeMdV2("_*[]()~`>#+-=|{}.!\\")).toBe(
      "\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!\\\\",
    );
  });

  it("leaves inline code span content untouched", () => {
    const out = escapeMdV2("See `const x = 1` for details.");
    expect(out).toBe("See `const x = 1` for details\\.");
    // The text inside the backticks is preserved verbatim; the trailing
    // period outside the span is escaped.
  });

  it("leaves fenced code block content untouched", () => {
    const src = "Here:\n```js\nconst x = a.b;\n```\nDone.";
    const out = escapeMdV2(src);
    expect(out).toBe("Here:\n```js\nconst x = a.b;\n```\nDone\\.");
  });

  it("escapes a stray backtick outside a span", () => {
    expect(escapeMdV2("a ` b")).toBe("a \\` b");
  });

  it("handles an unterminated inline span by escaping the stray backtick", () => {
    // An open backtick with no close is a stray character, not a span.
    const out = escapeMdV2("text `unterminated a.b");
    expect(out).toBe("text \\`unterminated a\\.b");
  });

  it("preserves newlines outside code", () => {
    expect(escapeMdV2("line one.\nline two.")).toBe("line one\\.\nline two\\.");
  });
});

describe("stripMdV2", () => {
  it("removes bold and italic markers", () => {
    expect(stripMdV2("*bold* and _italic_")).toBe("bold and italic");
  });

  it("removes bold-italic and underline markers", () => {
    expect(stripMdV2("***bi*** and __u__")).toBe("bi and u");
  });

  it("removes strikethrough and spoiler markers", () => {
    expect(stripMdV2("~st~ and ||sp||")).toBe("st and sp");
  });

  it("removes inline code backticks", () => {
    expect(stripMdV2("see `code` here")).toBe("see code here");
  });

  it("removes fenced code fence lines but keeps content", () => {
    expect(stripMdV2("```\nconst x = 1\n```")).toBe("const x = 1\n");
  });

  it("reduces links to their label text", () => {
    expect(stripMdV2("[label](https://example.com)")).toBe("label");
  });

  it("strips escape backslashes before special chars", () => {
    expect(stripMdV2("Hello\\. World \\[test\\]")).toBe("Hello. World [test]");
  });

  it("leaves unmatched markers intact", () => {
    expect(stripMdV2("a * b")).toBe("a * b");
  });
});

describe("stripRichMarkdown", () => {
  it("removes bold and italic markers", () => {
    expect(stripRichMarkdown("**bold** and _italic_")).toBe("bold and italic");
  });

  it("treats __ as bold in rich markdown", () => {
    expect(stripRichMarkdown("__bold__ and **also bold**")).toBe("bold and also bold");
  });

  it("removes GFM strikethrough and marked markers", () => {
    expect(stripRichMarkdown("~~strike~~ and ==mark==")).toBe("strike and mark");
  });

  it("removes spoiler markers and tg-spoiler tags", () => {
    expect(stripRichMarkdown("||spoiler|| and <tg-spoiler>secret</tg-spoiler>")).toBe("spoiler and secret");
  });

  it("removes supported inline HTML tags without touching literal angle brackets", () => {
    expect(stripRichMarkdown("x < y and <u>underline</u>")).toBe("x < y and underline");
  });

  it("removes inline code backticks", () => {
    expect(stripRichMarkdown("see `code` here")).toBe("see code here");
  });

  it("removes fenced code fence lines but keeps content", () => {
    expect(stripRichMarkdown("```python\nprint('hi')\n```")).toBe("print('hi')\n");
  });

  it("reduces links to their label text", () => {
    expect(stripRichMarkdown("[label](https://example.com)")).toBe("label");
  });

  it("does not strip backslash escapes", () => {
    expect(stripRichMarkdown("Hello\\. World \\[test\\]")).toBe("Hello\\. World \\[test\\]");
  });

  it("cleans headings and list markers", () => {
    expect(stripRichMarkdown("# Title\n- item one\n- item two")).toBe("Title\nitem one\nitem two");
  });

  it("leaves unmatched markers intact", () => {
    expect(stripRichMarkdown("a * b")).toBe("a * b");
  });
});

describe("systemReply", () => {
  it("wraps text with a backtick-quoted ok tag", () => {
    expect(systemReply("Project bound to /home/goblin", "ok")).toBe(
      "`[ok]` Project bound to /home/goblin",
    );
  });

  it("uses the error tag", () => {
    expect(systemReply("Failed to save file.txt", "error")).toBe(
      "`[error]` Failed to save file\\.txt",
    );
  });

  it("uses the queued tag", () => {
    expect(systemReply("Will run after this turn.", "queued")).toBe(
      "`[queued]` Will run after this turn\\.",
    );
  });

  it("escapes special characters in the text but not the tag", () => {
    const out = systemReply("a.b_c", "warn");
    expect(out).toBe("`[warn]` a\\.b\\_c");
  });
});

describe("sendSystemReply", () => {
  function makeMessage() {
    const calls: { text: string; opts?: ReplyOpts }[] = [];
    const reply = mock((_text: string, _opts?: ReplyOpts) => Promise.resolve());
    reply.mockImplementation((text: string, opts?: ReplyOpts) => {
      calls.push({ text, opts });
      return Promise.resolve();
    });
    return { reply, calls };
  }

  it("sends a silent MarkdownV2 reply by default", async () => {
    const m = makeMessage();
    await sendSystemReply({ reply: m.reply }, "Project bound to /path", "ok");
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.text).toBe("`[ok]` Project bound to /path");
    expect(m.calls[0]!.opts).toEqual({ parse_mode: "MarkdownV2", disable_notification: true });
  });

  it("omits disable_notification when silent is false", async () => {
    const m = makeMessage();
    await sendSystemReply({ reply: m.reply }, "Done.", "ok", { silent: false });
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.opts).toEqual({ parse_mode: "MarkdownV2" });
  });

  it("falls back to plain text on a 400 parse error, keeping disable_notification", async () => {
    const m = makeMessage();
    let first = true;
    m.reply.mockImplementation((text: string, opts?: ReplyOpts) => {
      if (first) {
        first = false;
        const err = { error_code: 400, description: "Bad Request: can't parse entities" };
        return Promise.reject(err);
      }
      m.calls.push({ text, opts });
      return Promise.resolve();
    });
    await sendSystemReply({ reply: m.reply }, "Failed to *save*.", "error");
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.text).toBe("[error] Failed to save.");
    // Plain-text retry drops parse_mode but keeps disable_notification (silent).
    expect(m.calls[0]!.opts).toEqual({ disable_notification: true });
  });

  it("swallows a failed plain-text retry", async () => {
    const m = makeMessage();
    let first = true;
    m.reply.mockImplementation((_text: string, _opts?: ReplyOpts) => {
      if (first) {
        first = false;
        return Promise.reject({ error_code: 400, description: "can't parse markdown" });
      }
      return Promise.reject(new Error("network gone"));
    });
    // Must not throw.
    await sendSystemReply({ reply: m.reply }, "x", "error");
  });

  it("swallows non-parse errors without retry", async () => {
    const m = makeMessage();
    m.reply.mockImplementation(() =>
      Promise.reject({ error_code: 429, description: "Too Many Requests" }),
    );
    await sendSystemReply({ reply: m.reply }, "x", "ok");
    expect(m.calls).toHaveLength(0);
  });
});

describe("classifyTelegramError", () => {
  it("classifies 429 as rate_limited with retryAfterSec", () => {
    const info = classifyTelegramError({
      error_code: 429,
      description: "Too Many Requests: retry after 5",
      parameters: { retry_after: 5 },
    });
    expect(info.outcome).toBe("rate_limited");
    expect(info.retryAfterSec).toBe(5);
    expect(info.errorCode).toBe(429);
  });

  it("classifies topic-not-found 400s", () => {
    const info = classifyTelegramError({
      error_code: 400,
      description: "Bad Request: topic not found",
    });
    expect(info.outcome).toBe("topic_not_found");
  });

  it("classifies 'message to edit not found' as message_gone", () => {
    const info = classifyTelegramError({
      error_code: 400,
      description: "Bad Request: message to edit not found",
    });
    expect(info.outcome).toBe("message_gone");
  });

  it("classifies 'message can't be edited' as message_gone", () => {
    const info = classifyTelegramError({
      error_code: 400,
      description: "Bad Request: message can't be edited",
    });
    expect(info.outcome).toBe("message_gone");
  });

  it("classifies 'message not found' as message_gone", () => {
    const info = classifyTelegramError({
      error_code: 400,
      description: "Bad Request: message not found",
    });
    expect(info.outcome).toBe("message_gone");
  });

  it("does NOT classify 'chat not found' as message_gone", () => {
    const info = classifyTelegramError({
      error_code: 400,
      description: "Bad Request: chat not found",
    });
    expect(info.outcome).toBe("error");
  });

  it("does NOT classify 'user not found' as message_gone", () => {
    const info = classifyTelegramError({
      error_code: 400,
      description: "Bad Request: user not found",
    });
    expect(info.outcome).toBe("error");
  });

  it("classifies 'message is not modified' as message_not_modified", () => {
    const info = classifyTelegramError({
      error_code: 400,
      description: "Bad Request: message is not modified",
    });
    expect(info.outcome).toBe("message_not_modified");
  });

  it("classifies unknown 400s as error", () => {
    const info = classifyTelegramError({
      error_code: 400,
      description: "Bad Request: something else",
    });
    expect(info.outcome).toBe("error");
  });

  it("classifies non-Telegram errors as error", () => {
    const info = classifyTelegramError(new Error("network failure"));
    expect(info.outcome).toBe("error");
  });
});

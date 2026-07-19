import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Context } from "grammy";
import type { Config } from "./config.ts";
import { AgentRunner } from "./agent/mod.ts";
import { PiAgentBackend } from "./agent/backend.ts";
import { createFauxPiServices } from "./test/faux-pi-services.ts";
import type { Api, Model } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { replyNoActiveSession, buildBot } from "./bot.ts";
import { memoryDir } from "./memory/paths.ts";
import { metricsPath } from "./sessions/paths.ts";
import { workdirPath, soulMdPath } from "./workspace/paths.ts";
import { piAgentDir } from "./pi-host.ts";
import { TEXT_SPLIT_THRESHOLD, TEXT_SPLIT_WINDOW_MS } from "./tg/mod.ts";

const runnerInstances: MockAgentRunner[] = [];

class MockAgentRunner {
  static nextPrompt?: (content: unknown, buffer: unknown) => Promise<void>;
  static nextFollowUp?: (content: unknown) => Promise<void>;

  readonly sessionId: string;
  streaming = false;
  abortTimedOut = false;
  abortBeforeInit = false;
  isPrompting = false;
  readonly prompt = mock(async (content: unknown, buffer: unknown) => {
    if (this.abortBeforeInit) {
      this.abortBeforeInit = false;
      throw new Error("Turn aborted before it started.");
    }
    this.isPrompting = true;
    this.streaming = true;
    try {
      await MockAgentRunner.nextPrompt?.(content, buffer);
    } finally {
      this.streaming = false;
      this.isPrompting = false;
    }
  });
  readonly followUp = mock(async (content: unknown) => {
    await MockAgentRunner.nextFollowUp?.(content);
  });
  readonly dispose = mock(() => {});
  readonly abort = mock(async () => {
    if (!this.streaming) this.abortBeforeInit = true;
    this.streaming = false;
  });
  readonly compact = mock(async () => ({ tokensBefore: 10_000 }));
  readonly setThinkingLevel = mock(() => {});
  readonly getActiveToolNames = mock(() => []);
  readonly markAbortTimedOut = mock(() => {
    this.abortTimedOut = true;
  });
  readonly modelName?: string;
  readonly skillsLoaded = null;
  readonly contextTokens = null;
  readonly contextFiles = null;

  constructor(opts: { sessionId: string; modelName?: string }) {
    this.sessionId = opts.sessionId;
    this.modelName = opts.modelName;
    runnerInstances.push(this);
  }

  get isStreaming(): boolean {
    return this.streaming;
  }

  get isAbortTimedOut(): boolean {
    return this.abortTimedOut;
  }
}

const dirs: string[] = [];
let currentFaux: (() => void) | undefined = undefined;
const originalFetch = globalThis.fetch;

function makeConfig(): Config {
  const goblinHome = mkdtempSync(join(tmpdir(), "goblin-bot-test-"));
  dirs.push(goblinHome);
  return {
    botToken: "123:token",
    allowedTgUserIds: new Set([1]),
    modelName: "poe/GPT-4o",
    poeApiKey: "poe-key",
    goblinHome,
    logLevel: "error",
    toolVisibility: "standard",
    skillSources: "goblin-only",
    voiceName: "en-US-AriaNeural",
    favorites: [],
  };
}

function makeApi() {
  const sent: string[] = [];
  const edits: string[] = [];
  let failTopicNotFound = false;
  let failParseOnce = false;
  let parseErrorThrown = false;
  const getFile = mock(async (_fileId: unknown) => ({ file_path: "photos/x.jpg" }));
  const getChatMemberCount = mock(async (_chatId: unknown) => 1);
  const sendMessage = mock(async (_chatId: number | string, text: string) => {
    sent.push(text);
    return { message_id: sent.length, date: 1, chat: { id: 1, type: "private" }, text };
  });
  const editMessageText = mock(async (_chatId: number | string, _messageId: number, text: string) => {
    edits.push(text);
    return true;
  });
  return {
    sent,
    edits,
    api: {
      getMe: mock(async () => ({ id: 99, is_bot: true, first_name: "Goblin", username: "goblinbot" })),
      getChatMemberCount,
      getFile,
      sendMessage,
      sendRichMessage: mock(async (_chatId: number | string, richMessage: { markdown?: string }) => {
        const text = richMessage.markdown ?? "";
        sent.push(text);
        return { message_id: sent.length, date: 1, chat: { id: 1, type: "private" }, text };
      }),
      sendRichMessageDraft: mock(async () => true),
      sendMessageDraft: mock(async () => true),
      editMessageText,
      sendChatAction: mock(async () => true),
      sendVoice: mock(async () => ({ message_id: 1 })),
      sendPhoto: mock(async () => ({ message_id: 1 })),
      sendDocument: mock(async () => ({ message_id: 1 })),
      editForumTopic: mock(async () => true),
    },
    failParseOnce(shouldFail = true) { failParseOnce = shouldFail; },
    async transform(method: string, payload: Record<string, unknown>) {
      if (method === "getMe") return { ok: true as const, result: await this.api.getMe() };
      if (method === "getChatMemberCount") return { ok: true as const, result: await getChatMemberCount(payload.chat_id) };
      if (method === "getFile") return { ok: true as const, result: await getFile(payload.file_id) };
      if (method === "sendMessage") {
        if (failTopicNotFound && payload.message_thread_id !== undefined) {
          throw { error_code: 400, description: "Bad Request: topic not found" };
        }
        if (failParseOnce && !parseErrorThrown && (payload as Record<string, unknown>).parse_mode === "MarkdownV2") {
          parseErrorThrown = true;
          throw { error_code: 400, description: "Bad Request: can't parse markdown" };
        }
        return { ok: true as const, result: await sendMessage(payload.chat_id as number | string, payload.text as string) };
      }
      if (method === "sendRichMessage") {
        if (failTopicNotFound && payload.message_thread_id !== undefined) {
          throw { error_code: 400, description: "Bad Request: topic not found" };
        }
        if (failParseOnce && !parseErrorThrown) {
          parseErrorThrown = true;
          throw { error_code: 400, description: "Bad Request: can't parse markdown" };
        }
        const richMessage = payload.rich_message as { markdown?: string } | undefined;
        const text = richMessage?.markdown ?? "";
        return { ok: true as const, result: await sendMessage(payload.chat_id as number | string, text) };
      }
      if (method === "editMessageText") {
        let text: string;
        if (typeof payload.text === "string") {
          text = payload.text;
        } else {
          const richMessage = payload.rich_message as { markdown?: string } | undefined;
          text = richMessage?.markdown ?? "";
        }
        return { ok: true as const, result: await editMessageText(payload.chat_id as number | string, payload.message_id as number, text) };
      }
      if (method === "sendChatAction") return { ok: true as const, result: true };
      if (method === "sendRichMessageDraft" || method === "sendMessageDraft") return { ok: true as const, result: true };
      if (method === "sendVoice" || method === "sendPhoto" || method === "sendDocument") return { ok: true as const, result: { message_id: 1 } };
      if (method === "editForumTopic") return { ok: true as const, result: true };
      throw new Error(`unexpected Telegram API method ${method}`);
    },
    failTopicNotFound() { failTopicNotFound = true; },
  };
}

async function makeBot(cfgPatch: Partial<Config> = {}) {
  const { buildBot: buildBotImpl } = await import("./bot.ts");
  const base = makeConfig();
  const cfg: Config = Object.freeze({ ...base, ...cfgPatch });
  const built = buildBotImpl(cfg, {
    createAgentRunner: (opts) => new MockAgentRunner(opts) as unknown as AgentRunner,
  });
  const api = makeApi();
  (built.bot as unknown as { botInfo: unknown }).botInfo = { id: 99, is_bot: true, first_name: "Goblin", username: "goblinbot" };
  built.bot.api.config.use((async (_prev: unknown, method: string, payload: unknown) => api.transform(method, payload as Record<string, unknown>)) as never);
  return { ...built, cfg, api };
}

async function makeBotWithRealRunner(cfgPatch: Partial<Config> = {}) {
  const base = makeConfig();
  const cfg: Config = Object.freeze({ ...base, ...cfgPatch });
  const home = cfg.goblinHome;
  mkdirSync(workdirPath(home), { recursive: true });
  mkdirSync(piAgentDir(home), { recursive: true });
  mkdirSync(memoryDir(home), { recursive: true });
  mkdirSync(dirname(soulMdPath(home)), { recursive: true });
  writeFileSync(soulMdPath(home), "test goblin identity\n", "utf-8");

  const faux = registerFauxProvider();
  currentFaux = faux.unregister;

  const built = buildBot(cfg, {
    createAgentRunner: (opts) =>
      new AgentRunner({
        ...opts,
        modelName: "faux/faux-1",
        resolvedModel: { model: faux.getModel() as Model<Api>, apiKey: "fake-key", thinkingLevel: "medium" },
        backendFactory: (bo) =>
          new PiAgentBackend({
            ...bo,
            deps: { createPiServices: (home) => createFauxPiServices(home, faux) },
          }),
      }),
  });
  const api = makeApi();
  (built.bot as unknown as { botInfo: unknown }).botInfo = { id: 99, is_bot: true, first_name: "Goblin", username: "goblinbot" };
  built.bot.api.config.use((async (_prev: unknown, method: string, payload: unknown) => api.transform(method, payload as Record<string, unknown>)) as never);
  return { ...built, cfg, api, faux };
}

function textUpdate(text: string, fromId = 1, messageId = 1) {
  return {
    update_id: 1,
    message: {
      message_id: messageId,
      date: 1,
      chat: { id: 1, type: "private", first_name: "Daniel" },
      from: { id: fromId, is_bot: false, first_name: "Daniel", username: "bermudi" },
      text,
      entities: text.startsWith("/") ? [{ type: "bot_command" as const, offset: 0, length: text.split(/\s/u)[0]!.length }] : undefined,
    },
  } as const;
}

function topicTextUpdate(text: string) {
  return {
    update_id: 4,
    message: {
      message_id: 4,
      date: 1,
      chat: { id: -100, type: "supergroup", title: "Forum", is_forum: true },
      is_topic_message: true,
      message_thread_id: 42,
      from: { id: 1, is_bot: false, first_name: "Daniel", username: "bermudi" },
      text,
      entities: text.startsWith("/") ? [{ type: "bot_command" as const, offset: 0, length: text.split(/\s/u)[0]!.length }] : undefined,
    },
  } as const;
}

function photoUpdate(caption = "look") {
  return {
    update_id: 2,
    message: {
      message_id: 2,
      date: 1,
      chat: { id: 1, type: "private", first_name: "Daniel" },
      from: { id: 1, is_bot: false, first_name: "Daniel", username: "bermudi" },
      caption,
      photo: [{ file_id: "small", file_unique_id: "s", width: 1, height: 1 }, { file_id: "big", file_unique_id: "b", width: 2, height: 2 }],
    },
  } as const;
}

function documentUpdate(fileName: string, caption?: string) {
  return {
    update_id: 3,
    message: {
      message_id: 3,
      date: 1,
      chat: { id: 1, type: "private", first_name: "Daniel" },
      from: { id: 1, is_bot: false, first_name: "Daniel", username: "bermudi" },
      document: { file_id: "doc", file_unique_id: "d", file_name: fileName },
      caption,
    },
  } as const;
}

function voiceUpdate(mimeType = "audio/ogg") {
  return {
    update_id: 5,
    message: {
      message_id: 5,
      date: 1,
      chat: { id: 1, type: "private", first_name: "Daniel" },
      from: { id: 1, is_bot: false, first_name: "Daniel", username: "bermudi" },
      voice: { file_id: "voice", file_unique_id: "v", duration: 1, mime_type: mimeType },
    },
  } as const;
}

function audioUpdate(fileName: string, caption?: string) {
  return {
    update_id: 6,
    message: {
      message_id: 6,
      date: 1,
      chat: { id: 1, type: "private", first_name: "Daniel" },
      from: { id: 1, is_bot: false, first_name: "Daniel", username: "bermudi" },
      audio: { file_id: "audio", file_unique_id: "a", duration: 1, file_name: fileName },
      caption,
    },
  } as const;
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (err: unknown) => void } {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function readTelegramEvents(home: string, sessionId: string): Record<string, unknown>[] {
  try {
    const raw = readFileSync(metricsPath(home, sessionId), "utf-8").trim();
    if (!raw) return [];
    return raw.split("\n").map((line) => JSON.parse(line)).filter((e) => e.type === "telegram");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return [];
    throw e;
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 250;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

beforeEach(() => {
  runnerInstances.length = 0;
  MockAgentRunner.nextPrompt = undefined;
  MockAgentRunner.nextFollowUp = undefined;
  currentFaux = undefined;
});

afterEach(() => {
  currentFaux?.();
  globalThis.fetch = originalFetch;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("replyNoActiveSession", () => {
  it("replies in DMs without a session", () => {
    const reply = mock(async () => ({}));
    const ctx = { reply } as unknown as Context;
    replyNoActiveSession(ctx, { chatId: 1 }, "text");
    expect(reply).toHaveBeenCalledWith(
      "`[info]` No active session\\. Use /new to start one\\.",
      { disable_notification: true, parse_mode: "MarkdownV2" },
    );
  });

  it("does not reply in topics without a session", () => {
    const reply = mock(async () => ({}));
    const ctx = { reply } as unknown as Context;
    replyNoActiveSession(ctx, { chatId: 1, topicId: 42 }, "text");
    expect(reply).not.toHaveBeenCalled();
  });
});

describe("buildBot integration", () => {
  it("/new creates a session and replies", async () => {
    const built = await makeBot();
    await built.bot.handleUpdate(textUpdate("/new"));

    expect(built.manager.list()).toHaveLength(1);
    expect(built.api.sent[0]).toContain("Created new session");
  });

  it("/archive disposes/removes the current runner and replies", async () => {
    const built = await makeBot();
    await built.bot.handleUpdate(textUpdate("/new"));
    const session = built.manager.list()[0]!;
    const prior = built.agentRunners.get(session.id)! as unknown as MockAgentRunner;

    await built.bot.handleUpdate(textUpdate("/archive"));

    expect(prior.dispose).toHaveBeenCalled();
    expect(built.agentRunners.has(session.id)).toBe(false);
    expect(built.api.sent.at(-1)).toContain("Session archived");
  });

  it("/project changes project directory and forces runner disposal", async () => {
    const built = await makeBot();
    await built.bot.handleUpdate(textUpdate("/new"));
    const session = built.manager.list()[0]!;
    const prior = built.agentRunners.get(session.id)! as unknown as MockAgentRunner;

    await built.bot.handleUpdate(textUpdate(`/project ${built.cfg.goblinHome}`));

    expect(built.manager.getProjectDir({ chatId: 1 })).toBe(built.cfg.goblinHome);
    expect(prior.dispose).toHaveBeenCalled();
    expect(built.agentRunners.has(session.id)).toBe(false);
  });

  it("unknown DM command without active session prompts for /new", async () => {
    const built = await makeBot();
    await built.bot.handleUpdate(textUpdate("/foo"));
    expect(built.api.sent).toEqual(["`[info]` No active session\\. Use /new to start one\\."]);
  });

  it("text messages release the update handler while the runner is busy", async () => {
    const built = await makeBot();
    await built.bot.handleUpdate(textUpdate("/new"));
    const pending = deferred();
    MockAgentRunner.nextPrompt = async () => {
      await pending.promise;
    };

    const handled = built.bot.handleUpdate(textUpdate("slow"));

    try {
      expect(await settlesWithin(handled, 25)).toBe(true);
    } finally {
      pending.resolve();
      await handled;
    }
  });

  it("/cancel reaches a runner with a pending prompt", async () => {
    const built = await makeBot();
    await built.bot.handleUpdate(textUpdate("/new"));
    const pending = deferred();
    MockAgentRunner.nextPrompt = async () => {
      await pending.promise;
    };

    await built.bot.handleUpdate(textUpdate("slow"));
    const runner = runnerInstances.at(-1)!;
    await waitFor(() => runner.isStreaming);

    const handled = built.bot.handleUpdate(textUpdate("/cancel"));

    try {
      expect(await settlesWithin(handled, 25)).toBe(true);
      expect(runner.abort).toHaveBeenCalled();
      expect(built.api.sent.at(-1)).toContain("Cancelled");
    } finally {
      pending.resolve();
      await handled;
    }
  });

  it("coalesces two adjacent text fragments into a single prompt", async () => {
    const built = await makeBot();
    await built.bot.handleUpdate(textUpdate("/new"));

    const head = "A".repeat(TEXT_SPLIT_THRESHOLD);
    const tail = "tail-of-split-message";

    await built.bot.handleUpdate(textUpdate(head, 1, 2));
    await built.bot.handleUpdate(textUpdate(tail, 1, 3));

    const runner = runnerInstances.at(-1)!;
    // Wait past the coalescer debounce window.
    await new Promise<void>((resolve) => setTimeout(resolve, TEXT_SPLIT_WINDOW_MS + 100));

    expect(runner.prompt).toHaveBeenCalledTimes(1);
    const content = runner.prompt.mock.calls[0]![0] as string;
    expect(content).toContain(head + tail);
  });

  it("photo messages release the update handler while download is pending", async () => {
    const built = await makeBot();
    await built.bot.handleUpdate(textUpdate("/new"));
    const pending = deferred();
    globalThis.fetch = mock(async () => {
      await pending.promise;
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "3" } });
    }) as unknown as typeof fetch;

    const handled = built.bot.handleUpdate(photoUpdate("slow image") as never);

    try {
      expect(await settlesWithin(handled, 25)).toBe(true);
      expect(runnerInstances.at(-1)!.prompt).not.toHaveBeenCalled();
    } finally {
      pending.resolve();
      await handled;
      await waitFor(() => runnerInstances.at(-1)!.prompt.mock.calls.length === 1);
    }
  });

  // Steer-vs-queue, steer-race fallback, stale-runner-after-dispose, and
  // idle-prompt behavior are covered at the intake seam in
  // src/tg/intake.test.ts. This suite keeps the adapter-level end-to-end
  // cases: command replies, media saving, allowlist, /queue reply-text, and
  // the nonblocking "update handler resolves before work settles" timing.

  it("/queue while idle runs immediately and replies Running.", async () => {
    const built = await makeBot();
    await built.bot.handleUpdate(textUpdate("/new"));

    await built.bot.handleUpdate(textUpdate("/queue do this now"));
    await waitFor(() => runnerInstances.at(-1)!.prompt.mock.calls.length === 1);

    expect(built.api.sent.at(-1)).toBe("`[ok]` Running\\.");
    const runner = runnerInstances.at(-1)!;
    expect(runner.abort).not.toHaveBeenCalled();
    const content = runner.prompt.mock.calls[0]![0] as string;
    expect(content).toContain("do this now");
  });

  it("/queue with no argument replies usage and schedules nothing", async () => {
    const built = await makeBot();
    await built.bot.handleUpdate(textUpdate("/new"));

    await built.bot.handleUpdate(textUpdate("/queue"));
    await flushMicrotasks();

    expect(built.api.sent.at(-1)).toBe("`[info]` Usage: /queue <text\\>");
    expect(runnerInstances.at(-1)!.prompt).not.toHaveBeenCalled();
  });

  it("/queue with no active session replies No active session.", async () => {
    const built = await makeBot();

    await built.bot.handleUpdate(textUpdate("/queue do something"));

    expect(built.api.sent.at(-1)).toBe("`[info]` No active session\\.");
    expect(runnerInstances).toHaveLength(0);
  });

  it("photo messages download image content and prompt the runner", async () => {
    const built = await makeBot();
    globalThis.fetch = mock(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "3" } })) as unknown as typeof fetch;
    await built.bot.handleUpdate(textUpdate("/new"));

    await built.bot.handleUpdate(photoUpdate("look") as never);

    const runner = runnerInstances.at(-1)!;
    await waitFor(() => runner.prompt.mock.calls.length === 1);
    expect(built.api.api.getFile).toHaveBeenCalledWith("big");
    const content = runner.prompt.mock.calls[0]![0] as Array<{ type: string; text?: string; data?: string }>;
    expect(content[0]).toEqual({ type: "text", text: "[From: Daniel (@bermudi)]" });
    expect(content[1]).toEqual({ type: "text", text: "look" });
    expect(content[2]?.type).toBe("image");
  });

  it("document messages save files and prompt the runner", async () => {
    const built = await makeBot();
    globalThis.fetch = mock(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "3" } })) as unknown as typeof fetch;
    await built.bot.handleUpdate(textUpdate("/new"));
    await built.bot.handleUpdate(textUpdate(`/project ${built.cfg.goblinHome}`));

    await built.bot.handleUpdate(documentUpdate("notes.txt", "please inspect") as never);
    await waitFor(() => runnerInstances.at(-1)!.prompt.mock.calls.length === 1);

    expect(built.api.api.getFile).toHaveBeenCalledWith("doc");
    expect(existsSync(join(built.cfg.goblinHome, "notes.txt"))).toBe(true);
    expect(built.api.sent.at(-1)).toBe("`[ok]` Saved notes\\.txt\\.");
    const prompt = runnerInstances.at(-1)!.prompt.mock.calls[0]![0] as string;
    expect(prompt).toBe("[From: Daniel (@bermudi)]\nplease inspect\n\n[File `notes.txt` saved to project directory.]");
  });

  it("document messages without projectDir forward captions", async () => {
    const built = await makeBot();
    await built.bot.handleUpdate(textUpdate("/new"));

    await built.bot.handleUpdate(documentUpdate("notes.txt", "caption only") as never);
    await waitFor(() => runnerInstances.at(-1)!.prompt.mock.calls.length === 1);

    expect(built.api.api.getFile).not.toHaveBeenCalled();
    const prompt = runnerInstances.at(-1)!.prompt.mock.calls[0]![0] as string;
    expect(prompt).toBe("[From: Daniel (@bermudi)]\ncaption only");
  });

  it("document messages reject unsafe filenames", async () => {
    const built = await makeBot();
    globalThis.fetch = mock(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "3" } })) as unknown as typeof fetch;
    await built.bot.handleUpdate(textUpdate("/new"));
    await built.bot.handleUpdate(textUpdate(`/project ${built.cfg.goblinHome}`));

    await built.bot.handleUpdate(documentUpdate(".") as never);
    await waitFor(() => built.api.sent.at(-1)!.includes("Rejected: unsafe filename"));

    expect(built.api.sent.at(-1)).toBe("`[warn]` Rejected: unsafe filename\\.");
  });

  it("voice messages transcribe, save the original file, and prompt the runner", async () => {
    // Voice intake now routes through Groq ASR: the Telegram download and the
    // Groq transcription call share globalThis.fetch, distinguished by URL.
    const built = await makeBot({ groqApiKey: "groq-key" });
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("api.telegram.org")) {
        return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "3" } });
      }
      // Groq ASR endpoint.
      return new Response(JSON.stringify({ text: "the transcript text" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await built.bot.handleUpdate(textUpdate("/new"));
    await built.bot.handleUpdate(textUpdate(`/project ${built.cfg.goblinHome}`));

    await built.bot.handleUpdate(voiceUpdate() as never);
    await waitFor(() => runnerInstances.at(-1)!.prompt.mock.calls.length === 1);

    expect(built.api.api.getFile).toHaveBeenCalledWith("voice");
    const saved = built.api.sent.at(-1)!;
    // The reply is MarkdownV2-escaped: `[ok]` Saved voice\-NNN\.oga\.
    expect(saved.includes("Saved voice\\-")).toBe(true);
    expect(saved.endsWith("\\.oga\\.")).toBe(true);
    // Extract the voice filename from the formatted reply: `[ok]` Saved voice\-NNN\.oga\.
    const match = saved.match(/Saved (voice\\-\d+\\\.oga)\\\./);
    const safeName = match![1]!.replace(/\\/g, "");
    expect(existsSync(join(built.cfg.goblinHome, safeName))).toBe(true);
    const prompt = runnerInstances.at(-1)!.prompt.mock.calls[0]![0] as string;
    expect(prompt).toContain("[Voice message transcript]\nthe transcript text");
    expect(prompt).toContain(`[Voice file \`${safeName}\` saved to project directory.]`);
  });

  it("audio messages save files and prompt the runner", async () => {
    const built = await makeBot();
    globalThis.fetch = mock(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "3" } })) as unknown as typeof fetch;
    await built.bot.handleUpdate(textUpdate("/new"));
    await built.bot.handleUpdate(textUpdate(`/project ${built.cfg.goblinHome}`));

    await built.bot.handleUpdate(audioUpdate("song.mp3", "listen") as never);
    await waitFor(() => runnerInstances.at(-1)!.prompt.mock.calls.length === 1);

    expect(built.api.api.getFile).toHaveBeenCalledWith("audio");
    expect(existsSync(join(built.cfg.goblinHome, "song.mp3"))).toBe(true);
    expect(built.api.sent.at(-1)).toBe("`[ok]` Saved song\\.mp3\\.");
    const prompt = runnerInstances.at(-1)!.prompt.mock.calls[0]![0] as string;
    expect(prompt).toBe("[From: Daniel (@bermudi)]\nlisten\n\n[Audio file `song.mp3` saved to project directory.]");
  });

  it("/resume of the already-bound session disposes the old runner before replacing it", async () => {
    const built = await makeBot();
    await built.bot.handleUpdate(textUpdate("/new"));
    const session = built.manager.list()[0]!;
    const oldRunner = built.agentRunners.get(session.id)! as unknown as MockAgentRunner;

    await built.bot.handleUpdate(textUpdate(`/resume ${session.id}`));

    expect(oldRunner.dispose).toHaveBeenCalled();
    expect(built.agentRunners.get(session.id)).not.toBe(oldRunner);
  });

  it("archives orphaned topic memory when Telegram reports topic not found", async () => {
    const built = await makeBot();
    await built.bot.handleUpdate(topicTextUpdate("/new") as never);
    const topicMemoryDir = join(memoryDir(built.cfg.goblinHome), "topics", "-100", "42");
    mkdirSync(topicMemoryDir, { recursive: true });
    writeFileSync(join(topicMemoryDir, "memory.md"), "orphaned memory");
    built.api.failTopicNotFound();
    MockAgentRunner.nextPrompt = async (_content, buffer) => {
      const callbacks = buffer as { onTextDelta: (text: string) => void; flushResponse: (force?: boolean) => Promise<void> };
      callbacks.onTextDelta("hello");
      await callbacks.flushResponse(true);
    };

    await built.bot.handleUpdate(topicTextUpdate("hello") as never);

    expect(existsSync(join(memoryDir(built.cfg.goblinHome), "archive", "topics", "-100", "42", "memory.md"))).toBe(true);
  });

  it("allowlist drops non-allowed DMs before commands run", async () => {
    const built = await makeBot();
    await built.bot.handleUpdate(textUpdate("/new", 2));
    expect(built.api.sent).toEqual([]);
    expect(built.manager.list()).toEqual([]);
  });

  it("records system reply sendMessage success metrics", async () => {
    const built = await makeBot();
    await built.bot.handleUpdate(textUpdate("/new"));
    const session = built.manager.list()[0]!;
    const events = readTelegramEvents(built.cfg.goblinHome, session.id);
    const systemSuccess = events.find((e) => e.op === "sendMessage" && e.channel === "system" && e.outcome === "success");
    expect(systemSuccess).toBeDefined();
  });

  it("records system reply parse-error failure and retry success", async () => {
    const built = await makeBot();
    built.api.failParseOnce();
    await built.bot.handleUpdate(textUpdate("/new"));
    const session = built.manager.list()[0]!;
    const events = readTelegramEvents(built.cfg.goblinHome, session.id);
    expect(events.filter((e) => e.op === "sendMessage" && e.channel === "system").length).toBe(2);
    const first = events.find((e) => e.op === "sendMessage" && e.channel === "system" && e.outcome === "error");
    expect(first).toBeDefined();
    expect(first?.errorCode).toBe(400);
    expect(first?.errorDescription).toContain("parse");
    const second = events.find((e) => e.op === "sendMessage" && e.channel === "system" && e.outcome === "success");
    expect(second).toBeDefined();
  });
});

describe("vertical slice with real AgentRunner", () => {
  it("streams a faux LLM response end-to-end through buildBot", async () => {
    const built = await makeBotWithRealRunner();
    const response = "Hello from the faux provider";
    built.faux.setResponses([fauxAssistantMessage(response)]);

    await built.bot.handleUpdate(textUpdate("/new"));
    await built.bot.handleUpdate(textUpdate("hello"));

    await waitFor(
      () =>
        built.api.sent.some((text) => text.includes(response)) ||
        built.api.edits.some((text) => text.includes(response)),
    );
    expect(built.api.sent.some((text) => text.includes(response)) || built.api.edits.some((text) => text.includes(response))).toBe(true);
  });
});

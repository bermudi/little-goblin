import { existsSync } from "node:fs";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Bot, Context } from "grammy";
import type { Config } from "../config.ts";
import { log } from "../log.ts";
import { sessionDir } from "../sessions/paths.ts";
import type { ChatLocator, SessionManager, SessionState } from "../sessions/mod.ts";
import type { AgentRunner } from "../agent/mod.ts";
import type { ResolvedModel } from "../agent/models.ts";
import type { SubagentRunner } from "../subagents/mod.ts";
import { DEFAULT_CASCADE_TIMEOUT_MS, interruptAndCascade } from "../interrupt.ts";
import { generateDiagnostics } from "../diagnostics.ts";
import { cancelReply } from "./cancel.ts";
import { executeNew } from "./new.ts";
import { executeArchive } from "./archive.ts";
import { executeProject } from "./project.ts";
import { executeModel } from "./model.ts";
import { executeCompact } from "./compact.ts";
import { executeName } from "./name.ts";
import { executeResume } from "./resume.ts";
import { executeThink, ALL_LEVELS } from "./think.ts";
import { parseCommandArg } from "./parse.ts";
import {
  CANCEL_SUBAGENT_USAGE_REPLY,
  formatSubagentsList,
  parseReviveSubagentArgs,
  parseSubagentId,
  REVIVE_SUBAGENT_USAGE_REPLY,
} from "./subagents.ts";
import { executeVoice } from "./voice.ts";
import { pingHandler } from "./ping.ts";
import { buildStartHandler } from "./start.ts";
import { buildScheduleDeps, executeSchedule } from "./schedule.ts";
import type { ScheduleStore } from "../scheduler/store.ts";
import type { SystemTag } from "../tg/format.ts";

// ---------------------------------------------------------------------------
// Shared dispatch types (owned by the registry; re-exported by dispatch.ts)
// ---------------------------------------------------------------------------

export type SideEffect =
  | { kind: "runner-created"; session: SessionState; locator: ChatLocator }
  | { kind: "runner-disposed"; sessionId: string }
  | { kind: "queue-prompt"; session: SessionState; text: string };

export type DispatchResult =
  | { kind: "replied"; reply: string; tag?: SystemTag; sideEffects: SideEffect[] }
  | { kind: "handled"; sideEffects: SideEffect[] }
  | { kind: "fallthrough" };

export interface DispatchDeps {
  manager: SessionManager;
  subagentRunner: SubagentRunner;
  cfg: Config;
  tryResolveModel: (
    cfg: Config,
    session: SessionState | null,
    runner?: AgentRunner,
  ) => ResolvedModel | undefined;
  interruptAndCascade: typeof interruptAndCascade;
  /**
   * Schedule store for `/schedule`. Optional so callers that don't wire
   * scheduling (e.g. unit tests of other commands) still satisfy the type.
   * The `/schedule` handler returns a usage reply when this is absent.
   */
  scheduleStore?: ScheduleStore;
}

export interface DispatchOpts {
  command: string;
  deps: DispatchDeps;
  rawText: string;
  locator: ChatLocator;
  isSupergroup: boolean;
  session: SessionState | null;
  existingRunner: AgentRunner | null;
  bot?: Bot;
}

export type CommandHandler = (opts: DispatchOpts) => Promise<DispatchResult>;

export type GrammyHandlerFactory = (deps: { manager: SessionManager }) => (ctx: Context) => Promise<void>;

// ---------------------------------------------------------------------------
// CommandDef
// ---------------------------------------------------------------------------

/**
 * When a command runs relative to an in-flight turn.
 *
 * - `"instant"` — runs immediately, never touches the in-flight turn. Used by
 *   read-only commands (lists, diagnostics) and commands whose effect is
 *   independent of the runner's streaming state.
 * - `"queue"` — if the runner is streaming, the command is deferred: the user
 *   gets an instant "Queued." ack, and the command runs (with a follow-up
 *   reply) once the turn settles naturally. If the runner is idle, runs
 *   immediately. Used by state-mutating commands whose effects want the
 *   runner idle (model switch, project rebind, archive, etc.).
 * - `"interrupt"` — aborts the in-flight turn via `interruptAndCascade` before
 *   running. Reserved for `/cancel`, whose entire semantics is "stop now."
 *
 * A function form lets a single command vary its timing by argument — e.g.
 * `/model` (list) is instant, `/model 2` (switch) is queue.
 */
export type CommandTiming = "instant" | "queue" | "interrupt";

export interface CommandDef {
  /** Canonical name without leading slash, e.g. "cancel". */
  name: string;
  /** Human-readable description shown in /help and the Telegram menu. */
  description: string;
  /** Alternative names (without slash). */
  aliases?: readonly string[];
  /** Argument placeholder shown in help, e.g. "<name>" or "[index]". */
  argsHint?: string;
  /**
   * When this command runs relative to an in-flight turn. Defaults to
   * `"instant"`. See {@link CommandTiming}.
   */
  timing?: CommandTiming | ((rawText: string) => CommandTiming);
  /** Dispatched from the message:text handler. Mutually exclusive with grammyHandler. */
  handler?: CommandHandler;
  /** Registered via bot.command(). Mutually exclusive with handler. */
  grammyHandler?: GrammyHandlerFactory;
}

// ---------------------------------------------------------------------------
// Helpers shared by handlers
// ---------------------------------------------------------------------------

function replied(reply: string, sideEffects: SideEffect[] = [], tag?: SystemTag): DispatchResult {
  return { kind: "replied", reply, sideEffects, tag };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Handler functions — one per dispatched command. These wrap the existing
// execute* helpers and carry over the side-effect logic from the former
// dispatch.ts switch verbatim.
// ---------------------------------------------------------------------------

const cancelHandler: CommandHandler = async ({ deps, session, existingRunner }) => {
  // /cancel is the sole interrupter: it aborts the in-flight turn itself,
  // rather than relying on a dispatch pre-check. The cascade result drives
  // the honest reply ("Cancelled." vs "Nothing to cancel." vs timeout suffix).
  const cascade = await deps.interruptAndCascade(
    existingRunner,
    deps.subagentRunner,
    DEFAULT_CASCADE_TIMEOUT_MS,
    session?.id ?? null,
  );
  return replied(cancelReply({
    hasSession: session !== null,
    cascade,
    cascadeTimeoutMs: DEFAULT_CASCADE_TIMEOUT_MS,
  }), [], cascade.attemptedMain || cascade.attemptedSubagents > 0 ? "ok" : "info");
};

const newHandler: CommandHandler = async ({ deps, locator, isSupergroup, session }) => {
  const { manager } = deps;
  const sideEffects: SideEffect[] = [];
  const priorSession = session;
  try {
    const result = executeNew({
      createSession: () => manager.createForChat(locator, { isSupergroup }),
    });
    if (priorSession) sideEffects.push({ kind: "runner-disposed", sessionId: priorSession.id });
    sideEffects.push({ kind: "runner-created", session: result.session, locator });
    return replied(result.reply, sideEffects, "ok");
  } catch (err) {
    log.error("new session creation failed", { error: String(err), sessionId: priorSession?.id });
    return replied("Failed to reset session. Please try again.", [], "error");
  }
};

const archiveHandler: CommandHandler = async ({ deps, session }) => {
  const { manager, cfg } = deps;
  const sideEffects: SideEffect[] = [];
  try {
    const result = executeArchive({
      hasSession: session !== null,
      sessionExists: session !== null && existsSync(sessionDir(cfg.goblinHome, session.id)),
      archive: () => {
        manager.archive(session!.id);
        sideEffects.push({ kind: "runner-disposed", sessionId: session!.id });
      },
    });
    const tag: SystemTag = result.kind === "archived" ? "ok" : "info";
    return replied(result.reply, sideEffects, tag);
  } catch (err) {
    log.error("archive failed", { error: String(err), sessionId: session?.id });
    return replied("Failed to archive session. Please try again.", [], "error");
  }
};

const projectHandler: CommandHandler = async ({ deps, locator, session, rawText }) => {
  const { manager } = deps;
  const sideEffects: SideEffect[] = [];
  try {
    const result = executeProject({
      hasSession: session !== null,
      rawText,
      setProjectDir: (dir) => {
        if (!session) return;
        manager.bindProjectDir(locator, dir);
        sideEffects.push({ kind: "runner-disposed", sessionId: session.id });
      },
    });
    const tag: SystemTag = result.kind === "set" || result.kind === "cleared" ? "ok"
      : result.kind === "bad-path" ? "warn"
      : "info";
    return replied(result.reply, sideEffects, tag);
  } catch (err) {
    log.error("project failed", { error: String(err), sessionId: session?.id });
    return replied("Failed to set project directory. Please try again.", [], "error");
  }
};

const modelHandler: CommandHandler = async ({ deps, session, existingRunner, rawText }) => {
  const { manager, cfg } = deps;
  const sideEffects: SideEffect[] = [];
  try {
    const currentModelResolved = deps.tryResolveModel(cfg, session, existingRunner ?? undefined);
    const result = executeModel({
      hasSession: session !== null,
      rawText,
      favorites: cfg.favorites,
      cfg,
      currentModelName: existingRunner?.modelName ?? session?.modelName ?? cfg.modelName,
      currentThinkingLevel: session?.thinkingLevel,
      currentResolvedModel: currentModelResolved,
      setModelName: (name) => {
        if (!session) return;
        manager.setModelName(session.id, name);
      },
      onThinkingLevelClamped: (newLevel) => {
        if (!session) return;
        manager.setThinkingLevel(session.id, newLevel);
      },
    });
    if ((result.kind === "set" || result.kind === "cleared") && existingRunner) {
      const targetName = result.kind === "set" ? result.modelName : cfg.modelName;
      await existingRunner.setModel(targetName);
    }
    const tag: SystemTag = result.kind === "set" || result.kind === "cleared" ? "ok"
      : result.kind === "no-favorites" || result.kind === "bad-index" || result.kind === "bad-model" ? "warn"
      : "info";
    return replied(result.reply, sideEffects, tag);
  } catch (err) {
    log.error("model failed", { error: String(err), sessionId: session?.id });
    return replied("Failed to switch model. Please try again.", [], "error");
  }
};

const thinkHandler: CommandHandler = async ({ deps, session, existingRunner, rawText }) => {
  const { manager, cfg } = deps;
  try {
    const currentModelResolved = deps.tryResolveModel(cfg, session, existingRunner ?? undefined);
    const supportedLevels = currentModelResolved
      ? (getSupportedThinkingLevels(currentModelResolved.model) as readonly ThinkingLevel[])
      : ALL_LEVELS;
    const result = executeThink({
      hasSession: session !== null,
      rawText,
      currentLevel: session?.thinkingLevel ?? currentModelResolved?.thinkingLevel ?? "medium",
      supportedLevels,
      setThinkingLevel: (level) => {
        if (!session) return;
        manager.setThinkingLevel(session.id, level);
        try { existingRunner?.setThinkingLevel(level); } catch { /* best-effort */ }
      },
    });
    const thinkTag: SystemTag = result.kind === "set" || result.kind === "cleared" ? "ok"
      : result.kind === "bad-level" ? "warn"
      : "info";
    return replied(result.reply, [], thinkTag);
  } catch (err) {
    log.error("think failed", { error: String(err), sessionId: session?.id });
    return replied("Failed to set thinking level. Please try again.", [], "error");
  }
};

const debugHandler: CommandHandler = async ({ deps, locator, session, existingRunner }) => {
  const { manager, cfg, subagentRunner } = deps;
  if (!session) return replied("No active session.", [], "info");
  const diag = generateDiagnostics({
    session,
    runner: existingRunner,
    subagentRunner,
    goblinHome: cfg.goblinHome,
    modelName: cfg.modelName,
    projectDir: manager.getProjectDir(locator),
  });
  return replied(diag, [], "info");
};

const compactHandler: CommandHandler = async ({ session, existingRunner, rawText }) => {
  try {
    const result = await executeCompact({ hasSession: session !== null, rawText, runner: existingRunner });
    const tag: SystemTag = result.kind === "compacted" ? "ok"
      : result.kind === "failed" ? "error"
      : "info";
    return replied(result.reply, [], tag);
  } catch (err) {
    log.error("compact failed", { error: String(err), sessionId: session?.id });
    return replied("Failed to compact session. Please try again.", [], "error");
  }
};

const nameHandler: CommandHandler = async ({ deps, session, rawText }) => {
  const { manager } = deps;
  try {
    const result = executeName({
      hasSession: session !== null,
      rawText,
      session,
      setTitle: (title) => {
        if (!session) return;
        manager.setTitle(session.id, title);
      },
    });
    const tag: SystemTag = result.kind === "renamed" ? "ok" : "info";
    return replied(result.reply, [], tag);
  } catch (err) {
    log.error("name failed", { error: String(err), sessionId: session?.id });
    return replied("Failed to name session. Please try again.", [], "error");
  }
};

const resumeHandler: CommandHandler = async ({ deps, locator, isSupergroup, session, rawText }) => {
  const { manager } = deps;
  const sideEffects: SideEffect[] = [];
  try {
    const result = executeResume({
      rawText,
      sessions: manager.list(),
      bindSession: (sessionId) => manager.bindExistingToChat(sessionId, locator, { isSupergroup }),
    });
    if (result.kind === "resumed") {
      if (session) sideEffects.push({ kind: "runner-disposed", sessionId: session.id });
      sideEffects.push({ kind: "runner-created", session: result.session, locator });
    }
    const tag: SystemTag = result.kind === "resumed" ? "ok"
      : result.kind === "not-found" || result.kind === "ambiguous" ? "warn"
      : "info";
    return replied(result.reply, sideEffects, tag);
  } catch (err) {
    log.error("resume failed", { error: String(err), sessionId: session?.id });
    return replied("Failed to resume session. Please try again.", [], "error");
  }
};

const subagentsHandler: CommandHandler = async ({ deps }) => {
  return replied(formatSubagentsList(deps.subagentRunner.list()), [], "info");
};

const cancelSubagentHandler: CommandHandler = async ({ deps, rawText }) => {
  const id = parseSubagentId(rawText);
  if (id === null) return replied(CANCEL_SUBAGENT_USAGE_REPLY, [], "info");
  try {
    await deps.subagentRunner.cancel(id);
    return replied(`Cancelled subagent \`${id}\`.`, [], "ok");
  } catch (err) {
    const message = errorMessage(err);
    log.error("cancel_subagent failed", { id, error: message });
    return replied(`Failed to cancel subagent \`${id}\`: ${message}`, [], "error");
  }
};

const reviveHandler: CommandHandler = async ({ deps, rawText }) => {
  const args = parseReviveSubagentArgs(rawText);
  if (args === null) return replied(REVIVE_SUBAGENT_USAGE_REPLY, [], "info");
  try {
    const result = await deps.subagentRunner.revive(args.id, args.prompt);
    return replied(result === "" ? `Revived subagent \`${args.id}\`.` : `Revived subagent \`${args.id}\`:\n${result}`, [], "ok");
  } catch (err) {
    const message = errorMessage(err);
    log.error("revive failed", { id: args.id, error: message });
    return replied(`Failed to revive subagent \`${args.id}\`: ${message}`, [], "error");
  }
};

const helpHandler: CommandHandler = async () => replied(helpReply(), [], "info");

const voiceHandler: CommandHandler = async ({ deps, session, locator, bot }) => {
  if (!session) return replied("No active session. Use /new to start one.", [], "info");
  if (!bot) {
    log.error("voice dispatch bot missing");
    return replied("Voice generation failed: internal error", [], "error");
  }
  try {
    const voiceResult = await executeVoice({
      home: deps.cfg.goblinHome,
      sessionId: session.id,
      bot,
      chatId: locator.chatId,
      topicId: locator.topicId,
    });
    switch (voiceResult.kind) {
      case "no-messages":
        return replied("No messages to voice yet.", [], "info");
      case "tts-failed":
        log.warn("voice failed", { error: voiceResult.error, sessionId: session.id });
        return replied(`Voice generation failed: ${voiceResult.error}`, [], "error");
      case "sent":
        return { kind: "handled", sideEffects: [] };
    }
  } catch (err) {
    log.error("voice failed", { error: String(err), sessionId: session.id });
    return replied(`Voice generation failed: ${errorMessage(err)}`, [], "error");
  }
};

const queueHandler: CommandHandler = async ({ session, existingRunner, rawText }) => {
  if (!session) return replied("No active session.", [], "info");
  const arg = parseCommandArg(rawText);
  if (arg.length === 0) return replied("Usage: /queue <text>", [], "info");
  const sideEffects: SideEffect[] = [{ kind: "queue-prompt", session, text: arg }];
  const ack = existingRunner?.isStreaming ? "Queued. Will run after the current turn." : "Running.";
  const tag: SystemTag = existingRunner?.isStreaming ? "queued" : "ok";
  return replied(ack, sideEffects, tag);
};

const scheduleHandler: CommandHandler = async ({ deps, session, locator, rawText }) => {
  // `/schedule` is instant-timing: it only mutates the schedule store and does
  // not touch the in-flight runner, so it never defers behind a streaming turn.
  if (!deps.scheduleStore) {
    return replied("Scheduling is not available.", [], "warn");
  }
  if (!session) return replied("No active session. Use /new to start one.", [], "info");
  const depsForSchedule = buildScheduleDeps(deps.scheduleStore, session, locator, Date.now());
  const result = executeSchedule(depsForSchedule, rawText);
  return replied(result.reply, [], result.tag);
};

// ---------------------------------------------------------------------------
// grammy handler factories
// ---------------------------------------------------------------------------

const pingGrammyFactory: GrammyHandlerFactory = () => pingHandler;
const startGrammyFactory: GrammyHandlerFactory = ({ manager }) => buildStartHandler(manager);

/**
 * Timing predicate for argument-conditional commands: instant with no
 * argument (list/show), queue with an argument (mutate). Used by `/model`
 * and `/think`.
 */
function instantUnlessArg(rawText: string): CommandTiming {
  return parseCommandArg(rawText) === "" ? "instant" : "queue";
}

// ---------------------------------------------------------------------------
// COMMAND_REGISTRY — the single source of truth
// ---------------------------------------------------------------------------

export const COMMAND_REGISTRY: readonly CommandDef[] = [
  {
    name: "cancel",
    description: "abort the current turn (cascades to subagents)",
    timing: "interrupt",
    handler: cancelHandler,
  },
  {
    name: "new",
    description: "reset this chat: archive the current session and start a fresh one",
    timing: "queue",
    handler: newHandler,
  },
  {
    name: "archive",
    description: "archive the active session",
    timing: "queue",
    handler: archiveHandler,
  },
  {
    name: "project",
    argsHint: "<dir>",
    description: "bind session to a project directory (or clear with /project)",
    timing: "queue",
    handler: projectHandler,
  },
  {
    name: "model",
    argsHint: "[index]",
    description: "list favorite models or switch to one",
    timing: instantUnlessArg,
    handler: modelHandler,
  },
  {
    name: "compact",
    argsHint: "[instructions]",
    description: "manually compact this session's context",
    timing: "queue",
    handler: compactHandler,
  },
  {
    name: "debug",
    description: "dump session diagnostics",
    timing: "instant",
    handler: debugHandler,
  },
  {
    name: "think",
    argsHint: "[level]",
    description: "show or set thinking level",
    timing: instantUnlessArg,
    handler: thinkHandler,
  },
  {
    name: "name",
    argsHint: "<name>",
    description: "name the active session",
    timing: "instant",
    handler: nameHandler,
  },
  {
    name: "resume",
    argsHint: "<id-or-name>",
    description: "bind this chat to an existing session",
    timing: "queue",
    handler: resumeHandler,
  },
  {
    name: "subagents",
    description: "list tracked subagents",
    timing: "instant",
    handler: subagentsHandler,
  },
  {
    name: "cancel_subagent",
    argsHint: "<id>",
    description: "cancel a single subagent",
    timing: "instant",
    handler: cancelSubagentHandler,
  },
  {
    name: "revive",
    argsHint: "<id> <prompt>",
    description: "revive a persisted subagent with a follow-up prompt",
    timing: "instant",
    handler: reviveHandler,
  },
  {
    name: "help",
    description: "show this list",
    timing: "instant",
    handler: helpHandler,
  },
  {
    name: "voice",
    aliases: ["v"],
    description: "convert the last assistant message to a voice note",
    timing: "instant",
    handler: voiceHandler,
  },
  {
    name: "queue",
    argsHint: "<text>",
    description: "enqueue text to run as a fresh turn after the current one settles",
    timing: "instant",
    handler: queueHandler,
  },
  {
    name: "schedule",
    argsHint: "<list|at|in|every|remove|pause|resume|heartbeat ...>",
    description: "manage scheduled turns and heartbeat for this session",
    timing: "instant",
    handler: scheduleHandler,
  },
  {
    name: "ping",
    description: "smoke-test: reply with pong and chat info",
    timing: "instant",
    grammyHandler: pingGrammyFactory,
  },
  {
    name: "start",
    description: "start a new session (DMs only)",
    timing: "instant",
    grammyHandler: startGrammyFactory,
  },
];

// ---------------------------------------------------------------------------
// Derived lookups — rebuilt once at module load
// ---------------------------------------------------------------------------

function buildLookup(): Map<string, CommandDef> {
  const lookup = new Map<string, CommandDef>();
  for (const def of COMMAND_REGISTRY) {
    lookup.set(def.name, def);
    for (const alias of def.aliases ?? []) {
      lookup.set(alias, def);
    }
  }
  return lookup;
}

const LOOKUP: ReadonlyMap<string, CommandDef> = buildLookup();

/**
 * Resolve a command token (with or without leading slash) to its CommandDef.
 * Returns null for unknown commands.
 */
export function resolveCommand(token: string): CommandDef | null {
  if (!token) return null;
  const key = token.startsWith("/") ? token.slice(1) : token;
  return LOOKUP.get(key) ?? null;
}

/**
 * Resolve the timing of a command for a given rawText. Function-form timing
 * (e.g. `/model` is instant with no arg, queue with an arg) is evaluated; a
 * null def defaults to `"instant"`.
 */
export function resolveTiming(def: CommandDef | null, rawText: string): CommandTiming {
  if (!def) return "instant";
  if (typeof def.timing === "function") return def.timing(rawText);
  return def.timing ?? "instant";
}

/**
 * Build the /help reply text from the registry. One line per def:
 *   /<name><args> — <description>
 * where <args> is a leading space plus argsHint if present, otherwise empty.
 */
export function helpReply(): string {
  const lines = ["Commands:"];
  for (const def of COMMAND_REGISTRY) {
    const args = def.argsHint ? ` ${def.argsHint}` : "";
    lines.push(`/${def.name}${args} — ${def.description}`);
  }
  return lines.join("\n");
}

/**
 * Telegram BotCommand name sanitization: lowercase, hyphens → underscores,
 * truncated to 32 chars, must match ^[a-z][a-z0-9_]{0,31}$.
 */
function sanitizeTelegramName(name: string): string | null {
  const sanitized = name.toLowerCase().replace(/-/g, "_").slice(0, 32);
  return /^[a-z][a-z0-9_]{0,31}$/.test(sanitized) ? sanitized : null;
}

/**
 * Derive the BotCommand[] payload for setMyCommands from the registry.
 * Aliases are excluded — one menu entry per canonical command.
 * Descriptions are truncated to 256 chars (Telegram's limit).
 */
export function telegramBotCommands(): { command: string; description: string }[] {
  const result: { command: string; description: string }[] = [];
  for (const def of COMMAND_REGISTRY) {
    const command = sanitizeTelegramName(def.name);
    if (!command) {
      log.warn("command name fails Telegram sanitization; excluded from menu", { name: def.name });
      continue;
    }
    const description = def.description.slice(0, 256);
    result.push({ command, description });
  }
  return result;
}

/**
 * Populate Telegram's `/` autocomplete menu from the registry.
 *
 * Best-effort: on failure, calls `warn` with the error and resolves — the
 * bot continues starting. Commands still dispatch via the `message:text`
 * handler regardless of whether the menu is populated.
 */
export async function syncTelegramMenu(
  api: { setMyCommands: (commands: { command: string; description: string }[]) => Promise<unknown> },
  warn: (message: string, context?: Record<string, unknown>) => void,
): Promise<void> {
  try {
    await api.setMyCommands(telegramBotCommands());
  } catch (err) {
    warn("setMyCommands failed; / autocomplete menu may be stale", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

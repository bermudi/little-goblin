import { existsSync } from "node:fs";
import type { Context } from "grammy";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Config } from "../config.ts";
import { log } from "../log.ts";
import { sessionDir } from "../sessions/paths.ts";
import type { ChatLocator, SessionManager, SessionState } from "../sessions/mod.ts";
import type { AgentRunner } from "../agent/mod.ts";
import type { ResolvedModel } from "../agent/models.ts";
import type { SubagentRunner } from "../subagents/mod.ts";
import { DEFAULT_CASCADE_TIMEOUT_MS, interruptAndCascade } from "../interrupt.ts";
import { generateDiagnostics } from "../diagnostics.ts";
import { cancelReply, formatCascadeTimeoutSuffix } from "./cancel.ts";
import { executeNew } from "./new.ts";
import { executeArchive } from "./archive.ts";
import { executeProject } from "./project.ts";
import { executeModel } from "./model.ts";
import { executeCompact } from "./compact.ts";
import { executeName } from "./name.ts";
import { executeResume } from "./resume.ts";
import { executeThink, ALL_LEVELS } from "./think.ts";
import { parseSubagentId, SUBAGENT_STUB_REPLY } from "./subagents.ts";
import { HELP_REPLY } from "./help.ts";

/** Slash-commands that trigger an interrupt + cascade-cancel before executing. */
export const CANCEL_CAPABLE_COMMANDS = new Set(["/cancel", "/new", "/archive", "/project", "/model", "/debug", "/compact", "/resume", "/name", "/think"]);

export type SideEffect =
  | { kind: "runner-created"; session: SessionState; locator: ChatLocator }
  | { kind: "runner-disposed"; sessionId: string }
  | { kind: "noop" };

export type DispatchResult =
  | { kind: "replied"; reply: string; sideEffects: SideEffect[] }
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
}

export interface DispatchOpts {
  command: string;
  ctx: Context;
  deps: DispatchDeps;
  rawText: string;
  locator: ChatLocator;
  isSupergroup: boolean;
  session: SessionState | null;
  existingRunner: AgentRunner | null;
}

function replied(reply: string, sideEffects: SideEffect[] = []): DispatchResult {
  return { kind: "replied", reply, sideEffects };
}

export async function handleCancelCapableCommand(opts: DispatchOpts): Promise<DispatchResult> {
  const { command, deps, rawText, locator, isSupergroup, session, existingRunner } = opts;
  const { manager, cfg, subagentRunner } = deps;
  const sideEffects: SideEffect[] = [];

  let cascade = null;
  if (CANCEL_CAPABLE_COMMANDS.has(command)) {
    cascade = await deps.interruptAndCascade(
      existingRunner,
      subagentRunner,
      DEFAULT_CASCADE_TIMEOUT_MS,
      session?.id ?? null,
    );
  }
  const suffix = () => cascade ? formatCascadeTimeoutSuffix(cascade, DEFAULT_CASCADE_TIMEOUT_MS) : "";

  switch (command) {
    case "/cancel":
      return replied(cancelReply({
        hasSession: session !== null,
        cascade: cascade ?? { attemptedMain: false, attemptedSubagents: 0, timedOutMain: false, timedOutSubagents: 0 },
        cascadeTimeoutMs: DEFAULT_CASCADE_TIMEOUT_MS,
      }));
    case "/new": {
      const priorSession = session;
      try {
        const result = executeNew({
          createSession: () => manager.createForChat(locator, { isSupergroup }),
        });
        if (priorSession) sideEffects.push({ kind: "runner-disposed", sessionId: priorSession.id });
        sideEffects.push({ kind: "runner-created", session: result.session, locator });
        return replied(`${result.reply}${suffix()}`, sideEffects);
      } catch (err) {
        log.error("new session creation failed", { error: String(err), sessionId: priorSession?.id });
        return replied("Failed to reset session. Please try again.");
      }
    }
    case "/archive": {
      try {
        const result = executeArchive({
          hasSession: session !== null,
          sessionExists: session !== null && existsSync(sessionDir(cfg.goblinHome, session.id)),
          archive: () => {
            manager.archive(session!.id);
            sideEffects.push({ kind: "runner-disposed", sessionId: session!.id });
          },
        });
        return replied(`${result.reply}${suffix()}`, sideEffects);
      } catch (err) {
        log.error("archive failed", { error: String(err), sessionId: session?.id });
        return replied("Failed to archive session. Please try again.");
      }
    }
    case "/project": {
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
        return replied(`${result.reply}${suffix()}`, sideEffects);
      } catch (err) {
        log.error("project failed", { error: String(err), sessionId: session?.id });
        return replied("Failed to set project directory. Please try again.");
      }
    }
    case "/model": {
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
            sideEffects.push({ kind: "runner-disposed", sessionId: session.id });
          },
          onThinkingLevelClamped: (newLevel) => {
            if (!session) return;
            manager.setThinkingLevel(session.id, newLevel);
          },
        });
        return replied(`${result.reply}${suffix()}`, sideEffects);
      } catch (err) {
        log.error("model failed", { error: String(err), sessionId: session?.id });
        return replied("Failed to switch model. Please try again.");
      }
    }
    case "/think": {
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
        return replied(`${result.reply}${suffix()}`, sideEffects);
      } catch (err) {
        log.error("think failed", { error: String(err), sessionId: session?.id });
        return replied("Failed to set thinking level. Please try again.");
      }
    }
    case "/debug": {
      if (!session) return replied("No active session.");
      const diag = generateDiagnostics({
        session,
        runner: existingRunner,
        subagentRunner,
        goblinHome: cfg.goblinHome,
        modelName: cfg.modelName,
        projectDir: manager.getProjectDir(locator),
      });
      return replied(`${diag}${suffix()}`);
    }
    case "/compact": {
      try {
        const result = await executeCompact({ hasSession: session !== null, rawText, runner: existingRunner });
        return replied(`${result.reply}${suffix()}`);
      } catch (err) {
        log.error("compact failed", { error: String(err), sessionId: session?.id });
        return replied("Failed to compact session. Please try again.");
      }
    }
    case "/name": {
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
        return replied(`${result.reply}${suffix()}`);
      } catch (err) {
        log.error("name failed", { error: String(err), sessionId: session?.id });
        return replied("Failed to name session. Please try again.");
      }
    }
    case "/resume": {
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
        return replied(`${result.reply}${suffix()}`, sideEffects);
      } catch (err) {
        log.error("resume failed", { error: String(err), sessionId: session?.id });
        return replied("Failed to resume session. Please try again.");
      }
    }
    case "/subagents":
      return replied(SUBAGENT_STUB_REPLY);
    case "/cancel_subagent": {
      const id = parseSubagentId(rawText);
      log.debug("/cancel_subagent stub invoked", { id });
      return replied(SUBAGENT_STUB_REPLY);
    }
    case "/revive": {
      const id = parseSubagentId(rawText);
      log.debug("/revive stub invoked", { id });
      return replied(SUBAGENT_STUB_REPLY);
    }
    case "/help":
      return replied(HELP_REPLY);
    default:
      return { kind: "fallthrough" };
  }
}

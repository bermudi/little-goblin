/**
 * Owns the side effects caused by one Pi AgentSession event stream.
 *
 * AgentRunner is the execution facade: it starts prompts and delegates the
 * event stream here. Keeping transcript writes, metrics, callback dispatch,
 * streamed-text reconciliation, and prompt-file notices together prevents
 * the facade from becoming another event orchestrator.
 */

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { log } from "../log.ts";
import {
  appendTranscriptEntry,
  dispatchAgentEvent,
  extractAssistantText,
  type TurnCallbacks,
} from "./events.ts";
import type { MetricsUsage, MetricsStore, TurnMetricsEvent } from "../metrics/mod.ts";
import type { TranscriptWriterContext } from "../sessions/transcript.ts";
import type { Surface } from "../surface.ts";
import { surfaceId } from "../surface.ts";
import { surfaceHeartbeatPath } from "../sessions/paths.ts";
import { agentsMdPath, heartbeatMdPath, soulMdPath } from "../workspace/paths.ts";

export interface AgentEventHandlerOptions {
  readonly sessionId: string;
  readonly goblinHome: string;
  readonly transcriptWriterContext: TranscriptWriterContext;
  readonly metricsStore: MetricsStore;
  readonly toolCwd: string;
  readonly surface?: Surface;
  readonly isCurrent: () => boolean;
}

type EventRecord = Record<string, unknown>;

interface PendingToolCall {
  readonly toolName: string;
  readonly args: unknown;
}

function asRecord(value: unknown): EventRecord | null {
  return typeof value === "object" && value !== null
    ? value as EventRecord
    : null;
}

function asFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function extractUsage(message: EventRecord): MetricsUsage {
  const usage = asRecord(message.usage) ?? {};
  const cost = asRecord(usage.cost) ?? {};
  return {
    input: asFiniteNumber(usage.input),
    output: asFiniteNumber(usage.output),
    cacheRead: asFiniteNumber(usage.cacheRead),
    cacheWrite: asFiniteNumber(usage.cacheWrite),
    totalTokens: asFiniteNumber(usage.totalTokens),
    cost: {
      input: asFiniteNumber(cost.input),
      output: asFiniteNumber(cost.output),
      cacheRead: asFiniteNumber(cost.cacheRead),
      cacheWrite: asFiniteNumber(cost.cacheWrite),
      total: asFiniteNumber(cost.total),
    },
  };
}

function extractTimestamp(value: EventRecord): string | null {
  const ts = value.ts;
  if (typeof ts === "string" && ts.length > 0) return ts;

  const timestamp = value.timestamp;
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return new Date(timestamp).toISOString();
  }
  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed)) return timestamp;
  }

  return null;
}

function buildTurnMetricsEvent(args: {
  readonly message: EventRecord;
  readonly turnStart: string | null;
  readonly turnEnd: string;
  readonly toolCount: number;
  readonly toolErrorCount: number;
}): TurnMetricsEvent {
  const startTime = args.turnStart ?? args.turnEnd;
  const durationMs = Math.max(0, Date.parse(args.turnEnd) - Date.parse(startTime));
  const model = typeof args.message.model === "string" ? args.message.model : "";
  const provider = typeof args.message.provider === "string" ? args.message.provider : "";
  const api = typeof args.message.api === "string" ? args.message.api : "";
  const responseModel = typeof args.message.responseModel === "string"
    ? args.message.responseModel
    : undefined;
  const stopReason = args.message.stopReason;
  const errorMessage = args.message.errorMessage;
  const usage = extractUsage(args.message);

  return {
    type: "turn",
    turnStart: startTime,
    turnEnd: args.turnEnd,
    durationMs,
    model,
    provider,
    api,
    responseModel,
    usage,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    cost: usage.cost.total,
    toolCount: args.toolCount,
    toolErrorCount: args.toolErrorCount,
    stopReason: typeof stopReason === "string" || stopReason === null ? stopReason : null,
    errorMessage: typeof errorMessage === "string" || errorMessage === null ? errorMessage : null,
  };
}

// Matches pi's public coding-tool path behavior. pi does not export its
// resolveToCwd helper, so keep this intentionally small compatibility seam
// limited to the normalizations that affect prompt-file notices.
const PI_UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizePiToolPath(rawPath: string): string {
  let normalized = rawPath.replace(PI_UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
  return normalized;
}

function resolveToolPath(cwd: string, rawPath: string): string {
  let expanded = normalizePiToolPath(rawPath);
  if (expanded === "~") {
    expanded = homedir();
  } else if (expanded.startsWith("~/")) {
    expanded = resolve(homedir(), expanded.slice(2));
  }
  return resolve(cwd, expanded);
}

function summarizeToolChange(toolName: string, args: EventRecord): string {
  if (toolName === "write") {
    const content = typeof args.content === "string" ? args.content : "";
    if (content.length === 0) return "wrote empty file";
    const lines = content.split("\n").length;
    return `wrote ${lines} line${lines === 1 ? "" : "s"} (${content.length} chars)`;
  }
  if (toolName === "edit") {
    const edits = Array.isArray(args.edits) ? args.edits.length : 0;
    return `${edits} edit${edits === 1 ? "" : "s"}`;
  }
  return "modified";
}

/**
 * Stateful event sink for one AgentRunner generation.
 *
 * The handler is deliberately synchronous at the Pi boundary. Notice
 * delivery is the one fire-and-forget exception: it is informational and
 * cannot make a successful file mutation fail.
 */
export class AgentEventHandler {
  private closed = false;
  private readonly sessionId: string;
  private readonly goblinHome: string;
  private readonly transcriptWriterContext: TranscriptWriterContext;
  private readonly metricsStore: MetricsStore;
  private readonly toolCwd: string;
  private readonly isCurrent: () => boolean;
  private readonly reservedPromptFilePaths: Set<string>;
  private callbacks: TurnCallbacks | null = null;
  private accumulatedText = "";
  private turnStart: string | null = null;
  private turnToolCount = 0;
  private turnToolErrorCount = 0;
  private readonly pendingToolCalls = new Map<string, PendingToolCall>();

  constructor(opts: AgentEventHandlerOptions) {
    this.sessionId = opts.sessionId;
    this.goblinHome = opts.goblinHome;
    this.transcriptWriterContext = opts.transcriptWriterContext;
    this.metricsStore = opts.metricsStore;
    this.toolCwd = opts.toolCwd;
    this.isCurrent = opts.isCurrent;

    const reserved = [
      soulMdPath(opts.goblinHome),
      agentsMdPath(opts.goblinHome),
      heartbeatMdPath(opts.goblinHome),
    ];
    if (opts.surface !== undefined) {
      reserved.push(surfaceHeartbeatPath(opts.goblinHome, surfaceId(opts.surface)));
    }
    this.reservedPromptFilePaths = new Set(reserved.map((path) => resolve(path)));
  }

  /**
   * Bind the current turn's callback sink and reset per-turn reconciliation
   * and metrics state. The initial timestamp preserves the fallback used when
   * Pi does not emit an agent_start/turn_start timestamp.
   */
  beginTurn(callbacks: TurnCallbacks, startedAt: string = new Date().toISOString()): void {
    if (this.closed) return;
    this.callbacks = callbacks;
    this.accumulatedText = "";
    this.turnStart = startedAt;
    this.turnToolCount = 0;
    this.turnToolErrorCount = 0;
  }

  /** Forward a status from a runtime-owned tool while authority remains live. */
  sendStatusUpdate(text: string): void {
    if (this.closed || !this.isCurrent()) return;
    this.callbacks?.onStatusUpdate(text);
  }

  /** Synchronously fence late backend events before asynchronous cleanup. */
  close(): void {
    this.closed = true;
    this.callbacks = null;
  }

  /** Handle one event emitted by the backend. */
  handle(event: AgentSessionEvent): void {
    // Pi may emit late events after lifecycle disposal. Drop every stale event
    // before it can write a transcript, metrics, callback, or tool side effect.
    if (this.closed || !this.isCurrent()) return;

    appendTranscriptEntry(
      this.sessionId,
      this.goblinHome,
      event,
      this.transcriptWriterContext,
    );
    this.updateMetrics(event);

    if (event.type === "tool_execution_start") {
      this.trackToolStart(event);
    } else if (event.type === "tool_execution_end") {
      this.handleToolEnd(event);
    }

    const callbacks = this.callbacks;
    if (callbacks === null) return;

    // Reconciliation must happen before ordinary callback dispatch so a
    // missing streamed tail is delivered in the same order as the original
    // text deltas.
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      this.accumulatedText += event.assistantMessageEvent.delta;
    }

    if (event.type === "message_end") {
      const finalText = extractAssistantText(event);
      if (finalText !== undefined) {
        if (
          finalText !== this.accumulatedText &&
          finalText.startsWith(this.accumulatedText)
        ) {
          const missing = finalText.slice(this.accumulatedText.length);
          log.warn("reconciliation: emitting missing text tail", {
            accLen: this.accumulatedText.length,
            finalLen: finalText.length,
            missingLen: missing.length,
          });
          this.accumulatedText += missing;
          callbacks.onTextDelta(missing);
        }
        // Track text per assistant message. A turn with tool calls can contain
        // several assistant message_end events.
        this.accumulatedText = "";
      }
    }

    dispatchAgentEvent(event, callbacks);
  }

  private updateMetrics(event: AgentSessionEvent): void {
    const eventRecord = asRecord(event) ?? {};

    switch (event.type) {
      case "agent_start":
      case "turn_start": {
        this.turnStart = extractTimestamp(eventRecord) ?? this.turnStart ?? new Date().toISOString();
        this.turnToolCount = 0;
        this.turnToolErrorCount = 0;
        break;
      }
      case "tool_execution_start":
        this.turnToolCount++;
        break;
      case "tool_execution_end":
        if (event.isError === true) this.turnToolErrorCount++;
        break;
      case "turn_end": {
        const message = asRecord(event.message);
        if (message?.role !== "assistant") break;

        const turnEnd = extractTimestamp(message) ??
          extractTimestamp(eventRecord) ??
          new Date().toISOString();
        this.metricsStore.record(buildTurnMetricsEvent({
          message,
          turnStart: this.turnStart,
          turnEnd,
          toolCount: this.turnToolCount,
          toolErrorCount: this.turnToolErrorCount,
        }));
        this.turnToolCount = 0;
        this.turnToolErrorCount = 0;
        break;
      }
      case "agent_end":
        this.turnStart = null;
        this.turnToolCount = 0;
        this.turnToolErrorCount = 0;
        break;
    }
  }

  private trackToolStart(event: Extract<AgentSessionEvent, { type: "tool_execution_start" }>): void {
    this.pendingToolCalls.set(event.toolCallId, {
      toolName: event.toolName,
      args: event.args,
    });
  }

  private handleToolEnd(event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>): void {
    const pending = this.pendingToolCalls.get(event.toolCallId);
    this.pendingToolCalls.delete(event.toolCallId);
    if (pending === undefined || event.isError === true) return;
    if (pending.toolName !== "write" && pending.toolName !== "edit") return;

    const args = asRecord(pending.args);
    if (args === null) return;
    const rawPath = typeof args.path === "string"
      ? args.path
      : typeof args.file_path === "string"
        ? args.file_path
        : undefined;
    if (rawPath === undefined) return;

    const resolvedPath = resolveToolPath(this.toolCwd, rawPath);
    if (!this.reservedPromptFilePaths.has(resolve(resolvedPath))) return;

    const fileName = basename(resolvedPath);
    const summary = summarizeToolChange(pending.toolName, args);
    this.sendNotice(`Modified prompt file \`${fileName}\`: ${summary}`);
  }

  private sendNotice(text: string): void {
    if (this.closed || !this.isCurrent()) return;
    const send = this.callbacks?.sendNotice;
    if (send === undefined) return;

    let delivery: Promise<void>;
    try {
      delivery = send(text);
    } catch (err) {
      log.warn("prompt-file notice failed", {
        error: err instanceof Error ? err.message : String(err),
        sessionId: this.sessionId,
      });
      return;
    }

    delivery.then(
      () => {
        // The notice has no compensating action. The current check prevents a
        // stale delivery from becoming the start of a follow-up chain.
        if (!this.isCurrent()) return;
      },
      (err: unknown) => {
        log.warn("prompt-file notice failed", {
          error: err instanceof Error ? err.message : String(err),
          sessionId: this.sessionId,
        });
      },
    );
  }
}

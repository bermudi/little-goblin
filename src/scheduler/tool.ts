import { Type, type Static } from "@sinclair/typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { parseDuration, parseAt, parseIn } from "./time.ts";
import { DEFAULT_HEARTBEAT_INTERVAL_MS } from "./store.ts";
import type { ChatLocator } from "../sessions/types.ts";
import type { ScheduleStore } from "./store.ts";

const scheduleTurnSchema = Type.Object(
  {
    action: Type.Union([
      Type.Literal("create_once"),
      Type.Literal("create_recurring"),
      Type.Literal("list"),
      Type.Literal("remove"),
      Type.Literal("pause"),
      Type.Literal("resume"),
      Type.Literal("heartbeat"),
    ]),
    in: Type.Optional(Type.String()),
    at: Type.Optional(Type.String()),
    every: Type.Optional(Type.String()),
    prompt: Type.Optional(Type.String()),
    id: Type.Optional(Type.String()),
    heartbeat_action: Type.Optional(
      Type.Union([Type.Literal("on"), Type.Literal("off"), Type.Literal("status")]),
    ),
    duration: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

type ScheduleTurnInput = Static<typeof scheduleTurnSchema>;

export interface ScheduleTurnToolArgs {
  store: ScheduleStore;
  sessionId: string;
  locator: ChatLocator;
  now: () => number;
}

function jsonResult(value: unknown): {
  content: { type: "text"; text: string }[];
  details: unknown;
} {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
}

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

function parseDurationOrThrow(token: string, field: string): number {
  const duration = parseDuration(token);
  if (duration === null) {
    throw new Error(`Invalid duration in \`${field}\`: ${token} (expected e.g. 30m, 2h, 1d)`);
  }
  return duration;
}

function requirePrompt(prompt: string | undefined): string {
  if (prompt === undefined || prompt.trim().length === 0) {
    throw new Error("A non-empty `prompt` is required for this action.");
  }
  return prompt.trim();
}

function requireId(id: string | undefined): string {
  if (id === undefined || id.trim().length === 0) {
    throw new Error("A non-empty `id` is required for this action.");
  }
  return id.trim();
}

function requireHeartbeatAction(action: string | undefined): "on" | "off" | "status" {
  if (action !== "on" && action !== "off" && action !== "status") {
    throw new Error("`heartbeat_action` must be one of: on, off, status");
  }
  return action;
}

function effectiveSource(source: "user" | "agent" | undefined): "user" | "agent" {
  return source ?? "user";
}

function redactedListRecord(s: {
  id: string;
  kind: string;
  state: string;
  enabled: boolean;
  nextRunAt: string;
  intervalMs?: number;
  prompt: string | null;
  source?: "user" | "agent";
}) {
  const isUser = effectiveSource(s.source) === "user";
  return {
    id: s.id,
    kind: s.kind,
    state: s.state,
    enabled: s.enabled,
    nextRunAt: s.nextRunAt,
    intervalMs: s.intervalMs,
    source: effectiveSource(s.source),
    prompt: isUser ? null : s.prompt,
    userOwned: isUser ? true : undefined,
  };
}

function assertAgentScheduleAuthority(
  s: { source?: "user" | "agent" } | null,
  id: string,
): void {
  if (s === null) {
    throw new Error(`No schedule found with id \`${id}\`.`);
  }
  if (effectiveSource(s.source) === "user") {
    throw new Error(`Schedule \`${id}\` is user-owned and cannot be modified by the agent.`);
  }
}

/**
 * Build an agent-facing `schedule_turn` tool.
 *
 * The tool gives the agent the same scheduling capabilities as the `/schedule`
 * command, but scoped to its own session and to schedules whose `source` is
 * `"agent"`. It creates, lists, mutates, and removes schedules; it also manages
 * the session heartbeat. All agent-originated transitions into `enabled` are
 * bounded by the per-session `MAX_AGENT_SCHEDULES` cap, which is enforced in
 * `ScheduleStore`.
 */
export function createScheduleTurnTool(args: ScheduleTurnToolArgs): ToolDefinition {
  return defineTool({
    name: "schedule_turn",
    label: "Schedule Turn",
    description: `Schedule a future autonomous turn for the current session.

Actions:
- create_once — schedule one prompt. Provide exactly one of \`in\` (duration, e.g. 30m) or \`at\` (ISO-8601) and a \`prompt\`.
- create_recurring — schedule a recurring prompt. Provide \`every\` (duration) and a \`prompt\`.
- list — list this session's schedules, with user-owned prompts redacted.
- remove / pause / resume — mutate a schedule by \`id\`. Agent may only touch agent-owned schedules.
- heartbeat — \`heartbeat_action\`: on [duration] | off | status.`,
    promptSnippet: "schedule_turn: schedule or manage a future autonomous turn for the current session.",
    parameters: scheduleTurnSchema,
    async execute(_toolCallId, params: ScheduleTurnInput) {
      const { store, sessionId, locator, now } = args;

      switch (params.action) {
        case "create_once": {
          const prompt = requirePrompt(params.prompt);
          const hasIn = params.in !== undefined && params.in.trim().length > 0;
          const hasAt = params.at !== undefined && params.at.trim().length > 0;
          if (hasIn && hasAt) {
            throw new Error("create_once requires exactly one of `in` or `at`, not both.");
          }
          if (!hasIn && !hasAt) {
            throw new Error("create_once requires one of `in` or `at`.");
          }

          const nowMs = now();
          const runResult = hasIn
            ? parseIn(params.in!.trim(), nowMs)
            : parseAt(params.at!.trim(), nowMs);
          if (!runResult.ok) {
            throw new Error(
              hasIn
                ? `Invalid duration in \`in\`: ${params.in!.trim()}`
                : `Invalid or past timestamp in \`at\`: ${params.at!.trim()}`,
            );
          }

          const record = store.create({
            sessionId,
            locator,
            kind: "once",
            prompt,
            nextRunAt: new Date(runResult.ms).toISOString(),
            source: "agent",
          });
          return jsonResult({
            id: record.id,
            source: record.source,
            kind: record.kind,
            nextRunAt: record.nextRunAt,
          });
        }

        case "create_recurring": {
          const prompt = requirePrompt(params.prompt);
          if (params.every === undefined || params.every.trim().length === 0) {
            throw new Error("create_recurring requires `every` duration.");
          }
          const intervalMs = parseDurationOrThrow(params.every.trim(), "every");
          const record = store.create({
            sessionId,
            locator,
            kind: "recurring",
            prompt,
            nextRunAt: new Date(now() + intervalMs).toISOString(),
            intervalMs,
            source: "agent",
          });
          return jsonResult({
            id: record.id,
            source: record.source,
            kind: record.kind,
            intervalMs: record.intervalMs,
            nextRunAt: record.nextRunAt,
          });
        }

        case "list": {
          const records = store.listBySession(sessionId).map(redactedListRecord);
          return jsonResult({ schedules: records });
        }

        case "remove": {
          const id = requireId(params.id);
          assertAgentScheduleAuthority(store.getForSession(sessionId, id), id);
          const removed = store.remove(sessionId, id, true);
          if (!removed) {
            throw new Error(`No schedule found with id \`${id}\`.`);
          }
          return jsonResult({ id, removed: true, source: "agent" });
        }

        case "pause": {
          const id = requireId(params.id);
          assertAgentScheduleAuthority(store.getForSession(sessionId, id), id);
          const record = store.pause(sessionId, id, true);
          if (!record) {
            throw new Error(`No schedule found with id \`${id}\`.`);
          }
          return jsonResult({
            id: record.id,
            source: record.source,
            state: record.state,
            nextRunAt: record.nextRunAt,
          });
        }

        case "resume": {
          const id = requireId(params.id);
          assertAgentScheduleAuthority(store.getForSession(sessionId, id), id);
          const record = store.resume(sessionId, id, true);
          if (!record) {
            throw new Error(`No schedule found with id \`${id}\`.`);
          }
          return jsonResult({
            id: record.id,
            source: record.source,
            state: record.state,
            nextRunAt: record.nextRunAt,
          });
        }

        case "heartbeat": {
          const heartbeatAction = requireHeartbeatAction(params.heartbeat_action);

          if (heartbeatAction === "status") {
            const hb = store.getHeartbeat(sessionId);
            if (hb === null) {
              return jsonResult({ enabled: false, source: null });
            }
            return jsonResult({
              enabled: hb.enabled,
              state: hb.state,
              intervalMs: hb.intervalMs,
              nextRunAt: hb.nextRunAt,
              source: effectiveSource(hb.source),
            });
          }

          if (heartbeatAction === "on") {
            let intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS;
            if (params.duration !== undefined && params.duration.trim().length > 0) {
              intervalMs = parseDurationOrThrow(params.duration.trim(), "duration");
            }
            const record = store.setHeartbeat({
              sessionId,
              locator,
              enabled: true,
              intervalMs,
              now: nowIso(now),
              agent: true,
            });
            return jsonResult({
              enabled: record.enabled,
              state: record.state,
              intervalMs: record.intervalMs,
              nextRunAt: record.nextRunAt,
              source: record.source,
            });
          }

          // heartbeat off
          const existing = store.getHeartbeat(sessionId);
          if (existing !== null && effectiveSource(existing.source) === "user") {
            throw new Error("Cannot turn off a user-owned heartbeat.");
          }
          const record = store.setHeartbeat({
            sessionId,
            locator,
            enabled: false,
            now: nowIso(now),
            agent: true,
          });
          return jsonResult({
            enabled: record.enabled,
            state: record.state,
            intervalMs: record.intervalMs,
            nextRunAt: record.nextRunAt,
            source: record.source,
          });
        }
      }
    },
  });
}

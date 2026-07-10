/**
 * `/schedule` command — pure execution helpers.
 *
 * The command is instant-timing: it only mutates the schedule store and does
 * not touch the in-flight runner, so it never defers behind a streaming turn.
 *
 * Subcommands:
 *   list                              — list schedules for the active session
 *   at <ISO-8601 datetime> <prompt>   — one-shot at an absolute time
 *   in <duration> <prompt>            — one-shot relative to now
 *   every <duration> <prompt>         — recurring
 *   remove <id>                       — remove a schedule (active session only)
 *   pause <id>                        — disable a schedule
 *   resume <id>                       — re-enable a schedule
 *   heartbeat on [duration]           — enable heartbeat (30m default)
 *   heartbeat off                     — disable heartbeat
 *   heartbeat status                  — show heartbeat state
 *
 * `executeSchedule` is pure: it takes injectable store operations + parsed
 * inputs and returns a reply string. The registry handler wires real deps.
 */
import type { ChatLocator, SessionState } from "../sessions/mod.ts";
import type { ScheduledTurn } from "../scheduler/types.ts";
import { formatDuration, formatRunTime, parseAt, parseDuration, parseIn } from "../scheduler/time.ts";
import type { SystemTag } from "../tg/format.ts";

/**
 * Result of executing a `/schedule` subcommand. The `tag` field drives the
 * system-reply prefix (`[ok]` / `[info]` / `[warn]`) at the dispatch site.
 */
export interface ScheduleCommandResult {
  reply: string;
  tag: SystemTag;
}

export const NO_ACTIVE_SESSION_REPLY = "No active session. Use /new to start one.";
export const SCHEDULE_USAGE_REPLY = [
  "Usage:",
  "  /schedule list",
  "  /schedule at <ISO-8601 datetime> <prompt>",
  "  /schedule in <duration> <prompt>",
  "  /schedule every <duration> <prompt>",
  "  /schedule remove <id>",
  "  /schedule pause <id>",
  "  /schedule resume <id>",
  "  /schedule heartbeat on [duration]",
  "  /schedule heartbeat off",
  "  /schedule heartbeat status",
  "",
  "Durations use integer units: m, h, d (e.g. 30m, 2h, 1d).",
].join("\n");

export const HEARTBEAT_USAGE_REPLY = "Usage: /schedule heartbeat <on [duration] | off | status>";

/**
 * Injectable schedule store operations. Mirrors `ScheduleStore`'s public
 * surface so tests can pass fakes without touching the filesystem.
 */
export interface ScheduleCommandDeps {
  hasSession: boolean;
  session: SessionState | null;
  locator: ChatLocator;
  now: number;
  create: (params: {
    kind: "once" | "recurring";
    prompt: string;
    nextRunAt: string;
    intervalMs?: number;
  }) => ScheduledTurn;
  list: () => ScheduledTurn[];
  remove: (id: string) => boolean;
  pause: (id: string) => ScheduledTurn | null;
  resume: (id: string) => ScheduledTurn | null;
  setHeartbeat: (params: { enabled: boolean; intervalMs?: number }) => ScheduledTurn;
  getHeartbeat: () => ScheduledTurn | null;
}

/**
 * Parse the `/schedule` argument string into a subcommand token + remainder.
 * Strips the `/schedule` (and optional `@bot`) prefix. Returns `null` when no
 * subcommand is present.
 */
export function parseScheduleArgs(rawText: string): { sub: string; rest: string } | null {
  const stripped = rawText.replace(/^\/schedule(?:@\S+)?(?:\s+)?/u, "").trim();
  if (stripped === "") return null;
  const sp = stripped.search(/\s/u);
  const sub = sp === -1 ? stripped : stripped.slice(0, sp);
  const rest = sp === -1 ? "" : stripped.slice(sp + 1).trim();
  return { sub, rest };
}

/** Truncate a prompt for list previews. */
function preview(text: string | null, max = 40): string {
  if (text === null) return "[heartbeat]";
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** Human-readable recurrence label for a schedule. */
function recurrenceLabel(s: ScheduledTurn): string {
  switch (s.kind) {
    case "once":
      return "once";
    case "recurring":
      return s.intervalMs !== undefined ? `every ${formatDuration(s.intervalMs)}` : "recurring";
    case "heartbeat":
      return s.intervalMs !== undefined ? `heartbeat ${formatDuration(s.intervalMs)}` : "heartbeat";
  }
}

/** State label for list output. */
function stateLabel(s: ScheduledTurn): string {
  if (s.state === "completed") return "completed";
  return s.enabled ? "enabled" : "disabled";
}

/** Next-run label for list output; completed one-shots show "completed". */
function nextRunLabel(s: ScheduledTurn): string {
  if (s.state === "completed") return "completed";
  return formatRunTime(Date.parse(s.nextRunAt));
}

function formatScheduleList(schedules: ScheduledTurn[]): string {
  if (schedules.length === 0) return "No schedules for this session.";
  const lines = ["Schedules:"];
  for (const s of schedules) {
    const sourceTag = s.source === "agent" ? " [agent]" : "";
    lines.push(
      `- \`${s.id}\` [${stateLabel(s)}]${sourceTag} ${recurrenceLabel(s)} → ${nextRunLabel(s)} :: ${preview(s.prompt)}`,
    );
  }
  return lines.join("\n");
}

/**
 * Execute a parsed `/schedule` subcommand against the injected deps. Returns
 * a `{ reply, tag }` result: the reply text and the system-reply tag that
 * drives the `[ok]` / `[info]` / `[warn]` prefix at the dispatch site. Pure
 * with respect to the filesystem and Telegram — the caller sends the reply.
 */
export function executeSchedule(deps: ScheduleCommandDeps, rawText: string): ScheduleCommandResult {
  if (!deps.hasSession || !deps.session) return { reply: NO_ACTIVE_SESSION_REPLY, tag: "info" };
  const parsed = parseScheduleArgs(rawText);
  if (!parsed) return { reply: SCHEDULE_USAGE_REPLY, tag: "info" };
  const { sub, rest } = parsed;

  switch (sub) {
    case "list":
      return { reply: formatScheduleList(deps.list()), tag: "info" };

    case "at": {
      const parts = rest.split(/\s+/u);
      const timeToken = parts[0] ?? "";
      const prompt = parts.slice(1).join(" ").trim();
      if (timeToken === "" || prompt === "") return { reply: SCHEDULE_USAGE_REPLY, tag: "info" };
      const result = parseAt(timeToken, deps.now);
      if (!result.ok) {
        return result.reason === "past"
          ? { reply: "That time is in the past.", tag: "warn" }
          : { reply: SCHEDULE_USAGE_REPLY, tag: "info" };
      }
      const created = deps.create({
        kind: "once",
        prompt,
        nextRunAt: new Date(result.ms).toISOString(),
      });
      return { reply: `Scheduled \`${created.id}\` for ${formatRunTime(result.ms)}:\n${prompt}`, tag: "ok" };
    }

    case "in": {
      const parts = rest.split(/\s+/u);
      const durToken = parts[0] ?? "";
      const prompt = parts.slice(1).join(" ").trim();
      if (durToken === "" || prompt === "") return { reply: SCHEDULE_USAGE_REPLY, tag: "info" };
      const result = parseIn(durToken, deps.now);
      if (!result.ok) return { reply: SCHEDULE_USAGE_REPLY, tag: "info" };
      const created = deps.create({
        kind: "once",
        prompt,
        nextRunAt: new Date(result.ms).toISOString(),
      });
      return { reply: `Scheduled \`${created.id}\` in ${durToken} (${formatRunTime(result.ms)}):\n${prompt}`, tag: "ok" };
    }

    case "every": {
      const parts = rest.split(/\s+/u);
      const durToken = parts[0] ?? "";
      const prompt = parts.slice(1).join(" ").trim();
      if (durToken === "" || prompt === "") return { reply: SCHEDULE_USAGE_REPLY, tag: "info" };
      const intervalMs = parseDuration(durToken);
      if (intervalMs === null) return { reply: SCHEDULE_USAGE_REPLY, tag: "info" };
      const firstRun = new Date(deps.now + intervalMs).toISOString();
      const created = deps.create({
        kind: "recurring",
        prompt,
        nextRunAt: firstRun,
        intervalMs,
      });
      return { reply: `Scheduled \`${created.id}\` every ${formatDuration(intervalMs)}:\n${prompt}`, tag: "ok" };
    }

    case "remove": {
      const id = rest.split(/\s+/u)[0] ?? "";
      if (id === "") return { reply: SCHEDULE_USAGE_REPLY, tag: "info" };
      const removed = deps.remove(id);
      return removed
        ? { reply: `Removed schedule \`${id}\`.`, tag: "ok" }
        : { reply: `No matching schedule \`${id}\`.`, tag: "warn" };
    }

    case "pause": {
      const id = rest.split(/\s+/u)[0] ?? "";
      if (id === "") return { reply: SCHEDULE_USAGE_REPLY, tag: "info" };
      const paused = deps.pause(id);
      return paused
        ? { reply: `Paused schedule \`${id}\`.`, tag: "ok" }
        : { reply: `No matching schedule \`${id}\`.`, tag: "warn" };
    }

    case "resume": {
      const id = rest.split(/\s+/u)[0] ?? "";
      if (id === "") return { reply: SCHEDULE_USAGE_REPLY, tag: "info" };
      const resumed = deps.resume(id);
      return resumed
        ? { reply: `Resumed schedule \`${id}\`.`, tag: "ok" }
        : { reply: `No matching schedule \`${id}\`.`, tag: "warn" };
    }

    case "heartbeat": {
      return executeHeartbeat(deps, rest);
    }

    default:
      return { reply: SCHEDULE_USAGE_REPLY, tag: "info" };
  }
}

/** `/schedule heartbeat <on [duration] | off | status>` — heartbeat manager. */
export function executeHeartbeat(deps: ScheduleCommandDeps, rest: string): ScheduleCommandResult {
  const parts = rest.split(/\s+/u).filter((x) => x !== "");
  const action = parts[0] ?? "";

  switch (action) {
    case "": {
      // Bare `/schedule heartbeat` shows status.
      return { reply: heartbeatStatus(deps), tag: "info" };
    }
    case "on": {
      const durToken = parts[1];
      // If a duration was supplied but invalid, surface usage rather than
      // silently falling back to the default. Absent duration → undefined,
      // which the store interprets as the 30-minute default.
      const parsedInterval = durToken !== undefined ? parseDuration(durToken) : undefined;
      if (parsedInterval === null) return { reply: HEARTBEAT_USAGE_REPLY, tag: "info" };
      const intervalMs: number | undefined = parsedInterval ?? undefined;
      const hb = deps.setHeartbeat({ enabled: true, intervalMs });
      return { reply: heartbeatStatusReply(hb, deps.now), tag: "ok" };
    }
    case "off": {
      deps.setHeartbeat({ enabled: false });
      return { reply: "Heartbeat disabled.", tag: "ok" };
    }
    case "status": {
      return { reply: heartbeatStatus(deps), tag: "info" };
    }
    default:
      return { reply: HEARTBEAT_USAGE_REPLY, tag: "info" };
  }
}

function heartbeatStatus(deps: ScheduleCommandDeps): string {
  const hb = deps.getHeartbeat();
  if (!hb || !hb.enabled) return "Heartbeat is disabled.";
  const interval = hb.intervalMs !== undefined ? formatDuration(hb.intervalMs) : "30m";
  const next = formatRunTime(Date.parse(hb.nextRunAt));
  return `Heartbeat is enabled: every ${interval}, next run ${next}.`;
}

function heartbeatStatusReply(hb: ScheduledTurn, now: number): string {
  const interval = hb.intervalMs !== undefined ? formatDuration(hb.intervalMs) : "30m";
  const next = formatRunTime(hb.enabled ? Date.parse(hb.nextRunAt) : now);
  return `Heartbeat enabled: every ${interval}, next run ${next}.`;
}

/**
 * Build the deps object the registry handler uses to call `executeSchedule`.
 * Exported so the handler can construct it from a `ScheduleStore` + session.
 */
export function buildScheduleDeps(
  store: {
    create: (params: {
      sessionId: string;
      locator: ChatLocator;
      kind: "once" | "recurring";
      prompt: string;
      nextRunAt: string;
      intervalMs?: number;
    }) => ScheduledTurn;
    listBySession: (sessionId: string) => ScheduledTurn[];
    remove: (sessionId: string, id: string) => boolean;
    pause: (sessionId: string, id: string) => ScheduledTurn | null;
    resume: (sessionId: string, id: string) => ScheduledTurn | null;
    setHeartbeat: (params: {
      sessionId: string;
      locator: ChatLocator;
      enabled: boolean;
      intervalMs?: number;
      now: string;
    }) => ScheduledTurn;
    getHeartbeat: (sessionId: string) => ScheduledTurn | null;
  },
  session: SessionState,
  locator: ChatLocator,
  now: number,
): ScheduleCommandDeps {
  return {
    hasSession: true,
    session,
    locator,
    now,
    create: (params) =>
      store.create({ sessionId: session.id, locator, ...params }),
    list: () => store.listBySession(session.id),
    remove: (id) => store.remove(session.id, id),
    pause: (id) => store.pause(session.id, id),
    resume: (id) => store.resume(session.id, id),
    setHeartbeat: (params) =>
      store.setHeartbeat({
        sessionId: session.id,
        locator,
        enabled: params.enabled,
        intervalMs: params.intervalMs,
        now: new Date(now).toISOString(),
      }),
    getHeartbeat: () => store.getHeartbeat(session.id),
  };
}

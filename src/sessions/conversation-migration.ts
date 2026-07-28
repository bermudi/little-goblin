import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../fs.ts";
import { parseSurfaceId, type SurfaceId } from "../surface.ts";
import { saveStore } from "../scheduler/store.ts";
import type { PersistedScheduledTurn, ScheduleStoreFile } from "../scheduler/types.ts";
import { isValidConversationId } from "./conversation.ts";
import type { ExecutionEnvironment } from "./environment.ts";
import { heartbeatMdPathForSession, schedulesPath, sessionsDir, statePath, surfaceHeartbeatPath } from "./paths.ts";
import { isValidExecutionEnvironment } from "./state.ts";
import { saveJsonFile } from "./state-file.ts";
import { saveTopicSettings } from "./topic-settings.ts";
import type { BindingsFile, ConversationId, ConversationState, TopicSettings, TopicSettingsFile } from "./types.ts";
import type { ExecutionEnvironmentPlan } from "./environment-migration.ts";

interface ConversationRecord {
  readonly id: ConversationId;
  readonly archived: boolean;
  readonly statePath: string;
  readonly raw: Record<string, unknown>;
  readonly environment: ExecutionEnvironment;
}

export interface ConversationRecordMigrationPlan {
  readonly id: ConversationId;
  readonly archived: boolean;
  readonly statePath: string;
  readonly state: ConversationState;
}

export interface HeartbeatPromptMigrationPlan {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly destinationContent?: string;
}

export interface ConversationMigrationPlan {
  readonly conversationRecords: ConversationRecordMigrationPlan[];
  readonly topicSettings: TopicSettingsFile | null;
  readonly schedules: ScheduleStoreFile | null;
  readonly heartbeatPrompts: HeartbeatPromptMigrationPlan[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJson(path: string): unknown | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`malformed JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function cloneSettings(settings: TopicSettingsFile): TopicSettingsFile {
  return {
    version: 1,
    surfaces: Object.fromEntries(
      Object.entries(settings.surfaces).map(([key, value]) => [key, { ...value }]),
    ) as TopicSettingsFile["surfaces"],
  };
}

function validateBindings(bindings: BindingsFile): void {
  const candidates = new Map<string, SurfaceId[]>();
  for (const [surfaceId, conversationId] of Object.entries(bindings.surfaces)) {
    parseSurfaceId(surfaceId);
    if (!isValidConversationId(conversationId)) {
      throw new Error(`binding ${surfaceId} has invalid conversation id: ${String(conversationId)}`);
    }
    const surfaces = candidates.get(conversationId) ?? [];
    surfaces.push(surfaceId as SurfaceId);
    candidates.set(conversationId, surfaces);
  }

  for (const [conversationId, surfaces] of candidates) {
    if (surfaces.length <= 1) continue;
    throw new Error(
      `conversation ${conversationId} has multiple surface bindings: ${surfaces.sort().join(", ")}. Repair the retained binding before migrating.`,
    );
  }
}

function readBindings(home: string, supplied?: BindingsFile): BindingsFile {
  const raw = supplied ?? readJson(join(home, "state", "bindings.json"));
  if (raw === null) return { version: 1, surfaces: {} };
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.surfaces)) {
    throw new Error("invalid canonical bindings file for conversation migration");
  }

  const surfaces: Record<SurfaceId, string> = {};
  for (const [surfaceId, conversationId] of Object.entries(raw.surfaces)) {
    if (typeof conversationId !== "string") {
      throw new Error(`binding ${surfaceId} has invalid conversation id: ${String(conversationId)}`);
    }
    surfaces[surfaceId as SurfaceId] = conversationId;
  }
  const bindings: BindingsFile = { version: 1, surfaces };
  validateBindings(bindings);
  return bindings;
}

function validateTopicSettingsValue(surfaceId: string, value: unknown): TopicSettings {
  if (!isRecord(value)) {
    throw new Error(`surface settings ${surfaceId} are invalid`);
  }
  parseSurfaceId(surfaceId);
  for (const key of ["projectRoot", "modelName", "thinkingLevel"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throw new Error(`surface settings ${surfaceId} have invalid ${key}`);
    }
  }
  return { ...value } as TopicSettings;
}

function readTopicSettings(home: string, supplied?: TopicSettingsFile): TopicSettingsFile {
  const raw = supplied ?? readJson(join(home, "state", "topic-settings.json"));
  if (raw === null) return { version: 1, surfaces: {} };
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.surfaces)) {
    throw new Error("invalid canonical topic-settings file for conversation migration");
  }

  const surfaces: Record<SurfaceId, TopicSettings> = {};
  for (const [surfaceId, value] of Object.entries(raw.surfaces)) {
    surfaces[surfaceId as SurfaceId] = validateTopicSettingsValue(surfaceId, value);
  }
  return { version: 1, surfaces };
}

function planEnvironmentOverrides(plan?: ExecutionEnvironmentPlan): Map<string, ExecutionEnvironment> {
  const overrides = new Map<string, ExecutionEnvironment>();
  for (const session of plan?.sessionPlans ?? []) {
    overrides.set(recordKey(session.id, session.archived), session.env);
  }
  return overrides;
}

function recordKey(id: string, archived: boolean): string {
  return `${archived ? "archive" : "active"}:${id}`;
}

function validateConversationRecord(
  id: ConversationId,
  raw: Record<string, unknown>,
  environmentOverride: ExecutionEnvironment | undefined,
): ExecutionEnvironment {
  if (raw.id !== undefined && raw.id !== id) {
    throw new Error(`conversation ${id} state file id mismatch: ${String(raw.id)}`);
  }
  if (typeof raw.createdAt !== "string" || Number.isNaN(Date.parse(raw.createdAt))) {
    throw new Error(`conversation ${id} has missing or invalid createdAt`);
  }
  if (raw.title !== undefined && typeof raw.title !== "string") {
    throw new Error(`conversation ${id} has invalid title`);
  }

  const environment = environmentOverride ?? raw.executionEnvironment;
  if (!isValidExecutionEnvironment(environment)) {
    throw new Error(`conversation ${id} has missing or invalid executionEnvironment`);
  }
  return environment;
}

function recordFromPath(
  id: ConversationId,
  archived: boolean,
  path: string,
  environmentOverrides: Map<string, ExecutionEnvironment>,
): ConversationRecord | null {
  const loaded = readJson(path);
  if (loaded === null) return null;
  if (!isRecord(loaded)) {
    throw new Error(`conversation ${id} state is not an object`);
  }

  const environment = validateConversationRecord(id, loaded, environmentOverrides.get(recordKey(id, archived)));
  return { id, archived, statePath: path, raw: loaded, environment };
}

function listConversationRecords(home: string, environmentPlan?: ExecutionEnvironmentPlan): ConversationRecord[] {
  const records: ConversationRecord[] = [];
  const overrides = planEnvironmentOverrides(environmentPlan);

  function scan(root: string, archived: boolean): void {
    let names: string[];
    try {
      names = readdirSync(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    for (const id of names) {
      if (!isValidConversationId(id)) continue;
      const path = archived
        ? join(root, id, "state.json")
        : statePath(home, id);
      const record = recordFromPath(id, archived, path, overrides);
      if (record !== null) records.push(record);
    }
  }

  const root = sessionsDir(home);
  scan(root, false);
  scan(join(root, "archive"), true);
  return records;
}

function legacyPreference(raw: Record<string, unknown>, key: "modelName" | "thinkingLevel", id: ConversationId): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`conversation ${id} has invalid ${key}`);
  }
  return value;
}

function planTopicSettingsMigration(
  settings: TopicSettingsFile,
  bindings: BindingsFile,
  activeRecords: Map<ConversationId, ConversationRecord>,
): TopicSettingsFile | null {
  const next = cloneSettings(settings);
  let changed = false;

  for (const [surfaceId, conversationId] of Object.entries(bindings.surfaces)) {
    const record = activeRecords.get(conversationId as ConversationId);
    if (record === undefined) {
      throw new Error(`binding ${surfaceId} references missing active conversation ${conversationId}`);
    }
    if (record.raw.chatId === 0) {
      throw new Error(`binding ${surfaceId} references internal conversation ${conversationId}`);
    }

    const modelName = legacyPreference(record.raw, "modelName", record.id);
    const thinkingLevel = legacyPreference(record.raw, "thinkingLevel", record.id);
    if (modelName === undefined && thinkingLevel === undefined) continue;

    const existing = next.surfaces[surfaceId as SurfaceId] ?? {};
    const updated = { ...existing };
    if (updated.modelName === undefined && modelName !== undefined) {
      updated.modelName = modelName;
      changed = true;
    }
    if (updated.thinkingLevel === undefined && thinkingLevel !== undefined) {
      updated.thinkingLevel = thinkingLevel;
      changed = true;
    }
    next.surfaces[surfaceId as SurfaceId] = updated;
  }

  return changed ? next : null;
}

function planConversationRecords(records: ConversationRecord[]): ConversationRecordMigrationPlan[] {
  const plans: ConversationRecordMigrationPlan[] = [];
  for (const record of records) {
    if (record.raw.chatId === 0) continue;
    plans.push({
      id: record.id,
      archived: record.archived,
      statePath: record.statePath,
      state: {
        id: record.id,
        createdAt: record.raw.createdAt as string,
        title: record.raw.title as string | undefined,
        executionEnvironment: record.environment,
      },
    });
  }
  return plans;
}

function validateScheduleRecord(entry: Record<string, unknown>, index: number): void {
  const id = typeof entry.id === "string" && entry.id.length > 0 ? entry.id : String(index);
  if (typeof entry.id !== "string" || entry.id.length === 0) {
    throw new Error(`schedule ${id} has invalid id`);
  }
  if (entry.kind !== "once" && entry.kind !== "recurring" && entry.kind !== "heartbeat") {
    throw new Error(`schedule ${id} has invalid kind`);
  }
  if (entry.prompt !== null && typeof entry.prompt !== "string") {
    throw new Error(`schedule ${id} has invalid prompt`);
  }
  if (typeof entry.enabled !== "boolean") {
    throw new Error(`schedule ${id} has invalid enabled`);
  }
  if (entry.state !== "enabled" && entry.state !== "disabled" && entry.state !== "completed") {
    throw new Error(`schedule ${id} has invalid state`);
  }
  for (const key of ["nextRunAt", "createdAt"] as const) {
    if (typeof entry[key] !== "string" || Number.isNaN(Date.parse(entry[key]))) {
      throw new Error(`schedule ${id} has invalid ${key}`);
    }
  }
  if (entry.intervalMs !== undefined && (typeof entry.intervalMs !== "number" || !Number.isFinite(entry.intervalMs) || entry.intervalMs <= 0)) {
    throw new Error(`schedule ${id} has invalid intervalMs`);
  }
  if ((entry.kind === "recurring" || entry.kind === "heartbeat") && entry.intervalMs === undefined) {
    throw new Error(`schedule ${id} is missing intervalMs`);
  }
  if (entry.source !== undefined && entry.source !== "user" && entry.source !== "agent") {
    throw new Error(`schedule ${id} has invalid source`);
  }
  if (entry.lastRun !== undefined) {
    if (!isRecord(entry.lastRun) || typeof entry.lastRun.at !== "string" || Number.isNaN(Date.parse(entry.lastRun.at))) {
      throw new Error(`schedule ${id} has invalid lastRun`);
    }
    if (!(["ok", "binding-mismatch", "archived", "error", "pending"] as readonly string[]).includes(String(entry.lastRun.outcome))) {
      throw new Error(`schedule ${id} has invalid lastRun outcome`);
    }
    if (entry.lastRun.message !== undefined && typeof entry.lastRun.message !== "string") {
      throw new Error(`schedule ${id} has invalid lastRun message`);
    }
  }
}

function planScheduleMigration(home: string, supplied?: ScheduleStoreFile): ScheduleStoreFile | null {
  const raw: unknown = supplied ?? readJson(schedulesPath(home));
  if (raw === null) return null;
  if (!isRecord(raw) || !Array.isArray(raw.schedules)) {
    throw new Error("invalid schedules file for conversation migration");
  }

  const heartbeats = new Set<string>();
  let changed = false;
  const schedules: PersistedScheduledTurn[] = raw.schedules.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`schedule ${index} is not an object`);
    }
    if (typeof entry.surfaceId !== "string") {
      throw new Error(`schedule ${String(entry.id ?? index)} has invalid surfaceId`);
    }
    parseSurfaceId(entry.surfaceId);
    if (entry.kind === "heartbeat") {
      if (heartbeats.has(entry.surfaceId)) {
        throw new Error(`surface ${entry.surfaceId} has duplicate heartbeat schedules`);
      }
      heartbeats.add(entry.surfaceId);
    }
    validateScheduleRecord(entry, index);

    const migrated = { ...entry };
    if (Object.prototype.hasOwnProperty.call(migrated, "sessionId")) {
      if (typeof migrated.sessionId !== "string") {
        throw new Error(`schedule ${String(migrated.id ?? index)} has invalid sessionId`);
      }
      delete migrated.sessionId;
      changed = true;
    }
    return migrated as unknown as PersistedScheduledTurn;
  });

  return changed ? { schedules } : null;
}

function planHeartbeatPrompts(home: string, bindings: BindingsFile): HeartbeatPromptMigrationPlan[] {
  const plans: HeartbeatPromptMigrationPlan[] = [];
  for (const [surfaceId, conversationId] of Object.entries(bindings.surfaces)) {
    const sourcePath = heartbeatMdPathForSession(home, conversationId);
    const source = readText(sourcePath);
    if (source === null) continue;

    const destinationPath = surfaceHeartbeatPath(home, surfaceId as SurfaceId);
    const destination = readText(destinationPath);
    const sourceHasContent = source.trim().length > 0;
    const destinationHasContent = destination !== null && destination.trim().length > 0;
    if (destination !== null && sourceHasContent && destinationHasContent && source !== destination) {
      throw new Error(`heartbeat prompt conflict between ${sourcePath} and ${destinationPath}`);
    }

    let destinationContent: string | undefined;
    if (destination === null || (sourceHasContent && !destinationHasContent)) {
      destinationContent = source;
    }
    plans.push({ sourcePath, destinationPath, destinationContent });
  }
  return plans;
}

export function planConversationMigration(
  home: string,
  bindings?: BindingsFile,
  settings?: TopicSettingsFile,
  environmentPlan?: ExecutionEnvironmentPlan,
  surfaceSchedules?: ScheduleStoreFile,
): ConversationMigrationPlan {
  const canonicalBindings = readBindings(home, bindings);
  const canonicalSettings = readTopicSettings(home, settings);
  const records = listConversationRecords(home, environmentPlan);
  const activeRecords = new Map<ConversationId, ConversationRecord>();
  for (const record of records) {
    if (!record.archived) activeRecords.set(record.id, record);
  }

  return {
    conversationRecords: planConversationRecords(records),
    topicSettings: planTopicSettingsMigration(canonicalSettings, canonicalBindings, activeRecords),
    schedules: planScheduleMigration(home, surfaceSchedules),
    heartbeatPrompts: planHeartbeatPrompts(home, canonicalBindings),
  };
}

export function applyConversationMigration(home: string, plan: ConversationMigrationPlan): void {
  for (const record of plan.conversationRecords) {
    saveJsonFile(record.statePath, record.state);
  }
  if (plan.topicSettings !== null) {
    saveTopicSettings(home, plan.topicSettings);
  }
  if (plan.schedules !== null) {
    saveStore(home, plan.schedules);
  }
  for (const heartbeat of plan.heartbeatPrompts) {
    if (heartbeat.destinationContent !== undefined) {
      atomicWrite(heartbeat.destinationPath, heartbeat.destinationContent);
    }
    rmSync(heartbeat.sourcePath);
  }
}

export function migrateConversationState(home: string): void {
  const plan = planConversationMigration(home);
  applyConversationMigration(home, plan);
}

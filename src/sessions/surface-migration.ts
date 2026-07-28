/**
 * Offline, precomputed, atomic-per-file migration of legacy session surface
 * state to canonical SurfaceId-keyed files.
 *
 * This runs once at startup, before the SessionManager is initialized or the
 * scheduler begins polling. It reads legacy and/or canonical bindings and
 * topic-settings files, computes the canonical replacement entirely in memory,
 * validates every produced SurfaceId, and only then writes the files.
 *
 * Legacy topic records have no persisted container kind. Migration gathers
 * evidence from every legacy/canonical record addressing the same numeric topic
 * (schedules, canonical bindings/settings) and requires exactly one consistent
 * container (`private` or `supergroup`). Absence or conflict fails before any
 * write so the operator can repair the state deliberately.
 */

import { readFileSync } from "node:fs";
import { surfaceId, parseSurfaceId, topicSurface, dmSurface, supergroupSurface, guestSurface, type Surface, type SurfaceId } from "../surface.ts";
import { saveStore } from "../scheduler/store.ts";
import type { ScheduleStoreFile, PersistedScheduledTurn } from "../scheduler/types.ts";
import { loadBindings, saveBindings, loadLegacyBindings, validateBindings } from "./bindings.ts";
import { loadCanonicalTopicSettingsForMigration, saveTopicSettings, loadLegacyTopicSettings } from "./topic-settings.ts";
import { schedulesPath } from "./paths.ts";
import { surfaceFromLocatorCompat } from "./surface-compat.ts";

import type { BindingsFile, LegacyBindingsFile, LegacyTopicSettingsFile, TopicSettingsFile, ChatLocator, TopicSettings } from "./types.ts";

export interface SurfaceMigrationPlan {
  readonly bindings: BindingsFile;
  readonly settings: TopicSettingsFile;
  readonly schedules: ScheduleStoreFile | null;
}

interface TopicEvidence {
  containers: Set<"private" | "supergroup">;
  sources: string[];
}

interface TopicRef {
  chatId: number;
  topicId: number;
}

function topicKey(ref: TopicRef): string {
  return `${ref.chatId}:${ref.topicId}`;
}

/**
 * Load schedules.json directly for evidence gathering. A missing or malformed
 * file is treated as empty, but filesystem failures propagate. This avoids
 * coupling the session migration to the scheduler's canonical in-memory model,
 * which is migrated in a later phase.
 */
function loadSchedulesForEvidence(home: string): { locator: ChatLocator }[] {
  let raw: string;
  try {
    raw = readFileSync(schedulesPath(home), "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    if (e instanceof SyntaxError) return [];
    throw e;
  }

  if (parsed === null || typeof parsed !== "object" || !Array.isArray((parsed as { schedules?: unknown }).schedules)) {
    return [];
  }
  return (parsed as { schedules: { locator?: ChatLocator }[] }).schedules
    .filter((schedule) => schedule?.locator !== undefined && schedule.locator !== null) as { locator: ChatLocator }[];
}

function collectTopicEvidence(
  canonicalBindings: BindingsFile,
  canonicalSettings: TopicSettingsFile,
  legacyBindings: LegacyBindingsFile,
  legacySettings: LegacyTopicSettingsFile,
  schedules: { locator: ChatLocator }[],
): Map<string, TopicEvidence> {
  const evidence = new Map<string, TopicEvidence>();

  function addEvidence(ref: TopicRef, container: "private" | "supergroup", source: string): void {
    const key = topicKey(ref);
    let entry = evidence.get(key);
    if (!entry) {
      entry = { containers: new Set(), sources: [] };
      evidence.set(key, entry);
    }
    entry.containers.add(container);
    entry.sources.push(source);
  }

  function extractFromSurfaceId(text: string, source: string): void {
    try {
      const surface = parseSurfaceId(text);
      if (surface.kind === "topic" && (surface.container === "private" || surface.container === "supergroup")) {
        addEvidence({ chatId: surface.chatId, topicId: surface.topicId }, surface.container, source);
      }
    } catch {
      // Ignore invalid canonical SurfaceIds; they will fail validation later.
    }
  }

  // Canonical bindings/settings already encode the container in the SurfaceId.
  for (const key of Object.keys(canonicalBindings.surfaces)) {
    extractFromSurfaceId(key, "canonical bindings");
  }
  for (const key of Object.keys(canonicalSettings.surfaces)) {
    extractFromSurfaceId(key, "canonical topic-settings");
  }

  // Legacy schedules carry explicit isPrivate metadata.
  for (let i = 0; i < schedules.length; i += 1) {
    const loc = schedules[i]!.locator;
    if (loc.topicId === undefined) continue;
    if (loc.isPrivate === true) {
      addEvidence({ chatId: loc.chatId, topicId: loc.topicId }, "private", `schedule ${i}`);
    } else if (loc.isPrivate === false) {
      addEvidence({ chatId: loc.chatId, topicId: loc.topicId }, "supergroup", `schedule ${i}`);
    }
  }

  // Identify which topics need evidence but were not proven above.
  function noteTopic(ref: TopicRef, source: string): void {
    const key = topicKey(ref);
    if (!evidence.has(key)) {
      evidence.set(key, { containers: new Set(), sources: [source] });
    }
  }

  for (const chatKey of Object.keys(legacyBindings.topics ?? {})) {
    const chatId = Number(chatKey);
    if (!Number.isSafeInteger(chatId)) continue;
    for (const topicKeyStr of Object.keys(legacyBindings.topics![chatKey] ?? {})) {
      const topicId = Number(topicKeyStr);
      if (!Number.isSafeInteger(topicId)) continue;
      noteTopic({ chatId, topicId }, "legacy bindings");
    }
  }

  for (const chatKey of Object.keys(legacySettings.topics ?? {})) {
    const chatId = Number(chatKey);
    if (!Number.isSafeInteger(chatId)) continue;
    for (const topicKeyStr of Object.keys(legacySettings.topics![chatKey] ?? {})) {
      const topicId = Number(topicKeyStr);
      if (!Number.isSafeInteger(topicId)) continue;
      noteTopic({ chatId, topicId }, "legacy topic-settings");
    }
  }

  return evidence;
}

function buildSessionSurfaces(bindings: BindingsFile): Map<string, Surface[]> {
  const map = new Map<string, Surface[]>();
  for (const [key, sessionId] of Object.entries(bindings.surfaces)) {
    const surface = parseSurfaceId(key as string);
    const arr = map.get(sessionId) ?? [];
    arr.push(surface);
    map.set(sessionId, arr);
  }
  return map;
}

function resolveTopicContainer(
  evidence: Map<string, TopicEvidence>,
  ref: TopicRef,
): "private" | "supergroup" {
  const key = topicKey(ref);
  const entry = evidence.get(key);
  if (!entry || entry.containers.size === 0) {
    const alternatives = [
      `tg:v1:topic:private:${ref.chatId}:${ref.topicId}`,
      `tg:v1:topic:supergroup:${ref.chatId}:${ref.topicId}`,
    ].join(", ");
    throw new Error(
      `Cannot migrate topic ${ref.chatId}:${ref.topicId}: missing container evidence. Replace the legacy entry with one of: ${alternatives}`,
    );
  }
  if (entry.containers.size > 1) {
    const containers = Array.from(entry.containers).join(", ");
    throw new Error(
      `Cannot migrate topic ${ref.chatId}:${ref.topicId}: conflicting container evidence (${containers}). Replace the legacy entry with the correct SurfaceId explicitly.`,
    );
  }
  return Array.from(entry.containers)[0]!;
}

function migrateBindings(
  canonical: BindingsFile,
  legacy: LegacyBindingsFile,
  evidence: Map<string, TopicEvidence>,
): BindingsFile {
  const surfaces: Record<SurfaceId, string> = { ...canonical.surfaces };

  for (const key of Object.keys(surfaces)) {
    parseSurfaceId(key as string);
  }

  function add(surface: Surface, sessionId: string): void {
    const key = surfaceId(surface);
    if (Object.prototype.hasOwnProperty.call(surfaces, key)) {
      // Canonical value wins on idempotence / mixed-generation restart.
      return;
    }
    // Validate the produced SurfaceId before accepting it.
    parseSurfaceId(key as string);
    surfaces[key] = sessionId;
  }

  for (const [chatKey, sessionId] of Object.entries(legacy.dm ?? {})) {
    const chatId = Number(chatKey);
    if (!Number.isSafeInteger(chatId) || chatId === 0) {
      throw new Error(`Cannot migrate legacy dm binding: invalid chat id ${chatKey}`);
    }
    add(dmSurface(chatId), sessionId);
  }

  for (const [chatKey, sessionId] of Object.entries(legacy.supergroups ?? {})) {
    const chatId = Number(chatKey);
    if (!Number.isSafeInteger(chatId) || chatId === 0) {
      throw new Error(`Cannot migrate legacy supergroup binding: invalid chat id ${chatKey}`);
    }
    add(supergroupSurface(chatId), sessionId);
  }

  for (const [chatKey, sessionId] of Object.entries(legacy.guest ?? {})) {
    const chatId = Number(chatKey);
    if (!Number.isSafeInteger(chatId) || chatId === 0) {
      throw new Error(`Cannot migrate legacy guest binding: invalid chat id ${chatKey}`);
    }
    add(guestSurface(chatId), sessionId);
  }

  for (const [chatKey, topics] of Object.entries(legacy.topics ?? {})) {
    const chatId = Number(chatKey);
    if (!Number.isSafeInteger(chatId) || chatId === 0) {
      throw new Error(`Cannot migrate legacy topic binding: invalid chat id ${chatKey}`);
    }
    if (!topics || typeof topics !== "object") continue;
    for (const [topicKeyStr, sessionId] of Object.entries(topics)) {
      const topicId = Number(topicKeyStr);
      if (!Number.isSafeInteger(topicId) || topicId <= 0) {
        throw new Error(`Cannot migrate legacy topic binding: invalid topic id ${topicKeyStr}`);
      }
      const container = resolveTopicContainer(evidence, { chatId, topicId });
      add(topicSurface(container, chatId, topicId), sessionId);
    }
  }

  return { version: 1, surfaces };
}

function migrateSettings(
  canonical: TopicSettingsFile,
  legacy: LegacyTopicSettingsFile,
  evidence: Map<string, TopicEvidence>,
): TopicSettingsFile {
  const surfaces: Record<SurfaceId, TopicSettings> = { ...canonical.surfaces };

  for (const key of Object.keys(surfaces)) {
    parseSurfaceId(key as string);
  }

  function add(surface: Surface, settings: TopicSettings): void {
    const key = surfaceId(surface);
    if (Object.prototype.hasOwnProperty.call(surfaces, key)) {
      return;
    }
    parseSurfaceId(key as string);
    surfaces[key] = settings;
  }

  for (const [chatKey, settings] of Object.entries(legacy.dm ?? {})) {
    const chatId = Number(chatKey);
    if (!Number.isSafeInteger(chatId) || chatId === 0) {
      throw new Error(`Cannot migrate legacy dm settings: invalid chat id ${chatKey}`);
    }
    add(dmSurface(chatId), settings);
  }

  for (const [chatKey, settings] of Object.entries(legacy.supergroups ?? {})) {
    const chatId = Number(chatKey);
    if (!Number.isSafeInteger(chatId) || chatId === 0) {
      throw new Error(`Cannot migrate legacy supergroup settings: invalid chat id ${chatKey}`);
    }
    add(supergroupSurface(chatId), settings);
  }

  for (const [chatKey, topics] of Object.entries(legacy.topics ?? {})) {
    const chatId = Number(chatKey);
    if (!Number.isSafeInteger(chatId) || chatId === 0) {
      throw new Error(`Cannot migrate legacy topic settings: invalid chat id ${chatKey}`);
    }
    if (!topics || typeof topics !== "object") continue;
    for (const [topicKeyStr, settings] of Object.entries(topics)) {
      const topicId = Number(topicKeyStr);
      if (!Number.isSafeInteger(topicId) || topicId <= 0) {
        throw new Error(`Cannot migrate legacy topic settings: invalid topic id ${topicKeyStr}`);
      }
      const container = resolveTopicContainer(evidence, { chatId, topicId });
      add(topicSurface(container, chatId, topicId), settings);
    }
  }

  return { version: 1, surfaces };
}

type LegacyScheduleRecord = {
  id: string;
  sessionId: string;
  surfaceId?: string;
  locator?: ChatLocator;
  kind: unknown;
  prompt?: string | null;
  enabled?: boolean;
  state?: unknown;
  nextRunAt?: string;
  intervalMs?: number;
  createdAt?: string;
  source?: unknown;
  lastRun?: unknown;
};

function scheduleSurface(
  loc: ChatLocator,
  sessionId: string,
  sessionSurfaces: Map<string, Surface[]>,
  evidence: Map<string, TopicEvidence>,
  recordId: string,
): Surface {
  if (loc.topicId !== undefined) {
    if (loc.isPrivate === true) {
      return topicSurface("private", loc.chatId, loc.topicId);
    }
    if (loc.isPrivate === false) {
      return topicSurface("supergroup", loc.chatId, loc.topicId);
    }
    const container = resolveTopicContainer(evidence, { chatId: loc.chatId, topicId: loc.topicId });
    return topicSurface(container, loc.chatId, loc.topicId);
  }

  if (loc.isPrivate !== undefined) {
    return surfaceFromLocatorCompat(loc);
  }

  const candidates = sessionSurfaces.get(sessionId) ?? [];
  const matches = candidates.filter((s) => s.kind !== "topic" && s.chatId === loc.chatId);
  if (matches.length === 1) {
    return matches[0]!;
  }
  if (matches.length === 0) {
    throw new Error(
      `Cannot migrate schedule ${recordId} (session ${sessionId}, chat ${loc.chatId}): no binding candidate. Bind the session to a DM, supergroup, or guest surface first, or set the locator's isPrivate flag.`,
    );
  }
  throw new Error(
    `Cannot migrate schedule ${recordId} (session ${sessionId}, chat ${loc.chatId}): multiple binding candidates. Set the locator's isPrivate flag or resolve the ambiguous bindings before migrating.`,
  );
}

/**
 * Plan the migration of legacy `schedules.json` entries from `locator` to `surfaceId`.
 *
 * The file is read directly so partially-migrated files (some legacy, some
 * canonical) are handled: canonical records with `surfaceId` are preserved;
 * legacy records with `locator` are rewritten to `surfaceId`. The returned
 * canonical file is validated in memory; the caller writes it atomically after
 * all other outputs have been computed.
 */
function planScheduleMigration(
  home: string,
  bindings: BindingsFile,
  evidence: Map<string, TopicEvidence>,
): ScheduleStoreFile | null {
  let raw: string;
  try {
    raw = readFileSync(schedulesPath(home), "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed schedules are left as-is; the scheduler will log and treat
    // the store as empty at runtime.
    return null;
  }

  if (parsed === null || typeof parsed !== "object" || !Array.isArray((parsed as Record<string, unknown>).schedules)) {
    return null;
  }

  const file = parsed as ScheduleStoreFile;
  let changed = false;
  const sessionSurfaces = buildSessionSurfaces(bindings);

  const migrated: PersistedScheduledTurn[] = file.schedules.map((entry) => {
    const rawEntry = entry as unknown as LegacyScheduleRecord;
    if (rawEntry.surfaceId !== undefined) {
      return entry as PersistedScheduledTurn;
    }
    if (rawEntry.locator === undefined) {
      throw new Error(
        `Cannot migrate schedule ${rawEntry.id ?? "(unknown)"}: missing both surfaceId and locator`,
      );
    }

    changed = true;
    const surface = scheduleSurface(
      rawEntry.locator,
      rawEntry.sessionId,
      sessionSurfaces,
      evidence,
      rawEntry.id ?? "(unknown)",
    );
    const newEntry = { ...entry, surfaceId: surfaceId(surface) } as PersistedScheduledTurn;
    // @ts-expect-error drop legacy locator field
    delete newEntry.locator;
    return newEntry;
  });

  for (const entry of migrated) {
    parseSurfaceId(entry.surfaceId as string);
  }

  if (!changed) return null;

  return { schedules: migrated };
}

/**
 * Read legacy and canonical surface state, compute the canonical replacement
 * for every file in memory, and validate every produced SurfaceId. The result
 * is a read-only plan: no persisted input is mutated.
 */
export function planSurfaceMigration(home: string): SurfaceMigrationPlan {
  const canonicalBindings = loadBindings(home);
  const legacyBindings = loadLegacyBindings(home);
  const canonicalSettings = loadCanonicalTopicSettingsForMigration(home);
  const legacySettings = loadLegacyTopicSettings(home);
  const schedules = loadSchedulesForEvidence(home);

  const evidence = collectTopicEvidence(
    canonicalBindings,
    canonicalSettings,
    legacyBindings,
    legacySettings,
    schedules,
  );

  const newBindings = migrateBindings(canonicalBindings, legacyBindings, evidence);
  validateBindings(newBindings);
  const newSettings = migrateSettings(canonicalSettings, legacySettings, evidence);
  const newSchedules = planScheduleMigration(home, newBindings, evidence);

  return { bindings: newBindings, settings: newSettings, schedules: newSchedules };
}

/**
 * Apply a validated surface migration plan. This performs the per-file atomic
 * writes and is the only surface-migration path that mutates persisted input.
 */
export function applySurfaceMigration(home: string, plan: SurfaceMigrationPlan): void {
  saveBindings(home, plan.bindings);
  saveTopicSettings(home, plan.settings);
  if (plan.schedules !== null) {
    saveStore(home, plan.schedules);
  }
}

/**
 * Convenience entry point: plan and apply surface migration in one call.
 * New orchestration code should prefer the separate plan/apply functions so
 * the whole-run migration can preflight every step before the first write.
 */
export function migrateSurfaceState(home: string): void {
  const plan = planSurfaceMigration(home);
  applySurfaceMigration(home, plan);
}

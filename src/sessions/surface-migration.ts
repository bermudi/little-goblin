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
import { loadBindings, saveBindings, loadLegacyBindings } from "./bindings.ts";
import { loadTopicSettings, saveTopicSettings, loadLegacyTopicSettings } from "./topic-settings.ts";
import { schedulesPath } from "./paths.ts";
import type { BindingsFile, LegacyBindingsFile, LegacyTopicSettingsFile, TopicSettingsFile, ChatLocator, TopicSettings } from "./types.ts";

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
 * Load schedules.json directly for evidence gathering. Reading is best-effort:
 * missing or malformed files are treated as empty. This avoids coupling the
 * session migration to the scheduler's canonical in-memory model, which is
 * migrated in a later phase.
 */
function loadSchedulesForEvidence(home: string): { locator: ChatLocator }[] {
  try {
    const raw = readFileSync(schedulesPath(home), "utf-8");
    const parsed = JSON.parse(raw) as { schedules?: { locator?: ChatLocator }[] };
    if (!Array.isArray(parsed?.schedules)) return [];
    return parsed.schedules.filter((s) => s?.locator !== undefined) as { locator: ChatLocator }[];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    // Malformed schedules should not block bindings/settings migration.
    return [];
  }
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

/**
 * Migrate legacy bindings and topic-settings to canonical SurfaceId-keyed files.
 *
 * The migration is fully precomputed: it throws before writing if any topic
 * lacks unambiguous container evidence. It is idempotent across legacy,
 * canonical, and mixed-generation inputs.
 */
export function migrateSurfaceState(home: string): void {
  const canonicalBindings = loadBindings(home);
  const legacyBindings = loadLegacyBindings(home);
  const canonicalSettings = loadTopicSettings(home);
  const legacySettings = loadLegacyTopicSettings(home);
  const schedules = loadSchedulesForEvidence(home);

  // Short-circuit: nothing legacy to process.
  const hasLegacy =
    Object.keys(legacyBindings.dm ?? {}).length > 0 ||
    Object.keys(legacyBindings.topics ?? {}).length > 0 ||
    Object.keys(legacyBindings.supergroups ?? {}).length > 0 ||
    Object.keys(legacyBindings.guest ?? {}).length > 0 ||
    Object.keys(legacySettings.dm ?? {}).length > 0 ||
    Object.keys(legacySettings.topics ?? {}).length > 0 ||
    Object.keys(legacySettings.supergroups ?? {}).length > 0;

  if (!hasLegacy) {
    return;
  }

  const evidence = collectTopicEvidence(
    canonicalBindings,
    canonicalSettings,
    legacyBindings,
    legacySettings,
    schedules,
  );

  const newBindings = migrateBindings(canonicalBindings, legacyBindings, evidence);
  const newSettings = migrateSettings(canonicalSettings, legacySettings, evidence);

  saveBindings(home, newBindings);
  saveTopicSettings(home, newSettings);
}

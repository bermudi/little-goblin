#!/usr/bin/env bun
/**
 * Migration script: move projectDir from session state.json to topic-settings.json.
 *
 * Scans all sessions for projectDir, looks up which binding (DM/topic/supergroup)
 * points to that session, and creates the corresponding entry in topic-settings.json.
 * Then strips projectDir from state.json.
 *
 * Run: bun run specs/changes/binding-scoped-project-dir/migrate.ts
 *
 * Safe to run multiple times (idempotent). Skips sessions with no active binding
 * (orphaned sessions).
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const home = process.env.GOBLIN_HOME ?? join(process.env.HOME!, ".goblin");

console.log(`Migrating projectDir from sessions to topic-settings in: ${home}`);

// --- Load bindings (config.json) ---
interface BindingsFile {
  dm?: Record<string, string>;
  topics?: Record<string, Record<string, string>>;
  supergroups?: Record<string, string>;
}

const configPath = join(home, "config.json");
let bindings: BindingsFile = { dm: {}, topics: {}, supergroups: {} };
if (existsSync(configPath)) {
  bindings = JSON.parse(readFileSync(configPath, "utf-8"));
}

// Build reverse map: sessionId -> { type, chatId, topicId? }
interface BindingTarget {
  type: "dm" | "topic" | "supergroup";
  chatId: string;
  topicId?: string;
}

const reverseMap = new Map<string, BindingTarget>();

for (const [chatId, sessionId] of Object.entries(bindings.dm ?? {})) {
  reverseMap.set(sessionId, { type: "dm", chatId });
}
for (const [chatId, sessionId] of Object.entries(bindings.supergroups ?? {})) {
  reverseMap.set(sessionId, { type: "supergroup", chatId });
}
for (const [chatId, inner] of Object.entries(bindings.topics ?? {})) {
  for (const [topicId, sessionId] of Object.entries(inner)) {
    reverseMap.set(sessionId, { type: "topic", chatId, topicId });
  }
}

// --- Load topic-settings.json ---
interface TopicSettings {
  projectDir?: string;
}

interface TopicSettingsFile {
  topics?: Record<string, Record<string, TopicSettings>>;
  dm?: Record<string, TopicSettings>;
  supergroups?: Record<string, TopicSettings>;
}

const topicSettingsPath = join(home, "topic-settings.json");
let topicSettings: TopicSettingsFile = { topics: {}, dm: {}, supergroups: {} };
if (existsSync(topicSettingsPath)) {
  try {
    topicSettings = JSON.parse(readFileSync(topicSettingsPath, "utf-8"));
  } catch {
    console.warn("  Warning: malformed topic-settings.json, starting fresh");
    topicSettings = { topics: {}, dm: {}, supergroups: {} };
  }
}

// --- Scan sessions ---
interface SessionState {
  id: string;
  projectDir?: string;
  chatId: number;
  topicId?: number;
}

const sessionsDir = join(home, "sessions");
if (!existsSync(sessionsDir)) {
  console.log("No sessions directory found. Nothing to migrate.");
  process.exit(0);
}

let migrated = 0;
let skipped = 0;

const entries = readdirSync(sessionsDir);

for (const id of entries) {
  if (id === "archive") continue;

  const stateFile = join(sessionsDir, id, "state.json");
  if (!existsSync(stateFile)) continue;

  let state: SessionState;
  try {
    state = JSON.parse(readFileSync(stateFile, "utf-8"));
  } catch {
    console.warn(`  Warning: malformed state.json for session ${id}, skipping`);
    continue;
  }

  if (!state.projectDir) continue;

  const binding = reverseMap.get(id);
  if (!binding) {
    console.log(
      `  Skipping orphaned session ${id} (projectDir: ${state.projectDir}) — no active binding`,
    );
    skipped++;
    continue;
  }

  // Write to topic-settings
  const chatKey = binding.chatId;
  if (binding.type === "topic" && binding.topicId !== undefined) {
    const topicKey = binding.topicId;
    topicSettings.topics ??= {};
    topicSettings.topics[chatKey] ??= {};
    topicSettings.topics[chatKey]![topicKey] = { projectDir: state.projectDir };
  } else if (binding.type === "supergroup") {
    topicSettings.supergroups ??= {};
    topicSettings.supergroups[chatKey] = { projectDir: state.projectDir };
  } else {
    topicSettings.dm ??= {};
    topicSettings.dm[chatKey] = { projectDir: state.projectDir };
  }

  console.log(
    `  Migrated: session ${id} -> ${binding.type}(${chatKey}${binding.topicId ? `, ${binding.topicId}` : ""}) projectDir=${state.projectDir}`,
  );

  // Strip projectDir from state.json
  const { projectDir: _, ...rest } = state;
  const tmpPath = join(sessionsDir, id, `.state-${id}.migrate.tmp`);
  writeFileSync(tmpPath, JSON.stringify(rest, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, stateFile);

  migrated++;
}

// --- Save topic-settings.json ---
if (migrated > 0) {
  const tmpPath = join(home, `.topic-settings.${randomUUID().slice(0, 8)}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(topicSettings, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, topicSettingsPath);
}

console.log(`\nDone. Migrated: ${migrated}, Skipped (orphaned): ${skipped}`);

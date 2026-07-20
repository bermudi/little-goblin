/**
 * One-shot migration from legacy markdown memory files into the SQLite-backed
 * memory store. The markdown files are preserved on disk as read-only export
 * artifacts; the SQLite database becomes canonical after migration.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { memoryDir } from "./paths.ts";
import { MemoryStore } from "./store.ts";
import type { MemoryEntryInput } from "./store.ts";

interface MarkdownScope {
  scope: string;
  entryKind: "memory" | "user";
  chatId: string | null;
}

interface ParsedMarkdown {
  description?: string;
  entries: string[];
}

function isInside(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith("/");
}

function scopeForMarkdownPath(memoryRoot: string, filePath: string): MarkdownScope | null {
  if (!isInside(memoryRoot, filePath)) return null;
  const rel = relative(memoryRoot, filePath).replace(/\\/g, "/");

  if (rel === "user.md") {
    return { scope: "user", entryKind: "user", chatId: null };
  }
  if (rel === "general/memory.md") {
    return { scope: "general", entryKind: "memory", chatId: null };
  }

  const topicsMatch = rel.match(/^topics\/(-?\d+)\/(-?\d+)\/memory\.md$/);
  if (topicsMatch) {
    const [, chatId, topicId] = topicsMatch;
    return { scope: `topics/${chatId}/${topicId}`, entryKind: "memory", chatId: String(Number(chatId)) };
  }

  const agentsMatch = rel.match(/^agents\/([^/]+)\/memory\.md$/);
  if (agentsMatch) {
    const [, name] = agentsMatch;
    return { scope: `agents/${name}`, entryKind: "memory", chatId: null };
  }

  const archiveMatch = rel.match(/^archive\/topics\/(-?\d+)\/(-?\d+)\/memory\.md$/);
  if (archiveMatch) {
    const [, chatId, topicId] = archiveMatch;
    return { scope: `archive/topics/${chatId}/${topicId}`, entryKind: "memory", chatId: String(Number(chatId)) };
  }

  return null;
}

function parseFrontmatter(content: string): ParsedMarkdown {
  let body = content;
  let description: string | undefined;

  if (content.startsWith("---\n") || content.startsWith("---\r\n")) {
    const newline = content.startsWith("---\r\n") ? "\r\n" : "\n";
    const endMarker = `${newline}---${newline}`;
    const endIndex = content.indexOf(endMarker, 4);
    if (endIndex !== -1) {
      const frontmatter = content.slice(4, endIndex);
      body = content.slice(endIndex + endMarker.length);
      for (const line of frontmatter.split(/\r?\n/)) {
        const match = line.match(/^description\s*:\s*(.*)$/);
        if (match) {
          let value = (match[1] ?? "").trim();
          if (value.startsWith('"') && value.endsWith('"')) {
            try {
              value = JSON.parse(value) as string;
            } catch {
              // Not valid JSON; fall through to manual unquoting.
            }
          }
          if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          description = value;
        }
      }
    }
  }

  const entries = body.length === 0 ? [] : body.split("\n§\n").map((e) => e.trim()).filter((e) => e.length > 0);
  return { description, entries };
}


function discoverMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(join(entry.parentPath ?? entry.path, entry.name));
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return results;
}

function fileCommitTimeMs(filePath: string): number | null {
  try {
    const out = execFileSync(
      "git",
      ["log", "-1", "--format=%ct", "--", filePath],
      { encoding: "utf-8", timeout: 5000 },
    );
    const seconds = Number.parseInt(out.trim(), 10);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  } catch {
    // Not a git repo, file not tracked, or git unavailable.
  }
  return null;
}

/**
 * Migrate legacy markdown memory files into the SQLite-backed
 * memory store. No-op if the store already has a `migrated_at` meta key.
 * Returns true when migration ran.
 */
export async function migrateFromMarkdown(home: string, store: MemoryStore): Promise<boolean> {
  if (store.db.getMeta("migrated_at") !== undefined) {
    return false;
  }

  const root = memoryDir(home);
  const files = discoverMarkdownFiles(root);
  const byScope = new Map<string, { scope: MarkdownScope; description?: string; entries: string[]; timestamp: number }>();

  for (const file of files) {
    const scopeInfo = scopeForMarkdownPath(root, file);
    if (scopeInfo === null) continue;

    const content = readFileSync(file, "utf-8");
    const parsed = parseFrontmatter(content);
    const timestamp = fileCommitTimeMs(file) ?? statSync(file).mtimeMs;

    const existing = byScope.get(scopeInfo.scope);
    if (existing) {
      // Defensive: if a scope somehow appears twice, keep the first.
      continue;
    }
    byScope.set(scopeInfo.scope, { scope: scopeInfo, description: parsed.description, entries: parsed.entries, timestamp });
  }

  const inputs: Array<MemoryEntryInput & { description?: string }> = [];
  for (const { scope, description, entries, timestamp } of byScope.values()) {
    for (const [i, entry] of entries.entries()) {
      inputs.push({
        scope: scope.scope,
        entryKind: scope.entryKind,
        text: entry,
        origin: "user",
        createdAt: timestamp + i,
        updatedAt: timestamp + i,
        chatId: scope.chatId,
        description,
      });
    }
    if (entries.length === 0 && description !== undefined) {
      inputs.push({
        scope: scope.scope,
        entryKind: scope.entryKind,
        text: "",
        origin: "user",
        createdAt: timestamp,
        updatedAt: timestamp,
        chatId: scope.chatId,
        description,
      });
    }
  }

  if (inputs.length > 0) {
    await store.importEntries(inputs);
  }

  store.db.setMeta("migrated_at", String(Date.now()));
  return true;
}

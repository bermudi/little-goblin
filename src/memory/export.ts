/**
 * Markdown export from the SQLite-backed memory store.
 *
 * Writes `user.md`, `general/memory.md`, `topics/<chatId>/<topicId>/memory.md`,
 * and `agents/<name>/memory.md` from the canonical SQLite state. Transcript
 * entries and archived scopes are not exported. Description metadata is written
 * as YAML frontmatter. All writes are atomic (tmp + rename).
 */

import { join } from "node:path";
import { atomicWrite } from "../fs.ts";
import { memoryDir, userPath } from "./paths.ts";
import { MemoryStore } from "./store.ts";

function pathForScope(home: string, scope: string): string | null {
  if (scope === "user") return userPath(home);
  if (scope === "general") return join(memoryDir(home), "general", "memory.md");

  const topicsMatch = scope.match(/^topics\/(-?\d+)\/(-?\d+)$/);
  if (topicsMatch) {
    const [, chatId, topicId] = topicsMatch;
    return join(memoryDir(home), "topics", chatId!, topicId!, "memory.md");
  }

  const agentsMatch = scope.match(/^agents\/([^/]+)$/);
  if (agentsMatch) {
    const [, name] = agentsMatch;
    return join(memoryDir(home), "agents", name!, "memory.md");
  }

  return null;
}

function formatFrontmatter(description: string | null): string {
  if (!description) return "";
  const escaped = description.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `---\ndescription: "${escaped}"\n---\n\n`;
}

/**
 * Regenerate the markdown export files from the current SQLite memory state.
 */
export function exportToMarkdown(home: string, store: MemoryStore): void {
  const db = store.db.database;

  const rows = db
    .query<{ scope: string }, Record<string, never>>(
      `SELECT scope FROM (
        SELECT DISTINCT scope FROM memory_entries WHERE entry_kind IN ('memory', 'user')
        UNION
        SELECT scope FROM memory_scopes
      ) ORDER BY scope`,
    )
    .all({});

  for (const { scope } of rows) {
    if (scope.startsWith("archive/")) continue;
    const filePath = pathForScope(home, scope);
    if (filePath === null) continue;

    const descriptionRow = db
      .query<{ description: string | null }, { $scope: string }>(
        "SELECT description FROM memory_scopes WHERE scope = $scope",
      )
      .get({ $scope: scope });

    const entries = db
      .query<{ text: string }, { $scope: string }>(
        "SELECT text FROM memory_entries WHERE scope = $scope AND entry_kind IN ('memory', 'user') ORDER BY display_order, created_at, id",
      )
      .all({ $scope: scope })
      .map((r) => r.text);

    const frontmatter = formatFrontmatter(descriptionRow?.description ?? null);
    const body = entries.join("\n§\n");
    atomicWrite(filePath, frontmatter + body);
  }
}

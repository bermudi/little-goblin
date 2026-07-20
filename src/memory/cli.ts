/**
 * CLI for inspecting and exporting the SQLite-backed memory store.
 *
 * Usage:
 *   bun run src/memory/cli.ts export
 *   bun run src/memory/cli.ts status
 *   bun run src/memory/cli.ts search <query>
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, statSync } from "node:fs";
import { MemoryDatabase } from "./db.ts";
import { MemoryStore } from "./store.ts";
import { EmbeddingProvider } from "./embeddings.ts";
import { searchMemoryEntries, type PersonaPolicy } from "./search.ts";
import { exportToMarkdown } from "./export.ts";
import { memoryDbPath, memoryDir } from "./paths.ts";

function goblinHome(): string {
  return process.env.GOBLIN_HOME ?? join(homedir(), ".goblin");
}

function ensureMemoryDir(home: string): void {
  mkdirSync(memoryDir(home), { recursive: true });
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function exportCommand(): Promise<void> {
  const home = goblinHome();
  ensureMemoryDir(home);
  const db = new MemoryDatabase(memoryDbPath(home));
  const store = new MemoryStore(db);
  try {
    exportToMarkdown(home, store);
    out("Memory export complete.");
  } finally {
    store.close();
  }
}

async function statusCommand(): Promise<void> {
  const home = goblinHome();
  ensureMemoryDir(home);
  const db = new MemoryDatabase(memoryDbPath(home));
  const embeddings = new EmbeddingProvider(db);
  const store = new MemoryStore(db, undefined, { embeddings });
  try {
    const dbSize = statSync(memoryDbPath(home)).size;
    const entryCount = store.getEntryCount();
    const usage = store.currentBudgetUsage();
    const lastSync = store.db.getMeta("last_transcript_sync");
    const status = embeddings.status();

    out(`Database: ${memoryDbPath(home)}`);
    out(`Size: ${formatBytes(dbSize)}`);
    out(`Entries: ${entryCount}`);
    out(`Budget: ${usage.current} / ${usage.budget} chars`);
    out(`Embedding provider: ${status.model} (${status.degraded ? "degraded" : "ok"})`);
    if (status.lastError) {
      out(`Last embedding error: ${status.lastError}`);
    }
    if (lastSync) {
      out(`Last transcript sync: ${new Date(Number.parseInt(lastSync, 10)).toISOString()}`);
    } else {
      out("Last transcript sync: never");
    }
  } finally {
    store.close();
  }
}

async function searchCommand(query: string): Promise<void> {
  const home = goblinHome();
  ensureMemoryDir(home);
  const db = new MemoryDatabase(memoryDbPath(home));
  const embeddings = new EmbeddingProvider(db);
  const store = new MemoryStore(db, undefined, { embeddings });
  try {
    const persona: PersonaPolicy = { kind: "all" };
    const activeScope = { chatId: 0, topicScope: "general" as const, namedAgent: null };
    const output = await searchMemoryEntries({
      store,
      activeScope,
      persona,
      query,
      corpus: "all",
      allChats: true,
    });

    out(`query: ${output.query}`);
    out(`searched scopes: ${output.searchedScopes}`);
    out(`results: ${output.results.length}`);
    for (const [i, result] of output.results.entries()) {
      out(`\n[${i + 1}] ${result.score.toFixed(4)}  ${result.scope}  v=${result.vectorScore.toFixed(4)} t=${result.textScore.toFixed(4)} b=${result.conceptBoost.toFixed(2)}`);
      out(result.text);
    }
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case "export":
      await exportCommand();
      break;
    case "status":
      await statusCommand();
      break;
    case "search": {
      const query = args.join(" ").trim();
      if (query.length === 0) {
        err("Usage: bun run src/memory/cli.ts search <query>");
        process.exit(1);
      }
      await searchCommand(query);
      break;
    }
    default:
      err("Usage: bun run src/memory/cli.ts {export|status|search <query>}");
      process.exit(1);
  }
}

main().catch((err) => {
  err(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

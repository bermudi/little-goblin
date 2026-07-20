/**
 * SQLite schema for the memory engine.
 *
 * Canonical store is `$GOBLIN_HOME/state/memory/memory.sqlite`.
 * WAL mode is enabled by the database lifecycle module.
 */

export const MEMORY_SCHEMA_VERSION = 2;

export const DDL = `
-- Schema metadata
CREATE TABLE IF NOT EXISTS memory_meta (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER
);

-- Memory entries. description lives in memory_scopes, not here.
CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  entry_kind TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  source_session TEXT,
  updated_source_session TEXT,
  source_role TEXT,
  category TEXT,
  confidence REAL,
  origin TEXT NOT NULL,
  promoted_at INTEGER,
  chat_id TEXT,
  recall_count INTEGER NOT NULL DEFAULT 0,
  last_recalled_at INTEGER
);

-- Per-scope metadata (description and last update).
CREATE TABLE IF NOT EXISTS memory_scopes (
  scope TEXT PRIMARY KEY,
  description TEXT,
  updated_at INTEGER NOT NULL
);

-- Cached embeddings per entry.
CREATE TABLE IF NOT EXISTS memory_embeddings (
  entry_id TEXT PRIMARY KEY REFERENCES memory_entries(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  hash TEXT NOT NULL,
  embedding BLOB NOT NULL,
  dims INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- FTS5 contentful index. Maintained manually on mutating paths.
CREATE VIRTUAL TABLE IF NOT EXISTS memory_index_fts USING fts5 (
  text,
  entry_id,
  scope,
  entry_kind,
  chat_id
);

-- Transcript sync tracking.
CREATE TABLE IF NOT EXISTS memory_sources (
  path TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  hash TEXT,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Concept vocabulary tags per entry.
CREATE TABLE IF NOT EXISTS memory_entry_tags (
  entry_id TEXT NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (entry_id, tag)
);
`;

export const INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_memory_entries_scope_kind ON memory_entries(scope, entry_kind);
CREATE INDEX IF NOT EXISTS idx_memory_entries_chat_id ON memory_entries(chat_id) WHERE chat_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_entries_origin ON memory_entries(origin);
CREATE INDEX IF NOT EXISTS idx_memory_entry_tags_tag ON memory_entry_tags(tag);
`;

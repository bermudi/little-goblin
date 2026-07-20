# Memory Scopes Table

## Status

accepted

## Context

The memory-engine design originally stored per-scope `description` as a column on `memory_entries`, duplicated across every row in the scope. This has two problems:

1. **Empty-scope footgun:** `set_description` on a scope with zero entries is a silent no-op — the UPDATE touches zero rows and the description is lost. A user who sets a description before writing any entries sees it disappear. The tool returns success.

2. **Duplication:** The description is stored on every row in the scope. Updating it requires a multi-row UPDATE. If rows are inserted by dreaming between a `set_description` call and the next read, the new rows carry a stale (or null) description unless the writer copies it.

## Decision

The system SHALL maintain a `memory_scopes` table that normalizes per-scope metadata:

```
memory_scopes (
  scope TEXT PRIMARY KEY,
  description TEXT,
  updated_at INTEGER NOT NULL
)
```

`set_description` SHALL upsert a single row in `memory_scopes` instead of updating `memory_entries` rows. The `description` column on `memory_entries` SHALL be removed — descriptions live only in `memory_scopes`.

The frozen summary, cross-scope index, and `memory_search` scope-entries response SHALL join `memory_scopes` to `memory_entries` on `scope` to surface descriptions.

`memory_scopes` rows SHALL be created lazily: the first `set_description` call on a scope with no prior row SHALL INSERT; subsequent calls SHALL UPDATE. A `set_description` call on a scope with zero memory entries SHALL succeed and persist the description — the row in `memory_scopes` is independent of `memory_entries`.

The migration SHALL create `memory_scopes` rows for every scope that has a non-null description in the existing markdown frontmatter. Scopes with no description SHALL have no `memory_scopes` row (or a row with `description = NULL`).

## Consequences

**Easier:** `set_description` on an empty scope works. Descriptions are stored once per scope, not duplicated across entries. No stale-description race between dreaming inserts and `set_description` updates.

**Harder:** Reads that need descriptions require a JOIN or a separate lookup. The frozen summary and cross-scope index now touch two tables instead of one.

**Schema impact:** The `description` column is removed from `memory_entries`. The `memory_scopes` table is added. Migration creates `memory_scopes` rows from existing markdown frontmatter descriptions.

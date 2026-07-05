/**
 * Metadata-bearing memory entry formatter/parser.
 *
 * Reflection-written entries embed lightweight Markdown metadata as an HTML
 * comment on the first line, followed by the human-readable body:
 *
 * ```md
 * <!-- memory: category=decision confidence=0.86 created_at=... updated_at=... source_session=s_123 source_role=user -->
 * User prefers terse engineering summaries with command/test evidence.
 * ```
 *
 * Legacy plain entries (no metadata block) are preserved unchanged. The
 * store's `\n§\n` delimiter logic is not touched — this module only
 * formats and parses individual entry strings.
 */

export type EntryCategory =
  | "profile"
  | "preference"
  | "project_fact"
  | "decision"
  | "gotcha"
  | "convention"
  | "commitment"
  | "standing_order";

export type EntrySourceRole = "user" | "assistant" | "tool" | "system";

export interface EntryMetadata {
  category: EntryCategory;
  confidence: number;
  created_at: string;
  updated_at: string;
  source_session: string;
  source_role: EntrySourceRole;
  /** Present only after consolidation updates an existing entry. */
  updated_source_session?: string;
}

export interface ParsedEntry {
  metadata: EntryMetadata;
  body: string;
}

const METADATA_PREFIX = "<!-- memory:";
const METADATA_SUFFIX = " -->";

/**
 * Format a reflected entry string from metadata and body text.
 *
 * The metadata is emitted as an HTML comment on the first line, followed by
 * the body on the next line. Fields are emitted in a stable order so git
 * diffs are minimal and predictable.
 */
export function formatReflectedEntry(metadata: EntryMetadata, text: string): string {
  const fields: string[] = [
    `category=${metadata.category}`,
    `confidence=${metadata.confidence}`,
    `created_at=${metadata.created_at}`,
    `updated_at=${metadata.updated_at}`,
    `source_session=${metadata.source_session}`,
  ];
  if (metadata.updated_source_session !== undefined) {
    fields.push(`updated_source_session=${metadata.updated_source_session}`);
  }
  fields.push(`source_role=${metadata.source_role}`);
  return `${METADATA_PREFIX} ${fields.join(" ")}${METADATA_SUFFIX}\n${text}`;
}

/**
 * Parse metadata from an entry string. Returns `null` for legacy plain
 * entries that have no metadata block.
 */
export function parseEntryMetadata(entry: string): ParsedEntry | null {
  if (!entry.startsWith(METADATA_PREFIX)) return null;
  const end = entry.indexOf(METADATA_SUFFIX, METADATA_PREFIX.length);
  if (end === -1) return null;
  const header = entry.slice(METADATA_PREFIX.length, end).trim();
  // Body starts after the suffix and the following newline.
  const bodyStart = end + METADATA_SUFFIX.length;
  const body = entry.slice(bodyStart).replace(/^\n/, "");
  const metadata = parseMetadataFields(header);
  if (metadata === null) return null;
  return { metadata, body };
}

/**
 * Strip the metadata block from an entry, returning just the body text.
 * Legacy entries are returned unchanged.
 */
export function stripEntryMetadata(entry: string): string {
  const parsed = parseEntryMetadata(entry);
  return parsed === null ? entry : parsed.body;
}

// ---------------------------------------------------------------------------
// Field parsing
// ---------------------------------------------------------------------------

const CATEGORIES: readonly EntryCategory[] = [
  "profile",
  "preference",
  "project_fact",
  "decision",
  "gotcha",
  "convention",
  "commitment",
  "standing_order",
] as const;

const ROLES: readonly EntrySourceRole[] = [
  "user",
  "assistant",
  "tool",
  "system",
] as const;

function parseMetadataFields(header: string): EntryMetadata | null {
  const map = new Map<string, string>();
  for (const part of header.split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key.length === 0) continue;
    map.set(key, value);
  }

  const category = readCategory(map.get("category"));
  const confidence = readConfidence(map.get("confidence"));
  const created_at = map.get("created_at");
  const updated_at = map.get("updated_at");
  const source_session = map.get("source_session");
  const source_role = readRole(map.get("source_role"));
  const updated_source_session = map.get("updated_source_session");

  if (
    category === null ||
    confidence === null ||
    created_at === undefined ||
    updated_at === undefined ||
    source_session === undefined ||
    source_role === null
  ) {
    return null;
  }

  const result: EntryMetadata = {
    category,
    confidence,
    created_at,
    updated_at,
    source_session,
    source_role,
  };
  if (updated_source_session !== undefined) {
    result.updated_source_session = updated_source_session;
  }
  return result;
}

function readCategory(value: string | undefined): EntryCategory | null {
  if (value === undefined) return null;
  return (CATEGORIES as readonly string[]).includes(value) ? (value as EntryCategory) : null;
}

function readRole(value: string | undefined): EntrySourceRole | null {
  if (value === undefined) return null;
  return (ROLES as readonly string[]).includes(value) ? (value as EntrySourceRole) : null;
}

function readConfidence(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return null;
  return n;
}

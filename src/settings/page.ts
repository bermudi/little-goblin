/**
 * Telegram Settings page — mobile-first Mini App operator console for every
 * whitelisted non-secret deployment section.
 *
 * Owner: Settings page (this module renders; `server.ts` serves it).
 * Lifetime: request-scoped static shell; form, selection, and catalog state
 * live in the browser per page open and are re-read from the API on every
 * load, so reopening the page always shows the persisted deployment config.
 * Authority: durable deployment config via the Settings store through
 * `server.ts` (`GET /api/config` read, `PUT /api/config/:section` saves with
 * the `expectedRevision` CAS, MCP mutations routed per decision 0042,
 * restart via `POST /api/restart`); catalog via request-owned discovery
 * (`/api/catalog`). This shell holds no secrets and performs no config I/O
 * or discovery itself, so it is served without authentication; every API
 * call carries Telegram initData and is verified server-side. Secret fields
 * are rendered as presence chips only and are never fetched or displayed as
 * values.
 * Persistence: none — no config cache, no stored selection.
 *
 * Layout: sections are a collapsible accordion (first card open, the rest
 * collapsed with a one-line value summary from `sectionSummary`), inputs are
 * fluid (`box-sizing: border-box` everywhere, `min-width: 0`, `width: 100%`)
 * so the page never scrolls sideways at phone widths, and the restart
 * affordance lives in a sticky bottom bar that only appears while
 * `revision !== bootRevision` (pending restart).
 *
 * `filterCatalogFamilies`, `validateSectionPatch`, `nextBackoffMs`,
 * `serverFieldErrorPlacements`, `saveFailureFeedback`, `parseListEntries`,
 * `canRemoveListEntry`, `sectionSummary`, and `secretPresence` are the
 * canonical search/validation/backoff/failure-rendering/chip/summary
 * implementations the embedded client script mirrors (it cannot import this
 * module without a bundler). Enum option lists (log levels, tool visibility, ASR models,
 * external backends) and the secrets presence chips are derived on this side
 * and handed to the embedded script as JSON through `scriptJson`, which
 * escapes `<` and the JSON line separators so an injected value can never
 * close the `<script>` element early. Provider strings
 * and config values reach the DOM only through `textContent` /
 * `setAttribute`, never parsed markup; the page never uses `innerHTML`.
 */

import { ConfigFileSchema, ExternalAgentsConfigSchema } from "../schema.ts";

export interface PageModelVariant {
  id: string;
  label: string;
  contextTokens?: number;
  outputTokens?: number;
  costTier?: string;
  costSummary?: string;
  description?: string;
  isNew: boolean;
  isBeta: boolean;
}

export interface PageModelFamily {
  id: string;
  slug: string;
  label: string;
  aliases: string[];
  variants: PageModelVariant[];
}

export interface PageModelCatalog {
  families: PageModelFamily[];
}

/** Escape provider text for safe HTML interpolation. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Serialize a value for embedding in the page's inline `<script>` via a
 * `${...}` interpolation. Raw `JSON.stringify` output is not script-safe: a
 * string containing `</script>` would close the script element early, and
 * the JSON-legal line separators U+2028/U+2029 were JS line terminators
 * before ES2019. Escaping `<` and the line separators as `\\uXXXX` (quotes
 * and backslashes are already escaped per JSON) parses back to the identical
 * value while making early termination impossible.
 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function matches(haystack: string, query: string): boolean {
  return haystack.toLowerCase().includes(query);
}

/**
 * Filter catalog families by free text across family labels/slugs/aliases
 * and exact variant identities/labels. A family-level hit keeps the whole
 * family; otherwise only matching variants are kept. Blank queries match all.
 */
export function filterCatalogFamilies(catalog: PageModelCatalog, query: string): PageModelCatalog {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return catalog;
  const families: PageModelFamily[] = [];
  for (const family of catalog.families) {
    const familyHit =
      matches(family.label, needle) ||
      matches(family.slug, needle) ||
      matches(family.id, needle) ||
      family.aliases.some((alias) => matches(alias, needle));
    if (familyHit) {
      families.push(family);
      continue;
    }
    const variants = family.variants.filter(
      (variant) => matches(variant.id, needle) || matches(variant.label, needle),
    );
    if (variants.length > 0) families.push({ ...family, variants });
  }
  return { families };
}

/** Minimal structural view of a (wrapped) zod schema node. */
interface SchemaEnumNode {
  options?: unknown;
  element?: unknown;
  unwrap?: () => unknown;
}

/**
 * Derive the option list from a zod enum schema, unwrapping `default`,
 * `optional`, and `array` wrappers (`ConfigFileSchema` fields carry
 * defaults). Single source of truth: the page's selects, its mirrored
 * client-side validation, and its error copy all read these lists, so a
 * schema change updates the page without a second hand-written list.
 */
function schemaEnumOptions(schema: unknown): readonly string[] {
  let node: SchemaEnumNode | undefined | null = schema as SchemaEnumNode | undefined;
  for (let depth = 0; depth < 8 && node !== undefined && node !== null; depth += 1) {
    if (
      Array.isArray(node.options) &&
      node.options.length > 0 &&
      node.options.every((option: unknown) => typeof option === "string")
    ) {
      return node.options;
    }
    const next: unknown =
      node.element !== undefined ? node.element : typeof node.unwrap === "function" ? node.unwrap() : undefined;
    if (next === undefined || next === node) break;
    node = next as SchemaEnumNode;
  }
  throw new Error("settings page: ConfigFileSchema enum options could not be derived");
}

// Schema-derived enum mirrors for client-side validation; the server
// re-validates every save against the same schema.
const LOG_LEVELS = schemaEnumOptions(ConfigFileSchema.shape.logLevel);
const TOOL_VISIBILITY_LEVELS = schemaEnumOptions(ConfigFileSchema.shape.toolVisibility);
const ASR_MODELS = schemaEnumOptions(ConfigFileSchema.shape.asrModel);
const EXTERNAL_BACKENDS = schemaEnumOptions(ExternalAgentsConfigSchema.shape.backends);
const MCP_TIMEOUT_MS = { min: 5000, max: 1_800_000 } as const;
const MCP_RESULT_CHARS = { min: 1000, max: 100_000 } as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isPositiveIntArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "number" && Number.isInteger(entry) && entry > 0)
  );
}

function isUrlWithProtocol(value: string, protocols: readonly string[]): boolean {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * Split a comma-separated raw string into trimmed, non-empty list entries.
 * The chips editor's add input accepts single values and comma-separated
 * pastes alike; collection always sends arrays (the API contract), so this
 * is the comma-separated fallback path into the list.
 */
export function parseListEntries(raw: string): string[] {
  const out: string[] = [];
  for (const part of String(raw).split(",")) {
    const value = part.trim();
    if (value.length > 0) out.push(value);
  }
  return out;
}

/**
 * Whether a list entry may offer a remove affordance. The operator's own
 * Telegram user id must stay in `allowedUsers` or the next boot locks them
 * out; the server already rejects it, the page mirrors the guard so the
 * mistake is impossible client-side. Outside Telegram the viewer id is
 * unknown, so removal is left to the server's judgment.
 */
export function canRemoveListEntry(field: string, value: string, viewerId: number | null): boolean {
  if (field === "allowedUsers" && viewerId !== null && String(viewerId) === value.trim()) return false;
  return true;
}

/**
 * Presence chips for the Secrets card: `[secrets-section key, display label]`.
 * Keys mirror the store's secret-field projection. The embeddings API key
 * lives outside the `secrets` section (`embeddings.apiKey`) and renders as
 * one extra chip; `secretPresence` and the embedded `renderSecrets` both
 * derive from this list plus that key, so the collapsed "N of M set"
 * summary can never drift from the rendered chips.
 */
export const SECRET_LABELS: readonly (readonly [key: string, label: string])[] = [
  ["botToken", "bot token"],
  ["openrouterApiKey", "openrouter key"],
  ["openaiApiKey", "openai key"],
  ["anthropicApiKey", "anthropic key"],
  ["zaiApiKey", "zai key"],
  ["opencodeApiKey", "opencode key"],
  ["groqApiKey", "groq key"],
];

function isPresentEntry(value: unknown): boolean {
  return value !== null && typeof value === "object" && (value as Record<string, unknown>).present === true;
}

/**
 * How many of the Secrets card's presence chips are set, derived from
 * `SECRET_LABELS` plus the embeddings key — the exact source the chips
 * render from. Takes the full deployment config (not just the secrets
 * section) because the embeddings key lives under `embeddings.apiKey`.
 */
function secretPresence(config: unknown): { set: number; total: number } {
  const d = config !== null && typeof config === "object" ? (config as Record<string, unknown>) : {};
  const secrets = d.secrets !== null && typeof d.secrets === "object" ? (d.secrets as Record<string, unknown>) : {};
  const embeddings =
    d.embeddings !== null && typeof d.embeddings === "object" ? (d.embeddings as Record<string, unknown>) : {};
  const set =
    SECRET_LABELS.filter(([key]) => isPresentEntry(secrets[key])).length + (isPresentEntry(embeddings.apiKey) ? 1 : 0);
  return { set, total: SECRET_LABELS.length + 1 };
}

/**
 * One-line value summary for a collapsed section card, derived from the
 * loaded config (not from form state). Examples: "zai/glm-5.3-flash ·
 * 1 user", "openai/emb-model", "port 3423 · enabled", "1 of 8 set". Empty
 * string when there is nothing to show. The secrets case takes the full
 * config so its count covers the embeddings key chip too.
 */
export function sectionSummary(section: string, data: unknown): string {
  if (data === null || typeof data !== "object") return "";
  const d = data as Record<string, unknown>;
  const count = (field: string): number => (Array.isArray(d[field]) ? (d[field] as unknown[]).length : 0);
  const strings = (field: string): string[] =>
    Array.isArray(d[field]) ? (d[field] as unknown[]).filter((v): v is string => typeof v === "string") : [];
  const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? "" : "s"}`;
  switch (section) {
    case "general": {
      const parts: string[] = [];
      if (typeof d.model === "string" && d.model.length > 0) parts.push(d.model);
      const favorites = count("favorites");
      if (favorites > 0) parts.push(plural(favorites, "favorite"));
      const users = count("allowedUsers");
      if (users > 0) parts.push(plural(users, "user"));
      return parts.join(" · ");
    }
    case "embeddings": {
      const parts: string[] = [];
      if (typeof d.provider === "string" && d.provider.length > 0) parts.push(d.provider);
      if (typeof d.model === "string" && d.model.length > 0) parts.push(d.model);
      return parts.join("/");
    }
    case "external-agents":
      return strings("backends").join(", ");
    case "devin":
      return typeof d.defaultModel === "string" && d.defaultModel.length > 0 ? d.defaultModel : "";
    case "mcp": {
      const enabled = strings("enabled");
      const disabled = strings("disabledServers");
      const on = enabled.filter((name) => !disabled.includes(name)).length;
      return `${on} on · ${disabled.length} off`;
    }
    case "settings": {
      const parts: string[] = [];
      if (typeof d.port === "number") parts.push(`port ${d.port}`);
      if (typeof d.enabled === "boolean") parts.push(d.enabled ? "enabled" : "disabled");
      return parts.join(" · ");
    }
    case "secrets": {
      const { set, total } = secretPresence(data);
      return `${set} of ${total} set`;
    }
    default:
      return "";
  }
}

/**
 * Client-side validation mirroring the server's per-section field rules
 * (`ConfigFileSchema` plus the decision-0042 MCP patch rules). Returns a map
 * of field name to actionable message; an empty map means the patch may be
 * sent. Section-level problems use the key "section". Only provided keys are
 * validated — the collector omits empty optional fields.
 */
export function validateSectionPatch(section: string, patch: Record<string, unknown>): Record<string, string> {
  const errors: Record<string, string> = {};
  switch (section) {
    case "general": {
      if (patch.model !== undefined && !isNonEmptyString(patch.model)) {
        errors.model = "must be a non-empty model name";
      }
      if (patch.logLevel !== undefined && !(typeof patch.logLevel === "string" && (LOG_LEVELS as readonly string[]).includes(patch.logLevel))) {
        errors.logLevel = `must be one of ${LOG_LEVELS.join(", ")}`;
      }
      if (patch.toolVisibility !== undefined && !(typeof patch.toolVisibility === "string" && (TOOL_VISIBILITY_LEVELS as readonly string[]).includes(patch.toolVisibility))) {
        errors.toolVisibility = `must be one of ${TOOL_VISIBILITY_LEVELS.join(", ")}`;
      }
      if (patch.voiceName !== undefined && !isNonEmptyString(patch.voiceName)) {
        errors.voiceName = "must be a non-empty voice name";
      }
      if (patch.asrModel !== undefined && !(typeof patch.asrModel === "string" && (ASR_MODELS as readonly string[]).includes(patch.asrModel))) {
        errors.asrModel = `must be one of ${ASR_MODELS.join(", ")}`;
      }
      if (patch.favorites !== undefined && !isStringArray(patch.favorites)) {
        errors.favorites = "must be a list of favorite names";
      }
      if (patch.allowedUsers !== undefined && !(isPositiveIntArray(patch.allowedUsers) && patch.allowedUsers.length > 0)) {
        errors.allowedUsers = "must be a non-empty list of positive integer Telegram user ids";
      }
      break;
    }
    case "embeddings": {
      for (const field of ["baseUrl", "model", "provider"] as const) {
        if (patch[field] !== undefined && !isNonEmptyString(patch[field])) {
          errors[field] = "must be a non-empty value";
        }
      }
      if (patch.cooldownSeconds !== undefined && !(typeof patch.cooldownSeconds === "number" && Number.isFinite(patch.cooldownSeconds) && patch.cooldownSeconds >= 0)) {
        errors.cooldownSeconds = "must be a non-negative number of seconds";
      }
      break;
    }
    case "external-agents": {
      if (patch.backends !== undefined) {
        const backends = patch.backends;
        const known =
          Array.isArray(backends) &&
          backends.every((entry) => typeof entry === "string" && (EXTERNAL_BACKENDS as readonly string[]).includes(entry));
        if (!known || (Array.isArray(backends) && new Set(backends).size !== backends.length)) {
          errors.backends = `must be a duplicate-free list of ${EXTERNAL_BACKENDS.join(", ")}`;
        }
      }
      break;
    }
    case "devin": {
      if (patch.defaultModel !== undefined && !(typeof patch.defaultModel === "string" && patch.defaultModel.length > 0 && patch.defaultModel.trim() === patch.defaultModel)) {
        errors.defaultModel = "must be a non-empty, unpadded exact model id";
      }
      break;
    }
    case "mcp": {
      if (patch.defaultTimeoutMs === undefined && patch.maxResultChars === undefined) {
        errors.section = "must contain a limits edit (defaultTimeoutMs or maxResultChars); server toggles are separate writes";
      }
      if (patch.defaultTimeoutMs !== undefined && !(typeof patch.defaultTimeoutMs === "number" && Number.isInteger(patch.defaultTimeoutMs) && patch.defaultTimeoutMs >= MCP_TIMEOUT_MS.min && patch.defaultTimeoutMs <= MCP_TIMEOUT_MS.max)) {
        errors.defaultTimeoutMs = `must be an integer between ${MCP_TIMEOUT_MS.min} and ${MCP_TIMEOUT_MS.max}`;
      }
      if (patch.maxResultChars !== undefined && !(typeof patch.maxResultChars === "number" && Number.isInteger(patch.maxResultChars) && patch.maxResultChars >= MCP_RESULT_CHARS.min && patch.maxResultChars <= MCP_RESULT_CHARS.max)) {
        errors.maxResultChars = `must be an integer between ${MCP_RESULT_CHARS.min} and ${MCP_RESULT_CHARS.max}`;
      }
      break;
    }
    case "settings": {
      if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") {
        errors.enabled = "must be on or off";
      }
      if (patch.port !== undefined && !(typeof patch.port === "number" && Number.isInteger(patch.port) && patch.port >= 1 && patch.port <= 65535)) {
        errors.port = "must be an integer between 1 and 65535";
      }
      if (patch.publicUrl !== undefined && !(typeof patch.publicUrl === "string" && isUrlWithProtocol(patch.publicUrl, ["https:"]))) {
        errors.publicUrl = "must be a valid https URL";
      }
      if (patch.allowedOrigins !== undefined && !(isStringArray(patch.allowedOrigins) && patch.allowedOrigins.every((origin) => isUrlWithProtocol(origin, ["https:", "http:"])))) {
        errors.allowedOrigins = "must be a list of valid http(s) origins";
      }
      break;
    }
    default:
      errors.section = "unknown section";
  }
  return errors;
}

/**
 * Reconnect backoff for the restart flow: 500ms doubling, capped at 5s, so a
 * reviving server is polled patiently instead of hammered.
 */
export function nextBackoffMs(attempt: number): number {
  return Math.min(500 * 2 ** Math.max(0, Math.floor(attempt)), 5000);
}

/** File-level key for each whitelisted section; mirrors the Settings store. */
const SECTION_FILE_KEYS: Readonly<Record<string, string | null>> = {
  general: null,
  embeddings: "embeddings",
  "external-agents": "externalAgents",
  devin: "devin",
  mcp: "mcp",
  settings: "settings",
};

/**
 * Compute the inline placements for a server field-error message. Server
 * issues are `path: message` entries separated by "; " and their paths carry
 * the file key for embedded sections ("settings.port"); error slots are
 * section-scoped (the "settings" section renders a "port" slot), so the
 * section's file-key prefix is stripped. Store messages may wrap the issue
 * list in prose ("Config update rejected: ...: settings.port: Too big"), so
 * the split point is the last ": " whose left side is a pure dotted field
 * path. Parts without a placeable field are dropped; when nothing lands, the
 * caller falls back to the full section-level message. The embedded client
 * script mirrors this logic (no bundler).
 */
export function serverFieldErrorPlacements(section: string, message: string): Record<string, string> {
  if (typeof message !== "string" || message.length === 0) return {};
  const fileKey = Object.hasOwn(SECTION_FILE_KEYS, section) ? (SECTION_FILE_KEYS[section] ?? null) : null;
  const placements: Record<string, string> = {};
  for (const part of message.split("; ")) {
    const placed = placePathMessage(part, fileKey);
    if (placed !== null) placements[placed.field] = placed.text;
  }
  return placements;
}

/** A dotted field path such as `settings.port`; bare identifiers only. */
const FIELD_PATH = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/;

/** Place one `; `-separated issue part; null when it holds no placeable field. */
function placePathMessage(part: string, fileKey: string | null): { field: string; text: string } | null {
  let segmentStart = 0;
  while (true) {
    const idx = part.indexOf(": ", segmentStart);
    if (idx < 0) return null;
    const candidate = part.slice(segmentStart, idx).trim();
    if (FIELD_PATH.test(candidate)) {
      const field =
        fileKey !== null && candidate.startsWith(`${fileKey}.`) ? candidate.slice(fileKey.length + 1) : candidate;
      if (field.length > 0 && !field.includes(".")) return { field, text: part.slice(idx + 2).trim() };
    }
    segmentStart = idx + 2;
  }
}

/** What the page shows after a failed section save. */
export interface SaveFailureView {
  /** Status line content; null leaves the section's status line untouched. */
  status: { kind: "error"; text: string } | null;
  /** Inline field-error placements keyed by section-scoped slot field. */
  fieldErrors: Record<string, string>;
  /** Offer a re-fetch of current settings (409 conflict). */
  reload: boolean;
}

/**
 * Distinct, visible feedback for a failed section save — expired sessions,
 * conflicts (with a reload affordance), 400 field errors (placed inline via
 * `serverFieldErrorPlacements`), and everything else. Every saving section
 * renders both a `data-save-status` slot and per-field `data-error-for`
 * slots, so every branch of this view is user-visible. The embedded client
 * script mirrors this logic (no bundler).
 */
export function saveFailureFeedback(
  section: string,
  status: number,
  body: { error?: unknown; message?: unknown } | null,
): SaveFailureView {
  const code = body !== null && typeof body === "object" && typeof body.error === "string" ? body.error : "unavailable";
  const message = body !== null && typeof body === "object" && typeof body.message === "string" ? body.message : "";
  if (status === 401 && code === "expired") {
    return {
      status: {
        kind: "error",
        text: "Telegram session expired. Close and reopen Settings from Telegram, then save again.",
      },
      fieldErrors: {},
      reload: false,
    };
  }
  if (status === 409 || code === "conflict") {
    return { status: { kind: "error", text: "Settings changed elsewhere (conflict). " }, fieldErrors: {}, reload: true };
  }
  if (status === 400) {
    const fieldErrors = serverFieldErrorPlacements(section, message);
    if (Object.keys(fieldErrors).length === 0) {
      return {
        status: { kind: "error", text: message.length > 0 ? message : `Save rejected (${code}).` },
        fieldErrors: {},
        reload: false,
      };
    }
    return { status: { kind: "error", text: "Fix the highlighted fields." }, fieldErrors, reload: false };
  }
  return { status: { kind: "error", text: `Save failed (${code}). Nothing was saved.` }, fieldErrors: {}, reload: false };
}

/** One form field of a whitelisted section, rendered into the static shell. */
interface PageFieldSpec {
  field: string;
  label: string;
  kind: "text" | "number" | "select" | "check" | "list" | "multi";
  options?: readonly string[];
  /** Optional fields: empty input means "leave unchanged" (omitted from the patch). */
  optional?: boolean;
  hint?: string;
}

/** One whitelisted section card with a plain form. */
interface PageSectionSpec {
  section: string;
  title: string;
  note?: string;
  fields: readonly PageFieldSpec[];
}

const SECTION_SPECS: readonly PageSectionSpec[] = [
  {
    section: "general",
    title: "General",
    fields: [
      { field: "model", label: "Model", kind: "text" },
      { field: "logLevel", label: "Log level", kind: "select", options: LOG_LEVELS },
      { field: "toolVisibility", label: "Tool visibility", kind: "select", options: TOOL_VISIBILITY_LEVELS },
      {
        field: "voiceName",
        label: "Voice name",
        kind: "text",
        optional: true,
        hint: "Empty leaves it unchanged; clearing requires editing goblin.json5.",
      },
      { field: "asrModel", label: "ASR model", kind: "select", options: ASR_MODELS },
      { field: "favorites", label: "Favorites", kind: "list", hint: "Add one entry at a time; comma-separated pastes split into separate chips." },
      {
        field: "allowedUsers",
        label: "Allowed users",
        kind: "list",
        hint: "Telegram user ids. Keep your own id in the list or you will lock yourself out.",
      },
    ],
  },
  {
    section: "embeddings",
    title: "Embeddings",
    note: "Non-secret endpoint fields. The API key is a secret and appears in the Secrets row only.",
    fields: [
      {
        field: "baseUrl",
        label: "Base URL",
        kind: "text",
        optional: true,
        hint: "Without /v1. Empty leaves it unchanged; clearing requires editing goblin.json5.",
      },
      { field: "model", label: "Model", kind: "text", optional: true },
      {
        field: "provider",
        label: "Provider",
        kind: "text",
        optional: true,
        hint: "Changing provider or model triggers a full memory reindex.",
      },
      { field: "cooldownSeconds", label: "Cooldown (seconds)", kind: "number", optional: true },
    ],
  },
  {
    section: "external-agents",
    title: "External agents",
    fields: [{ field: "backends", label: "Backends", kind: "multi", options: EXTERNAL_BACKENDS }],
  },
  {
    section: "settings",
    title: "Settings",
    note: "Warning: port and public URL changes take effect after a restart, and your reverse proxy (for example Tailscale Serve) must match them.",
    fields: [
      { field: "enabled", label: "Enabled", kind: "check" },
      { field: "port", label: "Port", kind: "number", hint: "Stable loopback port; the listener always binds 127.0.0.1." },
      {
        field: "publicUrl",
        label: "Public URL",
        kind: "text",
        optional: true,
        hint: "Operator-managed private HTTPS URL. Empty leaves it unchanged.",
      },
      {
        field: "allowedOrigins",
        label: "Allowed origins",
        kind: "list",
        optional: true,
        hint: "https origins; empty leaves it unchanged.",
      },
    ],
  },
];

function renderInput(section: PageSectionSpec, field: PageFieldSpec): string {
  const attrs = `data-section="${section.section}" data-field="${field.field}"${field.optional ? ' data-optional="1"' : ""}`;
  switch (field.kind) {
    case "select":
      return `<select id="field-${section.section}-${field.field}" ${attrs}>${field
        .options!.map((option) => `<option value="${option}">${option}</option>`)
        .join("")}</select>`;
    case "check":
      return `<div class="check-row"><input id="field-${section.section}-${field.field}" type="checkbox" ${attrs}><span>${escapeHtml(field.label)}</span></div>`;
    case "number":
      return `<input id="field-${section.section}-${field.field}" type="number" step="1" inputmode="numeric" ${attrs}>`;
    case "list":
      // Chips are rendered at runtime from the loaded config; the wrapper is
      // the form control the collector reads.
      return `<div class="chips" ${attrs} data-list="1"></div>`;
    case "multi":
      return `<div class="multi">${field
        .options!.map(
          (option) =>
            `<label class="check-row"><input type="checkbox" ${attrs} data-value="${option}"><span>${escapeHtml(option)}</span></label>`,
        )
        .join("")}</div>`;
    default:
      return `<input id="field-${section.section}-${field.field}" type="text" ${attrs}>`;
  }
}

function renderField(section: PageSectionSpec, field: PageFieldSpec): string {
  const labelHtml =
    field.kind === "multi" || field.kind === "check"
      ? ""
      : `<label for="field-${section.section}-${field.field}">${escapeHtml(field.label)}${
          field.optional ? ' <span class="optional">optional</span>' : ""
        }</label>`;
  return `<div class="field">${labelHtml}${renderInput(section, field)}<div class="field-error" data-error-for="${
    section.section
  }.${field.field}" role="alert" hidden></div>${field.hint ? `<p class="hint">${escapeHtml(field.hint)}</p>` : ""}</div>`;
}

/** Render one collapsible section card; only `openSection` starts expanded. */
function renderCard(spec: PageSectionSpec, open: boolean): string {
  return `<details class="card" data-section="${spec.section}"${open ? " open" : ""} aria-labelledby="heading-${
    spec.section
  }">
  <summary>
    <h2 class="card-title" id="heading-${spec.section}">${escapeHtml(spec.title)}</h2>
    <span class="card-summary" data-summary-for="${spec.section}"></span>
    <span class="dirty-dot" data-dirty-for="${spec.section}" hidden title="Unsaved changes"></span>
    <span class="chevron" aria-hidden="true">&#9656;</span>
  </summary>
  <div class="card-body">
    ${spec.note ? `<p class="note">${escapeHtml(spec.note)}</p>` : ""}
    ${spec.fields.map((field) => renderField(spec, field)).join("\n    ")}
    <div class="save-row"><button type="button" class="primary" data-save="${spec.section}" disabled>Save</button><button type="button" class="ghost" data-cancel="${spec.section}" disabled>Cancel</button><span class="save-status" data-save-status="${spec.section}" role="status"></span></div>
  </div>
</details>`;
}

/** Static accordion summary row shared by every card, hand-built ones too. */
function accordionSummary(section: string, title: string): string {
  return `<summary>
    <h2 class="card-title" id="heading-${section}">${escapeHtml(title)}</h2>
    <span class="card-summary" data-summary-for="${section}"></span>
    <span class="dirty-dot" data-dirty-for="${section}" hidden title="Unsaved changes"></span>
    <span class="chevron" aria-hidden="true">&#9656;</span>
  </summary>`;
}

/** Render the static Settings operator console. No secrets, no config data. */
export function renderSettingsPage(): string {
  const cards = new Map(
    SECTION_SPECS.map((spec) => [spec.section, renderCard(spec, spec.section === "general")] as const),
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Goblin Settings</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
[hidden] { display: none !important; }
*, *::before, *::after { box-sizing: border-box; min-width: 0; }
/* Label, muted, and border derive from fg/bg so they stay contrast-correct
   even when Telegram themeParams disagree with the OS color-scheme. */
:root {
  color-scheme: light dark;
  --theme-bg: #f2f4f7; --theme-card: #ffffff; --theme-fg: #101828;
  --theme-accent: #3390ec; --theme-accent-fg: #ffffff; --theme-link: #2b6fd4; --theme-ok: #1b7f37; --theme-err: #c22a2a;
  --theme-label: color-mix(in srgb, var(--theme-fg) 75%, var(--theme-bg));
  --theme-muted: color-mix(in srgb, var(--theme-fg) 52%, var(--theme-bg));
  --theme-border: color-mix(in srgb, var(--theme-fg) 15%, transparent);
}
@media (prefers-color-scheme: dark) {
  :root {
    --theme-bg: #17212b; --theme-card: #1d2733; --theme-fg: #f1f5f9;
    --theme-accent: #62a8ea; --theme-accent-fg: #10202e; --theme-link: #7cb8ee; --theme-ok: #57c26b; --theme-err: #ff7a7a;
  }
}
/* Pre-color-mix webviews (Chrome <111, Safari <16.2) cannot compute the
   mixed variables above; without fallbacks they resolve invalid at
   computed-value time and 1px borders and muted text vanish. Static values
   precomputed from the fg/bg pairs above; color-mix-capable browsers keep
   the derived versions. */
@supports not (color: color-mix(in srgb, red, blue)) {
  :root {
    --theme-label: #494f5c;  /* color-mix(fg 75%, bg) */
    --theme-muted: #7c828b;  /* color-mix(fg 52%, bg) */
    --theme-border: #d0d3d8; /* fg 15% over bg */
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --theme-label: #bbc0c6;
      --theme-muted: #888f96;
      --theme-border: #38414a;
    }
  }
}
body { margin: 0; font-family: system-ui, -apple-system, sans-serif; font-size: 14px; line-height: 1.45; background: var(--theme-bg); color: var(--theme-fg); }
header { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: var(--theme-card); border-bottom: 1px solid var(--theme-border); }
header h1 { font-size: 16px; font-weight: 600; margin: 0; flex: 1; }
#status-loading, #load-error { max-width: 640px; margin: 0 auto; padding: 12px 14px; }
#status-loading { color: var(--theme-muted); }
#load-error { color: var(--theme-err); font-size: 13px; }
main { max-width: 640px; margin: 0 auto; padding: 12px 12px 96px; display: grid; gap: 10px; grid-template-columns: minmax(0, 1fr); }
.card { background: var(--theme-card); border: 1px solid var(--theme-border); border-radius: 12px; }
.card > summary { display: flex; align-items: center; gap: 8px; padding: 12px 14px; cursor: pointer; list-style: none; }
.card > summary::-webkit-details-marker { display: none; }
.card[open] > summary { border-bottom: 1px solid var(--theme-border); }
.card-title { font-size: 14px; font-weight: 600; margin: 0; flex-shrink: 0; }
.card-summary { flex: 1; font-size: 12px; color: var(--theme-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dirty-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--theme-accent); flex-shrink: 0; }
.chevron { color: var(--theme-muted); font-size: 11px; flex-shrink: 0; transition: transform 0.15s; }
.card[open] .chevron { transform: rotate(90deg); }
.card-body { padding: 12px 14px 14px; display: grid; gap: 8px; }
.note, .hint, .meta { font-size: 12px; color: var(--theme-muted); margin: 0; overflow-wrap: anywhere; }
.field { display: grid; gap: 4px; }
.field > label, .field-label { font-size: 12px; font-weight: 500; color: var(--theme-label); }
.optional { font-weight: 400; font-size: 11px; opacity: 0.65; margin-left: 4px; }
input[type="text"], input[type="number"], input[type="search"], select { display: block; width: 100%; max-width: 100%; min-width: 0; height: 38px; font: inherit; font-size: 14px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--theme-border); background: var(--theme-bg); color: var(--theme-fg); }
input:focus, select:focus { border-color: var(--theme-accent); }
input:focus-visible, select:focus-visible, button:focus-visible { outline: 2px solid var(--theme-accent); outline-offset: 1px; }
select { appearance: none; -webkit-appearance: none; padding-right: 30px; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23808a99' stroke-width='1.5'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 10px center; }
.check-row { display: flex; align-items: center; gap: 8px; min-height: 32px; font-size: 14px; color: var(--theme-fg); cursor: pointer; }
input[type="checkbox"] { width: 18px; height: 18px; margin: 0; accent-color: var(--theme-accent); flex-shrink: 0; }
.multi { display: flex; gap: 4px 16px; flex-wrap: wrap; }
.field-error { color: var(--theme-err); font-size: 12px; overflow-wrap: anywhere; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.chip { display: inline-flex; align-items: center; gap: 2px; max-width: 100%; border: 1px solid var(--theme-border); border-radius: 999px; padding: 2px 4px 2px 10px; font-size: 12px; background: var(--theme-bg); }
.chip-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip-remove { border: 0; background: none; color: var(--theme-muted); font-size: 15px; line-height: 1; height: auto; padding: 2px 7px; cursor: pointer; border-radius: 50%; }
.chip-remove:hover { color: var(--theme-err); }
.chip-locked { color: var(--theme-muted); font-size: 10px; padding: 2px 8px 2px 2px; }
.chip-add-row { display: flex; gap: 6px; width: 100%; }
.chip-add { flex: 1; height: 32px; font-size: 13px; padding: 0 10px; }
.chip-add-btn { height: 32px; padding: 0 12px; font-size: 13px; }
button { font: inherit; font-size: 14px; height: 36px; border-radius: 8px; border: 1px solid var(--theme-border); background: transparent; color: var(--theme-fg); padding: 0 14px; cursor: pointer; }
button.primary { background: var(--theme-accent); border-color: var(--theme-accent); color: var(--theme-accent-fg); font-weight: 500; }
button.secondary { background: transparent; border-color: var(--theme-accent); color: var(--theme-accent); font-weight: 500; }
button.ghost { background: transparent; color: var(--theme-accent); }
button.link { border: 0; background: none; color: var(--theme-link); height: auto; padding: 4px 6px; font-size: 13px; }
button:disabled { opacity: 0.45; cursor: default; }
.save-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
.save-status { font-size: 12px; color: var(--theme-muted); flex: 1; min-width: 0; overflow-wrap: anywhere; }
.save-status.saved { color: var(--theme-ok); }
.save-status.error { color: var(--theme-err); }
#status-saved { color: var(--theme-ok); font-size: 13px; }
#catalog-error { color: var(--theme-err); font-size: 12px; }
.family { border-top: 1px solid var(--theme-border); padding: 6px 0; }
.family:first-child { border-top: 0; }
.family h3 { font-size: 13px; margin: 4px 0; }
.variant { display: block; width: 100%; height: auto; min-height: 36px; text-align: left; margin: 4px 0; padding: 8px 10px; font-size: 13px; overflow-wrap: anywhere; }
.variant[aria-pressed="true"] { outline: 2px solid var(--theme-accent); border-color: var(--theme-accent); }
.variant .meta { font-size: 11px; }
.mcp-row { display: flex; align-items: center; gap: 8px; padding: 7px 0; border-top: 1px solid var(--theme-border); font-size: 13px; }
.mcp-row:first-child { border-top: 0; }
.mcp-row .mcp-name { flex: 1; overflow-wrap: anywhere; }
.mcp-state { font-size: 12px; }
.mcp-state.on { color: var(--theme-ok); }
.mcp-state.off { color: var(--theme-muted); }
.presence-chip { display: inline-block; border: 1px solid var(--theme-border); border-radius: 999px; padding: 2px 9px; font-size: 11px; color: var(--theme-muted); margin: 2px 4px 2px 0; white-space: nowrap; }
.presence-chip.set { color: var(--theme-fg); border-color: var(--theme-ok); }
#restart-bar { position: sticky; bottom: 0; z-index: 30; max-width: 640px; margin: 0 auto; width: calc(100% - 24px); padding: 8px 0 calc(10px + env(safe-area-inset-bottom)); }
.bar-card { display: grid; gap: 6px; background: var(--theme-card); border: 1px solid var(--theme-border); border-radius: 12px; padding: 8px 12px; box-shadow: 0 -6px 20px rgba(0, 0, 0, 0.25); }
#restart-row { display: flex; align-items: center; gap: 10px; }
#restart-ok { flex: 1; font-size: 12px; color: var(--theme-muted); }
.badge { flex: 1; font-size: 12px; font-weight: 500; color: var(--theme-accent); overflow-wrap: anywhere; }
#restart-confirm { display: grid; gap: 6px; font-size: 12px; }
.confirm-actions { display: flex; gap: 8px; }
#reconnecting { position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.55); }
#reconnecting .reconnect-card { background: var(--theme-card); color: var(--theme-fg); border-radius: 12px; padding: 16px 20px; font-size: 14px; max-width: 320px; text-align: center; }
</style>
</head>
<body>
<header>
  <h1>Goblin Settings</h1>
</header>
<div id="status-loading" role="status">Loading settings…</div>
<div id="load-error" role="alert" hidden></div>
<main>
${cards.get("general") ?? ""}
${cards.get("embeddings") ?? ""}
${cards.get("external-agents") ?? ""}
<details class="card" data-section="devin" aria-labelledby="heading-devin">
  ${accordionSummary("devin", "Devin")}
  <div class="card-body">
    <p class="note">Deployment default for Devin runs. Applies to the next admitted run; no restart needed.</p>
    <div class="field">
      <div class="field-label">Saved deployment model</div>
      <div id="current-selection" class="meta"></div>
      <div class="field-error" data-error-for="devin.defaultModel" role="alert" hidden></div>
    </div>
    <input id="model-search" type="search" placeholder="Search families or exact models…" autocomplete="off">
    <div id="family-list"></div>
    <div class="save-row"><button id="save-button" type="button" class="primary" disabled>Save exact model</button><button type="button" class="ghost" data-cancel="devin" disabled>Cancel</button><span class="save-status" data-save-status="devin" role="status"></span></div>
    <div id="status-saved" role="status" hidden></div>
    <div id="catalog-error" role="alert" hidden></div>
  </div>
</details>
<details class="card" data-section="mcp" aria-labelledby="heading-mcp">
  ${accordionSummary("mcp", "MCP")}
  <div class="card-body">
    <p class="note">Server toggles and limit edits are separate writes; each is one atomic revision-checked change.</p>
    <div id="mcp-servers"></div>
    <div class="field">
      <div class="field-label">mcporter config path</div>
      <div id="mcp-config-path" class="meta"></div>
    </div>
    <div class="field">
      <label for="field-mcp-defaultTimeoutMs">Default timeout (ms)</label>
      <input id="field-mcp-defaultTimeoutMs" type="number" step="1" inputmode="numeric" data-section="mcp" data-field="defaultTimeoutMs">
      <div class="field-error" data-error-for="mcp.defaultTimeoutMs" role="alert" hidden></div>
    </div>
    <div class="field">
      <label for="field-mcp-maxResultChars">Max result chars</label>
      <input id="field-mcp-maxResultChars" type="number" step="1" inputmode="numeric" data-section="mcp" data-field="maxResultChars">
      <div class="field-error" data-error-for="mcp.maxResultChars" role="alert" hidden></div>
    </div>
    <div class="save-row"><button type="button" class="primary" data-save="mcp" disabled>Save limits</button><button type="button" class="ghost" data-cancel="mcp" disabled>Cancel</button><span class="save-status" data-save-status="mcp" role="status"></span></div>
  </div>
</details>
${cards.get("settings") ?? ""}
<details class="card" data-section="secrets" aria-labelledby="heading-secrets">
  ${accordionSummary("secrets", "Secrets")}
  <div class="card-body">
    <p class="note">Presence only. Secrets are managed in files, environment, or a vault and are never editable or displayed here.</p>
    <div id="secrets-list"></div>
  </div>
</details>
</main>
<div id="restart-bar" hidden>
  <div class="bar-card">
    <div id="restart-confirm" hidden>
      <span>Restart Goblin now? The process drains, exits, and systemd brings it back.</span>
      <div class="confirm-actions">
        <button id="restart-yes" type="button" class="primary">Confirm restart</button>
        <button id="restart-no" type="button" class="ghost">Cancel</button>
      </div>
    </div>
    <div id="restart-row">
      <span id="restart-ok" class="bar-ok">&#10003; All changes applied</span>
      <span id="pending-restart" class="badge" hidden></span>
      <button id="restart-button" type="button" class="secondary" hidden>Restart</button>
    </div>
  </div>
</div>
<div id="reconnecting" hidden role="status"><div class="reconnect-card">Restarting Goblin — waiting for it to come back…</div></div>
<script>
"use strict";
var tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
var initData = window.Telegram && window.Telegram.WebApp && typeof window.Telegram.WebApp.initData === "string"
  ? window.Telegram.WebApp.initData
  : "";
var authHeader = { authorization: "tma " + initData };
// The viewer's own Telegram user id (untrusted client-side copy) is used only
// to hide the remove affordance on their own allowedUsers chip; the server
// re-verifies every save.
var viewerId = tg && tg.initDataUnsafe && tg.initDataUnsafe.user && typeof tg.initDataUnsafe.user.id === "number"
  ? tg.initDataUnsafe.user.id
  : null;
var SECTIONS = ["general","embeddings","external-agents","devin","mcp","settings"];
var LOG_LEVELS = ${scriptJson(LOG_LEVELS)};
var TOOL_VISIBILITY_LEVELS = ${scriptJson(TOOL_VISIBILITY_LEVELS)};
var ASR_MODELS = ${scriptJson(ASR_MODELS)};
var EXTERNAL_BACKENDS = ${scriptJson(EXTERNAL_BACKENDS)};
var SECRET_LABELS = ${scriptJson(SECRET_LABELS)};
var state = { config: null, revision: null, bootRevision: null, catalog: null, selectedId: null };
var baselines = {};

var loadingEl = document.getElementById("status-loading");
var loadErrorEl = document.getElementById("load-error");
var reconnectEl = document.getElementById("reconnecting");
var restartEl = document.getElementById("restart-button");
var restartConfirmEl = document.getElementById("restart-confirm");
var listEl = document.getElementById("family-list");
var searchEl = document.getElementById("model-search");
var saveEl = document.getElementById("save-button");
var catalogErrorEl = document.getElementById("catalog-error");

function $(id) { return document.getElementById(id); }
function qsAll(selector) { return Array.prototype.slice.call(document.querySelectorAll(selector)); }
function el(tag, attrs) {
  var node = document.createElement(tag);
  if (attrs) {
    for (var key in attrs) {
      if (key === "text") node.textContent = attrs[key];
      else node.setAttribute(key, attrs[key]);
    }
  }
  return node;
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
function show(node) { node.hidden = false; }
function hide(node) { node.hidden = true; }
function setText(node, value) { if (node) node.textContent = value == null ? "" : String(value); }

// ---- Telegram WebApp theme variables, with plain-browser fallbacks ----
var THEME_MAP = [
  ["bg_color", "--theme-bg"],
  ["secondary_bg_color", "--theme-card"],
  ["text_color", "--theme-fg"],
  ["hint_color", "--theme-muted"],
  ["link_color", "--theme-link"],
  ["button_color", "--theme-accent"],
  ["button_text_color", "--theme-accent-fg"],
  ["destructive_text_color", "--theme-err"]
];
function applyTheme(params) {
  if (!params) return;
  for (var i = 0; i < THEME_MAP.length; i++) {
    var value = params[THEME_MAP[i][0]];
    if (typeof value === "string" && value.length > 0) {
      document.documentElement.style.setProperty(THEME_MAP[i][1], value);
    }
  }
}

// ---- canonical mirrors: filterCatalogFamilies, validateSectionPatch,
// nextBackoffMs, serverFieldErrorPlacements, saveFailureFeedback,
// parseListEntries, canRemoveListEntry, sectionSummary, secretPresence
// (see module header) ----
function nextBackoffMs(attempt) {
  return Math.min(500 * Math.pow(2, Math.max(0, Math.floor(attempt))), 5000);
}
var SECTION_FILE_KEYS = { general: null, embeddings: "embeddings", "external-agents": "externalAgents", devin: "devin", mcp: "mcp", settings: "settings" };
var FIELD_PATH = /^[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z0-9_]+)*$/;
function placePathMessage(part, fileKey) {
  var segmentStart = 0;
  while (true) {
    var idx = part.indexOf(": ", segmentStart);
    if (idx < 0) return null;
    var candidate = part.slice(segmentStart, idx).trim();
    if (FIELD_PATH.test(candidate)) {
      var field = fileKey !== null && candidate.lastIndexOf(fileKey + ".", 0) === 0 ? candidate.slice(fileKey.length + 1) : candidate;
      if (field.length > 0 && field.indexOf(".") < 0) return { field: field, text: part.slice(idx + 2).trim() };
    }
    segmentStart = idx + 2;
  }
}
function serverFieldErrorPlacements(section, message) {
  if (typeof message !== "string" || message.length === 0) return {};
  var fileKey = Object.prototype.hasOwnProperty.call(SECTION_FILE_KEYS, section) ? SECTION_FILE_KEYS[section] : null;
  var placements = {};
  var parts = message.split("; ");
  for (var i = 0; i < parts.length; i++) {
    var placed = placePathMessage(parts[i], fileKey);
    if (placed !== null) placements[placed.field] = placed.text;
  }
  return placements;
}
function saveFailureFeedback(section, status, body) {
  var code = body !== null && typeof body === "object" && typeof body.error === "string" ? body.error : "unavailable";
  var message = body !== null && typeof body === "object" && typeof body.message === "string" ? body.message : "";
  if (status === 401 && code === "expired") {
    return { status: { kind: "error", text: "Telegram session expired. Close and reopen Settings from Telegram, then save again." }, fieldErrors: {}, reload: false };
  }
  if (status === 409 || code === "conflict") {
    return { status: { kind: "error", text: "Settings changed elsewhere (conflict). " }, fieldErrors: {}, reload: true };
  }
  if (status === 400) {
    var fieldErrors = serverFieldErrorPlacements(section, message);
    var keys = Object.keys(fieldErrors);
    if (keys.length === 0) {
      return { status: { kind: "error", text: message.length > 0 ? message : "Save rejected (" + code + ")." }, fieldErrors: {}, reload: false };
    }
    return { status: { kind: "error", text: "Fix the highlighted fields." }, fieldErrors: fieldErrors, reload: false };
  }
  return { status: { kind: "error", text: "Save failed (" + code + "). Nothing was saved." }, fieldErrors: {}, reload: false };
}
function parseListEntries(raw) {
  var parts = String(raw).split(",");
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var value = parts[i].trim();
    if (value.length > 0) out.push(value);
  }
  return out;
}
function canRemoveListEntry(field, value, viewer) {
  if (field === "allowedUsers" && viewer !== null && String(viewer) === String(value).trim()) return false;
  return true;
}
function sectionSummary(section, data) {
  if (data === null || typeof data !== "object") return "";
  function count(field) { return Array.isArray(data[field]) ? data[field].length : 0; }
  function strings(field) {
    return Array.isArray(data[field]) ? data[field].filter(function (v) { return typeof v === "string"; }) : [];
  }
  function plural(n, unit) { return n + " " + unit + (n === 1 ? "" : "s"); }
  function pushText(parts, text) { if (typeof text === "string" && text.length > 0) parts.push(text); }
  if (section === "general") {
    var g = [];
    pushText(g, data.model);
    if (count("favorites") > 0) g.push(plural(count("favorites"), "favorite"));
    if (count("allowedUsers") > 0) g.push(plural(count("allowedUsers"), "user"));
    return g.join(" \\u00b7 ");
  }
  if (section === "embeddings") {
    var e = [];
    pushText(e, data.provider);
    pushText(e, data.model);
    return e.join("/");
  }
  if (section === "external-agents") return strings("backends").join(", ");
  if (section === "devin") return typeof data.defaultModel === "string" ? data.defaultModel : "";
  if (section === "mcp") {
    var enabled = strings("enabled");
    var disabled = strings("disabledServers");
    var on = 0;
    for (var i = 0; i < enabled.length; i++) if (disabled.indexOf(enabled[i]) < 0) on++;
    return on + " on \\u00b7 " + disabled.length + " off";
  }
  if (section === "settings") {
    var s = [];
    if (typeof data.port === "number") s.push("port " + data.port);
    if (typeof data.enabled === "boolean") s.push(data.enabled ? "enabled" : "disabled");
    return s.join(" \\u00b7 ");
  }
  if (section === "secrets") {
    var presence = secretPresence(data);
    return presence.set + " of " + presence.total + " set";
  }
  return "";
}
function isPresentEntry(value) { return value && typeof value === "object" && value.present === true; }
function secretPresence(config) {
  var d = config && typeof config === "object" ? config : {};
  var secrets = d.secrets && typeof d.secrets === "object" ? d.secrets : {};
  var embeddings = d.embeddings && typeof d.embeddings === "object" ? d.embeddings : {};
  var set = 0;
  for (var i = 0; i < SECRET_LABELS.length; i++) {
    if (isPresentEntry(secrets[SECRET_LABELS[i][0]])) set++;
  }
  if (isPresentEntry(embeddings.apiKey)) set++;
  return { set: set, total: SECRET_LABELS.length + 1 };
}
function matches(haystack, query) { return haystack.toLowerCase().includes(query); }
function filteredFamilies(query) {
  var needle = query.trim().toLowerCase();
  if (!needle) return state.catalog.families;
  var out = [];
  for (var i = 0; i < state.catalog.families.length; i++) {
    var family = state.catalog.families[i];
    var hay = [family.label, family.slug, family.id].concat(family.aliases || []);
    var familyHit = hay.some(function (text) { return matches(String(text), needle); });
    if (familyHit) { out.push(family); continue; }
    var variants = (family.variants || []).filter(function (v) {
      return matches(String(v.id), needle) || matches(String(v.label), needle);
    });
    if (variants.length > 0) out.push(Object.assign({}, family, { variants: variants }));
  }
  return out;
}
function mirrorValidate(section, patch) {
  var errors = {};
  function isStr(v) { return typeof v === "string"; }
  function nonEmpty(v) { return isStr(v) && v.trim().length > 0; }
  function oneOf(v, options) { return isStr(v) && options.indexOf(v) >= 0; }
  function isInt(v) { return typeof v === "number" && isFinite(v) && Math.floor(v) === v; }
  function strArray(v) { return Array.isArray(v) && v.every(function (e) { return isStr(e); }); }
  function posIntArray(v) {
    return Array.isArray(v) && v.every(function (e) { return isInt(e) && e > 0; });
  }
  if (section === "general") {
    if (patch.model !== undefined && !nonEmpty(patch.model)) errors.model = "must be a non-empty model name";
    if (patch.logLevel !== undefined && !oneOf(patch.logLevel, LOG_LEVELS)) errors.logLevel = "must be one of " + LOG_LEVELS.join(", ");
    if (patch.toolVisibility !== undefined && !oneOf(patch.toolVisibility, TOOL_VISIBILITY_LEVELS)) errors.toolVisibility = "must be one of " + TOOL_VISIBILITY_LEVELS.join(", ");
    if (patch.voiceName !== undefined && !nonEmpty(patch.voiceName)) errors.voiceName = "must be a non-empty voice name";
    if (patch.asrModel !== undefined && !oneOf(patch.asrModel, ASR_MODELS)) errors.asrModel = "must be one of " + ASR_MODELS.join(", ");
    if (patch.favorites !== undefined && !strArray(patch.favorites)) errors.favorites = "must be a list of favorite names";
    if (patch.allowedUsers !== undefined && !(posIntArray(patch.allowedUsers) && patch.allowedUsers.length > 0)) errors.allowedUsers = "must be a non-empty list of positive integer Telegram user ids";
  } else if (section === "embeddings") {
    var textFields = ["baseUrl", "model", "provider"];
    for (var i = 0; i < textFields.length; i++) {
      if (patch[textFields[i]] !== undefined && !nonEmpty(patch[textFields[i]])) errors[textFields[i]] = "must be a non-empty value";
    }
    if (patch.cooldownSeconds !== undefined && !(typeof patch.cooldownSeconds === "number" && isFinite(patch.cooldownSeconds) && patch.cooldownSeconds >= 0)) errors.cooldownSeconds = "must be a non-negative number of seconds";
  } else if (section === "external-agents") {
    if (patch.backends !== undefined) {
      var known = Array.isArray(patch.backends) && patch.backends.every(function (b) { return oneOf(b, EXTERNAL_BACKENDS); });
      var dupes = Array.isArray(patch.backends) && new Set(patch.backends).size !== patch.backends.length;
      if (!known || dupes) errors.backends = "must be a duplicate-free list of " + EXTERNAL_BACKENDS.join(", ");
    }
  } else if (section === "devin") {
    if (patch.defaultModel !== undefined && !(isStr(patch.defaultModel) && patch.defaultModel.length > 0 && patch.defaultModel.trim() === patch.defaultModel)) errors.defaultModel = "must be a non-empty, unpadded exact model id";
  } else if (section === "mcp") {
    if (patch.defaultTimeoutMs === undefined && patch.maxResultChars === undefined) errors.section = "must contain a limits edit (defaultTimeoutMs or maxResultChars); server toggles are separate writes";
    if (patch.defaultTimeoutMs !== undefined && !(isInt(patch.defaultTimeoutMs) && patch.defaultTimeoutMs >= 5000 && patch.defaultTimeoutMs <= 1800000)) errors.defaultTimeoutMs = "must be an integer between 5000 and 1800000";
    if (patch.maxResultChars !== undefined && !(isInt(patch.maxResultChars) && patch.maxResultChars >= 1000 && patch.maxResultChars <= 100000)) errors.maxResultChars = "must be an integer between 1000 and 100000";
  } else if (section === "settings") {
    if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") errors.enabled = "must be on or off";
    if (patch.port !== undefined && !(isInt(patch.port) && patch.port >= 1 && patch.port <= 65535)) errors.port = "must be an integer between 1 and 65535";
    if (patch.publicUrl !== undefined) {
      var okUrl = false;
      if (isStr(patch.publicUrl)) { try { okUrl = new URL(patch.publicUrl).protocol === "https:"; } catch (e) { okUrl = false; } }
      if (!okUrl) errors.publicUrl = "must be a valid https URL";
    }
    if (patch.allowedOrigins !== undefined) {
      var okOrigins = strArray(patch.allowedOrigins);
      if (okOrigins) {
        for (var j = 0; j < patch.allowedOrigins.length; j++) {
          try { var protocol = new URL(patch.allowedOrigins[j]).protocol; if (protocol !== "https:" && protocol !== "http:") okOrigins = false; }
          catch (e2) { okOrigins = false; }
        }
      }
      if (!okOrigins) errors.allowedOrigins = "must be a list of valid http(s) origins";
    }
  } else {
    errors.section = "unknown section";
  }
  return errors;
}

// ---- per-section form machinery ----
function jsonHeaders() { return Object.assign({}, authHeader, { "content-type": "application/json" }); }
function fieldInputs(section) { return qsAll('[data-section="' + section + '"][data-field]'); }
function fieldErrorSlot(section, field) {
  return document.querySelector('[data-error-for="' + section + "." + field + '"]');
}
function saveStatusEl(section) { return document.querySelector('[data-save-status="' + section + '"]'); }
function clearFieldErrors(section) {
  var slots = qsAll('[data-error-for^="' + section + '."]');
  for (var i = 0; i < slots.length; i++) { slots[i].textContent = ""; hide(slots[i]); }
  var status = saveStatusEl(section);
  if (status) { status.textContent = ""; status.className = "save-status"; }
}
function setSaveStatus(section, kind, message) {
  var status = saveStatusEl(section);
  if (!status) return;
  status.textContent = message;
  status.className = "save-status" + (kind ? " " + kind : "");
}
function chipValues(wrapper) {
  var chips = wrapper.querySelectorAll(".chip");
  var out = [];
  for (var i = 0; i < chips.length; i++) out.push(chips[i].getAttribute("data-value"));
  return out;
}
function buildChip(field, value) {
  var chip = el("span", { class: "chip" });
  chip.setAttribute("data-value", value);
  chip.appendChild(el("span", { class: "chip-value", text: value }));
  if (canRemoveListEntry(field, value, viewerId)) {
    var remove = el("button", { type: "button", class: "chip-remove", text: "\\u00d7" });
    remove.setAttribute("aria-label", "Remove " + value);
    remove.addEventListener("click", onChipRemove);
    chip.appendChild(remove);
  } else {
    chip.appendChild(el("span", { class: "chip-locked", text: "locked", title: "Your own Telegram user id cannot be removed" }));
  }
  return chip;
}
function renderChips(wrapper, values) {
  clear(wrapper);
  var field = wrapper.dataset.field;
  var isUsers = field === "allowedUsers";
  for (var i = 0; i < values.length; i++) {
    var value = String(values[i]);
    if (value.length === 0) continue;
    wrapper.appendChild(buildChip(field, value));
  }
  var row = el("div", { class: "chip-add-row" });
  var add = el("input", { class: "chip-add", type: "text", placeholder: isUsers ? "Add user id…" : "Add entry…" });
  if (isUsers) add.setAttribute("inputmode", "numeric");
  var addBtn = el("button", { type: "button", class: "chip-add-btn", text: "Add" });
  addBtn.addEventListener("click", function () { commitChipAdd(wrapper, add); });
  add.addEventListener("keydown", function (event) {
    if (event.key === "Enter") { event.preventDefault(); commitChipAdd(wrapper, add); }
  });
  row.appendChild(add);
  row.appendChild(addBtn);
  wrapper.appendChild(row);
}
function commitChipAdd(wrapper, add) {
  var field = wrapper.dataset.field;
  var section = wrapper.dataset.section;
  var slot = fieldErrorSlot(section, field);
  if (slot) { slot.textContent = ""; hide(slot); }
  var entries = parseListEntries(add.value);
  if (entries.length === 0) return;
  if (field === "allowedUsers") {
    for (var i = 0; i < entries.length; i++) {
      if (!/^[0-9]+$/.test(entries[i]) || Number(entries[i]) <= 0) {
        if (slot) { slot.textContent = "User ids must be positive integers."; show(slot); }
        return;
      }
    }
  }
  var existing = chipValues(wrapper);
  var added = false;
  for (var j = 0; j < entries.length; j++) {
    if (existing.indexOf(entries[j]) >= 0) continue;
    existing.push(entries[j]);
    wrapper.insertBefore(buildChip(field, entries[j]), wrapper.querySelector(".chip-add-row"));
    added = true;
  }
  add.value = "";
  if (added) refreshDirty(section);
}
function onChipRemove(event) {
  var chip = event.currentTarget.parentNode;
  var wrapper = chip.parentNode;
  if (!wrapper || wrapper.dataset.list !== "1") return;
  if (!canRemoveListEntry(wrapper.dataset.field, chip.getAttribute("data-value") || "", viewerId)) return;
  wrapper.removeChild(chip);
  refreshDirty(wrapper.dataset.section);
}
function setFieldValue(input, value) {
  if (input.dataset.list === "1") {
    renderChips(input, Array.isArray(value) ? value : []);
    return;
  }
  var type = input.getAttribute("type");
  if (type === "checkbox") {
    if (input.dataset.value !== undefined) input.checked = Array.isArray(value) && value.indexOf(input.dataset.value) >= 0;
    else input.checked = value === true;
    return;
  }
  input.value = Array.isArray(value) ? value.join(", ") : value === null || value === undefined ? "" : String(value);
}
function collectSection(section) {
  var patch = {};
  var inputs = fieldInputs(section);
  for (var i = 0; i < inputs.length; i++) {
    var input = inputs[i];
    var field = input.dataset.field;
    var type = input.getAttribute("type");
    if (input.dataset.list === "1") {
      var entries = chipValues(input);
      if (field === "allowedUsers") {
        var nums = [];
        for (var u = 0; u < entries.length; u++) {
          var n = Number(entries[u]);
          if (entries[u].length > 0 && Number.isInteger(n) && n > 0) nums.push(n);
        }
        patch[field] = nums;
      } else {
        patch[field] = entries;
      }
      if (entries.length === 0 && input.dataset.optional === "1") delete patch[field];
    } else if (type === "checkbox") {
      if (input.dataset.value !== undefined) {
        var values = patch[field] || (patch[field] = []);
        if (input.checked) values.push(input.dataset.value);
      } else patch[field] = input.checked;
    } else if (type === "number") {
      var raw = input.value.trim();
      if (raw.length === 0) {
        if (input.dataset.optional === "1") continue;
        patch[field] = NaN;
      } else patch[field] = Number(raw);
    } else {
      var text = input.value;
      if (input.dataset.optional === "1" && text.trim().length === 0) continue;
      patch[field] = text;
    }
  }
  return patch;
}

// ---- dirty tracking: save/cancel stay disabled until the form differs from
// the last loaded (or saved) config; dirty cards mark their title with a dot ----
function snapshotBaseline(section) { baselines[section] = JSON.stringify(collectSection(section)); }
function isDirtySection(section) {
  if (baselines[section] === undefined) return false;
  return JSON.stringify(collectSection(section)) !== baselines[section];
}
function refreshDevinDirty() {
  var saved = state.config && state.config.devin && typeof state.config.devin.defaultModel === "string"
    ? state.config.devin.defaultModel
    : null;
  var dirty = state.selectedId !== null && state.selectedId !== saved;
  if (saveEl) saveEl.disabled = !dirty;
  var cancel = document.querySelector('[data-cancel="devin"]');
  if (cancel) cancel.disabled = !dirty;
  var dot = document.querySelector('[data-dirty-for="devin"]');
  if (dot) dot.hidden = !dirty;
}
function refreshDirty(section) {
  if (section === "devin") { refreshDevinDirty(); return; }
  var dirty = isDirtySection(section);
  var save = document.querySelector('[data-save="' + section + '"]');
  var cancel = document.querySelector('[data-cancel="' + section + '"]');
  var dot = document.querySelector('[data-dirty-for="' + section + '"]');
  if (save) save.disabled = !dirty;
  if (cancel) cancel.disabled = !dirty;
  if (dot) dot.hidden = !dirty;
}
function cancelSection(section) {
  if (section === "devin") {
    state.selectedId = state.config && state.config.devin && state.config.devin.defaultModel
      ? state.config.devin.defaultModel
      : null;
    setText($("current-selection"), state.selectedId ? state.selectedId : "None saved yet.");
    clearFieldErrors("devin");
    hide($("status-saved"));
    refreshDevinDirty();
    renderList();
    return;
  }
  var data = state.config && state.config[section] ? state.config[section] : {};
  var inputs = fieldInputs(section);
  for (var i = 0; i < inputs.length; i++) setFieldValue(inputs[i], data[inputs[i].dataset.field]);
  clearFieldErrors(section);
  snapshotBaseline(section);
  refreshDirty(section);
}

// Sections whose changes apply on the next boot (everything but devin).
var RESTART_SECTIONS = { general: true, embeddings: true, "external-agents": true, mcp: true, settings: true };

function applyServerFieldErrors(section, placements) {
  var placed = 0;
  for (var key in placements) {
    var slot = fieldErrorSlot(section, key);
    if (!slot) continue;
    slot.textContent = placements[key];
    show(slot);
    placed++;
  }
  return placed;
}
async function handleSaveFailure(section, res) {
  var body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  var view = saveFailureFeedback(section, res.status, body);
  applyServerFieldErrors(section, view.fieldErrors);
  if (view.status) setSaveStatus(section, view.status.kind, view.status.text);
  if (view.reload) {
    var status = saveStatusEl(section);
    if (status) {
      var reload = el("button", { type: "button", class: "link", text: "Reload current settings" });
      reload.addEventListener("click", function () { reload.disabled = true; loadConfig(false); });
      status.appendChild(reload);
    }
  }
}
async function saveSection(section) {
  var patch = collectSection(section);
  clearFieldErrors(section);
  var errors = mirrorValidate(section, patch);
  var keys = Object.keys(errors);
  if (keys.length > 0) {
    var sectionMessage = "";
    for (var i = 0; i < keys.length; i++) {
      if (keys[i] === "section") { sectionMessage = errors[keys[i]]; continue; }
      var slot = fieldErrorSlot(section, keys[i]);
      if (slot) { slot.textContent = errors[keys[i]]; show(slot); }
    }
    setSaveStatus(section, "error", sectionMessage.length > 0 ? sectionMessage : "Fix the highlighted fields.");
    return;
  }
  setSaveStatus(section, "saving", "Saving…");
  var res;
  try {
    res = await fetch("/api/config/" + section, {
      method: "PUT",
      headers: jsonHeaders(),
      body: JSON.stringify({ patch: patch, expectedRevision: state.revision }),
    });
  } catch (e) {
    setSaveStatus(section, "error", "Save did not reach Goblin. Nothing was saved.");
    return;
  }
  if (res.ok) {
    var saved = await res.json();
    if (saved && typeof saved.revision === "string") {
      state.revision = saved.revision;
      if (state.config) state.config.revision = saved.revision;
    }
    if (state.config) state.config[section] = Object.assign({}, state.config[section], patch);
    snapshotBaseline(section);
    refreshDirty(section);
    renderSummaries();
    updateBadge(state.config);
    setSaveStatus(section, "saved", RESTART_SECTIONS[section] ? "Saved. Takes effect after restart." : "Saved.");
    return;
  }
  await handleSaveFailure(section, res);
}

// ---- sticky restart bar: visible only while revisions diverge ----
function updateBadge(config) {
  var bar = $("restart-bar");
  var badge = $("pending-restart");
  if (!bar || !badge) return;
  var pending = !!(config && typeof config.revision === "string" && typeof config.bootRevision === "string" && config.revision !== config.bootRevision);
  show(bar);
  badge.hidden = !pending;
  if (pending) badge.textContent = "Restart pending — Devin model changes apply without restart";
  restartEl.hidden = !pending;
  restartEl.disabled = false;
  var ok = $("restart-ok");
  if (ok) ok.hidden = pending;
  // A completed or aborted confirmation resets the bar to its idle layout.
  var row = $("restart-row");
  if (row) show(row);
  hide(restartConfirmEl);
}

// ---- collapsed-card value summaries ----
function renderSummaries() {
  if (!state.config) return;
  var nodes = qsAll("[data-summary-for]");
  for (var i = 0; i < nodes.length; i++) {
    var section = nodes[i].getAttribute("data-summary-for");
    // The secrets summary counts the rendered chips, so it reads the whole
    // config: the embeddings key lives outside the secrets section.
    var data = section === "secrets" ? state.config : state.config[section];
    setText(nodes[i], sectionSummary(section, data));
  }
}

// ---- MCP section (toggles and limits are separate writes) ----
function renderMcp(mcp) {
  var wrap = $("mcp-servers");
  if (!wrap) return;
  clear(wrap);
  setText($("mcp-config-path"), "");
  if (!mcp) return;
  setText($("mcp-config-path"), mcp.configPath && mcp.configPath.present ? "config path: set" : "config path: not set");
  var names = {};
  var enabled = Array.isArray(mcp.enabled) ? mcp.enabled : [];
  var disabled = Array.isArray(mcp.disabledServers) ? mcp.disabledServers : [];
  for (var i = 0; i < enabled.length; i++) names[enabled[i]] = true;
  for (var j = 0; j < disabled.length; j++) names[disabled[j]] = true;
  var sorted = Object.keys(names).sort();
  for (var k = 0; k < sorted.length; k++) {
    var name = sorted[k];
    var isOn = disabled.indexOf(name) < 0;
    var row = el("div", { class: "mcp-row" });
    row.appendChild(el("span", { class: "mcp-name", text: name }));
    row.appendChild(el("span", { class: "mcp-state " + (isOn ? "on" : "off"), text: isOn ? "on" : "off" }));
    var button = el("button", { type: "button", class: "link", text: isOn ? "Disable" : "Enable" });
    button.dataset.server = name;
    button.dataset.enable = isOn ? "0" : "1";
    button.addEventListener("click", onMcpToggle);
    row.appendChild(button);
    wrap.appendChild(row);
  }
  if (sorted.length === 0) wrap.appendChild(el("p", { class: "hint", text: "No known servers yet; they appear once configured in goblin.json5." }));
}
async function onMcpToggle(event) {
  var button = event.currentTarget;
  var server = button.dataset.server;
  var enable = button.dataset.enable === "1";
  button.disabled = true;
  var res;
  try {
    res = await fetch("/api/config/mcp", {
      method: "PUT",
      headers: jsonHeaders(),
      body: JSON.stringify({ patch: { server: server, enabled: enable }, expectedRevision: state.revision }),
    });
  } catch (e) {
    setSaveStatus("mcp", "error", "Toggle did not reach Goblin. Nothing was changed.");
    button.disabled = false;
    return;
  }
  if (res.ok) { await loadConfig(false); return; }
  await handleSaveFailure("mcp", res);
  button.disabled = false;
}

// ---- secrets presence row ----
// SECRET_LABELS (injected above) and secretPresence are the single source
// for both the chips and the collapsed-card summary.
function renderSecrets(config) {
  var wrap = $("secrets-list");
  if (!wrap) return;
  clear(wrap);
  var secrets = (config && config.secrets) || {};
  for (var i = 0; i < SECRET_LABELS.length; i++) {
    var entry = secrets[SECRET_LABELS[i][0]];
    var present = !!(entry && entry.present);
    wrap.appendChild(el("span", { class: "presence-chip" + (present ? " set" : ""), text: SECRET_LABELS[i][1] + ": " + (present ? "set" : "not set") }));
  }
  var embeddingsKey = config && config.embeddings && config.embeddings.apiKey;
  var embeddingsPresent = !!(embeddingsKey && embeddingsKey.present);
  wrap.appendChild(el("span", { class: "presence-chip" + (embeddingsPresent ? " set" : ""), text: "embeddings key: " + (embeddingsPresent ? "set" : "not set") }));
}

// ---- Devin catalog (request-owned discovery, exact-model save) ----
function variantMeta(variant) {
  var parts = [];
  if (variant.costSummary) parts.push(variant.costSummary);
  if (variant.costTier) parts.push(variant.costTier);
  if (variant.contextTokens) parts.push(variant.contextTokens + " context");
  if (variant.outputTokens) parts.push(variant.outputTokens + " output");
  if (variant.isNew) parts.push("new");
  if (variant.isBeta) parts.push("beta");
  return parts.join(" · ");
}
function renderDevin(devin) {
  state.selectedId = devin && devin.defaultModel ? devin.defaultModel : null;
  setText($("current-selection"), state.selectedId ? state.selectedId : "None saved yet.");
  refreshDevinDirty();
  renderList();
}
function renderList() {
  if (!state.catalog) return;
  clear(listEl);
  var hits = filteredFamilies(searchEl.value);
  for (var i = 0; i < hits.length; i++) {
    var family = hits[i];
    var group = el("section", { class: "family" });
    // Provider text reaches the DOM only as text.
    group.appendChild(el("h3", { text: family.label }));
    for (var j = 0; j < (family.variants || []).length; j++) {
      var variant = family.variants[j];
      var button = el("button", { type: "button", class: "variant" });
      button.setAttribute("aria-pressed", variant.id === state.selectedId ? "true" : "false");
      button.appendChild(document.createTextNode(variant.label + " (" + variant.id + ")"));
      button.appendChild(document.createElement("br"));
      var meta = el("span", { class: "meta", text: variantMeta(variant) || (variant.description || "") });
      meta.setAttribute("title", variant.description || "");
      button.appendChild(meta);
      button.addEventListener("click", function (variantId) {
        return function () {
          state.selectedId = variantId;
          hide($("status-saved"));
          refreshDevinDirty();
          renderList();
        };
      }(variant.id));
      group.appendChild(button);
    }
    listEl.appendChild(group);
  }
}
async function loadCatalog() {
  var res;
  try { res = await fetch("/api/catalog", { headers: authHeader }); }
  catch (e) {
    catalogErrorEl.textContent = "Model catalog is unreachable. Saved selection above is unchanged.";
    catalogErrorEl.hidden = false;
    return;
  }
  if (!res.ok) {
    var body = null;
    try { body = await res.json(); } catch (e2) { body = null; }
    var reason = body && typeof body.error === "string" ? body.error : "unavailable";
    catalogErrorEl.textContent = "Model catalog failed (" + reason + "). Saved selection above is unchanged.";
    catalogErrorEl.hidden = false;
    return;
  }
  hide(catalogErrorEl);
  state.catalog = await res.json();
  renderList();
}

// ---- config load + restart flow ----
function applyConfig(config) {
  state.config = config;
  state.revision = typeof config.revision === "string" ? config.revision : null;
  state.bootRevision = typeof config.bootRevision === "string" ? config.bootRevision : null;
  for (var s = 0; s < SECTIONS.length; s++) {
    var section = SECTIONS[s];
    var data = config[section];
    if (!data) continue;
    // An MCP toggle or post-restart reload must not wipe unsaved edits in
    // other sections; their baseline stays until they save (a moved revision
    // surfaces as a 409 with a reload affordance) or cancel.
    if (baselines[section] !== undefined && isDirtySection(section)) continue;
    var inputs = fieldInputs(section);
    for (var i = 0; i < inputs.length; i++) setFieldValue(inputs[i], data[inputs[i].dataset.field]);
    snapshotBaseline(section);
    refreshDirty(section);
  }
  renderMcp(config.mcp);
  renderSecrets(config);
  renderDevin(config.devin);
  renderSummaries();
  updateBadge(config);
  hide(loadingEl);
}
async function loadConfig(showLoading) {
  if (showLoading) { show(loadingEl); hide(loadErrorEl); }
  var res;
  try { res = await fetch("/api/config", { headers: authHeader }); }
  catch (e) {
    loadErrorEl.textContent = "Could not reach Goblin. Check the private connection and reopen Settings.";
    show(loadErrorEl);
    hide(loadingEl);
    return;
  }
  if (res.status === 401) {
    var body = null;
    try { body = await res.json(); } catch (e1) { body = null; }
    var code = body && typeof body.error === "string" ? body.error : "unauthorized";
    loadErrorEl.textContent = code === "expired"
      ? "Telegram session expired. Close and reopen Settings from Telegram, then save again."
      : "Not authorized. Open Settings from the operator Telegram account.";
    show(loadErrorEl);
    hide(loadingEl);
    return;
  }
  if (!res.ok) {
    loadErrorEl.textContent = "Settings are unavailable. Nothing was saved.";
    show(loadErrorEl);
    hide(loadingEl);
    return;
  }
  applyConfig(await res.json());
}
async function pollAfterRestart(attempt) {
  var res = null;
  try { res = await fetch("/api/config", { headers: authHeader }); } catch (e) { res = null; }
  if (res !== null && res.ok) {
    applyConfig(await res.json());
    hide(reconnectEl);
    restartEl.disabled = false;
    setSaveStatus("general", "saved", "Goblin restarted with the saved configuration.");
    return;
  }
  // 503 shutting-down and unreachable connections both mean: not back yet.
  setTimeout(function () { pollAfterRestart(attempt + 1); }, nextBackoffMs(attempt));
}
async function confirmRestart() {
  hide(restartConfirmEl);
  show(reconnectEl);
  restartEl.disabled = true;
  try { await fetch("/api/restart", { method: "POST", headers: jsonHeaders() }); }
  catch (e) { /* the connection drop is expected once the drain begins */ }
  pollAfterRestart(0);
}

// ---- wiring ----
saveEl.addEventListener("click", async function () {
  if (!state.selectedId) return;
  hide($("status-saved"));
  clearFieldErrors("devin");
  saveEl.disabled = true;
  var res;
  try {
    res = await fetch("/api/config/devin", {
      method: "PUT",
      headers: jsonHeaders(),
      body: JSON.stringify({ patch: { defaultModel: state.selectedId }, expectedRevision: state.revision }),
    });
  } catch (e) {
    setSaveStatus("devin", "error", "Save did not reach Goblin. Nothing was saved.");
    refreshDevinDirty();
    return;
  }
  if (res.ok) {
    var saved = await res.json();
    if (saved && typeof saved.revision === "string") {
      state.revision = saved.revision;
      if (state.config) state.config.revision = saved.revision;
    }
    if (state.config) state.config.devin = Object.assign({}, state.config.devin, { defaultModel: state.selectedId });
    updateBadge(state.config);
    setText($("current-selection"), state.selectedId);
    var savedEl = $("status-saved");
    savedEl.textContent = "Saved " + state.selectedId + ". It applies to the next run.";
    show(savedEl);
    renderSummaries();
    refreshDevinDirty();
    return;
  }
  await handleSaveFailure("devin", res);
  refreshDevinDirty();
});
restartEl.addEventListener("click", function () { show(restartConfirmEl); hide($("restart-row")); restartEl.disabled = true; });
$("restart-no").addEventListener("click", function () { hide(restartConfirmEl); show($("restart-row")); restartEl.disabled = false; });
$("restart-yes").addEventListener("click", confirmRestart);
searchEl.addEventListener("input", renderList);
var saveButtons = qsAll("[data-save]");
for (var b = 0; b < saveButtons.length; b++) {
  (function (button) {
    button.addEventListener("click", function () { saveSection(button.getAttribute("data-save")); });
  })(saveButtons[b]);
}
var cancelButtons = qsAll("[data-cancel]");
for (var c = 0; c < cancelButtons.length; c++) {
  (function (button) {
    button.addEventListener("click", function () { cancelSection(button.getAttribute("data-cancel")); });
  })(cancelButtons[c]);
}
function onFormMutation(event) {
  var target = event.target;
  if (!target || !target.classList || target.classList.contains("chip-add")) return;
  var card = typeof target.closest === "function" ? target.closest("[data-section]") : null;
  if (card) refreshDirty(card.getAttribute("data-section"));
}
document.addEventListener("input", onFormMutation);
document.addEventListener("change", onFormMutation);
if (tg) {
  applyTheme(tg.themeParams);
  tg.onEvent("themeChanged", function () { applyTheme(tg.themeParams); });
  if (typeof tg.ready === "function") tg.ready();
  if (typeof tg.expand === "function") tg.expand();
}
loadConfig(true);
loadCatalog();
</script>
</body>
</html>`;
}

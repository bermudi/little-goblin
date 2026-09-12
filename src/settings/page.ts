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
 * `escapeHtml`, `filterCatalogFamilies`, `validateSectionPatch`, and
 * `nextBackoffMs` are the canonical text/search/validation/backoff
 * implementations the embedded client script mirrors (it cannot import this
 * module without a bundler). Provider strings and config values reach the
 * DOM only through `textContent`, never parsed markup; the page never uses
 * `innerHTML`.
 */

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

// Schema-derived enum mirrors for client-side validation; they mirror
// `ConfigFileSchema` in `../schema.ts` (the server re-validates every save).
const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
const TOOL_VISIBILITY_LEVELS = ["none", "minimal", "standard", "verbose", "debug"] as const;
const ASR_MODELS = ["whisper-large-v3-turbo", "whisper-large-v3"] as const;
const EXTERNAL_BACKENDS = ["claude", "devin"] as const;
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
      { field: "voiceName", label: "Voice name", kind: "text" },
      { field: "asrModel", label: "ASR model", kind: "select", options: ASR_MODELS },
      { field: "favorites", label: "Favorites", kind: "list", hint: "Comma-separated names." },
      {
        field: "allowedUsers",
        label: "Allowed users",
        kind: "list",
        hint: "Comma-separated Telegram user ids. Keep your own id in the list or you will lock yourself out.",
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
        hint: "Comma-separated https origins; empty leaves it unchanged.",
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
      return `<input id="field-${section.section}-${field.field}" type="checkbox" ${attrs}>`;
    case "number":
      return `<input id="field-${section.section}-${field.field}" type="number" step="1" inputmode="numeric" ${attrs}>`;
    case "list":
      return `<input id="field-${section.section}-${field.field}" type="text" ${attrs} data-list="1">`;
    case "multi":
      return `<div class="multi">${field
        .options!.map(
          (option) =>
            `<label class="check"><input type="checkbox" ${attrs} data-value="${option}"> ${escapeHtml(option)}</label>`,
        )
        .join("")}</div>`;
    default:
      return `<input id="field-${section.section}-${field.field}" type="text" ${attrs}>`;
  }
}

function renderField(section: PageSectionSpec, field: PageFieldSpec): string {
  const labelHtml =
    field.kind === "multi"
      ? `<div class="field-label">${escapeHtml(field.label)}</div>`
      : `<label for="field-${section.section}-${field.field}">${escapeHtml(field.label)}${
          field.optional ? ' <span class="optional">optional</span>' : ""
        }</label>`;
  return `<div class="field">${labelHtml}${renderInput(section, field)}<div class="field-error" data-error-for="${
    section.section
  }.${field.field}" role="alert" hidden></div>${field.hint ? `<p class="hint">${escapeHtml(field.hint)}</p>` : ""}</div>`;
}

function renderCard(spec: PageSectionSpec): string {
  return `<section class="card" data-section="${spec.section}" aria-labelledby="heading-${spec.section}"><h2 id="heading-${
    spec.section
  }">${escapeHtml(spec.title)}</h2>${spec.note ? `<p class="note">${escapeHtml(spec.note)}</p>` : ""}${spec.fields
    .map((field) => renderField(spec, field))
    .join("")}<div class="save-row"><button type="button" class="primary" data-save="${spec.section}">Save</button><span class="save-status" data-save-status="${
    spec.section
  }" role="status"></span></div></section>`;
}

/** Render the static Settings operator console. No secrets, no config data. */
export function renderSettingsPage(): string {
  const cards = new Map(SECTION_SPECS.map((spec) => [spec.section, renderCard(spec)]));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Goblin Settings</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
[hidden] { display: none !important; }
:root {
  color-scheme: light dark;
  --theme-bg: #f2f4f7; --theme-card: #ffffff; --theme-fg: #101828; --theme-muted: #5b6472;
  --theme-accent: #3390ec; --theme-accent-fg: #ffffff; --theme-ok: #1b7f37; --theme-err: #c22a2a;
  --theme-border: rgba(16, 24, 40, 0.14);
}
@media (prefers-color-scheme: dark) {
  :root {
    --theme-bg: #17212b; --theme-card: #1d2733; --theme-fg: #f1f5f9; --theme-muted: #94a3b8;
    --theme-accent: #62a8ea; --theme-accent-fg: #10202e; --theme-ok: #57c26b; --theme-err: #ff7a7a;
    --theme-border: rgba(241, 245, 249, 0.16);
  }
}
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, sans-serif; font-size: 15px; background: var(--theme-bg); color: var(--theme-fg); }
header { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: var(--theme-card); border-bottom: 1px solid var(--theme-border); }
header h1 { font-size: 17px; margin: 0; flex: 1; }
.badge { background: var(--theme-err); color: #fff; font-size: 12px; font-weight: 600; border-radius: 999px; padding: 3px 10px; white-space: nowrap; }
button { font: inherit; border-radius: 8px; border: 1px solid var(--theme-border); background: var(--theme-card); color: var(--theme-fg); padding: 8px 12px; cursor: pointer; }
button.primary { background: var(--theme-accent); border-color: var(--theme-accent); color: var(--theme-accent-fg); }
button.danger { background: var(--theme-err); border-color: var(--theme-err); color: #fff; }
button.link { border: 0; background: none; color: var(--theme-accent); padding: 4px 6px; }
button:disabled { opacity: 0.5; cursor: default; }
#restart-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 14px; background: var(--theme-card); border-bottom: 1px solid var(--theme-border); font-size: 14px; }
main { max-width: 640px; margin: 0 auto; padding: 12px; display: grid; gap: 12px; }
.card { background: var(--theme-card); border: 1px solid var(--theme-border); border-radius: 12px; padding: 12px 14px; }
.card h2 { font-size: 16px; margin: 0 0 4px; }
.note, .hint, .meta { font-size: 13px; color: var(--theme-muted); margin: 4px 0; }
.field { margin: 10px 0; }
.field > label, .field-label { display: block; font-size: 13px; color: var(--theme-muted); margin-bottom: 4px; }
.optional { opacity: 0.7; font-size: 11px; }
input[type="text"], input[type="number"], input[type="search"], select { width: 100%; font: inherit; font-size: 16px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--theme-border); background: var(--theme-bg); color: var(--theme-fg); }
.multi { display: flex; gap: 14px; flex-wrap: wrap; }
.multi label.check { display: inline-flex; align-items: center; gap: 6px; font-size: 15px; color: var(--theme-fg); }
input[type="checkbox"] { width: 18px; height: 18px; accent-color: var(--theme-accent); }
.field-error { color: var(--theme-err); font-size: 13px; margin-top: 4px; }
.save-row { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
.save-status { font-size: 13px; min-width: 0; overflow-wrap: anywhere; }
.save-status.saved { color: var(--theme-ok); }
.save-status.error { color: var(--theme-err); }
#status-saved { color: var(--theme-ok); font-size: 14px; margin-top: 8px; }
#catalog-error { color: var(--theme-err); font-size: 13px; margin-top: 8px; }
#load-error { color: var(--theme-err); padding: 12px 14px; font-size: 14px; }
#status-loading { padding: 12px 14px; color: var(--theme-muted); }
.family { border-top: 1px solid var(--theme-border); padding: 8px 0; }
.family h3 { font-size: 14px; margin: 4px 0; }
.variant { display: block; width: 100%; text-align: left; margin: 6px 0; padding: 10px; font-size: 15px; }
.variant[aria-pressed="true"] { outline: 2px solid var(--theme-accent); }
.mcp-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-top: 1px solid var(--theme-border); }
.mcp-row .mcp-name { flex: 1; overflow-wrap: anywhere; }
.mcp-state.on { color: var(--theme-ok); }
.mcp-state.off { color: var(--theme-err); }
.presence-chip { display: inline-block; border: 1px solid var(--theme-border); border-radius: 999px; padding: 3px 10px; font-size: 13px; margin: 3px 4px 3px 0; }
.presence-chip.set { border-color: var(--theme-ok); color: var(--theme-ok); }
#reconnecting { position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.55); }
#reconnecting .reconnect-card { background: var(--theme-card); color: var(--theme-fg); border-radius: 12px; padding: 18px 20px; font-size: 15px; max-width: 320px; text-align: center; }
</style>
</head>
<body>
<header>
  <h1>Goblin Settings</h1>
  <span id="pending-restart" class="badge" hidden></span>
  <button id="restart-button" type="button" class="danger">Restart</button>
</header>
<div id="restart-confirm" hidden>
  <span>Restart Goblin now? The process drains, exits, and systemd brings it back.</span>
  <button id="restart-yes" type="button" class="danger">Confirm restart</button>
  <button id="restart-no" type="button">Cancel</button>
</div>
<div id="status-loading" role="status">Loading settings…</div>
<div id="load-error" role="alert" hidden></div>
<main>
${cards.get("general") ?? ""}
${cards.get("embeddings") ?? ""}
${cards.get("external-agents") ?? ""}
<section class="card" data-section="devin" aria-labelledby="heading-devin">
  <h2 id="heading-devin">Devin</h2>
  <p class="note">Deployment default for Devin runs. Applies to the next admitted run; no restart needed.</p>
  <div id="current-selection" class="meta"></div>
  <input id="model-search" type="search" placeholder="Search families or exact models…" autocomplete="off">
  <div id="family-list"></div>
  <div class="save-row"><button id="save-button" type="button" class="primary" disabled>Save exact model</button></div>
  <div id="status-saved" role="status" hidden></div>
  <div id="catalog-error" role="alert" hidden></div>
</section>
<section class="card" data-section="mcp" aria-labelledby="heading-mcp">
  <h2 id="heading-mcp">MCP</h2>
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
  <div class="save-row"><button type="button" class="primary" data-save="mcp">Save limits</button><span class="save-status" data-save-status="mcp" role="status"></span></div>
</section>
${cards.get("settings") ?? ""}
<section class="card" data-section="secrets" aria-labelledby="heading-secrets">
  <h2 id="heading-secrets">Secrets</h2>
  <p class="note">Presence only. Secrets are managed in files, environment, or a vault and are never editable or displayed here.</p>
  <div id="secrets-list"></div>
</section>
</main>
<div id="reconnecting" hidden role="status"><div class="reconnect-card">Restarting Goblin — waiting for it to come back…</div></div>
<script>
"use strict";
var tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
var initData = window.Telegram && window.Telegram.WebApp && typeof window.Telegram.WebApp.initData === "string"
  ? window.Telegram.WebApp.initData
  : "";
var authHeader = { authorization: "tma " + initData };
var SECTIONS = ["general","embeddings","external-agents","devin","mcp","settings"];
var state = { config: null, revision: null, bootRevision: null, catalog: null, selectedId: null };

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
  ["link_color", "--theme-accent"],
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

// ---- canonical mirrors: escapeHtml, filterCatalogFamilies,
// validateSectionPatch, nextBackoffMs (see module header) ----
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function nextBackoffMs(attempt) {
  return Math.min(500 * Math.pow(2, Math.max(0, Math.floor(attempt))), 5000);
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
    if (patch.logLevel !== undefined && !oneOf(patch.logLevel, ["debug","info","warn","error"])) errors.logLevel = "must be one of debug, info, warn, error";
    if (patch.toolVisibility !== undefined && !oneOf(patch.toolVisibility, ["none","minimal","standard","verbose","debug"])) errors.toolVisibility = "must be one of none, minimal, standard, verbose, debug";
    if (patch.voiceName !== undefined && !nonEmpty(patch.voiceName)) errors.voiceName = "must be a non-empty voice name";
    if (patch.asrModel !== undefined && !oneOf(patch.asrModel, ["whisper-large-v3-turbo","whisper-large-v3"])) errors.asrModel = "must be one of whisper-large-v3-turbo, whisper-large-v3";
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
      var known = Array.isArray(patch.backends) && patch.backends.every(function (b) { return oneOf(b, ["claude","devin"]); });
      var dupes = Array.isArray(patch.backends) && new Set(patch.backends).size !== patch.backends.length;
      if (!known || dupes) errors.backends = "must be a duplicate-free list of claude, devin";
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
function splitList(value) {
  var parts = String(value).split(",");
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i].trim();
    if (part.length > 0) out.push(part);
  }
  return out;
}
function setFieldValue(input, value) {
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
    if (type === "checkbox") {
      if (input.dataset.value !== undefined) {
        var values = patch[field] || (patch[field] = []);
        if (input.checked) values.push(input.dataset.value);
      } else patch[field] = input.checked;
    } else if (input.dataset.list === "1") {
      var list = splitList(input.value);
      if (list.length === 0 && input.dataset.optional === "1") continue;
      patch[field] = list;
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

// Sections whose changes apply on the next boot (everything but devin).
var RESTART_SECTIONS = { general: true, embeddings: true, "external-agents": true, mcp: true, settings: true };

function applyServerFieldErrors(section, message) {
  if (typeof message !== "string" || message.length === 0) return 0;
  var parts = message.split("; ");
  var placed = 0;
  for (var i = 0; i < parts.length; i++) {
    var idx = parts[i].indexOf(": ");
    if (idx <= 0) continue;
    var field = parts[i].slice(0, idx).trim();
    var text = parts[i].slice(idx + 2).trim();
    var slot = fieldErrorSlot(section, field);
    if (!slot) continue;
    slot.textContent = text;
    show(slot);
    placed++;
  }
  return placed;
}
async function handleSaveFailure(section, res) {
  var body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  var code = body && typeof body.error === "string" ? body.error : "unavailable";
  var message = body && typeof body.message === "string" ? body.message : "";
  if (res.status === 401 && code === "expired") {
    setSaveStatus(section, "error", "Telegram session expired. Close and reopen Settings from Telegram, then save again.");
    return;
  }
  if (res.status === 409 || code === "conflict") {
    // Distinct state: offer a re-fetch instead of faking success.
    setSaveStatus(section, "error", "Settings changed elsewhere (conflict). ");
    var status = saveStatusEl(section);
    if (status) {
      var reload = el("button", { type: "button", class: "link", text: "Reload current settings" });
      reload.addEventListener("click", function () { reload.disabled = true; loadConfig(false); });
      status.appendChild(reload);
    }
    return;
  }
  if (res.status === 400) {
    var placed = applyServerFieldErrors(section, message);
    if (placed === 0) setSaveStatus(section, "error", message.length > 0 ? message : "Save rejected (" + code + ").");
    else setSaveStatus(section, "error", "Fix the highlighted fields.");
    return;
  }
  setSaveStatus(section, "error", "Save failed (" + code + "). Nothing was saved.");
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
    updateBadge(state.config);
    setSaveStatus(section, "saved", RESTART_SECTIONS[section] ? "Saved. Takes effect after restart." : "Saved.");
    return;
  }
  await handleSaveFailure(section, res);
}

// ---- pending-restart badge ----
function updateBadge(config) {
  var badge = $("pending-restart");
  if (!badge) return;
  var pending = !!(config && typeof config.revision === "string" && typeof config.bootRevision === "string" && config.revision !== config.bootRevision);
  badge.hidden = !pending;
  if (pending) badge.textContent = "Restart required";
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
var SECRET_LABELS = [
  ["botToken", "bot token"],
  ["openrouterApiKey", "openrouter key"],
  ["openaiApiKey", "openai key"],
  ["anthropicApiKey", "anthropic key"],
  ["zaiApiKey", "zai key"],
  ["opencodeApiKey", "opencode key"],
  ["groqApiKey", "groq key"]
];
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
  setText($("current-selection"), state.selectedId ? "Saved deployment model: " + state.selectedId : "No deployment model selected yet.");
  renderList();
}
function renderList() {
  if (!state.catalog) return;
  clear(listEl);
  for (var i = 0; i < filteredFamilies(searchEl.value).length; i++) {
    var family = filteredFamilies(searchEl.value)[i];
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
      meta.setAttribute("title", escapeHtml(variant.description || ""));
      button.appendChild(meta);
      button.addEventListener("click", function (variantId) {
        return function () {
          state.selectedId = variantId;
          hide($("status-saved"));
          saveEl.disabled = false;
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
    var inputs = fieldInputs(section);
    for (var i = 0; i < inputs.length; i++) setFieldValue(inputs[i], data[inputs[i].dataset.field]);
  }
  renderMcp(config.mcp);
  renderSecrets(config);
  renderDevin(config.devin);
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
  setSaveStatus("devin", "", "");
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
    saveEl.disabled = false;
    return;
  }
  if (res.ok) {
    var saved = await res.json();
    if (saved && typeof saved.revision === "string") {
      state.revision = saved.revision;
      if (state.config) state.config.revision = saved.revision;
    }
    updateBadge(state.config);
    setText($("current-selection"), "Saved deployment model: " + state.selectedId);
    var savedEl = $("status-saved");
    savedEl.textContent = "Saved " + state.selectedId + ". It applies to the next run.";
    show(savedEl);
    saveEl.disabled = false;
    return;
  }
  await handleSaveFailure("devin", res);
  saveEl.disabled = false;
});
restartEl.addEventListener("click", function () { show(restartConfirmEl); restartEl.disabled = true; });
$("restart-no").addEventListener("click", function () { hide(restartConfirmEl); restartEl.disabled = false; });
$("restart-yes").addEventListener("click", confirmRestart);
searchEl.addEventListener("input", renderList);
var saveButtons = qsAll("[data-save]");
for (var b = 0; b < saveButtons.length; b++) {
  (function (button) {
    button.addEventListener("click", function () { saveSection(button.getAttribute("data-save")); });
  })(saveButtons[b]);
}
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

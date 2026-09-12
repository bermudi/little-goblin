/**
 * Telegram Settings page — mobile-first Mini App shell for searchable Devin
 * model selection and explicit saving.
 *
 * Owner: Settings page (this module renders; `server.ts` serves it).
 * Lifetime: request-scoped static shell; selection/catalog state lives in
 * the browser per page open and is re-read from the API on every load, so
 * reopening the page always shows the persisted deployment default.
 * Authority: durable selection via the Settings store through `server.ts`
 * (`GET /api/config` read, `PUT /api/config/devin` save); catalog via
 * request-owned discovery (`/api/catalog`).
 * This shell holds no secrets and performs no config I/O or discovery
 * itself, so it is served without authentication; every API call carries
 * Telegram initData and is verified server-side.
 * Persistence: none — no catalog cache, no stored selection.
 *
 * `escapeHtml` and `filterCatalogFamilies` are the canonical text/search
 * implementations the embedded client script mirrors (it cannot import this
 * module without a bundler). Provider strings reach the DOM only through
 * `textContent`, never parsed markup.
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

/** Render the static Settings shell. No secrets, no provider data. */
export function renderSettingsPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Goblin Settings</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; max-width: 640px; }
#model-search { width: 100%; font-size: 16px; padding: 10px; margin: 12px 0; box-sizing: border-box; }
.family { border-top: 1px solid #8884; padding: 8px 0; }
.variant { display: block; width: 100%; text-align: left; margin: 6px 0; padding: 10px; font-size: 15px; }
.variant[aria-pressed="true"] { outline: 2px solid currentColor; }
.meta { font-size: 13px; opacity: 0.8; }
#save-button { width: 100%; font-size: 17px; padding: 12px; margin-top: 12px; }
#status-error, #catalog-error { color: #b00020; }
#status-saved { color: #1b7f37; }
</style>
</head>
<body>
<h1>Deployment model</h1>
<div id="status-loading" role="status">Loading settings…</div>
<div id="status-error" role="alert" hidden></div>
<div id="catalog-error" role="alert" hidden></div>
<div id="current-selection" class="meta"></div>
<input id="model-search" type="search" placeholder="Search families or exact models…" autocomplete="off">
<div id="family-list"></div>
<button id="save-button" type="button" disabled>Save exact model</button>
<div id="status-saved" role="status" hidden></div>
<script>
"use strict";
const initData = (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData) || "";
const authHeader = { authorization: "tma " + initData };
const listEl = document.getElementById("family-list");
const searchEl = document.getElementById("model-search");
const saveEl = document.getElementById("save-button");
const loadingEl = document.getElementById("status-loading");
const errorEl = document.getElementById("status-error");
const catalogErrorEl = document.getElementById("catalog-error");
const savedEl = document.getElementById("status-saved");
const selectionEl = document.getElementById("current-selection");
let catalog = { families: [] };
let revision = null;
let selectedId = null;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function setText(el, value) {
  el.textContent = value == null ? "" : String(value);
}

function variantMeta(variant) {
  const parts = [];
  if (variant.costSummary) parts.push(variant.costSummary);
  if (variant.costTier) parts.push(variant.costTier);
  if (variant.contextTokens) parts.push(variant.contextTokens + " context");
  if (variant.outputTokens) parts.push(variant.outputTokens + " output");
  if (variant.isNew) parts.push("new");
  if (variant.isBeta) parts.push("beta");
  return parts.join(" · ");
}

function familyMatches(family, q) {
  const hay = [family.label, family.slug, family.id, ...(family.aliases || [])];
  return hay.some((text) => String(text).toLowerCase().includes(q));
}

function filteredFamilies(q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return catalog.families;
  const out = [];
  for (const family of catalog.families) {
    if (familyMatches(family, needle)) {
      out.push(family);
      continue;
    }
    const variants = (family.variants || []).filter(
      (v) => String(v.id).toLowerCase().includes(needle) || String(v.label).toLowerCase().includes(needle),
    );
    if (variants.length > 0) out.push({ ...family, variants });
  }
  return out;
}

function renderList() {
  while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
  for (const family of filteredFamilies(searchEl.value)) {
    const group = document.createElement("section");
    group.className = "family";
    const heading = document.createElement("h2");
    // Provider text reaches the DOM only as text.
    heading.textContent = family.label;
    group.appendChild(heading);
    for (const variant of family.variants || []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "variant";
      button.dataset.modelId = variant.id;
      button.setAttribute("aria-pressed", variant.id === selectedId ? "true" : "false");
      const title = document.createElement("span");
      title.textContent = variant.label + " (" + variant.id + ")";
      button.appendChild(title);
      const meta = document.createElement("span");
      meta.className = "meta";
      setText(meta, variantMeta(variant) || (variant.description || ""));
      meta.setAttribute("title", escapeHtml(variant.description || ""));
      button.appendChild(document.createElement("br"));
      button.appendChild(meta);
      button.addEventListener("click", () => {
        selectedId = variant.id;
        savedEl.hidden = true;
        saveEl.disabled = false;
        renderList();
      });
      group.appendChild(button);
    }
    listEl.appendChild(group);
  }
}

async function load() {
  let configRes;
  try {
    configRes = await fetch("/api/config", { headers: authHeader });
  } catch {
    showError("Could not reach Goblin. Check the private connection and reopen Settings.");
    loadingEl.hidden = true;
    return;
  }
  if (configRes.status === 401) {
    const code = await configRes.json().then((b) => b.error, () => "unauthorized");
    showError(code === "expired"
      ? "Telegram session expired. Close and reopen Settings from Telegram, then save again."
      : "Not authorized. Open Settings from the operator Telegram account.");
    loadingEl.hidden = true;
    return;
  }
  if (!configRes.ok) {
    showError("Settings are unavailable. Nothing was saved.");
    loadingEl.hidden = true;
    return;
  }
  const config = await configRes.json();
  revision = config.revision || null;
  selectedId = (config.devin && config.devin.defaultModel) || null;
  setText(selectionEl, selectedId ? "Saved deployment model: " + selectedId : "No deployment model selected yet.");

  let catalogRes;
  try {
    catalogRes = await fetch("/api/catalog", { headers: authHeader });
  } catch {
    catalogErrorEl.textContent = "Model catalog is unreachable. Saved selection above is unchanged.";
    catalogErrorEl.hidden = false;
    loadingEl.hidden = true;
    return;
  }
  if (!catalogRes.ok) {
    const reason = await catalogRes.json().then((b) => b.error, () => "unavailable");
    catalogErrorEl.textContent = "Model catalog failed (" + reason + "). Saved selection above is unchanged.";
    catalogErrorEl.hidden = false;
    loadingEl.hidden = true;
    return;
  }
  catalog = await catalogRes.json();
  loadingEl.hidden = true;
  renderList();
}

saveEl.addEventListener("click", async () => {
  if (!selectedId) return;
  savedEl.hidden = true;
  errorEl.hidden = true;
  saveEl.disabled = true;
  let res;
  try {
    res = await fetch("/api/config/devin", {
      method: "PUT",
      headers: { ...authHeader, "content-type": "application/json" },
      body: JSON.stringify({ patch: { defaultModel: selectedId }, expectedRevision: revision }),
    });
  } catch {
    showError("Save did not reach Goblin. Nothing was saved.");
    saveEl.disabled = false;
    return;
  }
  if (res.ok) {
    const saved = await res.json();
    revision = saved.revision || revision;
    setText(selectionEl, "Saved deployment model: " + selectedId);
    savedEl.textContent = "Saved " + selectedId + ". It applies to the next run.";
    savedEl.hidden = false;
    saveEl.disabled = false;
    return;
  }
  // Failure never appears as a successful save.
  const code = await res.json().then((b) => b.error, () => "unavailable");
  if (res.status === 401 && code === "expired") {
    showError("Telegram session expired. Close and reopen Settings from Telegram, then save again.");
  } else if (res.status === 409 || code === "conflict") {
    showError("Settings changed elsewhere (conflict). Reload the page to see the current selection, then save again.");
  } else {
    showError("Save failed (" + code + "). Nothing was saved.");
  }
  saveEl.disabled = false;
});

searchEl.addEventListener("input", renderList);
load();
</script>
</body>
</html>`;
}

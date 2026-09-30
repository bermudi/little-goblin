// The settings mini app's client — vanilla JS on purpose: no build step,
// served verbatim by http/mod.ts at /app.js. tsc still checks this file
// (checkJs via tsconfig.client.json); types at the data boundaries come
// from the server's own modules through JSDoc imports, so schema drift
// here is a typecheck failure, not a broken page. The markup+css live in
// app.ts; the ids this file looks up are static there.
//
// Page design rules (don't regress them — see app.ts for the full list):
// machine values are monospace, inputs render at 16px, save lives in the
// fixed bottom bar, and nothing structured is a raw text field.

/// <reference path="./telegram-webapp.d.ts" />

/** The config as the server validates it. */
/** @typedef {import("../config.ts").Config} Config */
/** One provider entry from the config's registry. */
/** @typedef {import("../config.ts").ProviderConfig} ProviderConfig */
/** The GET /api/config envelope — config plus the schema's kind lists. */
/** @typedef {import("./mod.ts").ConfigResponse} ConfigResponse */
/** What POST /api/config accepts from this page ("" clears a block). */
/** @typedef {import("./mod.ts").ConfigPostBody} ConfigPostBody */
/** The GET /api/memory-status shape. */
/** @typedef {import("./mod.ts").MemoryStatusResponse} MemoryStatusResponse */
/** GET /api/memory/documents — one page of retained exchanges. */
/** @typedef {import("./mod.ts").MemoriesListResponse} MemoriesListResponse */
/** One list item — a retained exchange. */
/** @typedef {import("./mod.ts").MemoryDocListItem} MemoryDocListItem */
/** GET /api/memory/documents/<id> — the document plus its facts. */
/** @typedef {import("./mod.ts").MemoryDocDetailResponse} MemoryDocDetailResponse */
/** One extracted fact. */
/** @typedef {import("./mod.ts").MemoryFactItem} MemoryFactItem */

/** One editable search/fetch chain step. */
/** @typedef {{ kind: string, auth: string }} ChainEntry */
/** Auth requirement (and hint) for one chain kind. */
/** @typedef {{ auth: string, note?: string }} KindMeta */
/** A provider card while editing — name changes stay draft until save. */
/**
 * @typedef {object} ProvDraftItem
 * @property {number} id
 * @property {string} name
 * @property {ProviderConfig["kind"]} kind
 * @property {string} baseUrl
 * @property {string} auth
 */
/** TTS block while editing — numeric-ish fields stay strings. */
/** @typedef {{ voice: string, rate: string, voices: string[] }} TtsDraft */
/** @typedef {{ model: string, auth: string }} TrDraft */
/** @typedef {{ baseUrl: string, bankId: string, auth: string, budget: string, tokens: string, timeout: string }} MemDraft */
/**
 * The page's editable mirror of the config. null blocks mean "unset" —
 * saved as "", which the server normalizes to absent.
 * @typedef {object} DraftState
 * @property {string} model
 * @property {string} titleModel
 * @property {string[]} favorites
 * @property {string} thinking
 * @property {TtsDraft | null} tts
 * @property {TrDraft | null} transcription
 * @property {ChainEntry[] | null} search
 * @property {ChainEntry[] | null} fetch
 * @property {number[]} allowedUsers
 * @property {string} publicUrl
 * @property {string} apiRoot
 * @property {string} port
 * @property {string} logLevel
 * @property {MemDraft | null} memory
 */

const tg = window.Telegram ? window.Telegram.WebApp : null;
const initData = (tg && tg.initData) || "";
/**
 * Element by id. Ids are static in the served HTML (app.ts); a miss is
 * a page bug and throws here loudly — never a silent skip.
 * @param {string} id
 * @returns {HTMLElement}
 */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
/**
 * Input/select/button accessors — same static-HTML assertion as $.
 * @param {string} id
 * @returns {HTMLInputElement}
 */
const inputEl = (id) => /** @type {HTMLInputElement} */ ($(id));
/**
 * @param {string} id
 * @returns {HTMLSelectElement}
 */
const selectEl = (id) => /** @type {HTMLSelectElement} */ ($(id));
/**
 * @param {string} id
 * @returns {HTMLButtonElement}
 */
const buttonEl = (id) => /** @type {HTMLButtonElement} */ ($(id));
// The schema's kind lists (single source: config.ts) — arrive with the
// config GET; the controls that read them only exist after load().
/** @type {readonly string[]} */
let KINDS = [];
/** @type {readonly string[]} */
let SEARCH_KINDS = [];
/** @type {readonly string[]} */
let FETCH_KINDS = [];

// The full operator vocabulary — the fallback when the model is unknown,
// and the ordering for nearest-rung clamping (mirrors the server).
const ORDER = ["off", "low", "medium", "high", "xhigh", "max"];

// Auth requirements per chain kind: "required" | "optional" | "none".
/** @type {Record<string, KindMeta>} */
const SEARCH_META = {
  brave: { auth: "required" },
  exa: { auth: "required" },
  jina: { auth: "optional", note: "Works keyless, rate-limited." },
  tavily: { auth: "required" },
  firecrawl: { auth: "required" },
  parallel: { auth: "required" },
  ddg: { auth: "none", note: "Keyless — unofficial endpoint, may rate-limit or break." }
};
/** @type {Record<string, KindMeta>} */
const FETCH_META = {
  local: { auth: "none", note: "Direct download + readability — no key." },
  jina: { auth: "optional", note: "Works keyless, rate-limited." },
  tavily: { auth: "required" },
  firecrawl: { auth: "required" },
  parallel: { auth: "required" }
};

const VOICE_SUGGESTIONS = [
  "en-US-AriaNeural", "en-US-GuyNeural", "en-GB-SoniaNeural", "en-AU-NatashaNeural",
  "es-ES-ElviraNeural", "es-MX-JorgeNeural", "de-DE-KatjaNeural", "fr-FR-DeniseNeural",
  "pt-BR-FranciscaNeural", "it-IT-ElsaNeural", "ru-RU-SvetlanaNeural", "pl-PL-ZofiaNeural",
  "uk-UA-PolinaNeural", "tr-TR-EmelNeural", "ar-EG-SalmaNeural", "hi-IN-SwaraNeural",
  "ja-JP-NanamiNeural", "ko-KR-SunHiNeural", "zh-CN-XiaoxiaoNeural", "nl-NL-ColetteNeural",
  "sv-SE-SofieNeural"
];

// ---------- state ----------
// The empty draft — populate() replaces it wholesale on load, before any
// control that reads it exists. Worst case a pre-load save could say is
// "Pick a default model.", and save stays disabled until a change is
// marked anyway.
/** @type {DraftState} */
const EMPTY_DRAFT = {
  model: "", titleModel: "", favorites: [], thinking: "medium",
  tts: null, transcription: null, search: null, fetch: null,
  allowedUsers: [], publicUrl: "", apiRoot: "", port: "8787", logLevel: "info", memory: null
};
// cfg mirrors the server schema for everything this page manages.
let cfg = EMPTY_DRAFT;
// Opaque server version of the form we loaded. A stale full-form save
// gets a conflict instead of replacing another tab's (or a hand edit's)
// newer settings.
let configTag = "";
/** @type {ProvDraftItem[]} */
let provDraft = [];
let provSeq = 0;
let dirty = false;
let loading = true;
let me = 0;
// Last non-null content of each optional block — flipping a switch off
// must not throw away the operator's chain/fields (display keeps them
// through the toggle; the save simply sends "").
/** @type {TtsDraft | null} */ let lastTts = null;
/** @type {TrDraft | null} */ let lastTranscription = null;
/** @type {MemDraft | null} */ let lastMemory = null;
/** @type {ChainEntry[] | null} */ let lastSearch = null;
/** @type {ChainEntry[] | null} */ let lastFetch = null;
try { me = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.id) || 0; } catch (e) { me = 0; }

/** @param {() => void} f @param {number} ms @returns {() => void} */
const debounce = (f, ms) => {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let t;
  return () => { clearTimeout(t); t = setTimeout(f, ms); };
};
const tap = () => { if (tg && tg.HapticFeedback) tg.HapticFeedback.selectionChanged(); };

/** @param {string} t @param {string} [kind] */
function msg(t, kind) {
  const elStatus = $("status");
  elStatus.textContent = t;
  elStatus.className = kind || "";
}
function updateSave() { buttonEl("save").disabled = !dirty; }
// The back button means: leave. Dirty work asks first; inside a
// settings section it climbs to the index; nowhere else does it show.
function updateBackButton() {
  if (!tg || !tg.BackButton) return;
  const show = dirty || section !== null;
  if (show) { if (tg.BackButton.show) tg.BackButton.show(); }
  else if (tg.BackButton.hide) tg.BackButton.hide();
}
function markDirty() {
  if (loading) return;
  if (!dirty) {
    dirty = true;
    $("dirtyPill").hidden = false;
    msg("Unsaved changes", "dirty");
    if (tg && tg.enableClosingConfirmation) tg.enableClosingConfirmation();
  }
  updateSave();
  updateBackButton();
}
function makeClean() {
  dirty = false;
  $("dirtyPill").hidden = true;
  if (tg && tg.disableClosingConfirmation) tg.disableClosingConfirmation();
  updateSave();
  updateBackButton();
}

/**
 * @param {string} tag
 * @param {string | null} cls
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
/** @param {string} path @param {string} label @param {() => void} onclick @returns {HTMLButtonElement} */
function iconBtn(path, label, onclick) {
  const b = /** @type {HTMLButtonElement} */ (el("button", "ibtn"));
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + "</svg>";
  b.onclick = onclick;
  return b;
}
const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

// ---------- view controller ----------
// Two tabs: settings (an index of section panels — the config lives one
// level deep) and memories (read-only browser). Sections never nest
// deeper; the Telegram back button and the dirty guard share one rule:
// dirty wins, then section-exit, then nothing.
let activeTab = "settings";
/** null = the settings index; otherwise a data-section value.
 * @type {string | null} */
let section = null;
/** @type {NodeListOf<HTMLButtonElement>} */
let tabButtons = document.querySelectorAll("#tabs button");

function renderView() {
  const settingsRoot = activeTab === "settings" && section === null;
  for (const p of document.querySelectorAll(".panel")) {
    const id = p.id;
    let on = false;
    if (id === "panel-settings") on = settingsRoot;
    else if (id === "panel-memories") on = activeTab === "memories";
    else on = activeTab === "settings" && section !== null && id === "panel-" + section;
    p.classList.toggle("on", on);
  }
  for (const b of tabButtons) b.setAttribute("aria-selected", String(b.dataset.tab === activeTab));
  document.body.classList.toggle("memtab", activeTab === "memories");
  setMemoryPolling(activeTab === "memories");
  updateBackButton();
  if (activeTab === "memories") void loadDocs(true);
}

function initTabs() {
  tabButtons = document.querySelectorAll("#tabs button");
  for (const b of tabButtons) {
    b.onclick = () => {
      const t = b.dataset.tab || "settings";
      // Tapping the active settings tab climbs back to its index.
      if (t === activeTab && t === "settings" && section !== null) section = null;
      else { activeTab = t; if (t === "memories") section = null; }
      renderView();
      window.scrollTo(0, 0);
      tap();
    };
  }
}

function initSections() {
  const rows = /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll("#settingsIndex .idx"));
  for (const b of rows) {
    b.onclick = () => {
      section = b.dataset.section || null;
      renderView();
      window.scrollTo(0, 0);
      tap();
    };
  }
}

// ---------- generic controls ----------
/** @param {string} id @param {() => boolean} get @param {(v: boolean) => void} set @param {() => void} [after] */
function bindSwitch(id, get, set, after) {
  const b = $(id);
  const paint = () => b.setAttribute("aria-checked", String(!!get()));
  b.onclick = () => { set(!get()); paint(); markDirty(); tap(); if (after) after(); };
  paint();
}
/** @param {string} boxId @param {string[]} values @param {() => string} get @param {(v: string) => void} set */
function segmented(boxId, values, get, set) {
  const box = $(boxId);
  box.replaceChildren();
  for (const v of values) {
    const b = /** @type {HTMLButtonElement} */ (el("button", null, v));
    b.type = "button";
    b.setAttribute("aria-pressed", String(get() === v));
    b.onclick = () => { set(v); segmented(boxId, values, get, set); markDirty(); tap(); };
    box.append(b);
  }
}
/** @param {string} id @param {(v: string) => void} set */
function bindText(id, set) {
  $(id).addEventListener("input", (e) => { set(/** @type {HTMLInputElement} */ (e.target).value); markDirty(); });
}

// chips editor — element type is string | number (user ids are numeric).
/**
 * @param {{ box: string, input: string, add: string, get: () => Array<string | number>, set: (a: Array<string | number>) => void, numeric?: boolean, datalist?: string, datalistValues?: string[], empty?: string }} opts
 * @returns {() => void}
 */
function initChips(opts) {
  function render() {
    const box = $(opts.box);
    box.replaceChildren();
    const arr = opts.get();
    if (!arr.length) box.append(el("span", "chips-empty", opts.empty || "none yet"));
    arr.forEach((v) => {
      const c = el("span", "chip");
      c.append(el("span", null, String(v)));
      const x = /** @type {HTMLButtonElement} */ (el("button", null, "×"));
      x.type = "button";
      x.setAttribute("aria-label", "remove " + v);
      x.onclick = () => {
        opts.set(arr.filter((a) => a !== v));
        render(); markDirty(); tap();
      };
      c.append(x);
      box.append(c);
    });
  }
  function add() {
    const inp = inputEl(opts.input);
    const raw = inp.value.trim();
    if (!raw) return;
    if (opts.numeric) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) { msg("User ids are positive whole numbers.", "err"); return; }
      if (opts.get().indexOf(n) !== -1) { inp.value = ""; return; }
      opts.set(opts.get().concat([n]));
    } else {
      if (opts.get().indexOf(raw) !== -1) { inp.value = ""; return; }
      opts.set(opts.get().concat([raw]));
    }
    inp.value = "";
    render(); markDirty();
  }
  $(opts.add).onclick = add;
  $(opts.input).addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
  if (opts.datalist && opts.datalistValues) {
    const dl = $(opts.datalist);
    dl.replaceChildren();
    for (const v of opts.datalistValues) dl.append(new Option(v, v));
    $(opts.input).setAttribute("list", opts.datalist);
  }
  render();
  return render;
}

// ---------- model sheet ----------
/** @type {string} */
let sheetMode = "model";
function sheetTarget() { return sheetMode === "title" ? cfg.titleModel : cfg.model; }
/** @param {string} ref */
function pickModel(ref) {
  if (sheetMode === "title") { cfg.titleModel = ref; $("titleVal").textContent = ref || "Off"; }
  else { cfg.model = ref; $("modelVal").textContent = ref; refreshThinking(); }
  markDirty();
  closeSheet();
}
/** @param {string} ref @param {string} label @param {string} current */
function sheetRow(ref, label, current) {
  const b = /** @type {HTMLButtonElement} */ (el("button", "mrow" + (ref === current ? " sel" : "")));
  b.type = "button";
  const span = el("span", ref ? "ref" : "ref off-label", label);
  span.title = ref;
  const check = el("span", "check");
  check.innerHTML = CHECK_SVG; // static constant, not user data
  b.append(span, check);
  b.onclick = () => pickModel(ref);
  return b;
}
/** @param {string} mode */
function openSheet(mode) {
  sheetMode = mode;
  $("sheetTitle").textContent = mode === "title" ? "Topic-title model" : "Default model";
  const body = $("sheetBody");
  body.replaceChildren();
  const current = sheetTarget();
  if (mode === "title") body.append(sheetRow("", "Off", current));
  const favs = cfg.favorites;
  if (favs.length) {
    body.append(el("div", "mgroup", "Favorites"));
    for (const f of favs) body.append(sheetRow(f, f, current));
  }
  if (current && favs.indexOf(current) === -1) {
    body.append(el("div", "mgroup", "Current"));
    body.append(sheetRow(current, current, current));
  }
  const sel = selectEl("sheetProv");
  sel.replaceChildren();
  const names = provDraft.filter((p) => p.name).map((p) => p.name);
  for (const n of names) sel.append(new Option(n, n));
  $("sheetCustom").classList.toggle("hidden", names.length === 0);
  $("veil").classList.add("on");
  $("sheet").classList.add("on");
  $("sheet").focus(); // keyboard entry point — no visible ring on a row
}
function closeSheet() {
  $("veil").classList.remove("on");
  $("sheet").classList.remove("on");
}
function initSheet() {
  $("modelBtn").onclick = () => openSheet("model");
  $("titleBtn").onclick = () => openSheet("title");
  $("sheetClose").onclick = closeSheet;
  $("veil").onclick = () => { closeSheet(); closeDocSheet(); };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeSheet(); closeDocSheet(); } });
  $("sheetUse").onclick = () => {
    const p = selectEl("sheetProv").value;
    const m = inputEl("sheetModel").value.trim();
    if (!p || !m) { msg("Pick a provider and type a model id.", "err"); return; }
    inputEl("sheetModel").value = "";
    pickModel(p + "/" + m);
  };
}

// ---------- thinking (server-owned capability table) ----------
/** @type {string[]} */
let thinkLevels = ORDER;
/** @param {string} name @returns {ProvDraftItem | null} */
function findProvByName(name) {
  for (const p of provDraft) if (p.name === name) return p;
  return null;
}
/** @returns {string | undefined} */
function displayLevel() {
  const idx = ORDER.indexOf(cfg.thinking);
  return thinkLevels.find((l) => ORDER.indexOf(l) >= idx) ?? thinkLevels[thinkLevels.length - 1];
}
function renderThinking() {
  const box = $("thinkingSeg");
  box.replaceChildren();
  const shown = cfg ? displayLevel() : null;
  for (const l of thinkLevels) {
    const b = /** @type {HTMLButtonElement} */ (el("button", null, l));
    b.type = "button";
    b.setAttribute("aria-pressed", String(shown === l));
    b.onclick = () => { cfg.thinking = l; renderThinking(); markDirty(); tap(); };
    box.append(b);
  }
}
let thinkingRequest = 0;
async function refreshThinking() {
  const request = ++thinkingRequest;
  const ref = cfg.model || "";
  const i = ref.indexOf("/");
  const modelId = i > 0 ? ref.slice(i + 1) : "";
  const prov = i > 0 ? findProvByName(ref.slice(0, i)) : null;
  /** @type {string[]} */
  let levels = ORDER;
  if (modelId && prov) {
    // base only matters to the kinds that carry one — a stale value must
    // not travel with a kind switch.
    const base = prov.kind === "openai-compatible" || prov.kind === "responses" ? prov.baseUrl.trim() : "";
    try {
      const res = await fetch(
        "/api/thinking-levels?kind=" + encodeURIComponent(prov.kind) +
          "&model=" + encodeURIComponent(modelId) +
          "&base=" + encodeURIComponent(base),
        { headers: { "x-init-data": initData } }
      );
      if (res.ok) levels = (/** @type {{ levels: string[] }} */ (await res.json())).levels;
    } catch (e) { /* keep the full vocabulary — honest unknown */ }
  }
  // Model switches can finish before an older request: only the latest
  // selection is allowed to repaint the segmented control.
  if (request !== thinkingRequest || ref !== cfg.model) return;
  thinkLevels = levels;
  renderThinking();
}
const refreshThinkingSoon = debounce(refreshThinking, 300);

// ---------- chains (search / fetch) ----------
// prefix: "search" | "fetch" — expects #{prefix}Steps and #{prefix}Add.
/**
 * @param {string} prefix
 * @param {readonly string[]} kinds
 * @param {Record<string, KindMeta>} meta
 * @param {() => ChainEntry[] | null} getArr
 * @param {(a: ChainEntry[]) => void} setArr
 * @returns {() => void}
 */
function initChain(prefix, kinds, meta, getArr, setArr) {
  const steps = $(prefix + "Steps");
  function render() {
    steps.replaceChildren();
    const arr = getArr() || [];
    arr.forEach((entry, i) => steps.append(row(entry, i, arr.length)));
  }
  /** @param {ChainEntry} entry @param {number} i @param {number} len */
  function row(entry, i, len) {
    const m = meta[entry.kind] || { auth: "optional" };
    const card = el("div", "cstep");
    const head = el("div", "chead");
    head.append(el("span", "cnum" + (i === 0 ? " primary" : ""), String(i + 1)));
    head.append(el("span", "crole", i === 0 ? "primary" : "fallback"));
    head.append(el("span", "sp"));
    if (i > 0) head.append(iconBtn("M12 19V5M6 11l6-6 6 6", "move up", () => move(i, -1)));
    if (i < len - 1) head.append(iconBtn("M12 5v14M6 13l6 6 6-6", "move down", () => move(i, 1)));
    head.append(iconBtn("M6 6l12 12M18 6L6 18", "remove step", () => {
      const a = getArr();
      if (!a) return;
      a.splice(i, 1);
      render(); markDirty();
    }));
    const sel = /** @type {HTMLSelectElement} */ (el("select", "mono"));
    for (const k of kinds) sel.append(new Option(k, k));
    sel.value = entry.kind;
    sel.setAttribute("aria-label", "step " + (i + 1) + " provider");
    sel.onchange = () => {
      entry.kind = sel.value;
      entry.auth = ""; // a kind switch must not carry the old kind's secret name
      render(); markDirty();
    };
    card.append(head, sel);
    if (m.auth === "none") {
      card.append(el("div", "cap", m.note || "No key needed."));
    } else {
      const inp = /** @type {HTMLInputElement} */ (el("input", "mono"));
      inp.placeholder = m.auth === "optional" ? "secret name (optional)" : "secret name in auth.jsonl";
      inp.value = entry.auth || "";
      inp.autocomplete = "off"; inp.spellcheck = false; inp.autocapitalize = "off";
      inp.setAttribute("aria-label", "step " + (i + 1) + " secret name");
      inp.oninput = () => { entry.auth = inp.value; markDirty(); };
      card.append(inp);
      if (m.auth === "optional" && m.note) card.append(el("div", "cap", m.note));
    }
    return card;
  }
  /** @param {number} i @param {number} d */
  function move(i, d) {
    const a = getArr();
    if (!a) return;
    const j = i + d;
    const t = a[i];
    const u = a[j];
    if (t !== undefined && u !== undefined) { a[i] = u; a[j] = t; }
    render(); markDirty();
  }
  $(prefix + "Add").onclick = () => {
    const first = kinds[0];
    if (first === undefined) return; // schema lists are never empty
    const a = getArr() || [];
    a.push({ kind: first, auth: "" });
    setArr(a);
    render(); markDirty();
  };
  render();
  return render;
}

// ---------- providers ----------
/** @param {string} name @returns {string[]} */
function providerRefs(name) {
  const refs = [];
  if (cfg.model.indexOf(name + "/") === 0) refs.push("default model");
  if (cfg.titleModel.indexOf(name + "/") === 0) refs.push("topic titles");
  for (const f of cfg.favorites) if (f.indexOf(name + "/") === 0) { refs.push("favorites"); break; }
  return refs;
}
/** @param {ProvDraftItem} p */
function provCard(p) {
  const card = el("div", "prov");
  const head = el("div", "prov-head");
  const name = /** @type {HTMLInputElement} */ (el("input", "pname mono"));
  name.placeholder = "name";
  name.value = p.name;
  name.autocomplete = "off"; name.spellcheck = false; name.autocapitalize = "off";
  name.setAttribute("aria-label", "provider name");
  // Name edits commit on blur — a half-typed name would break model refs.
  name.onchange = () => {
    const v = name.value.trim();
    if (!v) { name.value = p.name; msg("Every provider needs a name.", "err"); return; }
    if (provDraft.some((q) => q !== p && q.name === v)) {
      name.value = p.name;
      msg("Duplicate provider name: " + v, "err");
      return;
    }
    p.name = v; markDirty();
  };
  const rm = /** @type {HTMLButtonElement} */ (el("button", "rm", "Remove"));
  rm.type = "button";
  rm.onclick = () => {
    const refs = p.name ? providerRefs(p.name) : [];
    provDraft = provDraft.filter((q) => q !== p);
    renderProviders(); markDirty();
    if (refs.length) msg("Removed — still referenced by " + refs.join(", ") + ". Fix before saving.", "err");
  };
  head.append(name, rm);

  const kindLabel = el("div", "flabel", "Type");
  const kind = /** @type {HTMLSelectElement} */ (el("select", "mono"));
  for (const k of KINDS) kind.append(new Option(k, k));
  kind.value = p.kind;
  kind.setAttribute("aria-label", "provider type");
  const baseLabel = el("div", "flabel", "Base url");
  const base = /** @type {HTMLInputElement} */ (el("input", "mono"));
  base.placeholder = "https://…";
  base.value = p.baseUrl;
  base.autocomplete = "off"; base.spellcheck = false; base.autocapitalize = "off";
  base.setAttribute("aria-label", "base url");
  base.oninput = () => { p.baseUrl = base.value; markDirty(); refreshThinkingSoon(); };
  const authLabel = el("div", "flabel");
  const auth = /** @type {HTMLInputElement} */ (el("input", "mono"));
  auth.value = p.auth;
  auth.autocomplete = "off"; auth.spellcheck = false; auth.autocapitalize = "off";
  auth.setAttribute("aria-label", "secret name");
  auth.oninput = () => { p.auth = auth.value; markDirty(); };
  function sync() {
    const needsBase = kind.value === "openai-compatible" || kind.value === "responses";
    baseLabel.classList.toggle("hidden", !needsBase);
    base.classList.toggle("hidden", !needsBase);
    // codex auth is the CLI's OAuth file, not an auth.jsonl secret name.
    const codex = kind.value === "codex";
    authLabel.textContent = codex ? "Codex auth file" : "Secret name";
    auth.placeholder = codex ? "~/.codex/auth.json — blank = default" : "in auth.jsonl — not the secret itself";
  }
  // Options come from KINDS — providerKinds off the config GET, pinned
  // to the schema in both directions by config.test.ts — so the string
  // value is always one of the union's literals.
  kind.onchange = () => { p.kind = /** @type {ProvDraftItem["kind"]} */ (kind.value); sync(); markDirty(); refreshThinkingSoon(); };

  const kWrap = el("div", "frow"); kWrap.append(kindLabel, kind);
  const bWrap = el("div", "frow"); bWrap.append(baseLabel, base);
  const aWrap = el("div", "frow"); aWrap.append(authLabel, auth);
  card.append(head, kWrap, bWrap, aWrap);
  sync();
  return card;
}
function renderProviders() {
  const box = $("provs");
  box.replaceChildren();
  for (const p of provDraft) box.append(provCard(p));
}

// ---------- validation + save ----------
/** @returns {string | null} */
function validate() {
  const names = provDraft.map((p) => p.name);
  if (names.some((n) => !n)) return "Every provider needs a name.";
  if (new Set(names).size !== names.length) return "Duplicate provider name.";
  for (const p of provDraft) {
    if (p.kind === "openai-compatible" || p.kind === "responses") {
      if (!p.baseUrl.trim()) return 'Provider "' + p.name + '" needs a base url.';
      if (!p.auth.trim()) return 'Provider "' + p.name + '" needs a secret name.';
    } else if (p.kind === "openrouter" && !p.auth.trim()) {
      return 'Provider "' + p.name + '" needs a secret name.';
    }
  }
  if (!cfg.model) return "Pick a default model.";
  if (cfg.tts && !cfg.tts.voice.trim()) return "Text to speech is on — set a voice.";
  if (cfg.transcription && !cfg.transcription.auth.trim()) return "Transcription is on — set a secret name.";
  if (cfg.search) {
    if (!cfg.search.length) return "Search is on — add at least one provider, or switch it off.";
    for (const [i, e] of cfg.search.entries()) {
      const m = SEARCH_META[e.kind];
      if (m && m.auth === "required" && !e.auth.trim()) {
        return "Search step " + (i + 1) + " (" + e.kind + ") needs a secret name.";
      }
    }
  }
  if (cfg.fetch) {
    if (!cfg.fetch.length) return "The fetch chain is on — add at least one provider, or switch it off.";
    for (const [i, e] of cfg.fetch.entries()) {
      const m = FETCH_META[e.kind];
      if (m && m.auth === "required" && !e.auth.trim()) {
        return "Fetch step " + (i + 1) + " (" + e.kind + ") needs a secret name.";
      }
    }
  }
  if (cfg.memory) {
    if (!cfg.memory.baseUrl.trim()) return "Memory is on — set the hindsight url.";
    if (!cfg.memory.bankId.trim()) return "Memory is on — set a bank id.";
  }
  const port = Number(cfg.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return "Http port must be a number between 0 and 65535.";
  if (cfg.publicUrl.trim() && !cfg.publicUrl.trim().startsWith("https://")) {
    return "Public URL must use HTTPS for Telegram Web Apps.";
  }
  if (me && cfg.allowedUsers.indexOf(me) === -1) {
    return "Your own telegram id (" + me + ") must stay in allowed users.";
  }
  return null;
}
/** The POST /api/config body — checked against the server's wire type.
 * @returns {ConfigPostBody} */
function buildBody() {
  /** @type {Record<string, ProviderConfig>} */
  const providers = {};
  for (const p of provDraft) {
    if (p.kind === "openai-compatible" || p.kind === "responses") {
      providers[p.name] = { kind: p.kind, baseUrl: p.baseUrl.trim(), auth: p.auth.trim() };
    } else if (p.kind === "codex") {
      providers[p.name] = p.auth.trim() ? { kind: p.kind, authFile: p.auth.trim() } : { kind: p.kind };
    } else {
      providers[p.name] = { kind: p.kind, auth: p.auth.trim() };
    }
  }
  /**
   * @param {ChainEntry[] | null} arr
   * @param {Record<string, KindMeta>} meta
   * @returns {Array<{ kind: string, auth?: string }>}
   */
  const chainOut = (arr, meta) => (arr || []).map((e) => {
    const m = meta[e.kind];
    const auth = (e.auth || "").trim();
    if (!auth || (m && m.auth === "none")) return { kind: e.kind };
    return { kind: e.kind, auth: auth };
  });
  /** @param {string} s @returns {number | undefined} */
  const numOrUndef = (s) => (String(s).trim() ? Number(String(s).trim()) : undefined);
  return {
    providers: providers,
    model: cfg.model,
    titleModel: cfg.titleModel, // "" clears — server normalizes
    favorites: cfg.favorites.slice(),
    // The segmented controls only offer schema rungs; the string is one
    // of the union's literals.
    thinking: /** @type {ConfigPostBody["thinking"]} */ (cfg.thinking),
    tts: cfg.tts === null ? "" : {
      kind: "edge",
      voice: cfg.tts.voice.trim(),
      rate: cfg.tts.rate.trim() || undefined,
      voices: cfg.tts.voices.length ? cfg.tts.voices.slice() : undefined
    },
    transcription: cfg.transcription === null ? "" : {
      kind: "groq",
      model: cfg.transcription.model.trim() || "whisper-large-v3-turbo",
      auth: cfg.transcription.auth.trim()
    },
    search: cfg.search === null ? "" : chainOut(cfg.search, SEARCH_META),
    fetch: cfg.fetch === null ? "" : chainOut(cfg.fetch, FETCH_META),
    allowedUsers: cfg.allowedUsers.slice(),
    telegram: { apiRoot: cfg.apiRoot.trim() || undefined },
    publicUrl: cfg.publicUrl.trim(), // "" clears — server normalizes
    http: { port: Number(cfg.port) },
    memory: cfg.memory === null ? "" : {
      baseUrl: cfg.memory.baseUrl.trim(),
      bankId: cfg.memory.bankId.trim(),
      auth: cfg.memory.auth.trim() || undefined,
      budget: /** @type {"low" | "mid" | "high"} */ (cfg.memory.budget),
      maxTokens: numOrUndef(cfg.memory.tokens),
      recallTimeoutMs: numOrUndef(cfg.memory.timeout)
    },
    logLevel: /** @type {ConfigPostBody["logLevel"]} */ (cfg.logLevel)
  };
}
async function save() {
  const err = validate();
  if (err) { msg(err, "err"); return; }
  if (!configTag) { msg("Load settings before saving.", "err"); return; }
  msg("Saving…");
  buttonEl("save").disabled = true;
  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "content-type": "application/json", "x-init-data": initData, "if-match": configTag },
      body: JSON.stringify(buildBody())
    });
    const j = /** @type {{ error?: string }} */ (await res.json().catch(() => ({})));
    if (res.ok) {
      configTag = res.headers.get("etag") || "";
      makeClean();
      msg("Saved", "ok");
      if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
      setTimeout(() => { if (!dirty) msg("All changes saved"); }, 2500);
    } else {
      msg(res.status === 409
        ? "Settings changed elsewhere. Your edits were not saved; reopen settings to load the latest version."
        : "Save failed — " + (j.error || res.status), "err");
      if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("error");
    }
  } catch (e) {
    msg("Save failed — " + e, "err");
  }
  updateSave();
}

// ---------- memory status ----------
// Read-only projection of the same sources /memory reads; retry and
// dismiss stay in Telegram. Fetched on tab activation, then every 10s
// while the memory tab is the visible one — polling stops when it
// isn't.
const MEM_POLL_MS = 10000;
/** @type {ReturnType<typeof setInterval> | null} */
let memTimer = null;
let memInFlight = false;
// Same-origin, HMAC-gated answer from the same process that serves this
// page — not a zod boundary in the repo's sense. Defensive shape check
// in the populate() (/api/config) idiom (review ruling 2026-09-25): every
// field read is guarded, anything unexpected renders as unavailable
// instead of throwing mid-render.
/**
 * Same-origin, HMAC-gated answer from the same process that serves this
 * page — the JSDoc type below is the compile-time half; this is the
 * runtime half (review ruling 2026-09-25): every field read is guarded,
 * anything unexpected renders as unavailable instead of throwing
 * mid-render.
 * @param {unknown} s
 * @returns {MemoryStatusResponse | null}
 */
function checkMemoryStatus(s) {
  if (s === null || typeof s !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (s);
  /** @param {unknown} v @returns {v is number} */
  const int = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0;
  const completed = o.completed, blocked = o.blocked, dismissed = o.dismissed, queued = o.queued;
  if (typeof o.state !== "string") return null;
  const state = /** @type {MemoryStatusResponse["state"]} */ (o.state);
  if (!["disabled", "healthy", "pending", "degraded"].includes(state)) return null;
  if (typeof o.detail !== "string") return null;
  if (!int(completed) || !int(blocked) || !int(dismissed) || !int(queued)) return null;
  if (!(o.lastRecallAt === null || typeof o.lastRecallAt === "string")) return null;
  if (!(o.lastRecallOk === null || typeof o.lastRecallOk === "boolean")) return null;
  if (!Array.isArray(o.blockedDetail)) return null;
  /** @type {MemoryStatusResponse["blockedDetail"]} */
  const blockedDetail = [];
  for (const b of o.blockedDetail) {
    if (b === null || typeof b !== "object") return null;
    const d = /** @type {Record<string, unknown>} */ (b);
    if (typeof d.document !== "string") return null;
    if (!(d.error === null || typeof d.error === "string")) return null;
    if (!int(d.attempts)) return null;
    blockedDetail.push({ document: d.document, error: d.error, attempts: d.attempts });
  }
  return {
    state: state,
    detail: o.detail,
    completed: completed,
    blocked: blocked,
    dismissed: dismissed,
    queued: queued,
    lastRecallAt: o.lastRecallAt,
    lastRecallOk: o.lastRecallOk,
    topicNote: null,
    blockedDetail: blockedDetail
  };
}
// Local wall clock, like /memory — read by the operator on this box.
/** @param {string} iso */
function hm(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "never";
  /** @param {number} n */
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes());
}
/** @param {MemoryStatusResponse["state"]} state */
function memStateWord(state) {
  return el("span", "mono" + (state === "degraded" ? " st-err" : state === "healthy" ? " st-ok" : ""), state);
}
/** @param {MemoryStatusResponse} why */
function memHead(why) {
  const row = el("div", "row");
  const stack = el("div", "rstack");
  const label = el("div", "rlabel");
  label.append("status: ", memStateWord(why.state));
  stack.append(label, el("div", "cap", why.detail));
  row.append(stack);
  return row;
}
/** @param {MemoryStatusResponse} s */
function renderMemoryStatus(s) {
  const card = $("memStatusCard");
  card.replaceChildren();
  card.append(memHead(s));
  const meta = el("div", "row col");
  const mstack = el("div", "rstack");
  mstack.append(
    el("div", "cap", "queue: " + s.queued + " queued · " + s.completed + " retained" +
      (s.dismissed > 0 ? " · " + s.dismissed + " dismissed (kept for audit)" : "")),
    el("div", "cap", s.lastRecallAt === null
      ? "last recall: never"
      : "last recall: " + hm(s.lastRecallAt) + " (" + (s.lastRecallOk === false ? "failed" : "ok") + ")")
  );
  meta.append(mstack);
  card.append(meta);
  if (s.blocked > 0) {
    for (const b of s.blockedDetail) {
      const row = el("div", "row");
      const st = el("div", "rstack");
      const doc = b.document.length > 32 ? b.document.slice(0, 32) + "…" : b.document;
      const err = b.error || "unknown error";
      st.append(
        el("div", "rlabel mono", doc),
        el("div", "cap", b.attempts + " attempt" + (b.attempts === 1 ? "" : "s") + ": " +
          (err.length > 80 ? err.slice(0, 80) + "…" : err))
      );
      row.append(st);
      card.append(row);
    }
    const hint = el("div", "row");
    const hstack = el("div", "rstack");
    const cap = el("div", "cap");
    cap.append("actions: ", el("span", "mono", "/memory retry"), " · ", el("span", "mono", "/memory dismiss"));
    hstack.append(cap);
    hint.append(hstack);
    card.append(hint);
  }
}
/** @param {string} why */
function renderMemoryUnavailable(why) {
  const card = $("memStatusCard");
  card.replaceChildren();
  const row = el("div", "row");
  const stack = el("div", "rstack");
  const label = el("div", "rlabel");
  label.append("status: ", el("span", "mono", "unavailable"));
  stack.append(label, el("div", "cap", why));
  row.append(stack);
  card.append(row);
}
async function refreshMemoryStatus() {
  if (memInFlight) return;
  memInFlight = true;
  try {
    const res = await fetch("/api/memory-status", { headers: { "x-init-data": initData } });
    if (!res.ok) { renderMemoryUnavailable("status endpoint answered " + res.status); return; }
    const raw = await res.json();
    // Defensive shape check — see checkMemoryStatus for why this is
    // hand-rolled rather than zod.
    const checked = checkMemoryStatus(raw);
    if (checked === null) { renderMemoryUnavailable("status data failed validation — not rendered"); return; }
    renderMemoryStatus(checked);
  } catch (e) {
    renderMemoryUnavailable("could not reach goblin — " + e);
  } finally {
    memInFlight = false;
  }
}
/** @param {boolean} on */
function setMemoryPolling(on) {
  if (on) {
    refreshMemoryStatus();
    if (memTimer === null) memTimer = setInterval(refreshMemoryStatus, MEM_POLL_MS);
  } else if (memTimer !== null) {
    clearInterval(memTimer);
    memTimer = null;
  }
}

// ---------- memories browser ----------
// Read-only browsing over the same Hindsight bank recall reads, through
// goblin's own endpoints (the service never faces this page). The
// forget button is the one mutation, guarded by a Telegram confirm —
// the same go-ahead /forget delete asks for in chat, running the same
// protocol (memory-forget.ts).
const DOC_PAGE = 25;
let docOffset = 0;
let docTotal = 0;
let docsInFlight = false;
/** The document the detail sheet is currently showing (null = closed).
 * @type {string | null} */
let openDocId = null;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** @param {number} n */
const pad2 = (n) => String(n).padStart(2, "0");
/** Local wall clock, like /memory — read by the operator on this box.
 * @param {string | null} iso
 * @returns {string} */
function fmtDateTime(iso) {
  if (!iso) return "unknown date";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "unknown date";
  return MONTHS[d.getMonth()] + " " + d.getDate() + ", " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

/** @param {string} why */
function renderBrowserUnavailable(why) {
  $("memBrowser").hidden = true;
  const hint = $("memBrowserHint");
  hint.hidden = false;
  hint.textContent = why;
}

/** @param {MemoryDocListItem} d @returns {HTMLButtonElement} */
function docRow(d) {
  const row = /** @type {HTMLButtonElement} */ (el("button", "docrow"));
  row.type = "button";
  const stack = el("div", "dstack");
  const facts = d.factCount === 1 ? "1 fact" : d.factCount + " facts";
  stack.append(el("div", "d1", fmtDateTime(d.createdAt) + " · " + facts));
  stack.append(el("div", "d2", d.conversationId || d.id));
  const chev = el("span", "dchev");
  chev.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>'; // static markup
  row.append(stack, chev);
  row.onclick = () => { void openDoc(d.id, d.conversationId); };
  return row;
}

/** @param {boolean} reset */
async function loadDocs(reset) {
  if (docsInFlight) return;
  docsInFlight = true;
  const q = inputEl("docSearch").value.trim();
  const offset = reset ? 0 : docOffset;
  try {
    const params = new URLSearchParams({ limit: String(DOC_PAGE), offset: String(offset) });
    if (q) params.set("q", q);
    const res = await fetch("/api/memory/documents?" + params, { headers: { "x-init-data": initData } });
    if (res.status === 503) {
      const j = /** @type {{ error?: string }} */ (await res.json().catch(() => ({})));
      renderBrowserUnavailable(j.error || "memory is not configured");
      return;
    }
    if (!res.ok) { renderBrowserUnavailable("could not load memories — the service answered " + res.status); return; }
    const page = /** @type {MemoriesListResponse} */ (await res.json());
    docOffset = offset + page.items.length;
    docTotal = page.total;
    if (reset) $("docList").replaceChildren();
    for (const d of page.items) $("docList").append(docRow(d));
    const have = $("docList").childElementCount;
    $("docMore").hidden = have >= docTotal;
    $("docCount").textContent = docTotal === 0
      ? (q ? "nothing matches that filter" : "nothing retained yet")
      : "showing " + have + " of " + docTotal + " retained exchanges";
    $("memBrowser").hidden = false;
    $("memBrowserHint").hidden = true;
  } catch (e) {
    renderBrowserUnavailable("could not reach goblin — " + e);
  } finally {
    docsInFlight = false;
  }
}
const loadDocsSoon = debounce(() => { void loadDocs(true); }, 300);

/** @param {MemoryFactItem} f @returns {HTMLElement} */
function factBlock(f) {
  const invalid = f.state !== null && f.state !== "valid";
  const box = el("div", "fact" + (invalid ? " dim" : ""));
  box.append(el("div", "ftext", f.text));
  const bits = [];
  if (f.factType) bits.push(f.factType);
  const when = f.occurredStart || f.occurredEnd || f.mentionedAt;
  if (when) bits.push(fmtDateTime(when));
  if (invalid) bits.push(f.state || "invalidated");
  box.append(el("div", "fcap", bits.join(" · ")));
  return box;
}

/** @param {string} id @param {string | null} conversationId */
async function openDoc(id, conversationId) {
  openDocId = id;
  $("docSheetTitle").textContent = "Exchange";
  $("docFacts").replaceChildren(el("div", "cap", "Loading…"));
  $("docText").textContent = "";
  const wrap = /** @type {HTMLDetailsElement} */ ($("docTextWrap"));
  wrap.open = false;
  wrap.hidden = true;
  buttonEl("docForget").disabled = false;
  openDocSheet();
  let res;
  try {
    res = await fetch("/api/memory/documents/" + encodeURIComponent(id), { headers: { "x-init-data": initData } });
  } catch (e) {
    if (openDocId === id) $("docFacts").replaceChildren(el("div", "cap", "could not reach goblin — " + e));
    return;
  }
  if (openDocId !== id) return; // the sheet moved on mid-flight
  const j = /** @type {MemoryDocDetailResponse & { error?: string }} */ (await res.json().catch(() => ({})));
  if (!res.ok) {
    $("docFacts").replaceChildren(el("div", "cap", j.error || "could not load — the service answered " + res.status));
    return;
  }
  $("docSheetTitle").textContent = fmtDateTime(j.document.createdAt) +
    (conversationId ? " · " + conversationId : "");
  const factsBox = $("docFacts");
  factsBox.replaceChildren();
  if (j.facts.length === 0) factsBox.append(el("div", "cap", "No facts were extracted from this exchange."));
  for (const f of j.facts) factsBox.append(factBlock(f));
  if (j.factsTotal > j.facts.length) {
    factsBox.append(el("div", "cap", "+" + (j.factsTotal - j.facts.length) + " more — beyond this page"));
  }
  const text = j.originalText || "";
  if (text) {
    $("docText").textContent = text.length > 16000
      ? text.slice(0, 16000) + "…\n[truncated — the full text is on the server]"
      : text;
    wrap.hidden = false;
  }
}

function openDocSheet() {
  $("veil").classList.add("on");
  $("docSheet").classList.add("on");
  $("docSheet").focus();
}
function closeDocSheet() {
  if (!$('docSheet').classList.contains("on")) return;
  $("veil").classList.remove("on");
  $("docSheet").classList.remove("on");
  openDocId = null;
}

function initDocBrowser() {
  $("docSearch").addEventListener("input", loadDocsSoon);
  $("docMore").onclick = () => { void loadDocs(false); };
  $("docSheetClose").onclick = closeDocSheet;
  $("docForget").onclick = () => {
    const id = openDocId;
    if (!id) return;
    const doForget = async () => {
      buttonEl("docForget").disabled = true;
      try {
        const res = await fetch("/api/memory/documents/" + encodeURIComponent(id), {
          method: "DELETE",
          headers: { "x-init-data": initData },
        });
        const j = /** @type {{ ok?: boolean, cancelled?: number, redacted?: number, error?: string }} */ (await res.json().catch(() => ({})));
        if (res.ok) {
          closeDocSheet();
          if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
          msg("Forgotten — " + (j.cancelled ?? 0) + " queued cancelled, " + (j.redacted ?? 0) + " snapshots redacted", "ok");
          void loadDocs(true);
          refreshMemoryStatus();
        } else {
          buttonEl("docForget").disabled = res.status !== 409; // busy: allow retry
          msg(j.error || "forget failed — the service answered " + res.status, "err");
          if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("error");
        }
      } catch (e) {
        buttonEl("docForget").disabled = false;
        msg("forget failed — " + e, "err");
      }
    };
    // The go-ahead: the same confirmation /forget delete asks for in
    // chat, native to the client.
    if (tg && tg.showConfirm) {
      tg.showConfirm("Forget this exchange? Its facts stop being recalled. This cannot be undone.", (ok) => { if (ok) void doForget(); });
    } else {
      void doForget();
    }
  };
}

// ---------- load + populate ----------
/** @param {Config} c */
function populate(c) {
  cfg = {
    model: c.model || "",
    titleModel: c.titleModel || "",
    favorites: (c.favorites || []).slice(),
    thinking: c.thinking || "medium",
    tts: c.tts ? { voice: c.tts.voice || "", rate: c.tts.rate || "", voices: (c.tts.voices || []).slice() } : null,
    transcription: c.transcription ? { model: c.transcription.model || "", auth: c.transcription.auth || "" } : null,
    // The config's chain-entry arms differ (some keyless) — widen once;
    // absent fields read as undefined either way.
    search: Array.isArray(c.search)
      ? c.search.map((e) => {
          const w = /** @type {{ kind: string, auth?: string }} */ (e);
          return { kind: w.kind, auth: w.auth || "" };
        })
      : null,
    fetch: Array.isArray(c.fetch)
      ? c.fetch.map((e) => {
          const w = /** @type {{ kind: string, auth?: string }} */ (e);
          return { kind: w.kind, auth: w.auth || "" };
        })
      : null,
    allowedUsers: (c.allowedUsers || []).slice(),
    publicUrl: c.publicUrl || "",
    apiRoot: (c.telegram && c.telegram.apiRoot) || "",
    port: c.http && c.http.port !== undefined ? String(c.http.port) : "8787",
    logLevel: c.logLevel || "info",
    memory: c.memory ? {
      baseUrl: c.memory.baseUrl || "",
      bankId: c.memory.bankId || "",
      auth: c.memory.auth || "",
      budget: c.memory.budget || "low",
      tokens: c.memory.maxTokens !== undefined ? String(c.memory.maxTokens) : "",
      timeout: c.memory.recallTimeoutMs !== undefined ? String(c.memory.recallTimeoutMs) : ""
    } : null
  };
  provSeq = 0;
  provDraft = Object.entries(c.providers || {}).map(([name, p]) => {
    // Union arms differ (openrouter has no baseUrl, codex uses authFile);
    // widen once — absent fields read as undefined either way.
    const w = /** @type {{ kind: ProvDraftItem["kind"], baseUrl?: string, auth?: string, authFile?: string }} */ (p);
    return { id: ++provSeq, name: name, kind: w.kind, baseUrl: w.baseUrl || "", auth: w.auth || w.authFile || "" };
  });

  // Chat
  $("modelVal").textContent = cfg.model;
  $("titleVal").textContent = cfg.titleModel || "Off";
  // Voice — toggles keep the block's last content (lastTts etc.) so
  // flipping off is never "delete my work"; paint* re-syncs the controls
  // with the draft state on every toggle.
  const paintVoices = initChips({ box: "voiceChips", input: "voiceInput", add: "voiceAdd", datalist: "voiceDl", datalistValues: VOICE_SUGGESTIONS, get: () => cfg.tts ? cfg.tts.voices : [], set: (a) => { /** @type {TtsDraft} */ (cfg.tts).voices = /** @type {string[]} */ (a); }, empty: "no alternates — every language speaks with the default voice" });
  function paintTts() {
    $("ttsFields").classList.toggle("hidden", cfg.tts === null);
    inputEl("ttsVoice").value = cfg.tts ? cfg.tts.voice : "";
    inputEl("ttsRate").value = cfg.tts ? cfg.tts.rate : "";
    paintVoices();
  }
  bindSwitch("ttsOn",
    () => cfg.tts !== null,
    (v) => {
      if (v) cfg.tts = lastTts || { voice: "", rate: "", voices: [] };
      else { lastTts = cfg.tts; cfg.tts = null; }
    },
    paintTts);
  paintTts();
  // Field bindings below assert their block is non-null: every input is
  // hidden with its block, so the setter can only fire while it exists.
  bindText("ttsVoice", (v) => { /** @type {TtsDraft} */ (cfg.tts).voice = v; });
  bindText("ttsRate", (v) => { /** @type {TtsDraft} */ (cfg.tts).rate = v; });

  function paintTranscription() {
    $("trFields").classList.toggle("hidden", cfg.transcription === null);
    inputEl("trModel").value = cfg.transcription ? cfg.transcription.model : "";
    inputEl("trAuth").value = cfg.transcription ? cfg.transcription.auth : "";
  }
  bindSwitch("trOn",
    () => cfg.transcription !== null,
    (v) => {
      if (v) cfg.transcription = lastTranscription || { model: "", auth: "" };
      else { lastTranscription = cfg.transcription; cfg.transcription = null; }
    },
    paintTranscription);
  paintTranscription();
  bindText("trModel", (v) => { /** @type {TrDraft} */ (cfg.transcription).model = v; });
  bindText("trAuth", (v) => { /** @type {TrDraft} */ (cfg.transcription).auth = v; });

  // Web
  const paintSearchChain = initChain("search", SEARCH_KINDS, SEARCH_META, () => cfg.search, (a) => cfg.search = a);
  function paintSearch() {
    $("searchChain").classList.toggle("hidden", cfg.search === null);
    paintSearchChain();
  }
  bindSwitch("searchOn",
    () => cfg.search !== null,
    (v) => {
      if (v) cfg.search = lastSearch || [];
      else { lastSearch = cfg.search; cfg.search = null; }
    },
    paintSearch);
  paintSearch();
  const paintFetchChain = initChain("fetch", FETCH_KINDS, FETCH_META, () => cfg.fetch, (a) => cfg.fetch = a);
  function paintFetch() {
    $("fetchChain").classList.toggle("hidden", cfg.fetch === null);
    paintFetchChain();
  }
  bindSwitch("fetchOn",
    () => cfg.fetch !== null,
    (v) => {
      if (v) cfg.fetch = lastFetch || [];
      else { lastFetch = cfg.fetch; cfg.fetch = null; }
    },
    paintFetch);
  paintFetch();

  // Memory
  function paintMemory() {
    $("memFields").classList.toggle("hidden", cfg.memory === null);
    inputEl("memBase").value = cfg.memory ? cfg.memory.baseUrl : "";
    inputEl("memBank").value = cfg.memory ? cfg.memory.bankId : "";
    inputEl("memAuth").value = cfg.memory ? cfg.memory.auth : "";
    inputEl("memTokens").value = cfg.memory ? cfg.memory.tokens : "";
    inputEl("memTimeout").value = cfg.memory ? cfg.memory.timeout : "";
    if (cfg.memory) segmented("memBudget", ["low", "mid", "high"], () => /** @type {MemDraft} */ (cfg.memory).budget, (v) => { /** @type {MemDraft} */ (cfg.memory).budget = v; });
  }
  bindSwitch("memOn",
    () => cfg.memory !== null,
    (v) => {
      if (v) cfg.memory = lastMemory || { baseUrl: "", bankId: "", auth: "", budget: "low", tokens: "", timeout: "" };
      else { lastMemory = cfg.memory; cfg.memory = null; }
    },
    paintMemory);
  paintMemory();
  bindText("memBase", (v) => { /** @type {MemDraft} */ (cfg.memory).baseUrl = v; });
  bindText("memBank", (v) => { /** @type {MemDraft} */ (cfg.memory).bankId = v; });
  bindText("memAuth", (v) => { /** @type {MemDraft} */ (cfg.memory).auth = v; });
  bindText("memTokens", (v) => { /** @type {MemDraft} */ (cfg.memory).tokens = v; });
  bindText("memTimeout", (v) => { /** @type {MemDraft} */ (cfg.memory).timeout = v; });

  // Access
  initChips({ box: "userChips", input: "userInput", add: "userAdd", numeric: true, get: () => cfg.allowedUsers, set: (a) => cfg.allowedUsers = /** @type {number[]} */ (a), empty: "nobody — add your telegram user id" });
  bindText("publicUrl", (v) => cfg.publicUrl = v);
  bindText("apiRoot", (v) => cfg.apiRoot = v);
  bindText("httpPort", (v) => cfg.port = v);
  inputEl("publicUrl").value = cfg.publicUrl;
  inputEl("apiRoot").value = cfg.apiRoot;
  inputEl("httpPort").value = cfg.port;
  segmented("logSeg", ["debug", "info", "warn", "error"], () => cfg.logLevel, (v) => cfg.logLevel = v);

  // Providers + thinking
  renderProviders();
  $("addProv").onclick = () => {
    const first = KINDS[0];
    if (first === undefined) return; // schema list is never empty
    provDraft.push({ id: ++provSeq, name: "", kind: /** @type {ProvDraftItem["kind"]} */ (first), baseUrl: "", auth: "" });
    renderProviders(); markDirty();
    /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("#provs .prov:last-child .pname")).item(0)?.focus();
  };
  initChips({ box: "favChips", input: "favInput", add: "favAdd", get: () => cfg.favorites, set: (a) => cfg.favorites = /** @type {string[]} */ (a), empty: "no favorites — add refs you switch between" });
  refreshThinking();
}

async function load() {
  try {
    const res = await fetch("/api/config", { headers: { "x-init-data": initData } });
    if (!res.ok) { msg("Load failed — " + res.status, "err"); return; }
    configTag = res.headers.get("etag") || "";
    const r = /** @type {ConfigResponse} */ (await res.json());
    KINDS = r.providerKinds;
    SEARCH_KINDS = r.searchKinds;
    FETCH_KINDS = r.fetchKinds;
    populate(r.config);
    loading = false;
    msg("All changes saved");
    updateSave();
  } catch (e) {
    msg("Load failed — " + e, "err");
  }
}

// ---------- boot ----------
initTabs();
initSections();
initSheet();
initDocBrowser();
renderView();
$("save").onclick = save;
if (tg) {
  if (tg.expand) tg.expand();
  try { if (tg.setHeaderColor) tg.setHeaderColor("bg_color"); } catch (e) {}
  try { if (tg.setBackgroundColor) tg.setBackgroundColor("bg_color"); } catch (e) {}
  if (tg.BackButton && tg.BackButton.onClick) {
    tg.BackButton.onClick(() => {
      // Dirty work asks before being discarded; an open settings
      // section climbs to the index; both never apply at once (dirty
      // wins — leaving with unsaved work is the dangerous exit).
      if (dirty) {
        if (tg.showConfirm) tg.showConfirm("Discard unsaved changes?", (ok) => { if (ok) window.location.reload(); });
        return;
      }
      if (section !== null) {
        section = null;
        renderView();
      }
    });
  }
}
// The loading state is already in the DOM; let Telegram reveal it now
// rather than leaving the Web App waiting for an uncalled ready().
if (tg && tg.ready) tg.ready();
if (!initData) {
  loading = false;
  msg("Open from the Telegram menu button — settings need Telegram's proof of identity.", "err");
} else {
  load();
}

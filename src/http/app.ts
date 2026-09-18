// The settings mini app. One page, no build step: friendly inputs for
// every knob — providers are per-card fields, not a JSON blob — with
// server-side zod validation on save.
//
// Design rules this page follows (don't regress them):
// - Color comes only from Telegram's --tg-theme-* vars, so the page reads
//   as native in both light and dark; fallbacks mirror Telegram dark.
// - Machine values (model refs, urls, ids, secret names) are monospace;
//   human labels are the system sans. The split carries the meaning.
// - Inputs render at 16px — smaller and iOS zoom-jumps on focus.
// - Save lives in a fixed bottom bar with inline status; never strand it
//   below the fold.

export const APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>goblin settings</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  :root {
    color-scheme: light dark;
    --bg: var(--tg-theme-bg-color, #212121);
    --bg2: var(--tg-theme-secondary-bg-color, #181818);
    --text: var(--tg-theme-text-color, #ffffff);
    --hint: var(--tg-theme-hint-color, #aaaaaa);
    --link: var(--tg-theme-link-color, #62bcf9);
    --btn: var(--tg-theme-button-color, #40a7e3);
    --btn-text: var(--tg-theme-button-text-color, #ffffff);
    --sep: var(--tg-theme-separator-color, #303030);
    --err: var(--tg-theme-destructive-text-color, #e8574e);
    --ok: #57ab5a;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    font: 15px/1.45 system-ui, -apple-system, sans-serif;
    margin: 0; padding: 0 0 108px;
    background: var(--bg); color: var(--text);
  }
  .wrap { max-width: 560px; margin: 0 auto; padding: 0 16px; }

  header { padding: 20px 0 2px; display: flex; align-items: baseline; gap: 10px; }
  header .mark { font-family: var(--mono); font-size: 17px; font-weight: 700; letter-spacing: -0.02em; }
  header .what { color: var(--hint); font-size: 15px; }

  section { margin-top: 26px; padding-top: 18px; border-top: 1px solid var(--sep); }
  #providers { margin-top: 0; }
  section > h2 {
    font-size: 13px; font-weight: 550; color: var(--hint);
    margin: 0 0 4px;
  }
  section:first-of-type { border-top: 0; }

  label {
    display: block; margin: 14px 0 5px;
    font-size: 13px; color: var(--hint);
  }
  input, select {
    width: 100%; padding: 10px 12px;
    font: 16px/1.3 inherit; color: var(--text);
    background: var(--bg2);
    border: 1px solid var(--sep); border-radius: 10px;
    appearance: none; -webkit-appearance: none;
  }
  select {
    background-image: linear-gradient(45deg, transparent 50%, var(--hint) 50%),
                      linear-gradient(135deg, var(--hint) 50%, transparent 50%);
    background-position: calc(100% - 18px) 55%, calc(100% - 13px) 55%;
    background-size: 5px 5px;
    background-repeat: no-repeat;
    padding-right: 34px;
  }
  input:focus-visible, select:focus-visible, button:focus-visible {
    outline: none; border-color: var(--link);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--link) 25%, transparent);
  }
  input::placeholder { color: var(--hint); opacity: .6; }
  .mono { font-family: var(--mono); font-size: 15px; }

  /* providers */
  .prov {
    background: var(--bg2); border-radius: 12px;
    padding: 4px 12px 12px; margin: 12px 0;
  }
  .prov-head { display: flex; align-items: center; gap: 4px; margin: 0 -4px; }
  .pname {
    flex: 1; font-weight: 600;
    background: transparent; border-color: transparent;
  }
  .pname:focus-visible { border-color: transparent; box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--link) 45%, transparent); background: transparent; }
  .pdel {
    width: auto; margin: 4px 0; padding: 7px 10px;
    background: transparent; border: 0; border-radius: 8px;
    font: 500 13px system-ui; color: var(--err); cursor: pointer;
  }
  .pdel:hover { background: color-mix(in srgb, var(--err) 12%, transparent); }
  .micro { font-size: 12px; color: var(--hint); margin: 10px 2px 3px; }
  .prov input, .prov select { margin: 0; }
  #addProv {
    width: 100%; margin-top: 4px; padding: 12px;
    background: transparent; border: 1px dashed var(--sep); border-radius: 12px;
    font: 600 15px system-ui; color: var(--link); cursor: pointer;
  }
  #addProv:hover { border-color: var(--link); }
  .hidden { display: none; }

  /* bottom command bar */
  #bar {
    position: fixed; left: 0; right: 0; bottom: 0;
    background: color-mix(in srgb, var(--bg) 82%, transparent);
    -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
    border-top: 1px solid var(--sep);
    padding: 10px 16px calc(10px + env(safe-area-inset-bottom));
  }
  #bar .wrap { display: flex; align-items: center; gap: 14px; }
  #msg { flex: 1; font-size: 13px; min-height: 1.2em; white-space: pre-wrap; }
  #msg.ok { color: var(--ok); } #msg.err { color: var(--err); }
  #msg:not(.ok):not(.err) { color: var(--hint); }
  #save {
    width: auto; margin: 0; padding: 12px 30px;
    border: 0; border-radius: 12px;
    font: 600 16px system-ui; cursor: pointer;
    background: var(--btn); color: var(--btn-text);
  }
  #save:active { transform: scale(.97); }
</style>
</head>
<body>
  <div class="wrap">
    <header><span class="mark">goblin</span><span class="what">settings</span></header>

    <section>
      <h2>Model</h2>
      <label for="model">model</label>
      <input id="model" class="mono" list="modelRefs" placeholder="provider/model-id" autocomplete="off" spellcheck="false" autocapitalize="off">
      <label for="titleModel">title model (auto-titles new topics, blank = off)</label>
      <input id="titleModel" class="mono" list="modelRefs" placeholder="provider/model-id" autocomplete="off" spellcheck="false" autocapitalize="off">
      <datalist id="modelRefs"></datalist>
      <label for="favorites">favorites</label>
      <input id="favorites" class="mono" placeholder="comma-separated" autocomplete="off" spellcheck="false" autocapitalize="off">
      <label for="thinking">thinking</label>
      <select id="thinking"><option>off</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option><option>max</option></select>
    </section>

    <section>
      <h2>Access</h2>
      <label for="allowedUsers">allowed telegram user ids</label>
      <input id="allowedUsers" class="mono" placeholder="comma-separated" inputmode="numeric" autocomplete="off" spellcheck="false">
    </section>

    <section>
      <h2>Telegram</h2>
      <label for="publicUrl">public url (menu-button door)</label>
      <input id="publicUrl" class="mono" placeholder="https://…" autocomplete="off" spellcheck="false" autocapitalize="off">
      <label for="apiRoot">telegram api root (self-hosted bot-api, blank = cloud)</label>
      <input id="apiRoot" class="mono" placeholder="http://127.0.0.1:8081" autocomplete="off" spellcheck="false" autocapitalize="off">
    </section>

    <section id="providers">
      <h2>Providers</h2>
      <div id="provs"></div>
      <button id="addProv" type="button">+ add provider</button>
    </section>

    <section>
      <h2>Diagnostics</h2>
      <label for="logLevel">log level</label>
      <select id="logLevel"><option>debug</option><option>info</option><option>warn</option><option>error</option></select>
    </section>
  </div>

  <div id="bar"><div class="wrap">
    <div id="msg"></div>
    <button id="save">Save</button>
  </div></div>

<script>
const initData = window.Telegram?.WebApp?.initData ?? "";
const $ = (id) => document.getElementById(id);
// ok === undefined → neutral hint (e.g. the not-opened-from-Telegram notice);
// true/false → success/failure of an explicit action.
const msg = (t, ok) => { const el = $("msg"); el.textContent = t; el.className = ok === undefined ? "" : ok ? "ok" : "err"; };

const KINDS = ["openai-compatible", "openrouter", "codex"];

const debounce = (f, ms) => { let t; return () => { clearTimeout(t); t = setTimeout(f, ms); }; };

// Thinking levels are model-shaped: the server owns the capability table
// (/api/thinking-levels), this select just renders what comes back.
// ORDER is the full vocabulary — the fallback when the kind is unknown
// and the ordering for nearest-rung substitution.
const ORDER = ["off", "low", "medium", "high", "xhigh", "max"];

function providerCardFor(ref) {
  const name = ref.split("/")[0];
  for (const div of $("provs").children)
    if (div.querySelector(".pname").value.trim() === name) return div;
  return null;
}

async function refreshThinking() {
  const sel = $("thinking");
  const ref = $("model").value.trim();
  const i = ref.indexOf("/");
  const modelId = i > 0 ? ref.slice(i + 1) : "";
  let levels = ORDER;
  if (modelId) {
    const card = providerCardFor(ref);
    try {
      const res = await fetch(
        "/api/thinking-levels?kind=" + encodeURIComponent(card?.querySelector(".pkind").value ?? "") +
          "&model=" + encodeURIComponent(modelId) +
          "&base=" + encodeURIComponent(card?.querySelector(".pbase").value.trim() ?? ""),
        { headers: { "x-init-data": initData } },
      );
      if (res.ok) levels = (await res.json()).levels;
    } catch { /* keep the full vocabulary — honest unknown */ }
  }
  const wanted = sel.value;
  sel.replaceChildren(...levels.map(l => new Option(l, l)));
  if (levels.includes(wanted)) { sel.value = wanted; return; }
  // Stored value isn't on this model's ladder — mirror the server's
  // clamp: nearest rung at-or-above, else the top rung.
  const idx = ORDER.indexOf(wanted);
  sel.value = levels.find(l => ORDER.indexOf(l) >= idx) ?? levels[levels.length - 1];
}

function addProvider(name, p) {
  const div = document.createElement("div");
  div.className = "prov";
  const head = document.createElement("div");
  head.className = "prov-head";
  const pname = document.createElement("input");
  pname.className = "pname mono";
  pname.placeholder = "name";
  pname.autocomplete = "off"; pname.spellcheck = false; pname.autocapitalize = "off";
  const del = document.createElement("button");
  del.type = "button";
  del.className = "pdel";
  del.textContent = "remove";
  del.onclick = () => { div.remove(); refreshThinking(); };
  head.append(pname, del);
  const kindLabel = document.createElement("div");
  kindLabel.className = "micro"; kindLabel.textContent = "type";
  const kind = document.createElement("select");
  kind.className = "pkind";
  for (const k of KINDS) kind.append(new Option(k, k));
  const baseLabel = document.createElement("div");
  baseLabel.className = "micro pbase-label"; baseLabel.textContent = "base url";
  const base = document.createElement("input");
  base.className = "pbase mono";
  base.placeholder = "https://…";
  base.autocomplete = "off"; base.spellcheck = false; base.autocapitalize = "off";
  const authLabel = document.createElement("div");
  authLabel.className = "micro"; authLabel.textContent = "secret name (in auth.jsonl)";
  const auth = document.createElement("input");
  auth.className = "pauth mono";
  auth.placeholder = "not the secret itself";
  auth.autocomplete = "off"; auth.spellcheck = false; auth.autocapitalize = "off";
  const sync = () => {
    base.classList.toggle("hidden", kind.value !== "openai-compatible");
    baseLabel.classList.toggle("hidden", kind.value !== "openai-compatible");
    // codex auth is the CLI's OAuth file, not an auth.jsonl secret name.
    authLabel.textContent = kind.value === "codex"
      ? "codex auth file (blank = ~/.codex/auth.json)"
      : "secret name (in auth.jsonl)";
    auth.placeholder = kind.value === "codex" ? "~/.codex/auth.json" : "not the secret itself";
  };
  kind.onchange = () => { sync(); refreshThinking(); };
  // Provider name/kind decide which thinking levels the model field's
  // prefix maps to — re-derive as they're edited.
  pname.addEventListener("input", debounce(refreshThinking, 300));
  base.addEventListener("input", debounce(refreshThinking, 300));
  div.append(head, kindLabel, kind, baseLabel, base, authLabel, auth);
  $("provs").append(div);
  pname.value = name ?? "";
  kind.value = p?.kind ?? "openai-compatible";
  base.value = p?.baseUrl ?? "";
  auth.value = p?.auth ?? p?.authFile ?? "";
  sync();
}
$("addProv").onclick = () => addProvider();
$("model").addEventListener("input", debounce(refreshThinking, 300));

function readProviders() {
  const out = {};
  for (const div of $("provs").children) {
    const name = div.querySelector(".pname").value.trim();
    if (!name) continue;
    if (name in out) { msg("duplicate provider name: " + name, false); return null; }
    const kind = div.querySelector(".pkind").value;
    const authVal = div.querySelector(".pauth").value.trim();
    if (kind === "openai-compatible") {
      out[name] = { kind, baseUrl: div.querySelector(".pbase").value.trim(), auth: authVal };
    } else if (kind === "codex") {
      out[name] = authVal ? { kind, authFile: authVal } : { kind };
    } else {
      out[name] = { kind, auth: authVal };
    }
  }
  return out;
}

async function load() {
  const res = await fetch("/api/config", { headers: { "x-init-data": initData } });
  if (!res.ok) { msg("load failed: " + res.status, false); return; }
  const c = await res.json();
  $("model").value = c.model ?? "";
  $("titleModel").value = c.titleModel ?? "";
  $("favorites").value = (c.favorites ?? []).join(", ");
  $("thinking").value = c.thinking ?? "medium";
  $("allowedUsers").value = (c.allowedUsers ?? []).join(", ");
  $("publicUrl").value = c.publicUrl ?? "";
  $("apiRoot").value = c.telegram?.apiRoot ?? "";
  for (const [name, p] of Object.entries(c.providers ?? {})) addProvider(name, p);
  refreshThinking(); // after provider cards exist — kind lookup needs them
  $("logLevel").value = c.logLevel ?? "info";
  const dl = $("modelRefs");
  for (const r of new Set([c.model, c.titleModel, ...(c.favorites ?? [])].filter(Boolean))) {
    dl.append(new Option(r));
  }
}

$("save").onclick = async () => {
  const num = (s) => s.split(",").map(x => Number(x.trim())).filter(n => Number.isInteger(n) && n > 0);
  const strs = (s) => s.split(",").map(x => x.trim()).filter(Boolean);
  const providers = readProviders();
  if (!providers) return;
  const body = {
    model: $("model").value.trim(),
    titleModel: $("titleModel").value.trim(), // "" clears — server normalizes it
    favorites: strs($("favorites").value),
    thinking: $("thinking").value,
    allowedUsers: num($("allowedUsers").value),
    publicUrl: $("publicUrl").value.trim(), // "" clears the door — server normalizes it
    telegram: { apiRoot: $("apiRoot").value.trim() || undefined },
    providers,
    logLevel: $("logLevel").value,
  };
  const res = await fetch("/api/config", {
    method: "POST",
    headers: { "content-type": "application/json", "x-init-data": initData },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (res.ok) {
    msg("saved", true);
    window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("success");
  } else {
    msg("save failed — " + (j.error ?? res.status), false);
    window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("error");
  }
};

if (!initData) msg("open from the Telegram menu button");
else load();
</script>
</body>
</html>`;

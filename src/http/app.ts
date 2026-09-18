// The settings mini app. One page, no build step: friendly inputs for
// every knob — providers are per-card fields, not a JSON blob — with
// server-side zod validation on save.

export const APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>goblin settings</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.4 system-ui, sans-serif; margin: 0; padding: 16px;
         background: var(--tg-theme-bg-color, #fff); color: var(--tg-theme-text-color, #000); }
  label { display: block; margin: 12px 0 4px; opacity: .7; }
  input, select { width: 100%; box-sizing: border-box; padding: 8px;
    border-radius: 8px; border: 1px solid #8884; font: inherit;
    background: var(--tg-theme-secondary-bg-color, #f4f4f5); color: inherit; }
  button { margin-top: 16px; width: 100%; padding: 12px; border: 0; border-radius: 10px;
    font: inherit; font-weight: 600; cursor: pointer;
    background: var(--tg-theme-button-color, #40a7e3); color: var(--tg-theme-button-text-color, #fff); }
  #msg { margin-top: 10px; min-height: 1.2em; white-space: pre-wrap; }
  .err { color: #e5534b; } .ok { color: #57ab5a; }
  .prov { border: 1px solid #8884; border-radius: 10px; padding: 8px; margin: 8px 0; }
  .prov input, .prov select { margin: 4px 0; }
  .prov-head { display: flex; gap: 8px; align-items: center; }
  .prov-head .pname { flex: 1; font-weight: 600; }
  .pdel { width: auto; margin: 0; padding: 6px 10px; font-weight: 400; }
  .secondary { background: var(--tg-theme-secondary-bg-color, #f4f4f5);
    color: inherit; border: 1px solid #8884; margin-top: 8px; }
  .hidden { display: none; }
</style>
</head>
<body>
  <label>model</label><input id="model" list="modelRefs" placeholder="provider/model-id">
  <label>title model (topic auto-title, blank = off)</label><input id="titleModel" list="modelRefs" placeholder="provider/model-id">
  <datalist id="modelRefs"></datalist>
  <label>favorites (comma-separated)</label><input id="favorites">
  <label>thinking</label>
  <select id="thinking"><option>off</option><option>low</option><option>medium</option><option>high</option></select>
  <label>allowed telegram user ids (comma-separated)</label><input id="allowedUsers">
  <label>public url (mini-app door)</label><input id="publicUrl" placeholder="https://…">
  <label>telegram api root (self-hosted bot-api, blank = cloud)</label><input id="apiRoot">
  <label>providers</label>
  <div id="providers"></div>
  <button id="addProv" type="button" class="secondary">+ add provider</button>
  <label>log level</label>
  <select id="logLevel"><option>debug</option><option>info</option><option>warn</option><option>error</option></select>
  <button id="save">save</button>
  <div id="msg"></div>
<script>
const initData = window.Telegram?.WebApp?.initData ?? "";
const $ = (id) => document.getElementById(id);
const msg = (t, ok) => { const el = $("msg"); el.textContent = t; el.className = ok ? "ok" : "err"; };

const KINDS = ["openai-compatible", "openrouter"];

function addProvider(name, p) {
  const div = document.createElement("div");
  div.className = "prov";
  const head = document.createElement("div");
  head.className = "prov-head";
  const pname = document.createElement("input");
  pname.className = "pname";
  pname.placeholder = "name";
  const del = document.createElement("button");
  del.type = "button";
  del.className = "pdel";
  del.textContent = "remove";
  del.onclick = () => div.remove();
  head.append(pname, del);
  const kind = document.createElement("select");
  kind.className = "pkind";
  for (const k of KINDS) kind.append(new Option(k, k));
  const base = document.createElement("input");
  base.className = "pbase";
  base.placeholder = "base url";
  const auth = document.createElement("input");
  auth.className = "pauth";
  auth.placeholder = "auth.jsonl key";
  const sync = () => base.classList.toggle("hidden", kind.value !== "openai-compatible");
  kind.onchange = sync;
  div.append(head, kind, base, auth);
  $("providers").append(div);
  pname.value = name ?? "";
  kind.value = p?.kind ?? "openai-compatible";
  base.value = p?.baseUrl ?? "";
  auth.value = p?.auth ?? "";
  sync();
}
$("addProv").onclick = () => addProvider();

function readProviders() {
  const out = {};
  for (const div of $("providers").children) {
    const name = div.querySelector(".pname").value.trim();
    if (!name) continue;
    const kind = div.querySelector(".pkind").value;
    out[name] = kind === "openai-compatible"
      ? { kind, baseUrl: div.querySelector(".pbase").value.trim(), auth: div.querySelector(".pauth").value.trim() }
      : { kind, auth: div.querySelector(".pauth").value.trim() };
  }
  return out;
}

async function load() {
  const res = await fetch("/api/config", { headers: { "x-init-data": initData } });
  if (!res.ok) { msg("load failed: " + res.status); return; }
  const c = await res.json();
  $("model").value = c.model ?? "";
  $("titleModel").value = c.titleModel ?? "";
  $("favorites").value = (c.favorites ?? []).join(", ");
  $("thinking").value = c.thinking ?? "medium";
  $("allowedUsers").value = (c.allowedUsers ?? []).join(", ");
  $("publicUrl").value = c.publicUrl ?? "";
  $("apiRoot").value = c.telegram?.apiRoot ?? "";
  for (const [name, p] of Object.entries(c.providers ?? {})) addProvider(name, p);
  $("logLevel").value = c.logLevel ?? "info";
  const dl = $("modelRefs");
  for (const r of new Set([c.model, c.titleModel, ...(c.favorites ?? [])].filter(Boolean))) {
    dl.append(new Option(r));
  }
}

$("save").onclick = async () => {
  const num = (s) => s.split(",").map(x => Number(x.trim())).filter(n => Number.isInteger(n) && n > 0);
  const strs = (s) => s.split(",").map(x => x.trim()).filter(Boolean);
  const body = {
    model: $("model").value.trim(),
    titleModel: $("titleModel").value.trim(), // "" clears — server normalizes it
    favorites: strs($("favorites").value),
    thinking: $("thinking").value,
    allowedUsers: num($("allowedUsers").value),
    publicUrl: $("publicUrl").value.trim(), // "" clears the door — server normalizes it
    telegram: { apiRoot: $("apiRoot").value.trim() || undefined },
    providers: readProviders(),
    logLevel: $("logLevel").value,
  };
  const res = await fetch("/api/config", {
    method: "POST",
    headers: { "content-type": "application/json", "x-init-data": initData },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  msg(res.ok ? "saved" : "save failed: " + (j.error ?? res.status), res.ok);
  if (res.ok) window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("success");
};

if (!initData) msg("open from the Telegram menu button");
else load();
</script>
</body>
</html>`;

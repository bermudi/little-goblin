// The settings mini app. One page, no build step: friendly inputs for the
// common knobs, a JSON textarea for providers, server-side zod validation
// on save.

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
  input, select, textarea { width: 100%; box-sizing: border-box; padding: 8px;
    border-radius: 8px; border: 1px solid #8884; font: inherit;
    background: var(--tg-theme-secondary-bg-color, #f4f4f5); color: inherit; }
  textarea { font-family: ui-monospace, monospace; min-height: 160px; }
  button { margin-top: 16px; width: 100%; padding: 12px; border: 0; border-radius: 10px;
    font: inherit; font-weight: 600; cursor: pointer;
    background: var(--tg-theme-button-color, #40a7e3); color: var(--tg-theme-button-text-color, #fff); }
  #msg { margin-top: 10px; min-height: 1.2em; white-space: pre-wrap; }
  .err { color: #e5534b; } .ok { color: #57ab5a; }
</style>
</head>
<body>
  <label>model</label><input id="model" placeholder="provider/model-id">
  <label>favorites (comma-separated)</label><input id="favorites">
  <label>thinking</label>
  <select id="thinking"><option>off</option><option>low</option><option>medium</option><option>high</option></select>
  <label>allowed telegram user ids (comma-separated)</label><input id="allowedUsers">
  <label>public url (mini-app door)</label><input id="publicUrl" placeholder="https://…">
  <label>telegram api root (self-hosted bot-api, blank = cloud)</label><input id="apiRoot">
  <label>providers (JSON)</label><textarea id="providers" spellcheck="false"></textarea>
  <label>log level</label>
  <select id="logLevel"><option>debug</option><option>info</option><option>warn</option><option>error</option></select>
  <button id="save">save</button>
  <div id="msg"></div>
<script>
const initData = window.Telegram?.WebApp?.initData ?? "";
const $ = (id) => document.getElementById(id);
const msg = (t, ok) => { const el = $("msg"); el.textContent = t; el.className = ok ? "ok" : "err"; };

async function load() {
  const res = await fetch("/api/config", { headers: { "x-init-data": initData } });
  if (!res.ok) { msg("load failed: " + res.status); return; }
  const c = await res.json();
  $("model").value = c.model ?? "";
  $("favorites").value = (c.favorites ?? []).join(", ");
  $("thinking").value = c.thinking ?? "medium";
  $("allowedUsers").value = (c.allowedUsers ?? []).join(", ");
  $("publicUrl").value = c.publicUrl ?? "";
  $("apiRoot").value = c.telegram?.apiRoot ?? "";
  $("providers").value = JSON.stringify(c.providers ?? {}, null, 2);
  $("logLevel").value = c.logLevel ?? "info";
}

$("save").onclick = async () => {
  let providers;
  try { providers = JSON.parse($("providers").value); }
  catch (e) { msg("providers JSON invalid: " + e.message); return; }
  const num = (s) => s.split(",").map(x => Number(x.trim())).filter(n => Number.isInteger(n) && n > 0);
  const strs = (s) => s.split(",").map(x => x.trim()).filter(Boolean);
  const body = {
    model: $("model").value.trim(),
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
  msg(res.ok ? "saved" : "save failed: " + (j.error ?? res.status), res.ok);
  if (res.ok) window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("success");
};

if (!initData) msg("open from the Telegram menu button");
else load();
</script>
</body>
</html>`;

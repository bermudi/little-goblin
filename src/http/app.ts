// The settings mini app — goblin's configuration surface, designed to
// make "SSH is never required" literal: every key in goblin.json5 has a
// control here. One page, no build step: this file is the markup+css,
// served as-is; the client script is a separate plain-JS file (app.js)
// served verbatim and type-checked by tsc (checkJs, see
// tsconfig.client.json — types come from the server's own modules, so
// schema drift in this page is a typecheck failure, not a phone-only
// bug).
//
// Design rules this page follows (don't regress them):
// - Color comes only from Telegram's --tg-theme-* vars, so the page reads
//   as native in both light and dark; fallbacks mirror Telegram dark.
// - Machine values (model refs, urls, ids, secret names) are monospace;
//   human labels are the system sans. The split carries the meaning.
// - Inputs render at 16px — smaller and iOS zoom-jumps on focus.
// - Save lives in a fixed bottom bar with inline status; never strand it
//   below the fold. The tab bar sits under it; both stay visible.
// - Nothing structured is a raw text field: enums are segmented controls,
//   booleans are switches, lists are chip editors, model refs get a
//   picker sheet, and provider chains are ordered builders — the order
//   IS the fallback semantics, so the UI shows it.
// - Unsaved work is guarded: closing confirmation and the back button
//   ask before discarding (Telegram WebApp APIs, optional-chained).

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
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; }
  body {
    font: 15px/1.45 system-ui, -apple-system, sans-serif;
    background: var(--bg); color: var(--text);
    padding-bottom: calc(158px + env(safe-area-inset-bottom));
  }
  .wrap { max-width: 560px; margin: 0 auto; padding: 0 16px; }
  .hidden { display: none !important; }
  .mono { font-family: var(--mono); }
  .st-ok { color: var(--ok); }
  .st-err { color: var(--err); }

  header {
    position: sticky; top: 0; z-index: 20;
    background: color-mix(in srgb, var(--bg) 84%, transparent);
    -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
    border-bottom: 1px solid var(--sep);
    margin: 0 -16px; padding: 14px 16px 12px;
    display: flex; align-items: baseline; gap: 9px;
  }
  header .mark { font-family: var(--mono); font-size: 17px; font-weight: 700; letter-spacing: -0.02em; }
  header .sub { color: var(--hint); font-size: 15px; }
  #dirtyPill {
    margin-left: auto; align-self: center;
    font: 600 11px system-ui; letter-spacing: 0.02em;
    color: var(--btn-text); background: var(--btn);
    border-radius: 999px; padding: 3px 9px;
  }

  .panel { display: none; }
  .panel.on { display: block; }
  h2 {
    font-size: 13px; font-weight: 600; color: var(--hint);
    margin: 24px 6px 7px;
  }
  .lead { font-size: 13px; color: var(--hint); margin: 14px 6px 0; line-height: 1.4; }

  .card { background: var(--bg2); border-radius: 13px; overflow: hidden; }
  .row {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; padding: 11px 14px; min-height: 48px;
  }
  .row + .row, .frow + .row, .row + .frow, .frow + .frow,
  .details + .frow, .frow + .details, .row + .details { border-top: 1px solid var(--sep); }
  .row.col { flex-direction: column; align-items: stretch; gap: 10px; }
  .rstack { min-width: 0; }
  .rlabel { font-size: 15px; }
  .cap { font-size: 12.5px; color: var(--hint); line-height: 1.4; margin-top: 2px; }
  .row > .cap, .rstack .cap { margin-top: 3px; }
  .frow { padding: 11px 14px 13px; }
  .frow > label, .frow > .flabel {
    display: block; font-size: 13px; color: var(--hint); margin: 0 1px 6px;
  }
  .frow .cap { margin: 6px 1px 0; }

  input, select {
    width: 100%; padding: 10px 12px;
    font: 16px/1.3 var(--mono); color: var(--text);
    background: var(--bg);
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
  input:focus-visible, select:focus-visible, button:focus-visible, summary:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--link) 30%, transparent);
  }
  input::placeholder { color: var(--hint); opacity: .55; }

  /* value buttons — rows that open the model sheet */
  .valuebtn {
    display: flex; align-items: center; gap: 5px;
    max-width: 62%; padding: 6px 0 6px 6px;
    background: transparent; border: 0; color: var(--link);
    font: 500 14px var(--mono); cursor: pointer;
  }
  .valuebtn .val { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .valuebtn svg { width: 16px; height: 16px; flex: none; opacity: .7; }

  /* switch */
  .switch {
    flex: none; position: relative;
    width: 46px; height: 28px; border-radius: 999px;
    background: color-mix(in srgb, var(--text) 16%, transparent);
    border: 0; cursor: pointer; transition: background .18s;
  }
  .switch::after {
    content: ""; position: absolute; top: 2px; left: 2px;
    width: 24px; height: 24px; border-radius: 50%;
    background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.3);
    transition: transform .18s;
  }
  .switch[aria-checked="true"] { background: var(--btn); }
  .switch[aria-checked="true"]::after { transform: translateX(18px); }

  /* segmented control */
  .seg {
    display: flex; gap: 2px; padding: 2px; border-radius: 10px;
    background: color-mix(in srgb, var(--text) 8%, transparent);
  }
  .seg button {
    flex: 1; padding: 7px 4px; border: 0; border-radius: 8px;
    background: transparent; color: var(--hint);
    font: 500 13.5px system-ui; white-space: nowrap; cursor: pointer;
  }
  .seg button[aria-pressed="true"] {
    background: var(--bg2); color: var(--text); font-weight: 600;
    box-shadow: 0 1px 4px rgba(0,0,0,.22);
  }
  .seg button:focus-visible { box-shadow: 0 0 0 3px color-mix(in srgb, var(--link) 30%, transparent); }

  /* chips */
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chips-empty { font-size: 13.5px; color: var(--hint); padding: 2px 1px; }
  .chip {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 5px 6px 5px 11px; border-radius: 999px;
    background: color-mix(in srgb, var(--text) 8%, transparent);
    font: 500 13.5px var(--mono);
  }
  .chip button {
    width: 18px; height: 18px; border-radius: 50%; border: 0;
    background: color-mix(in srgb, var(--text) 14%, transparent);
    color: var(--text); font: 400 13px/1 system-ui;
    display: flex; align-items: center; justify-content: center; cursor: pointer;
  }
  .addrow { display: flex; gap: 8px; margin-top: 10px; }
  .addrow input { flex: 1; min-width: 0; }
  .addbtn {
    flex: none; padding: 0 16px; border: 0; border-radius: 10px;
    background: var(--btn); color: var(--btn-text);
    font: 600 14px system-ui; cursor: pointer;
  }
  .addbtn:active { transform: scale(.97); }

  /* provider + chain step cards */
  .prov, .cstep {
    background: var(--bg2); border-radius: 13px;
    padding: 2px 12px 13px; margin-bottom: 10px;
  }
  .prov-head { display: flex; align-items: center; gap: 4px; margin: 0 -4px; }
  .pname {
    flex: 1; min-width: 0; font-weight: 600;
    background: transparent; border-color: transparent; padding: 10px 4px;
  }
  .pname:focus-visible { border-color: transparent; box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--link) 45%, transparent); }
  .rm {
    flex: none; border: 0; background: transparent; border-radius: 8px;
    font: 500 13px system-ui; color: var(--err);
    padding: 8px 10px; cursor: pointer;
  }
  .rm:hover { background: color-mix(in srgb, var(--err) 12%, transparent); }
  .chead { display: flex; align-items: center; gap: 8px; padding: 9px 0 8px; }
  .cnum {
    flex: none; width: 24px; height: 24px; border-radius: 8px;
    display: flex; align-items: center; justify-content: center;
    background: color-mix(in srgb, var(--text) 10%, transparent);
    font: 600 13px var(--mono); color: var(--hint);
  }
  .cnum.primary { background: var(--btn); color: var(--btn-text); }
  .crole { font-size: 12.5px; color: var(--hint); }
  .chead .sp { flex: 1; }
  .ibtn {
    flex: none; width: 30px; height: 30px; border: 0; border-radius: 9px;
    background: transparent; color: var(--hint); cursor: pointer;
    display: flex; align-items: center; justify-content: center;
  }
  .ibtn svg { width: 16px; height: 16px; }
  .ibtn:hover { background: color-mix(in srgb, var(--text) 9%, transparent); color: var(--text); }
  .prov .frow, .cstep .frow { padding: 8px 0 0; }
  .prov .flabel, .cstep .flabel { font-size: 12.5px; }
  .prov .cap, .cstep .cap { margin-top: 6px; }
  .ghost {
    width: 100%; margin-top: 2px; padding: 12px;
    background: transparent; border: 1px dashed var(--sep); border-radius: 13px;
    font: 600 15px system-ui; color: var(--link); cursor: pointer;
  }
  .ghost:hover { border-color: var(--link); }

  details.tuning { padding: 0 14px; }
  details.tuning summary {
    list-style: none; cursor: pointer;
    font-size: 13px; color: var(--hint);
    padding: 12px 1px; display: flex; align-items: center; gap: 6px;
  }
  details.tuning summary::-webkit-details-marker { display: none; }
  details.tuning summary::before { content: "▸"; font-size: 11px; }
  details.tuning[open] summary::before { content: "▾"; }
  details.tuning .inner { padding: 2px 0 13px; }

  /* bottom bars */
  #bar {
    position: fixed; left: 0; right: 0;
    bottom: calc(56px + env(safe-area-inset-bottom));
    z-index: 30;
    background: color-mix(in srgb, var(--bg) 84%, transparent);
    -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
    border-top: 1px solid var(--sep);
    padding: 9px 16px;
  }
  #bar .wrap { display: flex; align-items: center; gap: 14px; }
  #status { flex: 1; font-size: 13px; min-height: 1.2em; color: var(--hint); white-space: pre-wrap; max-height: 88px; overflow-y: auto; }
  #status.dirty { color: var(--text); }
  #status.ok { color: var(--ok); }
  #status.err { color: var(--err); }
  #save {
    flex: none; padding: 11px 30px; border: 0; border-radius: 12px;
    font: 600 16px system-ui; cursor: pointer;
    background: var(--btn); color: var(--btn-text);
  }
  #save:disabled { opacity: .45; cursor: default; }
  #save:active:not(:disabled) { transform: scale(.97); }

  #tabs {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 31;
    display: flex;
    background: color-mix(in srgb, var(--bg) 88%, transparent);
    -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
    border-top: 1px solid var(--sep);
    padding: 5px 4px calc(5px + env(safe-area-inset-bottom));
  }
  #tabs button {
    flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px;
    padding: 4px 0 3px; border: 0; border-radius: 10px;
    background: transparent; color: var(--hint);
    font: 500 10px system-ui; cursor: pointer;
  }
  #tabs button svg { width: 23px; height: 23px; }
  #tabs button[aria-selected="true"] { color: var(--link); }

  /* model sheet */
  #veil {
    position: fixed; inset: 0; z-index: 40;
    background: rgba(0,0,0,.45);
    opacity: 0; pointer-events: none; transition: opacity .2s;
  }
  #veil.on { opacity: 1; pointer-events: auto; }
  #sheet {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 41;
    background: var(--bg); border-radius: 16px 16px 0 0;
    border-top: 1px solid var(--sep);
    transform: translateY(105%); transition: transform .24s cubic-bezier(.2,.8,.2,1);
    max-height: 80%; display: flex; flex-direction: column;
    padding-bottom: env(safe-area-inset-bottom);
  }
  #sheet.on { transform: none; }
  .grab { width: 36px; height: 4px; border-radius: 999px; background: var(--sep); margin: 8px auto 0; }
  .shead { display: flex; align-items: center; padding: 10px 16px 6px; }
  .shead h3 { margin: 0; font: 600 16px system-ui; flex: 1; }
  #sheetClose {
    border: 0; background: color-mix(in srgb, var(--text) 10%, transparent);
    color: var(--hint); width: 28px; height: 28px; border-radius: 50%;
    font: 400 15px/1 system-ui; cursor: pointer;
  }
  #sheetBody { overflow-y: auto; padding: 2px 8px 8px; }
  .mgroup { font-size: 12.5px; color: var(--hint); padding: 10px 8px 4px; }
  .mrow {
    display: flex; align-items: center; gap: 8px; width: 100%;
    padding: 11px 10px; border: 0; border-radius: 10px;
    background: transparent; color: var(--text); cursor: pointer;
    font: 500 14.5px var(--mono); text-align: left;
  }
  .mrow:hover { background: color-mix(in srgb, var(--text) 6%, transparent); }
  .mrow .ref { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mrow .check { margin-left: auto; flex: none; visibility: hidden; color: var(--btn); }
  .mrow .check svg { width: 17px; height: 17px; display: block; }
  .mrow.sel .check { visibility: visible; }
  .mrow .off-label { font-family: system-ui; color: var(--hint); }
  .scustom { border-top: 1px solid var(--sep); padding: 12px 16px 14px; }
  .scustom .flabel { font-size: 13px; color: var(--hint); margin-bottom: 8px; }
  .scustom-row { display: flex; gap: 8px; }
  .scustom-row select { flex: none; width: 38%; }
  .scustom-row input { flex: 1; min-width: 0; }
  #sheetUse {
    width: 100%; margin-top: 10px; padding: 11px; border: 0; border-radius: 11px;
    background: var(--btn); color: var(--btn-text);
    font: 600 15px system-ui; cursor: pointer;
  }

  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; }
  }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <span class="mark">goblin</span><span class="sub">settings</span>
      <span id="dirtyPill" hidden>unsaved</span>
    </header>

    <!-- CHAT -->
    <section class="panel on" id="panel-chat" role="tabpanel" aria-label="Chat">
      <h2>Model</h2>
      <div class="card">
        <div class="row">
          <div class="rstack"><div class="rlabel" id="modelLabel">Default model</div></div>
          <button class="valuebtn" id="modelBtn" aria-labelledby="modelLabel">
            <span class="val" id="modelVal"></span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
          </button>
        </div>
        <div class="row col">
          <div class="rstack">
            <div class="rlabel">Thinking</div>
            <div class="cap">Only levels this model can express are shown.</div>
          </div>
          <div class="seg" id="thinkingSeg" role="group" aria-label="Thinking level"></div>
        </div>
        <div class="row">
          <div class="rstack">
            <div class="rlabel" id="titleLabel">Topic titles</div>
            <div class="cap">Names new topics, then stops.</div>
          </div>
          <button class="valuebtn" id="titleBtn" aria-labelledby="titleLabel">
            <span class="val" id="titleVal"></span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
          </button>
        </div>
      </div>

      <h2>Favorites</h2>
      <div class="card">
        <div class="frow">
          <div class="chips" id="favChips"></div>
          <div class="addrow">
            <input id="favInput" class="mono" placeholder="provider/model-id" autocomplete="off" spellcheck="false" autocapitalize="off" aria-label="add favorite">
            <button class="addbtn" id="favAdd" type="button">Add</button>
          </div>
          <div class="cap">Offered in /model and in the pickers above.</div>
        </div>
      </div>
    </section>

    <!-- VOICE -->
    <section class="panel" id="panel-voice" role="tabpanel" aria-label="Voice">
      <h2>Voice notes</h2>
      <div class="card">
        <div class="row">
          <div class="rstack">
            <div class="rlabel">Text to speech</div>
            <div class="cap">Edge read-aloud — free and unofficial. Failures post a note in chat.</div>
          </div>
          <button class="switch" id="ttsOn" aria-label="text to speech"></button>
        </div>
        <div id="ttsFields" class="hidden">
          <div class="frow">
            <label for="ttsVoice">Voice</label>
            <input id="ttsVoice" placeholder="en-US-AriaNeural" autocomplete="off" spellcheck="false" autocapitalize="off">
            <div class="cap">Used for /voice mode and the speaker button on replies.</div>
          </div>
          <div class="frow">
            <label for="ttsRate">Rate</label>
            <input id="ttsRate" placeholder="+10%" autocomplete="off" spellcheck="false" autocapitalize="off">
          </div>
          <div class="frow">
            <div class="flabel">Alternate voices</div>
            <div class="chips" id="voiceChips"></div>
            <div class="addrow">
              <input id="voiceInput" list="voiceDl" placeholder="add a voice" autocomplete="off" spellcheck="false" autocapitalize="off" aria-label="add alternate voice">
              <button class="addbtn" id="voiceAdd" type="button">Add</button>
            </div>
            <datalist id="voiceDl"></datalist>
            <div class="cap">The speak tool may pick one per message — language follows the voice name.</div>
          </div>
        </div>
      </div>

      <h2>Transcription</h2>
      <div class="card">
        <div class="row">
          <div class="rstack">
            <div class="rlabel">Speech to text</div>
            <div class="cap">Voice and video notes are transcribed on arrival; the bot can transcribe other audio files on request.</div>
          </div>
          <button class="switch" id="trOn" aria-label="speech to text"></button>
        </div>
        <div id="trFields" class="hidden">
          <div class="frow">
            <label for="trModel">Model</label>
            <input id="trModel" placeholder="whisper-large-v3-turbo" autocomplete="off" spellcheck="false" autocapitalize="off">
            <div class="cap">Blank uses the default.</div>
          </div>
          <div class="frow">
            <label for="trAuth">Secret name</label>
            <input id="trAuth" placeholder="in auth.jsonl — not the secret itself" autocomplete="off" spellcheck="false" autocapitalize="off">
          </div>
        </div>
      </div>
    </section>

    <!-- WEB -->
    <section class="panel" id="panel-web" role="tabpanel" aria-label="Web">
      <h2>Search</h2>
      <div class="card">
        <div class="row">
          <div class="rstack">
            <div class="rlabel">Search tool</div>
            <div class="cap">Off removes search from the agent's tools.</div>
          </div>
          <button class="switch" id="searchOn" aria-label="search tool"></button>
        </div>
      </div>
      <div id="searchChain" class="hidden">
        <div id="searchSteps" style="margin-top:10px"></div>
        <button class="ghost" id="searchAdd" type="button">+ Add provider</button>
        <div class="cap" style="margin:8px 6px 0">Tried top to bottom. A failure moves on to the next; an empty result is an answer and stops the chain.</div>
      </div>

      <h2>Fetch</h2>
      <div class="card">
        <div class="row">
          <div class="rstack">
            <div class="rlabel">Custom extraction chain</div>
            <div class="cap">Off uses built-in extraction: direct download, no key. JS-heavy sites need the browser skill either way.</div>
          </div>
          <button class="switch" id="fetchOn" aria-label="custom extraction chain"></button>
        </div>
      </div>
      <div id="fetchChain" class="hidden">
        <div id="fetchSteps" style="margin-top:10px"></div>
        <button class="ghost" id="fetchAdd" type="button">+ Add provider</button>
        <div class="cap" style="margin:8px 6px 0">Same rule as search — order is the fallback order.</div>
      </div>
    </section>

    <!-- MEMORY -->
    <section class="panel" id="panel-memory" role="tabpanel" aria-label="Memory">
      <h2>Status</h2>
      <div class="card" id="memStatusCard">
        <div class="row">
          <div class="rstack">
            <div class="rlabel">status: <span class="mono">…</span></div>
            <div class="cap">Live view of the memory queue — fetched while this tab is open. Read-only; the verbs live in Telegram.</div>
          </div>
        </div>
      </div>
      <h2>Long-term memory</h2>
      <div class="card">
        <div class="row">
          <div class="rstack">
            <div class="rlabel">Memory</div>
            <div class="cap">Self-hosted hindsight. Completed exchanges are retained; relevant facts are recalled into new turns.</div>
          </div>
          <button class="switch" id="memOn" aria-label="long-term memory"></button>
        </div>
        <div id="memFields" class="hidden">
          <div class="frow">
            <label for="memBase">Hindsight url</label>
            <input id="memBase" placeholder="http://127.0.0.1:8888" autocomplete="off" spellcheck="false" autocapitalize="off">
          </div>
          <div class="frow">
            <label for="memBank">Bank id</label>
            <input id="memBank" placeholder="goblin" autocomplete="off" spellcheck="false" autocapitalize="off">
          </div>
          <div class="frow">
            <label for="memAuth">Secret name</label>
            <input id="memAuth" placeholder="in auth.jsonl — blank for loopback" autocomplete="off" spellcheck="false" autocapitalize="off">
          </div>
          <div class="row col">
            <div class="rlabel">Recall budget</div>
            <div class="seg" id="memBudget" role="group" aria-label="Recall budget"></div>
          </div>
          <details class="tuning">
            <summary>Recall tuning</summary>
            <div class="inner">
              <div class="frow" style="padding:6px 0 0">
                <label for="memTimeout">Timeout (ms)</label>
                <input id="memTimeout" placeholder="2000" inputmode="numeric" autocomplete="off" spellcheck="false">
              </div>
              <div class="frow" style="padding:10px 0 0">
                <label for="memTokens">Max tokens</label>
                <input id="memTokens" placeholder="1024" inputmode="numeric" autocomplete="off" spellcheck="false">
                <div class="cap">Tight by default — turns must not wait on memory.</div>
              </div>
            </div>
          </details>
        </div>
      </div>
    </section>

    <!-- ACCESS -->
    <section class="panel" id="panel-access" role="tabpanel" aria-label="Access">
      <h2>Allowed users</h2>
      <div class="card">
        <div class="frow">
          <div class="chips" id="userChips"></div>
          <div class="addrow">
            <input id="userInput" placeholder="telegram user id" inputmode="numeric" autocomplete="off" spellcheck="false" aria-label="add allowed user">
            <button class="addbtn" id="userAdd" type="button">Add</button>
          </div>
          <div class="cap">Telegram user ids that may talk to goblin and open these settings. Your own id can't be removed.</div>
        </div>
      </div>

      <h2>Doors</h2>
      <div class="card">
        <div class="frow">
          <label for="publicUrl">Public url</label>
          <input id="publicUrl" placeholder="https://…" autocomplete="off" spellcheck="false" autocapitalize="off">
          <div class="cap">HTTPS door for this app — tailscale serve, funnel, or a reverse proxy pointed at the port below.</div>
        </div>
        <div class="frow">
          <label for="apiRoot">Bot api root</label>
          <input id="apiRoot" placeholder="http://127.0.0.1:8081" autocomplete="off" spellcheck="false" autocapitalize="off">
          <div class="cap">Self-hosted telegram-bot-api in --local mode, for large files. Blank = Telegram cloud. Restart applies.</div>
        </div>
      </div>

      <h2>Advanced</h2>
      <div class="card">
        <div class="frow">
          <label for="httpPort">Http port</label>
          <input id="httpPort" placeholder="8787" inputmode="numeric" autocomplete="off" spellcheck="false">
          <div class="cap">The port this settings app is served on. Restart applies.</div>
        </div>
        <div class="row col">
          <div class="rlabel">Log level</div>
          <div class="seg" id="logSeg" role="group" aria-label="Log level"></div>
        </div>
      </div>
    </section>

    <!-- PROVIDERS -->
    <section class="panel" id="panel-providers" role="tabpanel" aria-label="Providers">
      <p class="lead">Model vendors goblin can call. Secrets are names in auth.jsonl — the values never land in config.</p>
      <h2>Providers</h2>
      <div id="provs"></div>
      <button class="ghost" id="addProv" type="button">+ Add provider</button>
    </section>
  </div>

  <div id="bar"><div class="wrap">
    <div id="status"></div>
    <button id="save" type="button" disabled>Save</button>
  </div></div>

  <nav id="tabs" aria-label="Sections">
    <button type="button" role="tab" aria-selected="true" data-tab="chat">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4.5c-4.5 0-8 2.9-8 6.5 0 2 1.1 3.9 2.8 5.1L6.2 19.6l3.4-1.5c.8.2 1.6.3 2.4.3 4.5 0 8-2.9 8-6.5s-3.5-6.4-8-6.4z"/></svg>
      <span>Chat</span>
    </button>
    <button type="button" role="tab" aria-selected="false" data-tab="voice">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/></svg>
      <span>Voice</span>
    </button>
    <button type="button" role="tab" aria-selected="false" data-tab="web">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.5 2.2 3.8 5 3.8 8s-1.3 5.8-3.8 8c-2.5-2.2-3.8-5-3.8-8S9.5 6.2 12 4z"/></svg>
      <span>Web</span>
    </button>
    <button type="button" role="tab" aria-selected="false" data-tab="memory">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4l8 4-8 4-8-4 8-4z"/><path d="M4 12l8 4 8-4"/><path d="M4 16l8 4 8-4"/></svg>
      <span>Memory</span>
    </button>
    <button type="button" role="tab" aria-selected="false" data-tab="access">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v5.5c0 4.4-2.9 7.4-7 9-4.1-1.6-7-4.6-7-9V6l7-3z"/></svg>
      <span>Access</span>
    </button>
    <button type="button" role="tab" aria-selected="false" data-tab="providers">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4.5" width="16" height="6.5" rx="2"/><rect x="4" y="13" width="16" height="6.5" rx="2"/><path d="M8 7.75h.01M8 16.25h.01"/></svg>
      <span>Providers</span>
    </button>
  </nav>

  <div id="veil"></div>
  <div id="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle" tabindex="-1">
    <div class="grab"></div>
    <div class="shead">
      <h3 id="sheetTitle">Model</h3>
      <button id="sheetClose" type="button" aria-label="close">×</button>
    </div>
    <div id="sheetBody"></div>
    <div class="scustom" id="sheetCustom">
      <div class="flabel">Custom model</div>
      <div class="scustom-row">
        <select id="sheetProv" aria-label="provider"></select>
        <input id="sheetModel" class="mono" placeholder="model-id" autocomplete="off" spellcheck="false" autocapitalize="off" aria-label="model id">
      </div>
      <button id="sheetUse" type="button">Use this model</button>
    </div>
  </div>

<script src="/app.js"></script>
</body>
</html>`;

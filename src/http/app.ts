// The settings mini app — goblin's configuration surface, designed to
// make "SSH is never required" literal: every key in goblin.json5 has a
// control here. One page, no build step, vanilla JS.
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

<script>
const tg = window.Telegram ? window.Telegram.WebApp : null;
const initData = (tg && tg.initData) || "";
const $ = (id) => document.getElementById(id);
const KINDS = __PROVIDER_KINDS__;
const SEARCH_KINDS = __SEARCH_KINDS__;
const FETCH_KINDS = __FETCH_KINDS__;

// The full operator vocabulary — the fallback when the model is unknown,
// and the ordering for nearest-rung clamping (mirrors the server).
const ORDER = ["off", "low", "medium", "high", "xhigh", "max"];

// Auth requirements per chain kind: "required" | "optional" | "none".
const SEARCH_META = {
  brave: { auth: "required" },
  exa: { auth: "required" },
  jina: { auth: "optional", note: "Works keyless, rate-limited." },
  tavily: { auth: "required" },
  firecrawl: { auth: "required" },
  parallel: { auth: "required" },
  ddg: { auth: "none", note: "Keyless — unofficial endpoint, may rate-limit or break." }
};
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
// cfg mirrors the server schema for everything this page manages.
// null blocks (tts/transcription/search/fetch/memory) mean "unset" —
// sent as "" which the server normalizes to absent.
let cfg = null;
let provDraft = [];   // [{id, name, kind, baseUrl, auth}] — name edits stay draft until save
let provSeq = 0;
let dirty = false;
let loading = true;
let me = 0;
// Last non-null content of each optional block — flipping a switch off
// must not throw away the operator's chain/fields (display keeps them
// through the toggle; the save simply sends "").
let lastTts = null;
let lastTranscription = null;
let lastMemory = null;
let lastSearch = null;
let lastFetch = null;
try { me = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.id) || 0; } catch (e) { me = 0; }

const debounce = (f, ms) => { let t; return () => { clearTimeout(t); t = setTimeout(f, ms); }; };
const tap = () => { if (tg && tg.HapticFeedback) tg.HapticFeedback.selectionChanged(); };

function msg(t, kind) {
  const elStatus = $("status");
  elStatus.textContent = t;
  elStatus.className = kind || "";
}
function updateSave() { $("save").disabled = !dirty; }
function markDirty() {
  if (loading) return;
  if (!dirty) {
    dirty = true;
    $("dirtyPill").hidden = false;
    msg("Unsaved changes", "dirty");
    if (tg) {
      if (tg.enableClosingConfirmation) tg.enableClosingConfirmation();
      if (tg.BackButton && tg.BackButton.show) tg.BackButton.show();
    }
  }
  updateSave();
}
function makeClean() {
  dirty = false;
  $("dirtyPill").hidden = true;
  if (tg) {
    if (tg.disableClosingConfirmation) tg.disableClosingConfirmation();
    if (tg.BackButton && tg.BackButton.hide) tg.BackButton.hide();
  }
  updateSave();
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function iconBtn(path, label, onclick) {
  const b = el("button", "ibtn");
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + "</svg>";
  b.onclick = onclick;
  return b;
}
const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

// ---------- tabs ----------
function initTabs() {
  const btns = Array.prototype.slice.call(document.querySelectorAll("#tabs button"));
  for (const b of btns) {
    b.onclick = () => {
      for (const x of btns) x.setAttribute("aria-selected", String(x === b));
      for (const p of document.querySelectorAll(".panel")) {
        p.classList.toggle("on", p.id === "panel-" + b.dataset.tab);
      }
      setMemoryPolling(b.dataset.tab === "memory");
      tap();
    };
  }
}

// ---------- generic controls ----------
function bindSwitch(id, get, set, after) {
  const b = $(id);
  const paint = () => b.setAttribute("aria-checked", String(!!get()));
  b.onclick = () => { set(!get()); paint(); markDirty(); tap(); if (after) after(); };
  paint();
}
function segmented(boxId, values, get, set) {
  const box = $(boxId);
  box.replaceChildren();
  for (const v of values) {
    const b = el("button", null, v);
    b.type = "button";
    b.setAttribute("aria-pressed", String(get() === v));
    b.onclick = () => { set(v); segmented(boxId, values, get, set); markDirty(); tap(); };
    box.append(b);
  }
}
function bindText(id, set) {
  $(id).addEventListener("input", (e) => { set(e.target.value); markDirty(); });
}

// chips editor: opts = {box, input, add, get, set, numeric?, datalist?, empty?}
function initChips(opts) {
  function render() {
    const box = $(opts.box);
    box.replaceChildren();
    const arr = opts.get();
    if (!arr.length) box.append(el("span", "chips-empty", opts.empty || "none yet"));
    arr.forEach((v) => {
      const c = el("span", "chip");
      c.append(el("span", null, String(v)));
      const x = el("button", null, "×");
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
    const inp = $(opts.input);
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
  if (opts.datalist) {
    const dl = $(opts.datalist);
    dl.replaceChildren();
    for (const v of opts.datalistValues) dl.append(new Option(v, v));
    $(opts.input).setAttribute("list", opts.datalist);
  }
  render();
  return render;
}

// ---------- model sheet ----------
let sheetMode = "model";
function sheetTarget() { return sheetMode === "title" ? cfg.titleModel : cfg.model; }
function pickModel(ref) {
  if (sheetMode === "title") { cfg.titleModel = ref; $("titleVal").textContent = ref || "Off"; }
  else { cfg.model = ref; $("modelVal").textContent = ref; refreshThinking(); }
  markDirty();
  closeSheet();
}
function sheetRow(ref, label, current) {
  const b = el("button", "mrow" + (ref === current ? " sel" : ""));
  b.type = "button";
  const span = el("span", ref ? "ref" : "ref off-label", label);
  span.title = ref;
  const check = el("span", "check");
  check.innerHTML = CHECK_SVG; // static constant, not user data
  b.append(span, check);
  b.onclick = () => pickModel(ref);
  return b;
}
function openSheet(mode) {
  sheetMode = mode;
  $("sheetTitle").textContent = mode === "title" ? "Topic-title model" : "Default model";
  const body = $("sheetBody");
  body.replaceChildren();
  const current = sheetTarget();
  if (mode === "title") body.append(sheetRow("", "Off", current));
  const favs = cfg.favorites.filter((f) => mode === "title" || true);
  if (favs.length) {
    body.append(el("div", "mgroup", "Favorites"));
    for (const f of favs) body.append(sheetRow(f, f, current));
  }
  if (current && favs.indexOf(current) === -1) {
    body.append(el("div", "mgroup", "Current"));
    body.append(sheetRow(current, current, current));
  }
  const sel = $("sheetProv");
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
  $("veil").onclick = closeSheet;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });
  $("sheetUse").onclick = () => {
    const p = $("sheetProv").value;
    const m = $("sheetModel").value.trim();
    if (!p || !m) { msg("Pick a provider and type a model id.", "err"); return; }
    $("sheetModel").value = "";
    pickModel(p + "/" + m);
  };
}

// ---------- thinking (server-owned capability table) ----------
let thinkLevels = ORDER;
function findProvByName(name) {
  for (const p of provDraft) if (p.name === name) return p;
  return null;
}
function displayLevel() {
  const idx = ORDER.indexOf(cfg.thinking);
  return thinkLevels.find((l) => ORDER.indexOf(l) >= idx) ?? thinkLevels[thinkLevels.length - 1];
}
function renderThinking() {
  const box = $("thinkingSeg");
  box.replaceChildren();
  const shown = cfg ? displayLevel() : null;
  for (const l of thinkLevels) {
    const b = el("button", null, l);
    b.type = "button";
    b.setAttribute("aria-pressed", String(shown === l));
    b.onclick = () => { cfg.thinking = l; renderThinking(); markDirty(); tap(); };
    box.append(b);
  }
}
async function refreshThinking() {
  const ref = cfg.model || "";
  const i = ref.indexOf("/");
  const modelId = i > 0 ? ref.slice(i + 1) : "";
  const prov = i > 0 ? findProvByName(ref.slice(0, i)) : null;
  let levels = ORDER;
  if (modelId && prov) {
    // base only matters to openai-compatible — a stale value must not
    // travel with a kind switch.
    const base = prov.kind === "openai-compatible" ? prov.baseUrl.trim() : "";
    try {
      const res = await fetch(
        "/api/thinking-levels?kind=" + encodeURIComponent(prov.kind) +
          "&model=" + encodeURIComponent(modelId) +
          "&base=" + encodeURIComponent(base),
        { headers: { "x-init-data": initData } }
      );
      if (res.ok) levels = (await res.json()).levels;
    } catch (e) { /* keep the full vocabulary — honest unknown */ }
  }
  thinkLevels = levels;
  renderThinking();
}
const refreshThinkingSoon = debounce(refreshThinking, 300);

// ---------- chains (search / fetch) ----------
// prefix: "search" | "fetch" — expects #{prefix}Steps and #{prefix}Add.
function initChain(prefix, kinds, meta, getArr, setArr) {
  const steps = $(prefix + "Steps");
  function render() {
    steps.replaceChildren();
    const arr = getArr() || [];
    arr.forEach((entry, i) => steps.append(row(entry, i, arr.length)));
  }
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
      a.splice(i, 1);
      render(); markDirty();
    }));
    const sel = el("select", "mono");
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
      const inp = el("input", "mono");
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
  function move(i, d) {
    const a = getArr();
    const t = a[i]; a[i] = a[i + d]; a[i + d] = t;
    render(); markDirty();
  }
  $(prefix + "Add").onclick = () => {
    const a = getArr() || [];
    a.push({ kind: kinds[0], auth: "" });
    setArr(a);
    render(); markDirty();
  };
  render();
  return render;
}

// ---------- providers ----------
function providerRefs(name) {
  const refs = [];
  if (cfg.model.indexOf(name + "/") === 0) refs.push("default model");
  if (cfg.titleModel.indexOf(name + "/") === 0) refs.push("topic titles");
  for (const f of cfg.favorites) if (f.indexOf(name + "/") === 0) { refs.push("favorites"); break; }
  return refs;
}
function provCard(p) {
  const card = el("div", "prov");
  const head = el("div", "prov-head");
  const name = el("input", "pname mono");
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
  const rm = el("button", "rm", "Remove");
  rm.type = "button";
  rm.onclick = () => {
    const refs = p.name ? providerRefs(p.name) : [];
    provDraft = provDraft.filter((q) => q !== p);
    renderProviders(); markDirty();
    if (refs.length) msg("Removed — still referenced by " + refs.join(", ") + ". Fix before saving.", "err");
  };
  head.append(name, rm);

  const kindLabel = el("div", "flabel", "Type");
  const kind = el("select", "mono");
  for (const k of KINDS) kind.append(new Option(k, k));
  kind.value = p.kind;
  kind.setAttribute("aria-label", "provider type");
  const baseLabel = el("div", "flabel", "Base url");
  const base = el("input", "mono");
  base.placeholder = "https://…";
  base.value = p.baseUrl;
  base.autocomplete = "off"; base.spellcheck = false; base.autocapitalize = "off";
  base.setAttribute("aria-label", "base url");
  base.oninput = () => { p.baseUrl = base.value; markDirty(); refreshThinkingSoon(); };
  const authLabel = el("div", "flabel");
  const auth = el("input", "mono");
  auth.value = p.auth;
  auth.autocomplete = "off"; auth.spellcheck = false; auth.autocapitalize = "off";
  auth.setAttribute("aria-label", "secret name");
  auth.oninput = () => { p.auth = auth.value; markDirty(); };
  function sync() {
    const compat = kind.value === "openai-compatible";
    baseLabel.classList.toggle("hidden", !compat);
    base.classList.toggle("hidden", !compat);
    // codex auth is the CLI's OAuth file, not an auth.jsonl secret name.
    const codex = kind.value === "codex";
    authLabel.textContent = codex ? "Codex auth file" : "Secret name";
    auth.placeholder = codex ? "~/.codex/auth.json — blank = default" : "in auth.jsonl — not the secret itself";
  }
  kind.onchange = () => { p.kind = kind.value; sync(); markDirty(); refreshThinkingSoon(); };

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
function validate() {
  const names = provDraft.map((p) => p.name);
  if (names.some((n) => !n)) return "Every provider needs a name.";
  if (new Set(names).size !== names.length) return "Duplicate provider name.";
  for (const p of provDraft) {
    if (p.kind === "openai-compatible") {
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
    for (let i = 0; i < cfg.search.length; i++) {
      const e = cfg.search[i];
      const m = SEARCH_META[e.kind];
      if (m && m.auth === "required" && !e.auth.trim()) {
        return "Search step " + (i + 1) + " (" + e.kind + ") needs a secret name.";
      }
    }
  }
  if (cfg.fetch) {
    if (!cfg.fetch.length) return "The fetch chain is on — add at least one provider, or switch it off.";
    for (let i = 0; i < cfg.fetch.length; i++) {
      const e = cfg.fetch[i];
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
  if (me && cfg.allowedUsers.indexOf(me) === -1) {
    return "Your own telegram id (" + me + ") must stay in allowed users.";
  }
  return null;
}
function buildBody() {
  const providers = {};
  for (const p of provDraft) {
    if (p.kind === "openai-compatible") {
      providers[p.name] = { kind: p.kind, baseUrl: p.baseUrl.trim(), auth: p.auth.trim() };
    } else if (p.kind === "codex") {
      providers[p.name] = p.auth.trim() ? { kind: p.kind, authFile: p.auth.trim() } : { kind: p.kind };
    } else {
      providers[p.name] = { kind: p.kind, auth: p.auth.trim() };
    }
  }
  const chainOut = (arr, meta) => (arr || []).map((e) => {
    const m = meta[e.kind];
    const auth = (e.auth || "").trim();
    if (!auth || (m && m.auth === "none")) return { kind: e.kind };
    return { kind: e.kind, auth: auth };
  });
  const numOrUndef = (s) => (String(s).trim() ? Number(String(s).trim()) : undefined);
  return {
    providers: providers,
    model: cfg.model,
    titleModel: cfg.titleModel, // "" clears — server normalizes
    favorites: cfg.favorites.slice(),
    thinking: cfg.thinking,
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
      budget: cfg.memory.budget,
      maxTokens: numOrUndef(cfg.memory.tokens),
      recallTimeoutMs: numOrUndef(cfg.memory.timeout)
    },
    logLevel: cfg.logLevel
  };
}
async function save() {
  const err = validate();
  if (err) { msg(err, "err"); return; }
  msg("Saving…");
  $("save").disabled = true;
  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "content-type": "application/json", "x-init-data": initData },
      body: JSON.stringify(buildBody())
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok) {
      makeClean();
      msg("Saved", "ok");
      if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
      setTimeout(() => { if (!dirty) msg("All changes saved"); }, 2500);
    } else {
      msg("Save failed — " + (j.error || res.status), "err");
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
let memTimer = null;
let memInFlight = false;
// Same-origin, HMAC-gated answer from the same process that serves this
// page — not a zod boundary in the repo's sense. Defensive shape check
// in the populate() (/api/config) idiom (review ruling 2026-09-25): every
// field read is guarded, anything unexpected renders as unavailable
// instead of throwing mid-render.
function checkMemoryStatus(s) {
  if (s === null || typeof s !== "object") return null;
  const int = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0;
  if (!["disabled", "healthy", "pending", "degraded"].includes(s.state)) return null;
  if (typeof s.detail !== "string") return null;
  if (!int(s.completed) || !int(s.blocked) || !int(s.dismissed) || !int(s.queued)) return null;
  if (!(s.lastRecallAt === null || typeof s.lastRecallAt === "string")) return null;
  if (!(s.lastRecallOk === null || typeof s.lastRecallOk === "boolean")) return null;
  if (!Array.isArray(s.blockedDetail)) return null;
  for (const b of s.blockedDetail) {
    if (b === null || typeof b !== "object") return null;
    if (typeof b.document !== "string") return null;
    if (!(b.error === null || typeof b.error === "string")) return null;
    if (!int(b.attempts)) return null;
  }
  return s;
}
// Local wall clock, like /memory — read by the operator on this box.
function hm(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "never";
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes());
}
function memStateWord(state) {
  return el("span", "mono" + (state === "degraded" ? " st-err" : state === "healthy" ? " st-ok" : ""), state);
}
function memHead(why) {
  const row = el("div", "row");
  const stack = el("div", "rstack");
  const label = el("div", "rlabel");
  label.append("status: ", memStateWord(why.state));
  stack.append(label, el("div", "cap", why.detail));
  row.append(stack);
  return row;
}
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
function setMemoryPolling(on) {
  if (on) {
    refreshMemoryStatus();
    if (memTimer === null) memTimer = setInterval(refreshMemoryStatus, MEM_POLL_MS);
  } else if (memTimer !== null) {
    clearInterval(memTimer);
    memTimer = null;
  }
}

// ---------- load + populate ----------
function populate(c) {
  cfg = {
    model: c.model || "",
    titleModel: c.titleModel || "",
    favorites: (c.favorites || []).slice(),
    thinking: c.thinking || "medium",
    tts: c.tts ? { voice: c.tts.voice || "", rate: c.tts.rate || "", voices: (c.tts.voices || []).slice() } : null,
    transcription: c.transcription ? { model: c.transcription.model || "", auth: c.transcription.auth || "" } : null,
    search: Array.isArray(c.search) ? c.search.map((e) => ({ kind: e.kind, auth: e.auth || "" })) : null,
    fetch: Array.isArray(c.fetch) ? c.fetch.map((e) => ({ kind: e.kind, auth: e.auth || "" })) : null,
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
  provDraft = Object.keys(c.providers || {}).map((name) => {
    const p = c.providers[name];
    return { id: ++provSeq, name: name, kind: p.kind, baseUrl: p.baseUrl || "", auth: p.auth || p.authFile || "" };
  });

  // Chat
  $("modelVal").textContent = cfg.model;
  $("titleVal").textContent = cfg.titleModel || "Off";
  // Voice — toggles keep the block's last content (lastTts etc.) so
  // flipping off is never "delete my work"; paint* re-syncs the controls
  // with the draft state on every toggle.
  const paintVoices = initChips({ box: "voiceChips", input: "voiceInput", add: "voiceAdd", datalist: "voiceDl", datalistValues: VOICE_SUGGESTIONS, get: () => cfg.tts ? cfg.tts.voices : [], set: (a) => cfg.tts.voices = a, empty: "no alternates — the speak tool uses the default voice" });
  function paintTts() {
    $("ttsFields").classList.toggle("hidden", cfg.tts === null);
    $("ttsVoice").value = cfg.tts ? cfg.tts.voice : "";
    $("ttsRate").value = cfg.tts ? cfg.tts.rate : "";
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
  bindText("ttsVoice", (v) => cfg.tts.voice = v);
  bindText("ttsRate", (v) => cfg.tts.rate = v);

  function paintTranscription() {
    $("trFields").classList.toggle("hidden", cfg.transcription === null);
    $("trModel").value = cfg.transcription ? cfg.transcription.model : "";
    $("trAuth").value = cfg.transcription ? cfg.transcription.auth : "";
  }
  bindSwitch("trOn",
    () => cfg.transcription !== null,
    (v) => {
      if (v) cfg.transcription = lastTranscription || { model: "", auth: "" };
      else { lastTranscription = cfg.transcription; cfg.transcription = null; }
    },
    paintTranscription);
  paintTranscription();
  bindText("trModel", (v) => cfg.transcription.model = v);
  bindText("trAuth", (v) => cfg.transcription.auth = v);

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

  // Memory
  function paintMemory() {
    $("memFields").classList.toggle("hidden", cfg.memory === null);
    $("memBase").value = cfg.memory ? cfg.memory.baseUrl : "";
    $("memBank").value = cfg.memory ? cfg.memory.bankId : "";
    $("memAuth").value = cfg.memory ? cfg.memory.auth : "";
    $("memTokens").value = cfg.memory ? cfg.memory.tokens : "";
    $("memTimeout").value = cfg.memory ? cfg.memory.timeout : "";
    if (cfg.memory) segmented("memBudget", ["low", "mid", "high"], () => cfg.memory.budget, (v) => cfg.memory.budget = v);
  }
  bindSwitch("memOn",
    () => cfg.memory !== null,
    (v) => {
      if (v) cfg.memory = lastMemory || { baseUrl: "", bankId: "", auth: "", budget: "low", tokens: "", timeout: "" };
      else { lastMemory = cfg.memory; cfg.memory = null; }
    },
    paintMemory);
  paintMemory();
  bindText("memBase", (v) => cfg.memory.baseUrl = v);
  bindText("memBank", (v) => cfg.memory.bankId = v);
  bindText("memAuth", (v) => cfg.memory.auth = v);
  bindText("memTokens", (v) => cfg.memory.tokens = v);
  bindText("memTimeout", (v) => cfg.memory.timeout = v);

  // Access
  initChips({ box: "userChips", input: "userInput", add: "userAdd", numeric: true, get: () => cfg.allowedUsers, set: (a) => cfg.allowedUsers = a, empty: "nobody — add your telegram user id" });
  bindText("publicUrl", (v) => cfg.publicUrl = v);
  bindText("apiRoot", (v) => cfg.apiRoot = v);
  bindText("httpPort", (v) => cfg.port = v);
  $("publicUrl").value = cfg.publicUrl;
  $("apiRoot").value = cfg.apiRoot;
  $("httpPort").value = cfg.port;
  segmented("logSeg", ["debug", "info", "warn", "error"], () => cfg.logLevel, (v) => cfg.logLevel = v);

  // Providers + thinking
  renderProviders();
  $("addProv").onclick = () => {
    provDraft.push({ id: ++provSeq, name: "", kind: KINDS[0], baseUrl: "", auth: "" });
    renderProviders(); markDirty();
    const cards = document.querySelectorAll("#provs .prov:last-child .pname");
    if (cards.length) cards[cards.length - 1].focus();
  };
  initChips({ box: "favChips", input: "favInput", add: "favAdd", get: () => cfg.favorites, set: (a) => cfg.favorites = a, empty: "no favorites — add refs you switch between" });
  refreshThinking();
}

async function load() {
  try {
    const res = await fetch("/api/config", { headers: { "x-init-data": initData } });
    if (!res.ok) { msg("Load failed — " + res.status, "err"); return; }
    const c = await res.json();
    populate(c);
    loading = false;
    msg("All changes saved");
    updateSave();
  } catch (e) {
    msg("Load failed — " + e, "err");
  }
}

// ---------- boot ----------
initTabs();
initSheet();
$("save").onclick = save;
if (tg) {
  if (tg.expand) tg.expand();
  try { if (tg.setHeaderColor) tg.setHeaderColor("bg_color"); } catch (e) {}
  try { if (tg.setBackgroundColor) tg.setBackgroundColor("bg_color"); } catch (e) {}
  if (tg.BackButton && tg.BackButton.onClick) {
    tg.BackButton.onClick(() => {
      if (tg.showConfirm) tg.showConfirm("Discard unsaved changes?", (ok) => { if (ok) window.location.reload(); });
    });
  }
}
if (!initData) {
  loading = false;
  msg("Open from the Telegram menu button — settings need Telegram's proof of identity.", "err");
} else {
  load();
}
</script>
</body>
</html>`;

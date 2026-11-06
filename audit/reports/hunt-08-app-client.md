> Audited 2026-10-23 17:30 local, at repo commit `9d4f861e` (tracked tree clean; only untracked audit/ notes).

# Hunt 08 — App client (app/) bug hunt

Scope per brief: everything under `app/src/` except `speech.tsx`, plus
`app/index.html`, `app/public/`, `app/vite.config.ts`, `app/tsconfig.json`.
Read-and-report only. No suite/typecheck runs (operator override); one
sanctioned scratch test was written and run (P1 below). All line numbers
from the current tree.

---

## 1. Findings (most severe first)

### P1 — Composer voice recorder never stops on unmount; mic stays live and the recording is lost
- **File:** `app/src/ChatView.tsx:1514-1607` (recorder state, `startRecording`,
  `stopRecording`), rendered at `app/src/ChatView.tsx:1844-1854`.
- **What:** The recorder is click-to-start (`aria-label="Record a voice note"`
  → `startRecording`, which calls `navigator.mediaDevices.getUserMedia` and
  `new MediaRecorder(stream)`). `stopRecording` runs only from the
  in-composer Cancel / Stop-and-send buttons. There is **no unmount cleanup**:
  no effect return stops `recorder.current` or the stream tracks. If the
  operator starts a recording and then navigates (rail click, note link, any
  route change — the composer unmounts), the composer's stop affordances are
  gone, `onstop` never fires, and the audio tracks are never stopped.
- **Consequence:** The browser keeps the microphone hot (tab-level recording
  indicator) with no in-app UI to stop it, capture continues into a detached
  chunks buffer until the tab closes, and the recorded audio is unreachable
  (neither sent nor recoverable).
- **Verified:** scratch test `/tmp/goblin-hunt-08-recorder.test.tsx` (mounted
  `Composer` with a fake `getUserMedia`/`MediaRecorder` in happy-dom, clicked
  the mic, unmounted): `track.stop` calls = 0, `recorder.stop` calls = 0.
  Test passes, proving the leak.
- **Rule violated:** wrong behavior on a plausible path (privacy-sensitive
  device left running). No design/app.md ruling names it; it is a plain
  correctness defect against the transcript contract the composer otherwise
  keeps ("Release-sends … the same shape Telegram voice notes take",
  ChatView.tsx:1511-1513).
- **Test that would catch it:** the scratch test above, reduced into
  `Composer.test.tsx`.

### P2 — Settings TTS engine select can crash the whole app during the client/server version-skew window
- **File:** `app/src/SettingsView.tsx:1687-1692` (hardcoded engine options),
  `1700`, `1702`, `1708`, `1711`, `1722`, `1725` (`kinds?.ttsDefaults[draft.tts.kind].model/.auth`
  chains).
- **What:** The TTS `Engine` `<select>` lists a **hardcoded** client-side
  vocabulary (`edge|openrouter|logfare|mimo|onemin`), while the defaults come
  from the server response (`ttsDefaults: typeof ttsCloudDefaults`,
  `src/http/operator-wire.ts:32`, `src/config.ts:419-426`). The load-time
  fence at `SettingsView.tsx:1162-1165` guards exactly this "freshly built
  client against a not-yet-restarted server" window — but only checks
  `authDefaults` and `modelCatalog`. If the running server predates a TTS
  kind the client offers (e.g. `onemin`), `ttsDefaults["onemin"]` is
  `undefined` and `.model` throws a TypeError **during render**. There is no
  error boundary anywhere in `app/src` (grep: no `componentDidCatch` /
  `getDerivedStateFromError`), so React unmounts the entire tree — blank PWA
  until reload on a restarted server.
- **Trigger:** deploy window (new client bundle published, old server still
  running) → Settings → Voice → Text to speech on → Engine → pick the kind
  the old server doesn't know.
- **Rule violated:** AGENTS.md Guardrails — "Fail loud" cuts both ways: this
  fails *silent and total*; the code's own comment at line 1158-1165 says
  this window "must fail loud here, not crash later" and the tts path crashes
  later.
- **Label:** static inference — not executed (the one scratch test was spent
  on P1); the missing-key → undefined-index chain is mechanical.
- **Test sketch:** settings response fixture without one ttsDefaults key →
  switch engine to it → expect a visible error, not a thrown render.

### P3 — Trailing-slash deep links silently render the empty chat state
- **File:** `app/src/App.tsx:97-100` (`windowFromPath` requires `/window$`),
  `:181-183` (`deepLinkConv` requires `$` right after the id) — while
  `pageFromPath` (`:76-80`), `projectFromPath` (`:85-88`), `noteFromPath`
  (`:91-94`) all accept an optional trailing slash.
- **What:** `/app/c/<id>/` (a hand-typed or link-mangled conversation URL)
  and `/app/c/<id>/window/` fail both matchers, fall through `onPop`/the
  page initializer to `setPage("chat"); setCurrent(null)` — the operator
  lands on "Pick a conversation, or say something" with no error, and a
  fresh conversation could be started from a URL that named one.
- **Rule violated:** design/app.md → Spin-off → Links ("`{publicUrl}/app/c/<appId>`
  opens one conversation") — the link shape is load-bearing; the matcher is
  stricter than every sibling matcher in the same file. Invariant hygiene.
- **Test sketch:** `deepLinkConv("/app/c/abc/")` → expect `"app/abc"` (or a
  documented refusal), same for `windowFromPath("/app/c/abc/window/")`.

### P3 — TokenGate misdiagnoses network failures as a rejected token
- **File:** `app/src/App.tsx:205-210`.
- **What:** `submit()` proves the token with `listConversations(token)`; the
  catch maps `ApiError 503` to "The app channel isn't configured" and
  **everything else** — including `TypeError` from an unreachable tailnet —
  to "That token wasn't accepted." An operator whose tailnet is down is told
  a valid token is bad, inviting pointless rotation. `AppShell`'s probe path
  (`:777-786`) already has the correct split (`ApiError` vs
  "Couldn't reach goblin — check the tailnet."); the gate doesn't reuse it.
- **Rule violated:** AGENTS.md — "Fail loud … every failure surfaces with
  enough context to debug it"; wrong diagnosis on a plausible path (network
  blip at gate time).

### P3 — Post-turn and idle-reconnect history re-reads swallow failures with no surface
- **File:** `app/src/ChatView.tsx:2386-2394` (`refreshTranscript` rejects with
  `() => {}`) and `:2431-2445` (`idleReconnect.current` reject `() => {}`).
- **What:** the reconciliation GET failing (server briefly down, auth expiry)
  is completely silent: no log line, no transcript hint. Consequences the
  operator can't see: the ratings bar (`applyRatingSnapshot`) never refreshes
  after a turn (design/app.md → Reply ratings: "The action bar refreshes the
  list after reconnect reconciliation and turn finish"), and an idle
  reconnect's durability promise (#79) is skipped without notice. The comment
  says "A failed re-read leaves the snapshot standing" — deliberate, but
  nothing anywhere surfaces it.
- **Rule violated:** AGENTS.md Guardrails — "Fail loud. Never swallow an
  exception." Severity stays P3 because the transcript itself still stands.

### P3 — `restoreNoteVersion` bypasses the shared request layer
- **File:** `app/src/api.ts:433-447`.
- **What:** every other note call rides `rawRequest` (door rewrite to
  `/api/*` + `x-init-data` on the telegram door, bearer otherwise), but
  `restoreNoteVersion` hand-rolls a bare `fetch` with only the bearer header.
  Unreachable on `/t/` today (the mini app renders only settings/memory,
  App.tsx:489-494), so it's hygiene, not behavior: a latent trap the day a
  note surface mounts on the telegram door — the restore would 404 there
  while every sibling call works.
- **Rule violated:** AGENTS.md — "Each external contract is known by one
  adapter" (the adapter exists; this call steps around it).

### P3 — Files view offers a preview that can never render for `.svg` attachments
- **File:** `app/src/StateViews.tsx:218-224` (`attachmentKind` puts `svg` in
  the `image` class) and `:290-292` (`<img src={blobUrl}>`).
- **What:** the Files view fetches bytes through `/api/app/attachments/file`
  (`src/http/operator.ts:1201-1224`), whose content-type map deliberately
  excludes svg — design/app.md → State viewer: "svg absent from the
  content-type map (it downloads rather than renders same-origin)". The
  blob arrives `application/octet-stream`, so the "preview" button produces a
  broken `<img>` while `.png` etc. preview fine. The chat-side helper gets
  this right (ChatView.tsx:143 `INLINE_IMAGE` excludes svg).
- **Rule violated:** the design's svg ruling, on the operator surface;
  invariant hygiene (dead affordance).

### P3 — Recording hint copy describes a hold-to-record control that doesn't exist
- **File:** `app/src/ChatView.tsx:1845-1851` — hint text "recording — release
  sends" over a click-to-toggle button (`aria-label` flips to "Stop and
  send"). Nothing in the mic button's handlers (`:1942-1965`) implements
  press/hold. Misleading name/label for the actual interaction.

### P3 — Client-side mirrors of server vocabularies escape the wire-type guardrail
- **Files:** `app/src/tools/schemas.ts:1-52` (zod copies of every bespoke
  tool's args/output shapes — the header admits "the client's copy of each
  tool's contract, mirroring src/agent/tools/*.ts");
  `app/src/settingsDraft.ts:81` (`TtsKind` union re-declares the server's
  tts kinds), `:18-26` (`THINKING_ORDER` "Mirrors the server's
  thinkingLevels"), `:45-67` (`VOICE_SUGGESTIONS`).
- **What:** the AGENTS.md app-client guardrail is "wire types are imported
  from server sources so config schema changes break typecheck, not the
  page". These mirrors don't break anything at typecheck; a server-side field
  rename silently degrades the client to the generic tool renderer (visible
  but degraded — the fallback is by design) or, for TTS kinds, to the P2
  crash path. Severity P3 because failure is visible/degraded, not silent
  corruption — but they are redefined copies in the client of contracts the
  server owns, which the brief flags as findings.

### Leads (unverified, flagged for a design ruling or a future pass)
- **Failed send in an existing conversation drops the draft permanently.**
  `ChatView`'s composer `onSend` returns void (`ChatView.tsx:2595-2598`), so
  `Composer.send` treats it as accepted and clears the durable draft
  (`:1700-1712`). If the POST then fails at the network level, the user
  message lives only in local `useChat` state with "The turn failed"; after a
  reload both the message and the draft are gone. design/app.md → Composer
  drafts says a draft is "removed by an accepted send; a declined or fenced
  send keeps it" — whether a locally-accepted-but-network-failed send counts
  as "accepted" needs a ruling. (`startChat`'s lazy-create path handles this
  correctly by returning `false`.)
- **MemoryView's 10s status poll lacks the serialization the feed was given.**
  `app/src/MemoryView.tsx:108-122` ticks every 10s with no in-flight guard
  and no sequence fence; overlapping responses can land out of order. The
  2026-10-20/22 rulings (design/app.md → Delivery and arm truth) govern the
  responsibility feed specifically, so this is an analogy, not a citation —
  but the same sustained-latency argument that produced the feed's serialize
  rule applies to this poller.

---

## 2. Checked and clean (later passes can skip)

- **HtmlFrame containment** (`app/src/ui/HtmlFrame.tsx`): `sandbox="allow-scripts"`
  only, CSP meta injected first (nothing executes ungated before it), meta
  refresh stripped at the source (quoted/bare, any attribute order) plus a
  live MutationObserver for script-inserted ones, capture-phase click guard
  cancels all anchor navigations and re-expresses `#fragment` as the frame's
  own hash, `base-uri 'none'`, height postMessage accepted only from this
  frame's own `contentWindow` and clamped 80-900. Matches design/app.md →
  Intelligent UI escape hatch line by line, including the documented
  `location`-assignment residual.
- **Chart** (`ui/Chart.tsx`): hand-drawn SVG, zero html injection surfaces;
  zero-total guards, largest-remainder percentages, single-100% slice circle
  special case; `series[0]!` backed by the schema's `.min(1)`
  (src/agent/tools/ui-schema.ts:71).
- **UiPart/blocks/picks** (`ui/`): all block payloads re-validated through
  the server's own `ui-schema.ts` (imported, not copied); invalid → generic
  tool row or skeleton, never blank; streaming pins html to skeleton at any
  depth; `[ui]` actions ride the composer's visible send; tab panels keyed by
  active tab (uncontrolled form values can't leak across tabs).
- **markdown.tsx adversarial content**: the only `dangerouslySetInnerHTML`
  in the client is hljs output (escapes markup by contract, wrapped in try);
  autolink/link hrefs are regex-confined to literal `http(s)://` (no
  `javascript:` can earn an anchor); no `<img>` synthesis anywhere in the
  transcript renderer; table wrapper + `overflow-wrap: anywhere` per the
  2026-10-21 ruling; machinery tag lines fenced via server-owned
  `isMachineryText` (src/tags.ts — a leaf import).
- **Tool part renderers** (`tools/`): every bespoke view narrows through
  zod first and falls back to `genericView`; unknown tool names and future
  part states land on generic/skeleton faces, never blank (`mod.tsx` header
  contract holds); search/fetch URLs gated by `isHttpUrl` before earning an
  anchor; all clips capped.
- **telegram.ts**: local stand-in never fetches third-party bytes, injected
  SDK wins, hash-param parsing mirrors the official parser (`+`→space,
  undecodable stays raw), plain-browser initData stays empty so the door
  shows its notice. Covered by `telegram.test.ts`.
- **api.ts token storage**: sessionStorage + localStorage eviction migration
  is correct (adopt-into-session preserves login; every touch removes the
  persistent copy).
- **settingsSave/SettingsView save flow**: 409 is non-retryable and says
  "reload the page" (client respects the conflict — brief's probe answered);
  autosave gate (dirty/valid/not-saving/signature-not-attempted) prevents
  retry loops; `publicUrl` edits staged behind explicit Save; pending
  provider names hold autosave and refuse Save; post-save provider auth ack
  reconciles without clobbering concurrent edits.
- **NoteEditor/NoteView/noteDraft**: the draft CAS (snapshot compare-delete),
  compare-and-swap writes for detached editors, conflict forward-guards
  (`stateRev` ordering), Keep-mine forced write on `theirs.rev`, title/body
  single-lane saves, unmount drain, pagehide keepalive with measured wire
  bytes — read end-to-end and found coherent; the leave-guard/discard-ref
  wiring into App's navigation matches design/app.md → State viewer dirty
  rulings.
- **InterruptedTurns**: matches design/app.md → Interrupted turn recovery —
  decisions gated on server ack, resume disabled while `dispatched` calls
  stand, 409 refetches instead of trusting the copy, acknowledged runs
  dropped client-side and reconnected via `resumeStream`, no optimistic
  mutation, server reasons shown verbatim.
- **ResponsibilityFeed**: sequence-fenced responses, in-flight-serialized
  polls, stale-state banner over loaded rows — implements the 2026-10-20/22
  rulings exactly.
- **PushControls + sw.js**: VAPID key base64url→bytes decode, subscription
  body validated before send, endpoint shown to the server only as a SHA-256
  hash; sw push payload clamped to same-origin `/app/` targets,
  notificationclick focuses an `/app/` window or opens one — generic payload,
  no reply text (matches the 2026-10-22 push ruling).
- **vite.config.ts dev proxy**: Origin-laundering restricted to the dev
  server's own requests (`origin.host === req.headers.host`), cross-origin
  keeps its headers so the trust gate still refuses — comment-documented and
  correct.
- **Wire types**: no client-side redefinitions of wire types anywhere
  (grep-verified) — all imported from `src/http/app-wire.ts`,
  `src/http/operator-wire.ts`, `src/config.ts`, `src/agent/attachments.ts`,
  `src/agent/tools/ui-schema.ts`, `src/tags.ts`. No `any`, no
  `@ts-ignore`/`@ts-expect-error` in scope. `app/tsconfig.json` joins the
  typecheck program; `telegram-webapp.d.ts` stays under app/src only.
- **App.navigation-races.test.tsx**: covers late-completion races for the
  create-project dialog, note mint from project page/notes index, cancelled
  project starts (restore-only-origin, destination-draft preservation, row
  removal), typed-after-send preservation, fenced note chats, double-mint,
  and note-chat during held cleanup. What it does **not** cover (and where
  the P1 lives): unmounting a composer **mid-recording**, and any composer
  teardown that owns live browser resources rather than parked drafts.

## 3. Couldn't verify / no written source found

- **AI SDK runtime semantics** relied on while reading ChatView: `stop()`
  flipping status back to "ready" a tick later (the steer comment at
  ChatView.tsx:2460-2464 asserts it), `onFinish` `isAbort` semantics,
  `resume`-on-mount's 204 → `reconnectToStream` returning null (the wrapper
  exists precisely because the SDK exposes no callback). These are
  comment-documented and test-covered per the repo's suite, but I did not
  execute them.
- **CSP meta honored inside `srcdoc` iframes across target browsers** — the
  design says the mechanism was probed live when built; I did not re-probe.
- **P2 (TTS version-skew crash)** is static inference; one scratch test was
  allowed and was spent proving P1. The missing-key → `undefined.model` chain
  is mechanical given `typeof ttsCloudDefaults` keying.
- **Sqlite/broker-side behavior** of anything the client consumes — out of
  scope (hunt 7 owns the HTTP endpoints).
- Scratch-test side effects: `/tmp/goblin-hunt-08-recorder.test.tsx` and a
  `/tmp/node_modules` symlink (created so bun could resolve `react` from
  /tmp) remain under /tmp.

---

## 4. Simplifications & code smells (P3, evidence-backed)

1. **Three copies of the auth/door header dance.** `api.ts rawRequest`
   (:137-154) is the one adapter; `api.ts fetchAttachment` (:896-910)
   re-implements its telegram/bearer logic inline, and
   `ChatView.fetchAttachmentUrl` (:145-156) re-implements it a third time —
   against a *different* endpoint shape (`/api/app/attachments/<name>` vs
   `/api/app/attachments/file?name=`). `rawRequest` already returns the
   `Response`; both blob paths could compose on it.
2. **`bytes` vs `fmtBytes`**: byte formatters duplicated —
   `opsShared.tsx:31-35` (`bytes`) and `tools/parse.ts:148-152` (`fmtBytes`),
   identical logic, different names; ChatView imports `bytes` into the chat
   while the tool renderers two files over use `fmtBytes`.
3. **`relTime` duplicated**: `App.tsx:143-155` and `memoryShared.tsx:10-24` —
   same open-webui-style relative-time ladder in two variants.
4. **Identical SVG glyphs**: `App.tsx` `PinGlyph` (:243-261) and
   `PinActionGlyph` (:282-287) render the same markup; one of the two (plus
   `ActionGlyph` wrapping) makes the other redundant.
5. **Address-slice hand-rolls**: `api.ts` defines `seg()` at :492, but
   `getMessages` (:452) and `stopConversation` (:474) inline
   `id.slice("app/".length)` instead; `ChatView.tsx:2327` uses a magic
   `id.slice(4)` for the same address.
6. **Dead optional chaining as false comfort**: the `kinds?.ttsDefaults[...]`
   chains in SettingsView (e.g. :1700, :1708) — `kinds` is guaranteed
   non-null past the `kinds === null` render fence, so `?.` does nothing,
   and it protects nothing against the actual failure mode (the P2 missing
   key). Reads as validated; isn't.
7. **`TelegramDoor`'s `useState` that never sets**: `App.tsx:499`
   `const [chatWidth] = useState<ChatWidth>(loadChatWidth)` — the setter is
   dropped; a plain `const chatWidth = loadChatWidth()` says the same thing
   without implying state.

# App channel — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## App channel (PWA → APK)

Ruling 2026-09-30, operator ask. Telegram stops being the only channel:
goblin grows a second, disjoint one — the app.

**Why.** The operator's reading pains live in Telegram's client, not in
goblin: long replies read as 4096-chunked fragments, topic lists desync
between devices (a client cache bug goblin cannot fix), and Mini Apps
cold-start in 4-5s on Android — that is Telegram's WebView container, not
our payload (BotFather's own app is equally slow, which is the proof).
Arrival is fine where it is; reading moves.

**The shape: disjoint channels.** Two conversation pools, one store. A
conversation is born on the surface where it starts and stays there —
Telegram conversations deliver to Telegram exactly as before, app
conversations (`app/<id>`) stream to the app. No mirroring, no fan-out,
no cross-surface reading: routing is decided by the address kind alone.
The channels share the turn loop, tools, config, memories, skills — and
nothing else. Deliberately dumber than the aliasing and mirroring
proposals considered and rejected in the same conversation: the moment
"where does this answer appear" has any answer longer than "where you
asked", the operator has to think before reading, and that thinking is
the bug.

**Protocol: the store already speaks it.** History is UIMessage JSON
(envelope v1); the turn loop already produces a UIMessage stream
(`toUIMessageStream`) that the Telegram sink consumes today. The app
endpoints pipe what exists: history reads serve stored UIMessages
verbatim, chat requests run a turn and stream the same shape. Store
format = wire format — no translation layer to design, drift, or test
twice. `POST /api/app/conversations/<id>/stop` rides `runtime.stop` —
the same epoch bump + abort the Telegram `/stop` command owns — so the
client's Stop button ends the turn server-side, not just its stream.

**Auth.** No Telegram `initData` exists outside Telegram. The app
channel's lock is a bearer token on `/api/app/*` — optional since
2026-09-30 by operator ruling, on the collie precedent: device-level
trust — tailscale proves the device — with no person-level auth.
`appToken` in config names an auth.jsonl record — config stays
secret-free per the Config invariant — and the mode resolves once per
process at boot (boot-pinned: a mid-run `appToken` flip applies only
after restart, `onConfigWritten` warns). Set → bearer required: the
record resolves per request through the same `resolve()` every other
credential rides (pass-keys `!command` records included); a wrong or
missing token → 401, an unresolvable record → 503 — both logged.
Rotating a record's value needs a restart, because `loadAuth` is a
boot-time snapshot and `resolve` memoizes per name. Unset → trust
mode: `/api/app/*` serves unauthenticated — the tailnet is the only
lock. Boot logs the mode either way, and trust mode adds a warn that
is the guardrail: **funnel is a misconfiguration** — if `publicUrl`
ever points at a funnel address (public HTTPS), a token becomes
MANDATORY; the warn line exists to catch it. The mini app keeps its
initData validation untouched.

**Client.** React + `@ai-sdk/react` (`useChat`) in `app/` — Vite, strict
TS, its own tsconfig program wired into `bun run typecheck`. This is the
recorded amendment to the no-build rule: `src/http/app.js` (the settings
mini app) keeps the ships-as-served treatment forever; the app client is
a built artifact because React is the price of the SDK's chat pieces, and
built artifacts are allowed exactly there and nowhere else. `src/http`
serves `app/dist` under `/app/`; a missing build is a fail-loud 500 with
a log line, never a silent empty page. Tool activity renders as an
expandable "Worked" row (pattern lifted from openclaw's app — mechanism
only, zero code adopted).

**Packaging ladder.** PWA first, on the tailnet URL through the existing
`tailscale serve` door — manifest + service worker make it installable
(home-screen icon, ~1s open, zero APK churn while iterating; the operator
evaluated twenty-APK development and declined). APK via Capacitor when
stable: same build output wrapped, plus the Android share-target intent —
the thing PWAs cannot do (Android's share sheet lists only real installed
apps, observed 2026-09-30) — and later FCM if push is ever demanded. TWA
is rejected on mechanism: Google's assetlinks verification cannot pass on
a tailnet-only domain. PWA and APK are one channel in two shells; nothing
in the server knows which is talking.

**Logging.** The app boundary joins the existing bar: intake (message →
app address), auth failures, stream start/finish, attachment uploads —
each a line with the fields to reconstruct it from `goblin.log`.

**Landing note.** The channel landed in three staged commits behind the
gate "existing telegram tests pass unmodified". The gate means no
pre-existing assertion was modified or removed; additive assertions
inside existing files are allowed (the address round-trip test gained
its `app/` rejection line in place, `src/tg/notify.test.ts`).

**Out, explicitly:** mirroring or cross-channel reading of any kind
(revisit needs a ruling here), app-side push (Telegram stays the bell for
its own conversations; app conversations ring nothing until FCM is
demanded), widgets, in-app voice mode, iOS.


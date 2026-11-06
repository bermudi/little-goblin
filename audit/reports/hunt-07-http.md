> Audited 2026-10-23 16:44 local, at repo commit `59d3f7d7` (tracked tree clean; only untracked audit/ notes). Production files are identical at `9d4f861e`, the HEAD this audit closed on — its sole change is app/src/WindowView.test.tsx.

# Hunt 07 — src/http/ + app boundary modules

Bug hunt against goblin v2, scope per `/tmp/goblin-hunts/hunt-07.txt`: every
module in `src/http/`, plus `src/app-approvals.ts`, `src/app-link.ts`,
`src/app-media.ts`, `src/app-push.ts`, `src/stateview.ts` and their colocated
tests. Read-and-report only. Governing spec: `design/app.md`, `DESIGN.md` →
Product boundary / Domain model, AGENTS.md → Guardrails.

Verification: `bun test src/http/ src/app-media.test.ts src/app-push.test.ts
src/stateview.test.ts` → **313 pass, 0 fail** (from repo root, preload loaded).
`bun run typecheck` → clean (both programs). Additional one-off probes were
run through the `app-testing.ts` rig from `/tmp/goblin-hunt-07/*.test.ts`
(read-only; no repo files touched, no live services, no secrets read).

---

## 1. Findings (most severe first)

### F1 — P1: one malformed UIMessage part permanently poisons the conversation

- **Where:** `src/http/app-chat.ts:30-71` — the `chatBody` schema. Parts are
  validated as `z.looseObject({ type: z.string() })` plus a `superRefine` that
  checks only `NOTE_PART`, `SKILL_PART`, and `ATTACHMENT_PART` data. The
  payloads of `text` (and `file`/`image`/unknown) parts are never validated;
  `runtime.submit(conv, message as UIMessage, sink)` (app-chat.ts:320) receives
  the cast result.
- **Triggering input (probe-verified through the real rig):**
  `POST /api/app/chat` with
  `message.parts: [{ "type": "text", "text": 12345 }]`.
  Accepted with 200, persisted verbatim, and the turn fails with
  `"Invalid prompt: The messages do not match the ModelMessage[] schema."`.
  Every *subsequent well-formed* turn on that conversation fails the same way
  (probe: three consecutive turns, `roles=["user","user","user"]` — no
  assistant event ever lands). Recovery is only deleting the conversation;
  `retry` re-submits the poison, and there is no message-edit surface.
- **Why it's a bug, rules violated:**
  - AGENTS.md → Guardrails: "Validate external input with zod at boundaries
    (config, Telegram updates, tool args, disk state)." The client-supplied
    UIMessage is external input at the `/api/app/chat` boundary; its part
    payloads cross unvalidated.
  - DESIGN.md → Domain model → Turn exceptions (the poison-pill precedent):
    a bad submit's "message stays in history and **degrades to a readable
    placeholder in later model views**". The degradation seam exists
    (`src/turn/view.ts:202-221`, "message unconvertible — degrading to
    placeholder") but never fires here: `convertToModelMessages` happily
    passes a wrong-typed `text` part through, and the failure lands later at
    `streamText`'s `standardizePrompt`. So the documented self-healing does
    not exist for this shape.
- **Test sketch:** POST `/api/app/chat` with `parts:[{type:"text",text:1}]`
  → expect 422 (boundary refusal); or, if intake stays permissive, POST a
  malformed then a good message and assert the second turn completes and an
  assistant event persists. Probe scripts: `/tmp/goblin-hunt-07/probe-poison.test.ts`.
- **Severity rationale:** not P0 — single-operator tailnet client, fails loud
  on the wire, no secret/crash/data destruction beyond the conversation's
  future replies. P1 because a plausible client defect (non-React client,
  buggy release, APK webview) silently converts a conversation into a
  permanent error loop.

### F2 — P2: trust-mode origin gate no longer matches its written ruling (own-Host accepted vs loopback-only)

- **Where:** `src/http/app-auth.ts:35-48` (`allowedBrowserOrigins`) and
  `:50-78` (`browserMutationRefusal`).
- **Rule (design/app.md → App channel → Auth, ruling 2026-10-08 #75):**
  "`Origin` must match the request's own Host (either scheme — TLS ends at
  the front) or the configured `publicUrl`'s origin", and the trade-off
  paragraph adds: "The request's own Host is accepted **for proxy
  compatibility**… a stricter pinned-origin policy needs **its own ruling**."
  The same section accepts a DNS-rebinding residual: "The residual is
  accepted for proxy/direct-access compatibility."
- **Code:** once `publicUrl` is set it is the only accepted origin (good);
  without it, **only literal loopback hosts** may mint a Host-derived origin
  (`isLoopbackHost`). A browser on a non-loopback Host whose `Origin` matches
  its own `Host` — exactly the documented "proxy compatibility" shape — is
  refused 403 on every mutation.
- **History:** commit `a023bda6` ("fix(http): a Host header cannot mint its
  own browser origin", 2026-10-09) deliberately tightened this and pinned it
  in `src/http/app-auth.test.ts:119` ("a spoofed Host minting its own Origin
  match is refused (DNS rebinding)"). The design doc was never amended, and
  the doc itself demands a ruling for exactly this tightening — none exists
  in `design/app.md`.
- **Impact:** availability-only, and only for non-sanctioned fronts (a proxy
  that preserves Host; direct access via a tailnet hostname). The code is the
  *safer* side; the divergence is the finding. Fix direction is a doc
  amendment recording the 2026-10-09 ruling (or restoring the documented
  behavior if proxy compatibility was actually load-bearing).
- **Severity rationale:** P2 — documented access shape refused on an edge
  deployment; sanctioned doors (loopback, `tailscale serve` + `publicUrl`)
  work and are test-pinned.

### F3 — P3: app-door attachment read-back serves through symlinks (realpath containment layer missing)

- **Where:** `src/http/app-attachments.ts:82-115` — `GET /api/app/attachments/<name>`
  validates the name only lexically (`basename(name) !== name`, no leading
  dot, `isStoredAttachmentPath` = `resolve(path).startsWith(dir + sep)`,
  `src/agent/attachments.ts:125-128` — no symlink resolution) and serves via
  `Bun.file(file)`, which follows symlinks.
- **Rule (design/app.md → Operator console → State viewer, ruling 2026-10-11):**
  "Two layers, each sufficient: zod validation of every name/path/param, then
  containment in **realpath space**, so neither lexical traversal nor symlink
  indirection escapes" and the viewer "serves real files, never links". The
  section's Attachments sentence covers the read-back ("read-back serves
  inert bytes"). The *operator* door (`/api/app/attachments/file` →
  `stateview.attachmentPath` → `contained()` realpath check) honors this and
  is test-pinned (`app-channel.test.ts:212`).
- **Probe-verified:** with a symlink `<attachments>/leak.txt → /tmp/…/loot.txt`,
  the app door returned `200` + the outside file's bytes, while the operator
  door refused. Existing coverage (`app-attachments.test.ts:65`) pins only
  lexical traversal (`..%2F..%2Fconfig.json`, dotfiles, subpaths) — not
  symlink indirection.
- **Reachability caveat:** planting the symlink requires local write access
  to `$GOBLIN_HOME/attachments` (the agent's own tools, or the operator);
  the agent can already read files directly, so this is invariant hygiene,
  not an exfil primitive — hence P3, not higher.
- **Same class:** `app-chat.ts:61-69` gates client-posted `ATTACHMENT_PART`
  paths with the same lexical `isStoredAttachmentPath`; `deps.transcribe`
  (app-chat.ts:233) then reads through any symlink the same way.

### F4 — P3: failed turns emit the terminal SSE error chunk twice

- **Where:** `src/http/app-sse.ts:69-84` (`finish` pushes a synthetic
  `{"type":"error"}` for every non-`completed` done) on top of the SDK's own
  error chunk that already rode the wire via `emitChunk`
  (`src/turn/stream.ts:598-605`, `onError` → uiStream error part).
- **Probe-verified:** a failed turn's body ends with
  `data: {"type":"error","errorText":"Invalid prompt: …"}` twice, then
  `data: [DONE]`. Harmless to the SDK client (it stops at the first error
  part); wire noise and double-log surface. Note `[DONE]` itself is always
  delivered (verified on completed, stop-fenced, and error paths — an earlier
  suspicion from truncated probe output was wrong).

### F5 — P3: the two attachment doors pick content types differently — svg renders inline on the app door

- **Where:** `src/http/app-attachments.ts:105` uses `Bun.file(...).type`
  (extension sniffing) — probe-verified Bun maps `.svg` → `image/svg+xml`,
  which the inline regex `^(image|audio|video)/` matches, so an svg is served
  inline with **no** `content-disposition: attachment`. The operator door
  deliberately maps svg to `application/octet-stream`
  (`src/stateview.ts:296-318`, "svg absent from the content-type map (it
  downloads rather than renders same-origin)" — design/app.md → State viewer
  → Attachments).
- **Mitigation present:** the app door also sets `content-security-policy:
  sandbox` + `x-content-type-options: nosniff`, so scripts cannot execute
  even on top-level navigation — this is door-behavior inconsistency, not a
  live XSS. P3 hygiene; one removed header away from mattering.

### F6 — P3: `/api/app/*` JSON routes have no request-body size cap

- **Where:** all `await req.json()` sites in scope (e.g. `app-chat.ts:108,162`,
  `app-notes.ts:164`, `app-conversations.ts:176`, the `parsedJson` helpers).
  The hook caps at 32 KiB (`mod.ts:49`), the injection check at 64 KiB
  (`check.ts:17`), uploads at 32 MiB (`app-attachments.ts:15`) — JSON bodies
  are bounded only by Bun.serve's platform default. Trusted-operator threat
  model; inconsistent with the capped neighbors. P3.

### F7 — P3: `app_push_deliveries` rows accumulate forever

- **Where:** `src/app-push.ts:143-148` — sent markers are `INSERT OR IGNORE`
  only; nothing prunes old `(notification_key, endpoint_hash)` rows.
  design/app.md → App-native Web Push says "subscriptions and sent markers
  live in SQLite" with no pruning ruling, so this is hygiene, not a ruled
  invariant: one row per (turn × endpoint), unbounded over months. P3.

### F8 — P3: non-null assertion over a disk read in the ratings route

- **Where:** `src/app-conversations.ts:882` —
  `const record = ratings.latestEvent(convId.id, entry.seq)!;` immediately
  after `ratings.recordApp(...)`. If the read ever returns null (store edge),
  the route throws `TypeError` → generic 500 instead of a clean failure.
  P3 invariant hygiene (fail-loud, but with the wrong failure shape).

---

## 2. Checked and clean (later passes can skip)

- **`mod.ts` routing & surfaces:** `/api/app/*` refusal-503 when unwired;
  mini-app door fails closed 503 without a `botToken` (boot independence);
  hook route (method gate, sha256 lookup, 32 KiB cap, post-body re-lookup
  TOCTOU defense, 60 s throttle, 503-not-accepting, log lines);
  `/app`, `/app/c|p|n/<id>` regex-gated shells; `/` redirect; unexpected
  handler throw → logged 500 (wrapping try/catch; `idleTimeout: 255`).
- **`auth.ts` initData:** timing-safe HMAC compare, stale/future windows,
  user JSON guarded, credential material never logged (refusal categories
  only). `localeCompare` vs byte-order key sort is a theoretical mismatch
  only for non-ASCII keys; Telegram's fixed ASCII key set can't hit it, and a
  mismatch fails closed (bad-hmac).
- **`app-auth.ts`:** fixed-length digest bearer compare (no length leak);
  auth-mode boot-pinned (name resolved once in `src/index.ts:722`, value
  resolution memoized by the auth store); resolution failure → loud 503;
  funnel = warn, matching the design's "guardrail warn" wording; bearer mode
  never runs the origin gate; `Sec-Fetch-Site: same-site` refused; non-browser
  clients (no headers) pass — all test-pinned (`app-auth.test.ts`,
  `app-channel.test.ts:110`).
- **`check.ts`:** loopback-only injection endpoint, method/caps/zod/gate
  outage behavior all test-pinned; `readBodyBytesCapped` enforces the cap on
  streamed bodies, not just `content-length`.
- **`app-dist.ts`:** missing build → fail-loud 500 + log line (test-pinned);
  lexical traversal blocked including not-URL-decoded `%2e` inputs (they stay
  literal filenames); `dist` symlink re-resolved per request
  (`existsSync`/`statSync`/`readFile` each follow it at call time — a
  `publish-app.sh` flip serves on the next request without restart; a broken
  symlink reads as missing → the loud 500); cache-control split
  (index no-store, `/assets/` immutable); vite `base: "/app/"` makes both
  `/app/` and `/t/` doors share the one build.
- **`app-sse.ts` heartbeat:** comment ping after 5 s silence sampled at
  1.25 s (well under threshold, no phase-lock), timer unref'd, wire death
  loud (`warn` with conversation) while the turn continues; heartbeat +
  `[DONE]` behavior test-pinned (`app-chat.test.ts:151`).
- **Streaming members / join replay / backpressure:**
  `runtime.subscribeLiveChunks` subscribes + snapshots the wire atomically
  (gapless replay — `runtime.ts:431-440`); `emitChunk` fans out to every
  member with throwing-sink detach (`streamFailed` + warn, never fatal —
  `stream.ts:130-158`); `claimMembers`/`joinMember` replay the whole wire to
  merged/steered members; `endLive` delivers exactly one terminal per
  subscriber; the in-memory log survives overflow attempts (one `live` per
  `runTurn`); idle attach → 204, and the #79 durability ordering is
  test-pinned (`app-conversations.test.ts:409,457`); `data-context` parts
  ride the wire only (replayed to late joiners, never persisted); the
  replay-then-live ordering in the stream route is safe (sync section, no
  await between subscribe and replay loop).
- **Settings freshness (If-Match):** operator save requires If-Match
  (428 missing / 409 stale against a fresh disk read), saves serialize
  through `configSaveQueue`, unknown top-level and `telegram.*` keys refused,
  telegram sub-object merged not replaced, thinking clamped to expressible
  rungs, app-door "settings saved but not applied" 500 split — all pinned in
  `mod.test.ts:233-333` and `app-channel.test.ts:408-535`. The app
  `/api/app/config` PATCH has no If-Match, but its read-merge-write window is
  fully synchronous (atomic in one JS turn) and a competing full save
  re-reads disk at save time, so no silent overwrite exists. Self-lockout:
  mini-app own-id refusal in `saveConfig`; app-door empty-operators-while-
  telegram-enabled refused by the config schema (`config.ts:1017`), with the
  telegram-disabled allowance test-pinned (`app-channel.test.ts:476`).
- **Notes:** If-Match required for content writes and restore (428/409 with
  the row + etag), archived guards, rewrite passes `req.signal`, list cap
  1000 + truncated flag.
- **`stateview.ts`:** the operator-side two-layer containment is correct —
  zod `SEGMENT_SCHEMA`/`REL_PATH_SCHEMA` at the router, realpath `contained()`
  underneath; skill dirs must be real directories (`lstatSync`), links back
  inside their base serve, `ENOENT` → null while everything else propagates;
  log tail bounded (≤512 KiB window, ≤1000 lines, torn writes counted as
  truncation); attachment serve cap 32 MiB → 413; svg absent from the map;
  identity files fixed to three names; **`auth.jsonl` is unreachable from
  every route** — the auth surface exposes record *names* only.
- **`app-push.ts` + `src/http/app-push.ts`:** subscription zod (https
  endpoint ≤4096, bounded keys), status/views expose endpoint hashes only;
  VAPID pair lazily generated into `auth.jsonl`, never logged; payloads
  generic (title/body + `/app/c/<id>`, no reply text/authority); fenced turns
  silent; 404/410 prune vs transient retain; per-done dedupe (WeakMap key) +
  per-key in-flight dedupe; interactive turns ring only when the SSE wire
  died (`app-sse.ts:115-121`); register forces VAPID materialization.
- **`app-conversations.ts` routes:** every `<id>` path segment zod-validated
  (`conversationFromSegment`); conversation create conflict on project
  rebinding; client-side id minting preserved (`appIdSchema`, server UUID
  fallback); ratings — server-chosen rateable set (last assistant event per
  anchor + last of each contiguous unanchored run, verified against
  `app-wire`/design wording), non-rateable ids refused 404; interrupted-run
  decide/resume gates (dispatched calls block resume, 409 names them);
  archive never fences a turn, appended events auto-unarchive, archiving
  clears the pin server-side (`conversation.ts:1181`), pin-on-archived
  refused; delete fences (`runtime.stop`) then sweeps; search scoped to
  `app/%`; window route read-only, 503 unwired, serves capture + lineage.
- **`app-responsibilities.ts`:** reattach conditional on the pre-listing
  snapshot (`StaleAttachmentError` → 409), same-identity unresolved-delivery
  refusal (`ReconciliationConflict` → 409) — both per the 2026-10-20 fences.
- **`app-programs.ts` / approvals:** hook URL revealed exactly once on the
  mutating response; approval lanes resolve presentation-only.
- **`app-media.ts`:** authority check before persist and emit; cleanup on
  failed append; `composeTurnSinks` forwards the optional seams correctly.
- **`app-approvals.ts` / `app-link.ts`:** typed marker parts only, shared
  owners decide; one deep-link builder.
- **Hygiene:** no `console.*` in any scoped non-test file; no `any` (strict
  typecheck passes both programs).

## 3. Couldn't verify / suspected but untraceable

- **Prod topology for F2:** whether trust-mode deployments always sit behind
  `tailscale serve` with `publicUrl` set (making the own-Host refusal
  unreachable in practice) — needs the operator's actual front config; I did
  not touch live services.
- **F3 reachability:** whether the agent sandbox can plant symlinks inside
  `$GOBLIN_HOME/attachments` (sandbox scope is `design/sandbox.md`, out of
  scope here). The route defect itself is probe-verified; only its practical
  reachability is open.
- **F6 platform bound:** Bun.serve's default max request body size was
  assumed (128 MiB) as the only backstop for uncapped JSON routes — not
  measured.
- **Push nuance (no finding):** with a dead submitting client *and* a second
  client still live-watching via attach, `notifyDone` still rings once —
  arguably within "an interactive turn notifies only if its SSE wire died",
  since the *submitting* wire died; I could not trace a written ruling for
  the multi-client interpretation and left it as a lead, not a finding.
- **`localeCompare` initData sort:** byte-order divergence is theoretical
  (Telegram's fixed ASCII key set); fail-closed if it ever fired. Not
  elevated to a finding.

## 4. Simplifications & code smells (P3-level, evidence-backed)

- **Dead code — `src/http/app-auth.ts:80-84`:** a private `jsonBodyRefusal`
  copy that is never called in the module (the used one lives in
  `app-shared.ts`; verified by reference scan). Delete.
- **Duplicated helper — `parsedJson`:** byte-identical in
  `src/http/app-conversations.ts:171-188` and `src/http/app-programs.ts:35-52`,
  while `app-notes.ts` inlines the same jsonBodyRefusal → parse → safeParse →
  422 block four times (lines ~160, 195, 293, 341) and `app-chat.ts` twice
  (tts, chat). One shared helper in `app-shared.ts` would replace six+ copies.
- **Parallel route tables for the two doors:** `mod.ts:30-47`
  (`OPERATOR_TAILS`, `/api/*` shapes) vs `app-channel.ts:19-34`
  (`APP_OPERATOR_TAILS`, `/api/app/*` shapes). The design's "two doors onto
  one surface share validation" is enforced by hand here — a tail added to
  one table and missed in the other silently diverges the doors (the
  `memory/*` vs `attachments` shapes already differ). A single table with a
  door parameter (or a test asserting door parity) would pin it.
- **Double submit/stream plumbing in `app-chat.ts`:** the retry path
  (lines 200-221) and the submit path (lines 312-332) repeat the same
  build-sink → try-submit → catch/dispose/500/log/return-Response block; one
  helper would carry it.
- **Redundant existence check:** `app-conversations.ts:556` checks
  `store.get(...) !== null` before the PATCH body await, then re-checks at
  line 578 after `await req.json()` — only the post-await check is
  meaningful; the first can go.
- **Duplicated pin-guard:** the route-level "cannot pin an archived
  conversation" 409 (`app-conversations.ts:1032-1043`) restates the store
  invariant (`conversation.ts:1135-1144`, throws). Deliberate for a clean
  409, but two codes to keep in sync — a typed store error would collapse
  them.
- **`stateview.ts:465` — `scannedBytes: len`:** reports the *requested*
  window length, not the bytes actually read (`read` may be smaller when the
  file shrank under stat); the neighboring `windowCut` logic already models
  the short read, so the field is mildly misleading on that rare path.
- **`app-conversations.ts:882` non-null assertion** (also F8): replace with
  an explicit not-found branch rather than `!` on a SQLite read.

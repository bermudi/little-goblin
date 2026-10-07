# goblin v2 — bug hunt report (2026-10-06)

> **Restored 2026-10-07.** The file vanished from the tree (not in trash);
> re-written verbatim from the authoring session. Freshness re-check against
> the current tree: **Finding 2 (Bun idle timeout) is fixed** —
> `src/http/mod.ts:507` now sets `idleTimeout: 255`. Everything else re-verified
> still present (line numbers below have drifted by a few; F1's send fallback is
> now at `delegation-lifecycle.ts:838`, F3's recovery claim at `runtime.ts:1007`,
> F5's herdr fallback at `herdr.ts:190`). All other findings and suspicions stand
> as written. The original 2026-10-06 verification statements (tests green, tree
> clean) refer to the tree as it stood at hunt time.

Hunt only, no fixes. Scope: full `src/` sweep against `DESIGN.md` + `design/*.md`
rulings and the AGENTS.md invariants, priority order: concurrent loops →
durable writes → boundary parsing → error paths. Every confirmed finding was
verified by re-reading the full path (two independent passes on the P2s) and,
where marked, by a live reproduction. Nothing in the tree was modified:
`git status` clean, `bun test` 1376 pass / 0 fail (87 files), `bun run
typecheck` (all three tsc programs) pass.

Ranking: **P1 none found · P2 ×2 · P3 ×15.** Fix order suggestion: 1 → 2 → 3 →
4 → 5, then the rest by convenience.

---

## Confirmed findings

### 1. P2 — A failed post-prompt `herdr get` records a stale seq baseline → spurious "done", the real result is never notified

**Files:** `src/delegation-lifecycle.ts` (`launch`, falls back to `0`),
(`send`, falls back to the *previous run's* baseline), (pending-prompt delivery
in `check`, falls back to the pre-prompt seq). Consumed by the done rule:
`if (info.state_change_seq > d.baselineSeq || freshReport)`.

**Trace:** `send()` re-prompts a finished delegation. The design says the row
records "the herdr `state_change_seq` observed **after** prompting"
(design/delegation.md:85) and "send … resets the seq baseline" (:154); the done
rule's correctness rests on that ("a fresh prompt is idle before it's working",
:126-127). When the post-prompt `get` throws (a herdr hiccup in that one
round-trip — the exact case the code comment anticipates), the fallback writes
the *old* baseline, which is strictly below the agent's current seq (the
previous run finished via the seq rule, and the done transition never
re-baselines). The first watcher poll that catches the agent `idle` before it
starts the new work — the state the design itself documents as normal — then
sees `seq > baselineSeq` and fires **done**: a spurious `[delegation: … done]`
notice (the old report was just archived away, so the body is a screen tail),
the row leaves `active()`, and **nothing watches the agent anymore — the real
report is never delivered**. The `send` comment "the watcher's next poll
reconciles" is wrong: no code path re-captures a baseline for a `running` row
(the only re-baselines are the park transitions and the CAS in `transitionIf`).

**Verified:** full code trace, twice (independently). Not yet reproduced
against live herdr. One residual unknown (see suspicions): whether herdr's
`state_change_seq` is ≥1 for a brand-new agent, which would widen the `launch`
site's `0` fallback from theoretical to live.

**Fix:** never fall back to a pre-prompt value — on a failed post-prompt `get`,
keep the row in a "baseline pending" posture (stay `starting`, or store a null
baseline) and have the next scan capture the then-current seq *before* applying
any verdict to that row.

### 2. P2 — Bun's 10 s idle timeout kills quiet app-channel SSE streams and slow handlers; no `idleTimeout`, no `server.timeout(req, 0)`

> **FIXED since the hunt** — `idleTimeout: 255` is now set on `Bun.serve`.
> Kept for the record; the heartbeat consideration below still applies if a
> lower ceiling is ever wanted.

**File:** `src/http/mod.ts` — the only `Bun.serve` config. No
`idleTimeout` and no `server.timeout(` anywhere in `src/` (grep-verified).

**Reproduction (run during this hunt, scratch port 18731, no live state
touched):** a Bun 1.4.2 SSE response that emits one chunk then goes quiet is
closed by the server at **~12 s wall time**; a chunk queued at 15 s never
arrives (`curl -sN` shows `data: hello`, then connection close,
`total_time=12.0s`). `node_modules/bun-types/docs/runtime/http/server.mdx`
("idleTimeout"): *"Bun.serve closes connections after 10 seconds of
inactivity … That includes in-flight requests where your handler is still
running but hasn't written any bytes … If your stream goes quiet for longer
than idleTimeout, Bun closes the connection mid-response."*

**Reachable routinely:** (a) mid-turn tool calls — `tool-input-available` →
`tool-output-available` streams nothing while `bash` (minutes), `fetch` (20 s
timeout), `vision` (120 s) or `delegate` run; (b) pre-first-chunk — recall +
attachment materialization + provider TTFT before the first UIMessage chunk;
(c) the chat route's `await deps.transcribe(...)` before the Response exists;
(d) `/api/app/tts` synthesis of up to 40k chars; (e) attach streams
(`GET .../stream`) idling while the watched turn sits in a tool call.

**Violated:** design/app.md → *Streaming members & resumable streams* — "a
live tail **until the turn's outcome**", "a reload mid-turn re-watches the
in-flight reply". The client sees a connection reset mid-turn and renders a
failure while the turn continues server-side — the ghost-turn UX the ruling
exists to prevent. Recoverable (history + wire log persist; reconnect works),
hence P2 not P1.

**Fix:** in `startHttp`'s `fetch(req, server)`, call `server.timeout(req, 0)`
for the SSE/tts responses (or `idleTimeout: 255` server-wide, plus a periodic
SSE comment heartbeat if a ceiling is wanted).

### 3. P3 — Overflow-recovery claims queued streaming members without the join replay

**File:** `src/runtime.ts` (the `recovery !== undefined` claim block) vs the
replay `prepareStep` performs in its steering path.

When a turn dies of context overflow, the compact-and-resume window (a summary
model call — seconds to minutes) leaves `runtime` admission open; an app client
submitting then is claimed by the resumed `runTurn` via
`lane.pending.splice(...)` — **without** replaying `live.chunks` into the new
streaming sink. `prepareStep`'s steering path does exactly this replay, with
the comment "missed everything emitted before the join — replay the wire log
so its client sees the reply from the first token, not from mid-sentence".

**Violates:** design/app.md → *Join replay*: "A member that attaches mid-turn
first receives everything the wire already saw — from sentence one … carried
across overflow recovery so the resumed attempt continues the same wire
seamlessly." Symptom: that client watches the reply from mid-sentence (the
pre-overflow text is missing) until a history reload.

**Fix:** replay `live.chunks` to claimed streaming sinks in the recovery
branch, same loop as `prepareStep`.

### 4. P3 — A *dangling* symlinked harness settings file gets its link replaced, not written through

**Files:** `src/harness-trust.ts` (`managedPath`: `realpathSync` ENOENT →
returns the **link** path) + `src/durable.ts` (`renameSync(tmp, path)`
replaces the symlink with a regular file).

**Reproduction (run during this hunt):** dangling `~/.claude.json` →
`dots/claude.json` symlink; `realpathSync` → ENOENT, `existsSync` → false;
tmp+rename → `isSymbolicLink() === false`. The link is gone.

**Violates:** design/delegation.md:75-76 — "symlinked settings write through
to the managed target, **never replace the link**" — and the stitch-symlink
discipline in AGENTS.md (write-temp-then-rename silently forks the config).
Live symlinks are handled correctly; only the dangling case forks, silently,
and the dots store stops propagating to that file. `seedCodex` hits the same
shape via `existsSync(path) === false` → empty text → write at the link path.

**Fix:** `lstat` before realpath — a symlink (even dangling) resolves via
`readlink` to its target or fails the launch loudly like the other
unextendable forms.

### 5. P3 — A capped/killed herdr read pours raw agent screen text into an unfenced error string and the log

**File:** `src/herdr.ts`: `let message = (r.stderr || r.stdout).trim() ||
`exit ${r.code}``. When `boundedRun` cap-kills an `agent read` / `pane read`
(output > 1 MiB → SIGKILL → `exitCode null` → `exit_-1`), stderr is empty and
the error message becomes up to 1 MiB of raw screen text. That lands (a) in
`goblin.log` via `readScreenTail`'s warns, contradicting herdr.ts's own rule
("don't put raw agent output into a log or error"), and (b) reaches the model
**unfenced** as `screen unreadable: …` error prose in the `delegate read`
result — design/delegation.md requires failure screens to "travel fenced …
never interpolated into error prose". The notice path is safe; only the error
path leaks.

**Fix:** cap the fallback message (e.g. 200 chars) and never use stdout as the
message for the read verbs.

### 6. P3 — `/forget` crash window can resurrect a "forgotten" document in the bank

**Files:** `src/memory-forget.ts` (settles only rows with state `submitted`) +
`src/memory-queue.ts` (`process()` flips `pending`→`submitted` only *after*
`client.submit` returns and `update` runs).

A crash (or SIGKILL) between Hindsight accepting the retain and the row update
leaves a `pending` row for an operation that is **live remotely**.
`settleInflightRetention` treats `pending` as never-sent and cancels it;
`/forget delete` then suppresses, deletes the local row and the remote
document — after which the accepted op completes and re-creates the document
with no local row left to settle and no retry to suppress against. Violates
design/memory.md ("serialize against in-flight writes before deleting … so
forgotten sources cannot be resurrected"; ruling 4's durable-operation-UUID
protocol exists for exactly this window). Narrow (crash mid-submit + operator
forgets that exact document — the accepted-crash-window class), but the fix is
cheap: before `cancelDocument`, poll `client.operation(opId)` once per
`pending` op of the document and treat non-null non-terminal as `submitted`.

### 7. P3 — File-send timeouts are neither marked uncertain nor noticed (voice and text are)

**File:** `src/tg/delivery.ts` (`sendFile` catch: `failure = { err };
throw err`) vs `sendVoice` → `markUncertain` and the text chunks →
`markUncertain`.

A `sendPhoto`/`sendDocument` timeout is exactly as ambiguous as a sendMessage
timeout (the upload may have landed), but: the sink isn't marked uncertain, so
the turn's remaining text/reaction proceed normally; no "delivery uncertain"
notice is ever sent for files; and `send_file`'s tool result reads `send
failed: …` (`agent/tools/send.ts`), inviting the model to resend content
that may have arrived. design/telegram.md → Delivery: "a sendMessage timeout
is ambiguous … never resend that content … best-effort send a distinct
'delivery uncertain—check Telegram before retrying' notice". The never-resend
half holds at the sink; the mark-uncertain + notice half does not for this door.

**Fix:** on `TelegramTimeoutError` in `sendFile`, `markUncertain(err,
"sendPhoto"|"sendDocument")`, and word the tool error as ambiguous.

### 8. P3 — The transcribe tool reports a provider outage as "the audio may contain no speech"

**Files:** `src/agent/tools/transcribe.ts` (maps `null` to that fixed
string) + `src/agent/transcribe.ts` (over-cap path: a failed *first*
segment warn-logs and `break`s → `texts.length === 0` → `null`).

Under the 25 MiB cap a provider failure throws and the tool correctly says
"transcription failed: …". Over the cap, a whisper outage on a big video note
degrades to *"no transcript produced — the audio may contain no speech"*, which
the model relays to the operator as a diagnosis. The engine's own doc comment
admits the dual meaning of null ("no speech found, or every segment failed");
the tool string collapses them. Violates the design/tools.md tool contract
(every stop names its own recovery) and misattributes a transient failure.

**Fix:** carry a reason out of `transcribeAudio` (`no-speech` vs
`segments-failed`) or rethrow when zero segments produced text.

### 9. P3 — `bell.ts` pings a deleted app conversation under its stale title, contradicting its own comment

**File:** `src/tg/bell.ts`: comment says "a deleted conversation degrades
to the generic label rather than a stale name", but
`deps.store.get(conv.id)?.title ?? conv.title ?? "app conversation"` falls
through to the **captured stale title** when `get` returns null (deleted). The
ping reads `<old title>: …` with an "Open in app" button into a dead
conversation.

**Fix:** branch on `store.get(conv.id) === null` and use the generic label
(drop the button too).

### 10. P3 — Mail subject admits CR/LF; header-injection safety is incidental, not validated

**Files:** `src/agent/tools/mail.ts` (`subject: z.string().max(500)`) +
`src/mail.ts` (`encodeSubject`).

A subject like `hi\r\nBcc: attacker@x` is currently closed **by accident**: the
CR/LF fail `encodeSubject`'s printable-ASCII test, so the whole subject takes
the base64 encoded-word branch and no second header materializes. Residual:
the raw injection text renders in the Telegram approval draft where it isn't
visibly part of the header, and the sent subject contains it literally. Any
future "only encode non-ASCII" refactor opens real header injection on an
approval-gated send path. Violates the AGENTS.md zod-at-boundary rule for tool
args (`to`/`cc` get real validation; subject doesn't).

**Fix:** `refine((s) => !/[\r\n]/.test(s))` on the subject schema.

### 11. P3 — Delegation concurrency-cap TOCTOU on the send-reactivation path

**File:** `src/delegation-lifecycle.ts` (`send`): `live()` → cap check →
**awaits** (report archive, `herdr.prompt`) → `markRunning`. Two `delegate
send` reactivations from different lanes can both pass the cap and both flip
their rows to running → `maxRunning` exceeded. (The `launch` path's check →
`create` segment is fully synchronous — **not** a TOCTOU; only send's is.)
design/delegation.md → Start: "the tool refuses beyond it".

**Fix:** re-check `live()` immediately before `markRunning`, or make the cap an
atomic conditional write.

### 12. P3 — `/app` convenience redirect bounces proxied clients to `127.0.0.1`

**File:** `src/http/mod.ts`: `Response.redirect(`${url.origin}/app/`,
302)` — `url.origin` is the Host the backend saw. Behind any door that rewrites
Host to the loopback target (nginx default, some tailscale serve configs), a
remote operator hitting `{publicUrl}/app` gets a dead `http://127.0.0.1:8787/…`.
The deep-link routes (`/app/c/<id>`, `/app/`) serve the shell directly and are
unaffected.

**Fix:** serve the client shell for `/app` directly (same call as the
deep-link route), no redirect.

### 13. P3 — A directory named `report.md` wedges a delegation's completion forever

**File:** `src/delegation-lifecycle.ts` (`reportBody`: only ENOENT is
"no report"; `EISDIR` throws) — the scan's per-row catch retries every 15 s
indefinitely while the row holds a `live()` slot. Reachable from harness
misbehavior (`mkdir report.md`). Fail-loud per AGENTS.md, but the loop is
unbounded.

**Fix:** treat a non-regular file at the report path as "no report" (screen-tail
fallback), log once.

### 14. P3 — A `reviewModel` rejection bypasses the review-id logging contract

**File:** `src/reviewer.ts`: `await deps.reviewModel(conv)` sits outside
the local failure handling that wraps `generateText`; the rejection (most
likely real-world review failure: model resolve/auth) surfaces via the runtime
backstop's `reviewer failed` line with only `{conversation}` — the one line
that can't be correlated. design/skills.md → Instrumentation: "Every line
carries the review id."

**Fix:** wrap the `reviewModel` await like the generateText call (log with
review id, discard staging, return).

### 15. P3 — A completed turn that renders empty is totally silent

**File:** `src/tg/delivery.ts` (`flush`: `needed =
Math.ceil(body.length / CHUNK_LIMIT)` → 0 chunks → no bubble) and the voice
path (`content.spoken === ""` → nothing synthesized) — no bubble, no reaction,
no warn, in either mode. The operator sees typing… then nothing. Reachable
only from a provider returning an empty final message (not from a Telegram
update), and invisible in the log's delivery lines.

**Fix:** when a completed turn renders empty, send a short placeholder (or at
least emit a warn with the conversation id).

### 16. P3 — Command replies are the one unbounded Telegram send left in `src/tg/`

**File:** `src/tg/commands.ts` (`reply`): bare `.catch`, no
`withTimeout` — on a wedged bot-api the reply hangs ~500 s (grammy's
client-wide default) instead of failing at the 30 s budget every sibling call
uses. Fire-and-forget, so nothing wedges; consistency only. Same shape in
`tg/mod.ts`'s command-failure catch.

**Fix:** wrap in `withTimeout(..., "sendMessage (command reply)")`.

### 17. P3 — `tg_pings` grows without bound

**File:** `src/tg/pings.ts`: one INSERT per delivered ping, forever — no
cap, no GC, no cleanup when the target app conversation is deleted. Correctness
is fine (intake guards `store.get(hit) !== null`; flush-time deletion is
handled by `dropAppBatch`); rows are small; hygiene only.

**Fix:** opportunistically delete rows whose conversation no longer exists, or
cap by age.

---

## Unverified suspicions (not counted as findings)

Each needs one live check; none is confirmed.

- **codex reasoning replay** (`src/agent/codex/model.ts`): assistant reasoning
  parts are dropped from replayed history while the request asks for
  `include: ["reasoning.encrypted_content"]`. On the Responses protocol a
  `function_call` item normally follows its `reasoning` item; replaying
  without it is a plausible 400 on every codex tool-followup turn (**would be
  P2 if real**). Needs one live codex turn with a tool call — not run here
  because it requires reading live OAuth key material (red line). The module
  comment shows the trade-off was known; no test pins a multi-turn tool replay.
- **herdr's initial `state_change_seq`** for a brand-new agent: if the
  launch/prompt itself counts (seq ≥ 1 before any work), finding 1's `launch`
  site (baseline `0`) misfires on first launches too; if seq starts at 0,
  `send` remains the sharp case. One look at herdr's docs/source settles it.
- **`isLoopbackHost` trusts a client-controlled Host header**
  (`http/check.ts`): the loopback bind is the real lock only while every
  fronting door rewrites Host. The design accepts this trust class ("same
  trust class as the hook token-in-URL") — flagging for the door audit, not as
  a defect.
- **`wake()` get-or-creates the pinned address** (`wake.ts`): a delegation
  row pinned to a Telegram topic deleted client-side would resurrect an empty
  conversation on the next notice.
- **Saved-skill notice vs app conversations**: `sendSkillSavedNotice` skips app
  ids ("app conversation rings nothing", tested) while Spin-off rules that
  background turns *ring* — a skill learned during an app-conversation turn is
  announced nowhere except history. Two defensible readings of two design
  files; needs a one-line ruling.
- **program tool non-null assertions** (`agent/tools/program.ts`):
  unreachable today — the `get` → `update`/`get` segments are synchronous —
  but any await added between them turns the `!` into a raw TypeError instead
  of the module's structured `{error}`.
- **`onToolCall` status-only first bubble** (tg/delivery.ts): a tool call
  before any text can emit `"\n\n—\n⚙ bash …"` alone; the empty-window test
  suggests the shape is intended (v1 parity).
- **`decidedBy: "command"` mislabel** (rolling.ts, superseded-check path):
  returned for plain input, but every consumer discards that result when
  `stillRouteable()` is false — latent log-semantics nit only.
- **mail-gws 1 MiB stdout cap vs an enormous unfired history window**
  (`mail-gws.ts`): could loop poll-failures; believed self-healing via
  Google's history-cursor expiry → `HistoryExpiredError` re-baseline
  (unverified).
- **Concurrent `forgetDocument` calls** (Telegram + mini app) serialize against
  the worker but not each other; traced interleavings converge, but no test
  pins it.
- **`/memory status` "degraded"** sticks from `lastRecallOk === false` until
  the next recall attempt even if the outage ended — matches its label; cosmetic.
- **Mail-watcher outage episodes are in-memory** (restart re-warns) — module
  comment claims deliberate; contrast with memory's SQLite episodes.
- **codex `sseEvents` never cancels the body reader on `[DONE]`**
  (`codex/model.ts`) — GC reclaims it; resource hygiene only.
- **Oversize-body status inconsistency**: hook → 413, injection-check → 400.
  No client depends on it.
- **`app/src/api.ts` declares the DELETE response inline** instead of in
  `app-wire.ts` — the one wire-shape gap in the schema-drift-fails-typecheck
  discipline.

---

## Coverage notes (swept and clean)

- **Core loops:** scheduler scan, mail watcher (single-flight ticks, episode
  latches, CAS checkpoints), memory worker (pause gate, outage episodes, fresh
  UUID retries), delegation watcher (non-overlap, notice-before-CAS,
  boot recovery), rolling DM router (re-reads after every await), coalescing
  buffer (retain-and-backoff, order-preserving merges, drain semantics) — no
  races found beyond those listed.
- **`durable.ts` and callers:** every production whole-file write goes through
  it (config, skills, codex OAuth, catalog caches, webcache, trust seeds,
  attachments pipeline); the one hole is finding 4's dangling-symlink input.
  SQLite stays on WAL+transactions per the documented split.
- **Boundaries:** Telegram intake (inbox journal, allowedUsers gate, dedup by
  update id + chat/message identity), config load/merge/If-Match saves, every
  HTTP body zod-validated (chat bodies incl. the attachment-path confinement),
  initData HMAC + freshness + allowlist, bearer via fixed-length digests,
  webhook route states exactly per design/programs.md, app-dist traversal
  blocked, FTS queries neutralized (`toFtsQuery`), gws/Hindsight/herdr outputs
  zod-parsed.
- **Error paths:** provider-errors classifier, filter-stream buffering,
  delegation fail paths, harness-trust refusals — fail-loud discipline holds
  everywhere except the specific findings above. No `console.log`, no `any`,
  no swallowed exceptions found anywhere in `src/`.
- **Not covered:** live Telegram/live herdr/live Gmail behavior (read-only
  hunt), and the app/ React client beyond wire agreement (typecheck + subagent
  spot-check; no deep UI-logic audit).

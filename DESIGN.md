# goblin v2 — design

Rewrite of little-goblin. Same product, ruthless scope. The old codebase is at
`~/build/little-goblin`; it keeps running on lithium until cutover. Nothing is imported —
no code, no state, no specs. This document is the only thing that carries over,
plus the lessons it encodes.

## Why

pi-coding-agent is the ceiling: pi-ai supports only text and images, thinking
levels are half-broken, and the codebase grew an enormous stabilization
apparatus (roughly 10x test code to product code) to compensate for seams pi
forced on it. Vercel AI SDK gives provider-agnostic model access, native
document/audio parts, and thinking levels that actually work — so the agent
core gets rewritten around it, and everything else gets rebuilt only if it
earns its place.

## Product boundary

- One human operator (bermudi), one Bun process, homelab. It runs as a
  systemd user unit (`deploy/goblin.service`, linger enabled): restart on
  failure, starts on boot, SIGTERM rides the graceful shutdown path.
  `scripts/install.sh` installs it — idempotent, path-substituting, and it
  refuses to enable a half-configured service (config/auth missing) rather
  than crash-loop it. That script plus first-boot scaffolding (home layout,
  SOUL.md/AGENTS.md stubs, fail-loud config pointer) is the entire setup
  story — no onboarding wizard, ever.
- Telegram is the UI: long polling, topics, reactions, files, voice — **and
  Mini Apps, designed in from the start** (the process serves them over HTTP;
  see Intake & delivery).
- Goblin's machine state lives in SQLite (`bun:sqlite`, WAL); files stay
  where humans edit them — config, auth, workspace. Optional long-term
  memory lives in a separate Hindsight service backed by PostgreSQL (see
  Long-term memory). This does not migrate Goblin's conversation store.
- No standalone web UI beyond Telegram Mini Apps, no multi-channel, no plugin
  SDK, no k8s.

## Domain model

Two concepts. Conversation identity **is** the Telegram address.

```text
Telegram update
      │
      ▼
Conversation ─────── (chatId, threadId?) → durable event history
      │ while a turn is running
      ▼
    Turn ──────────── ephemeral: one agent loop + serialized queue
```

- **Conversation** — keyed by its Telegram address: a forum topic — in the
  operator's group or in the bot's DM, which supports topics too — or the
  bare chat itself. Owns `events` (user msgs, assistant msgs, tool calls,
  system events), `meta` (created, model/thinking overrides).
- **Turn** — a unit of work enqueued on a conversation. Per-conversation
  serial queue; one active turn. A turn's history snapshot is taken at
  admission: messages submitted while it runs join the queue and its
  successor's context, never its own. `/stop` fences the running turn and
  drops queued ones; messages still in the intake buffer are user input,
  not queued turns, and flush into a fresh turn at the new epoch.

**Topics are the UX.** There are no `/new` or `/resume` commands. A forum
topic is a conversation: create a topic to start one, post in an old topic to
resume it. The bot may also create topics itself (`createForumTopic`). A chat
without topics is one standing conversation. Conversation management is
Telegram's job, not a command set's. A topic created without an explicit name
(`is_name_implicit`) carries a placeholder; the first text burst triggers a
one-shot rename via the optional `titleModel` config ref — an explicit
operator rename always wins.

### The authority rule

The one lesson from v1's RuntimeMachine worth keeping, minus the machinery:
**before any side effect (Telegram send, state write, tool call), the turn
re-checks that it still holds authority** — its conversation epoch hasn't
advanced since enqueue.

Implementation: each conversation carries a monotonic `epoch`, bumped on
conversation-scoped settings changes (`/voice`, `/memory on|off`) and
explicit cancellation. Model and thinking are config-global since
`/model` and `/think` retired — the mini app writes global config, not
conversation state, so nothing there needs fencing. A turn
captures `(conversationId, epoch)` at admission and calls `checkAuthority()`
around every await. Fenced turns abort quietly and log it. No machines, no
drain sets — one counter and one function.

Shutdown rides the same rule. SIGINT/SIGTERM closes the runtime (submits
still land in history but never run), fences every live lane — each sink
stamps "⏹ superseded" and runs its final flush — and drains the intake
buffer into history, all under a bounded budget. A crash mid-turn leaves
the same shape minus the flush: the user message is in history, the next
turn answers it. Boot never auto-retries a half-run turn — tool calls
aren't idempotent, and an unanswered tail can't be told apart from
`/stop`. If recovery is ever wanted it is notify-don't-retry: surface
the orphaned turn to the operator, don't replay it.

## Model layer

Vercel AI SDK (`ai` package). `streamText` with tools and `stopWhen` for the
agent loop.

- **Provider registry** in config: name → AI SDK provider factory + auth
  reference. v1 targets:
  - `zai` — GLM via OpenAI-compatible endpoint (`@ai-sdk/openai-compatible`).
    Daily driver.
  - `openrouter` — `@openrouter/ai-sdk-provider`.
  - `codex` — `ai-sdk-provider-codex-cli` exists (ChatGPT Plus/Pro auth via
    `codex` CLI login) but wraps the CLI's own agent loop — no caller tools,
    so it can't drive goblin's turn loop. Ours is a thin `LanguageModelV2`
    over `chatgpt.com/backend-api/codex/responses` (`src/agent/codex.ts`):
    reads `~/.codex/auth.json` per call, refreshes expired access tokens
    against the OAuth endpoint, and writes rotated refresh tokens back —
    not writing back would invalidate the CLI's own login.
- **Thinking**: `off|low|medium|high|xhigh|max` is an operator vocabulary,
  not a provider contract — `thinkingOptions` maps each family to the
  nearest honest knob and writes the collapse down; `thinkingLevelsFor`
  is the same table read the other way, and the mini app offers only what the active model can express. Family ladders follow the bare
  model id under every kind — a `glm-5.3` is forced-thinking whether z.ai
  serves it directly or via a relay. Stored values outside a model's set
  aren't errors — defaults span models, so the mapping clamps them to the
  nearest rung at-or-above (GLM's own collapse direction). GLM
  (docs.z.ai): 5.3+ is forced thinking with effort `low|high|max`
  (unlisted values silently become `max`; `off`/`medium` clamp to `low`/
  `high`), 5.2 toggles plus `high|max`, ≤4.6 toggles only. Endpoint
  caveat: z.ai's coding plan (`api.z.ai/api/coding/…`) serves only
  5.3-gen models and aliases older glm-* ids to them, so on that base
  URL every glm gets the 5.3 ladder and wire map. GPT/codex
  takes `reasoning_effort` verbatim on a `low|medium|high|xhigh` ladder
  (gpt-6 adds `max`); `off` isn't a rung and clamps to the floor.
  OpenRouter's public `/models` catalog is fetched + cached like
  models.dev: `supported_parameters` discriminates `reasoning_effort`
  (native ladder → verbatim), `reasoning` only (toggle → `off|low`), or
  neither (non-reasoner → `off`); a cold catalog passes the level
  through — fail loud, never fake knowledge. `off` = `enabled:false`. No
  `/think` command — the mini app owns the knob.
- **History**: stored as AI SDK `UIMessage`-format JSON (the v5 parts array —
  text, reasoning, tool, file parts), wrapped in a versioned envelope
  `{"v":1,"message":…}`: the SDK owns the part shapes, so every row stamps
  the format that wrote it — a future shape change is a deliberate
  `v1→v2` converter at open, never silent placeholder degradation of old
  rows. `openStore` migrates bare (pre-envelope) rows once; reads accept
  both shapes.
- **Causal view, arrival-order storage.** `events` appends in arrival seq —
  that stays the truth. What the model sees interleaves replies by
  `anchor_seq`: each assistant response is stamped with the seq of the user
  message that triggered its turn and sorts immediately after it, so a reply
  never reads as having seen input that arrived while it ran. Submits queued
  behind a running turn coalesce into one successor turn — a single model
  call answers them all — and consecutive user messages merge into one at
  conversion.
- **Compaction**: history is unbounded on disk, bounded in the window by
  pointer relocation, never deletion. A conversation whose completed turn
  crosses **75% of its model's catalog context window** — or the operator's
  `/compact` — compacts: the conversation's own model (a summary is a
  compression of everything the agent knew; a sloppy one silently degrades
  every future turn, and it runs rarely) summarizes everything from the
  previous boundary (or the start) up to a cut chosen at a **completed
  exchange** — the causal-view rule, so a response is never orphaned from
  its user message — keeping a recent tail inside a token budget (~25% of
  the window, estimated). An interleaved burst (operator messages that
  arrived mid-turn) is atomic: the cut coarsens to whole bursts rather
  than splitting them. The summarizer input is the delta since the
  previous boundary plus the previous summary — never the re-serialized
  whole past, so the summary call stays bounded by one compaction
  interval, not by total history. The result lands in a first-class `compactions`
  table (boundary seq, summary, tokens before, model, timestamp); the latest
  row is the conversation's active pointer and earlier rows are the audit
  trail. The event stream is untouched — arrival-order storage stays the
  truth, and the full record remains queryable forever. The model view
  becomes [summary message] + events whose causal position follows the
  boundary — `anchorSeq ?? seq`, the same key the causal sort uses, so a
  late answer to a folded question rides into the summary with it rather
  than stranding orphaned in the tail. The summary is
  minted at read time as a user-role message framing the carried context.
  The requestHash move is the sanctioned boundary (Cache stability), logged
  as `history compacted` with the numbers. Failure is loud and lossless: a
  failed summary call writes no boundary and warns; the next threshold
  crossing retries. `/stop` and shutdown abort an in-flight summary —
  no pointer is written, the crossing retries. Auto-compaction runs inside the conversation's serial
  lane after the turn's sinks are notified — the reply lands first, a
  queued successor waits out the summary call. `/compact` is the same
  compaction serialized through the conversation's lane — a running turn
  completes (its response appended) before the cut is chosen, and a
  queued submit waits out the summary call — and replies with the
  numbers; with the context
  window unknown it still compacts (manual is a forced scrub). The ≥80%
  utilization warn stays as the alarm that compaction didn't happen or
  didn't keep up.
- **Capabilities**: don't hand-maintain a matrix. Use what the SDK exposes on
  model objects (`supportedUrls`, unsupported-feature warnings) plus the
  `models.dev` catalog for per-model input modalities (image/audio/document),
  which is what other agent tools already do.
- **Content**: the payoff — AI SDK takes image, document, and audio parts.
  Telegram media is saved to `attachments/` and stored in history as a
  `data-attachment` part (path + metadata, no payload). Each part's
  representation — file part vs text reference (transcript first for
  speech) — is a pure function of the stored ref and the conversation's
  model: file part when the model consumes the media type and the payload
  fits the per-item inline cap, reference otherwise. One carve-out:
  audio only inlines when the ref is marked `speech` — a voice or video
  note. Attached audio is data (Transcription, below); an mp3's bytes in
  every request is the most expensive way to not listen to it. Pure means stable:
  the same history under the same model materializes to the same request
  bytes every turn (see Cache stability). A model switch recomputes
  representations once — legitimate, because a model switch is already a
  cold cache. Only disk failure (file gone) degrades an item that would
  have inlined, with a warn.
- **Cache stability.** Provider prompt caching is a pricing and latency
  feature goblin is designed around, not an afterthought: z.ai caches
  repeated prefixes implicitly (no breakpoints; `cached_tokens` in
  usage), other providers do the same by prefix matching. The invariant:
  **the request for turn N+1 is the request for turn N with new content
  appended — bytes already sent are never rewritten.** Consequences:
  - No per-turn re-judgment of history. Attachment representation is the
    pure function above; there is no whole-turn budget and no newest-first
    eviction — an old image never degrades to a path
    reference because newer ones arrived.
  - The system prompt carries no automatic per-turn variability — no
    clock. Current time comes from `date` via bash when it matters.
    Operator edits (SOUL.md, AGENTS.md, USER.md, skills) stay live next turn;
    they are explicit cache boundaries and log the cost they incur.
  - Every model call logs usage with the cached split
    (`cachedInputTokens`, null when the provider doesn't report) and the
    request prefix hash — cache behavior and any drift are observable in
    goblin.log. Window utilization warns as input approaches the
    catalog context limit. History compaction is an explicit logged
    boundary that starts a fresh stable prefix — never silent eviction
    (see Compaction).

  Sanctioned one-time rewrites, each visible as a requestHash move in the
  log: a model switch — or a catalog refresh that changes a model's
  listed modalities — recomputes attachment representations once; a fenced
  or failed turn leaves its user message unanswered, and the successor
  turn's burst-merge (Causal view) rewrites that boundary; a corrupt row's
  placeholder is a repair, not drift. Everything else that moves the hash
  is a bug.
- **Transcription**: voice notes and video notes are speech — the two
  media kinds Telegram only produces by recording someone — and a model
  that can't consume audio shouldn't lose them to a bare path. Attached
  audio (`audio`, audio-mime `document`) is data, not speech: an mp3
  meant for `ffmpeg` shouldn't pay whisper for lyrics, so it is never
  transcribed eagerly and never inlines (the `speech` marker above).
  On-demand transcription of attached audio is the `transcribe` tool's
  job — same provider, same segmentation, called deliberately.
  When `transcription` is configured (`kind: groq`, whisper `model`, `auth`
  ref — other kinds slot in as the SDK grows transcription providers),
  intake transcribes the saved recording once and stores the text inside
  the `data-attachment` part. Eager, not per-turn: the transcript is
  durable history, and materialization prefers it over the path
  reference whenever the file can't go inline — wrong modality or spent
  budget — while audio-capable models still get the file part. The call rides the
  per-conversation intake chain (off the update hot path), bounded at 60s
  per call. Files over the provider's 25 MiB upload cap are segmented, not
  skipped: ffmpeg extracts the audio track to mono opus — a video note's
  payload is mostly pixels — and splits it into 15-minute chunks,
  transcribed sequentially and joined; a partial result is kept and
  warn-logged rather than discarded. ffmpeg presence is probed at boot
  when transcription is configured, and install.sh warns when the config
  names it but PATH lacks it. A failed transcription — whisper down,
  ffmpeg missing, corrupt media — leaves the attachment path-referenced
  and warn-logged: it must never eat a voice message.

## Tools (v1)

Hand-rolled, zod-validated, twelve:

`read_file` `write_file` `edit_file` `bash` (timeout) `speak` `transcribe`
`program` `delegate` `send_file` `memory_search` `search` `fetch`

All tools run in the deployment workspace — conversations have no cwd and
there is no `/cd`. Working elsewhere is the agent's own business (`cd x &&
…` inside `bash`), not conversation state.

`speak` is the voice-out twin of intake transcription: it *synthesizes*,
it does not send. The tool hands audio bytes to the turn's delivery sink
(`sink.onVoiceNote`), which owns the Telegram call — so "Telegram send is
delivery, not a tool" stays true and voice notes ride the same serialized
chain and authority fencing as text: a `/stop`'d turn can't emit one.
Input is `text` or a file `path` (plain text/markdown; richer formats are
extracted with the agent's own tools first) — a path is synthesized
straight from disk, so "read me this document" never re-types the content
as model output. Long input is split at sentence boundaries inside the
tts module, never by the caller. TTS is default-on (Delivery, TTS), so
the tool rides that block; `tts: ""` removes it.

`transcribe` is the other direction of the same pair: a workspace audio
or video file → text, present only when `transcription` is configured
and riding the same provider seam as intake. It exists precisely because
intake *doesn't* transcribe attached audio — "transcribe this podcast"
is a tool call against the saved attachment path, not a re-send.

`program` manages standing programs (list/create/update/delete/toggle/
hook) — see `Programs`. `delegate` hands tasks to other harnesses —
see `Delegation`. Both are bound per-turn to the running conversation
so what they create is pinned to the chat/topic it was born in; the
model never handles chat ids.

**Tool results are text.** Every provider goblin speaks (OpenAI-compatible
chat completions, the codex Responses shim) serializes tool results as a
string — the SDK's `toModelOutput` media-parts hook exists, but the wire
formats can't carry it, and an image sent as stringified JSON is garbage,
not vision. So tools never put image bytes in results: `read_file` sniffs
magic bytes and returns a structured note (type, dimensions when the
header carries them, size) naming the two working channels — the operator
sending the image via Telegram (intake materializes it natively for vision
models) or `bash`/`ffmpeg` for metadata work. If a provider whose tool
results carry media ever arrives, revisit this ruling — the hook is the
door.

**Bounded, self-describing output.** Read tool: line window + byte ceiling
+ per-line clamp — three ceilings because each catches a shape the others
miss (long files, wide files, minified one-liners); output stops at
complete numbered lines only, and every stop names its own recovery
(`Use offset=N`, sed fallback for a giant line, did-you-mean on a miss,
tail reads via negative offset). Bash: tail-truncation at complete lines,
UTF-8 boundary-safe, with the dropped-byte count stated — the single
exception being a final line that alone exceeds the whole budget, whose
last bytes are kept with an ellipsis prefix so a mid-line start is never
mistaken for a whole line. Special files (devices, FIFOs, sockets) are
refused before any I/O — `read_file` on `/dev/zero` is a hang, not a
read; `bash` (timeouts + output caps) is the sanctioned channel for
those.

External agents arrived as `delegate` (see `Delegation`). Subagent and
MCP tools do not exist — each arrives with the feature that needs it,
designed then, not spec'd now.

## Web access (search, fetch, browser)

Returned on demand (2026-09-24): scheduled jobs answering "brief me on X"
need the outside world. Classification: `search` and `fetch` are
chat-native — a personal assistant that can't look things up is a gap
against this doc. The browser returns as a skill over a CLI, not a native
tool. MCP stays out, with its return conditions on record (below).

- **`search` is one tool with a provider behind it** — the model-provider
  pattern. OpenClaw, which also has MCP, still ships a generic `web_search`
  with vendors plugged in behind it (plus a dozen per-vendor tools); hermes
  kept one `web_search` with eleven backends. One tool it is: provider
  switch = config edit, and the tool's name, schema, and result shape never
  move — request bytes and the model's habits stay stable. Swapping
  providers via MCP would swap tool names and schemas in front of the
  model; the flexibility argument inverts.
- **Config**: optional `search` block (absent or `""` → tool absent):
  `{kind, auth?}` with kinds
  `brave|exa|jina|tavily|firecrawl|parallel|ddg`, or an ordered list of
  such entries — the fallback chain. `auth` is an auth.jsonl ref,
  required for every kind but jina (keyless tolerated, rate-limited) and
  ddg (keyless — the unofficial html endpoint; it can rate-limit or
  break, it's the no-key default, not a promise). Enabling/disabling the
  block is a deploy-time cache boundary, logged.
- **Fallback chains are explicit config, never implicit.** A list entry
  order is the walk order: first is primary, the rest are fallbacks.
  Transport, HTTP, and auth failures advance to the next entry; an EMPTY
  result set (or a structured refusal on the fetch side) is an answer
  from that provider and stops the walk — "no results" must never
  silently mean "results from whoever has any". Every failed attempt
  logs its own line; when the answer comes from a non-primary provider,
  the result says so (`(via ddg — brave: HTTP 402 …)` — hermes'
  `served_by`, adopted) so the model can tell the operator and the
  operator can fix the primary. Borrowed from hermes'
  `search_with_failover`; NOT borrowed: its round-robin ring, seeded
  cursor, and fleet-spreading — one operator gets deterministic config
  order, and no vendor is ever injected that the operator didn't write.
  No health checks, no cooldowns, no pinning: try-next-on-error is the
  whole mechanism.
- **Wire formats** follow hermes' plugins/web (brave and tavily verbatim)
  and the vendors' own SDK wire paths, checked against the SDK sources:
  exa `POST api.exa.ai/search` (`x-api-key`), parallel
  `POST api.parallel.ai/v1/search` + `/v1/extract` (Bearer), firecrawl
  `POST api.firecrawl.dev/v2/search` + `/v2/scrape` (Bearer), jina
  `s.jina.ai` / `r.jina.ai` (Bearer, keyless tolerated).
- **Input**: `{query, count?}` zod-validated, count default 5 cap 10. No
  provider-knob mirroring (freshness, topic, domain filters): recency is
  expressible in the query, and knobs are how fifteen search tools happen.
- **Output is deterministic text**: numbered `title — URL — snippet` lines.
  Provider answer-fields and full-content payloads are dropped at the
  boundary; snippets bounded by the read/bash truncation discipline
  (complete lines, byte ceiling, recovery named: re-query narrower or
  `fetch` a result URL). Every result carries its URL — fetch is the named
  next step.
- **`fetch` is always in the set** — default `local`, no config, no key:
  direct HTTP (20s timeout, 8 MiB cap) + in-process readability
  extraction (`@mozilla/readability` over `linkedom` — pure JS, the
  industry path). An optional `fetch` block selects a server-side
  extractor instead: `{kind: "jina"|"tavily"|"firecrawl"|"parallel",
  auth?}` — or an ordered chain of such entries plus `local`, the same
  list rule as search (`[{kind: "parallel", auth: "parallel"},
  {kind: "local"}]` is the resilient default shape: paid extraction
  with a free direct fallback). The per-capability split hermes ships:
  search and fetch providers are chosen independently (brave for search,
  parallel for extract, say). Both paths share one output discipline. Input `{url,
  maxChars?}`; local does content-type dispatch — HTML → readability,
  text-ish (text, markdown, json, csv, xml) → raw, anything else (PDF
  included) → structured refusal naming recovery (`bash` + file tools,
  or `send_file` to put it in the operator's hands). v1 does not parse
  PDFs; the refusal says so instead of guessing.
- **Overflow goes to disk, recovery named** (hermes' `web_extract` rule,
  adopted): default 15k-char head+tail window (~75/25, cut on line
  boundaries) with a `[TRUNCATED n chars]` footer; the full extracted text
  lands in `$GOBLIN_HOME/state/webcache/<sha>.txt` and the footer names the
  absolute path plus the exact `read_file` call to page through the middle.
  Near-empty extraction from a JS shell says so and names the browser as
  the recovery path — never a silent empty result.
- **No SSRF policy — recorded as a ruling.** `bash` already has full
  network access, so pretending `fetch` is a boundary is security theater;
  the boundary is the tool set, same as `bash`. Loopback/LAN fetches are
  legal (the local bot-api server is fair game).
- **Auth never enters tool env** (the standing rule): the search key is
  resolved lazily in-process at the point of use, exactly like provider
  keys.
- **Logging**: one line per external call — search logs provider, query,
  count, duration, status; fetch logs url, status, content-type, bytes,
  extraction outcome, truncated flag, duration. Failures surface as tool
  errors, never silent empties.
- **The browser is a skill, not a tool.** goblin authors
  `skills/browser/SKILL.md` over the `agent-browser` CLI: hermes' default
  local browser mode drives that same CLI, and openclaw's nine doc pages
  (dedicated profile, port collisions, orphan sweeps, login management,
  loopback auth) are the price of owning browser lifecycle in-process —
  goblin borrows the capability, not the machinery. The CLI owns headless
  Chrome, accessibility snapshots with `@eN` refs, sessions, and idle
  shutdown; bash is the channel. The SKILL.md is a thin stub pointing at
  `agent-browser skills get core` — the CLI serves version-matched
  instructions, so the stub never rots. The skill ships with the repo
  (`deploy/skills/browser/SKILL.md`, seeded write-if-absent at first
  boot): capability plumbing is not agent memory — a rebuilt box regains
  the skill, and once seeded the workspace copy is goblin's to evolve.
  The dependency + recovery command ride the `compatibility` frontmatter
  line, which the system prompt's catalog renders every turn — a missing
  CLI is never a dead-end invitation, and the operator never has to be
  the one to mention it. Install as config knob stays out for the same
  reason as every other knob. The operator-browser attach mode (pin-tab, never close
  operator tabs, never read credentials) is carried in the skill now, for
  the day a box with a display wants it. If the model fumbles CLI
  ergonomics in practice, a thin native `browser` tool wrapping the same
  CLI arrives — designed then, with evidence. Not now.
- **MCP stays out**, return conditions on record: (1) stdio servers take
  secrets via env vars, which the bash-inherits-env rule forbids — remote
  HTTP servers with per-call header auth, or config-file servers, would be
  the only allowed shapes; (2) dynamic tool schemas drift the request
  prefix — a returning MCP layer must snapshot its tool surface at boot and
  log every change; (3) servers dump 5–50 tools into every request — both
  references built filtering/tool-search machinery to cope, and goblin
  doesn't ship that until a second concrete service demand (beyond
  search/fetch/browser) names itself.

## Skills

Agent Skills (agentskills.io format): one directory per skill holding
`SKILL.md` — YAML frontmatter plus a Markdown body — alongside whatever
scripts/references/assets the body points at. The frontmatter is validated
per the spec: `name` + `description` required; `license`, `compatibility`,
`metadata`, `allowed-tools` checked for shape when present and then
ignored for behavior — except `compatibility`, which joins the catalog
line so a skill needing tools the box lacks isn't a dead-end invitation.
`allowed-tools` is spec-experimental and nothing here enforces per-skill
tool scope. `disable-model-invocation` is a non-spec extension the
operator's catalog already carries; it is honored (below). Unknown keys
pass through — real skills in the wild carry extra fields.

One catalog, fixed: `workspace/skills/`. It sits inside the agent's cwd so
goblin can author its own — writing `skills/<name>/SKILL.md` is the entire
publishing flow, live next turn. One exception ships from the repo: the
browser skill is seeded by `ensureHomeLayout` (write-if-absent, from
`deploy/skills/browser/SKILL.md`) because DESIGN mandates the capability —
a rebuilt box must regain it without operator prompting or agent memory.
Sharing in a host skill is a symlink —
made by goblin on request, or by hand; there is no second root, no source
policy, no selection UI.

The lifecycle is the filesystem, and the agent is the operator's hands:
**install** = "install the mq skill" in chat → goblin links or copies it
into `skills/`, fetches a repo via `bash`, or files a SKILL.md that
arrived as a Telegram attachment; **update** = edit the files; **remove**
= delete the entry. Each is live on the next turn — no command,
registry, cache, or tombstone for any of it, and no ssh: the operator
asks in Telegram and goblin already has a shell on the box. Where to
fetch *from* (the operator's skills repo, the host catalog) is
deployment fact, not code — it lives in the workspace `AGENTS.md` so the
agent knows its sources. Hand-editing `skills/` over ssh always works;
it is the fallback, not the flow. `skills-ref validate` is installed for
authoring-time checks — goblin runs it via `bash` after writing a skill,
and a skipped entry plus the warn log is the failure signal when it
doesn't.

Discovery is per turn, in `buildSystemPrompt`: scan `skills/*/SKILL.md`
(symlinks resolved), parse a bounded head of each file for frontmatter —
the body is never injected — and render a `## skills` section listing
name + description (+ compatibility when set) + path. The section
renders even when the catalog is empty: it's also the notice that the
capability exists.

- `name` must equal its directory name and follow the spec rule —
  1–64 chars, `a-z0-9` and hyphens, no leading/trailing hyphen, no
  consecutive hyphens; `description` is required, ≤1024 chars.
- `disable-model-invocation: true` excludes the skill from the list —
  manual-only. The operator can still name it and the agent can `ls
  skills/` and read it; it just isn't advertised every turn.
- A malformed entry never kills a turn: `log.warn` with path + reason,
  skip it, and the section notes the skip count so the agent can surface
  it in chat — and fix the file, when it's one it authored.
- Sorted by name; deterministic. Same-name conflicts can't exist —
  name == dirname means they'd be the same directory.

Scan contract: each entry in `skills/` is stat'ed (symlinks followed).
A directory without `SKILL.md` warns and skips; a non-directory is
ignored silently; a broken symlink warns and skips. Frontmatter is read
from a bounded head (16 KiB — a `---` that doesn't close inside it is
malformed). The catalog caps at 128 entries: over that, the
sorted-first-128 list plus a warn — a self-authored catalog that big is
already a bug worth surfacing.

The section, approximately:

```text
## skills

Skills are directories under `skills/` — each a SKILL.md (frontmatter:
name, description) with instructions plus any scripts/files it needs.
When a request matches one, read_file its SKILL.md and follow it. This
catalog is yours: write skills/<name>/SKILL.md when you learn a
repeatable task, then `skills-ref validate ./skills/<name>` via bash.
Edits are live next turn.

- mq — jq for Markdown … [Requires the mq CLI] (skills/mq/SKILL.md)
- pdf — Extract PDF text … (skills/pdf/SKILL.md)
(1 entry skipped as malformed — see goblin.log)
```

An empty catalog renders the header plus "(none yet)" — the notice that
the capability exists is the point.

Invocation is `read_file`. The model sees the catalog line, reads the
SKILL.md when one matches the request, runs its scripts via `bash`.
Activation is already observable in the tool-call log — no skill tool, no
per-skill tool scoping (`allowed-tools` is parsed and ignored), no
snapshots, no fingerprints.

Still out — machinery that returns only on demand: additional catalog
roots (host, project), per-conversation selection, a `/skills` command or
mini-app surface, immutable skill snapshots.

## Programs (standing orders)

Scheduled jobs arrived on demand (2026-09-20); programs generalize
them on demand (2026-09-26, operator ask: "more proactive"). A
program is **standing authority for one concern**, borrowed from
openclaw's standing orders (`docs/automation/standing-orders.md`):
a charter — scope, what needs the operator's OK, when to escalate,
what not to do, steps — plus the triggers that wake it. "You own the
weekly report; compile it Fridays, only escalate if something looks
off." A job was a program with a cron and a one-line charter; the
`jobs` table and `schedule` tool are superseded, not kept alongside.

What we took from openclaw is the charter *shape*, not its storage:
openclaw puts standing orders in the always-injected AGENTS.md, which
every conversation sees — the same shared-file scope its HEARTBEAT.md
leaked through for years. Here the charter is the row. The design
takes that lesson wholesale: **a program's instructions are the
program's state, never a workspace file.** Rulings:

- **State is rows, not files.** A `programs` table in `goblin.sqlite`
  (own connection in `src/programs.ts`, same WAL file): name,
  charter, optional 5-field cron, optional webhook token hash, the
  pinned Telegram address, enabled, last_run, next_run (null without
  a cron). A program needs at least one trigger. Creating one changes
  nothing in the workspace and nothing in any prompt — cache stable
  by construction. On first open, rows from the legacy `jobs` table
  (if any) copy in once — prompt becomes charter — and the old table
  is left untouched; no general migration framework.
- **Firing is one path for every trigger.** Cron tick, webhook hit,
  or anything later: `runtime.submit` of a user message
  `[program: <name> · trigger: <schedule|webhook>]` + the charter
  (+ the event payload, below) into the pinned conversation.
- **Authority is granted, never self-issued.** Creating or widening a
  program needs the operator's explicit ask — the agent may *propose*
  one ("want me to own this?"), never grant itself standing
  authority. What a firing turn does is bounded by its charter and
  the same ask-first rule as any operator message.
- **Webhooks: one secret address per program.** `POST
  /hook/<token>` on the existing HTTP server (bound to 127.0.0.1;
  reachable only through whatever door `publicUrl` fronts —
  `tailscale serve` keeps it tailnet-only, `funnel` makes it public
  for GitHub/CI). The token is 32 random bytes, base64url; only its
  sha256 is stored. **The token never enters model context**: the
  tool that enables or rotates a hook DMs the full URL to each
  `allowedUsers` id — never the program's topic, whose group readers
  aren't implicitly authorized — outside conversation history, and
  returns only "hook enabled, URL sent privately" to the model. No DM
  delivered = tool error (hook stays set; rotate resends). The route
  re-resolves the token after reading the body (a hook disabled or
  rotated mid-upload is dead) and answers 503 + `Retry-After` once
  the runtime stops accepting turns — a closed runtime only records
  submits, so a 202 would be a lie. Disable = clear the hash; rotate
  = new token. Body (text or JSON, capped at 32 KiB, larger →
  413) rides into the turn fenced as `<event>…</event>` with a
  standing note that event content is data to evaluate, never
  instructions — a webhook is untrusted input by construction.
  Throttle: one fire per program per 60 s; extra hits get 429 and a
  log line. Unknown/disabled token → 404, no body echo.
- **Recurrence is cron, evaluated in the server's local timezone**
  (operator = admin; `date` via bash agrees). The model translates
  natural language → cron inside the tool call; `cron-parser`
  validates it at the boundary — an invalid expression is rejected
  before a row exists. No interval-plus-prose hybrids; prose recurrence
  is where heartbeat bugs came from.
- **A program belongs to the conversation where it was created**
  (chat/topic address pinned by the tool from the live conversation
  — the model never handles chat ids). The fired message gets a sink
  built like any other (voice per conversation setting); replies
  land in that chat/topic. The lane queue orders it behind any live
  turn — no interleaving, no special execution path, epoch fencing
  applies.
- **Management is the `program` tool** (list/create/update/delete/
  toggle/hook), zod-validated, one tool not a CLI — state mutation
  belongs behind validation and logging. `hook` takes
  `enable|rotate|disable`. Firing turns may use the tool too (a
  program retiring itself when its charter says it's done is fine);
  every mutation logs. Edits within an existing charter's intent
  (reword, reschedule, toggle) need no go-ahead; new programs and
  widened authority do (above).
- **The scheduler is an in-process ticker** (30s) in the runtime
  process; systemd covers crashes. A fire time missed while the
  process was down fires **once** at the next tick (boot catch-up),
  then advances to the next future occurrence — never a replay of
  every missed instance. Occurrences skipped while a program was
  disabled are skipped, not owed: re-enabling recomputes `next_run`
  from now. Submit first, then markRan: a message that landed is
  history even if the turn never ran. A submit that throws never
  landed — release the sink with the error, deliver it, then
  markRan anyway: one attempt per occurrence, so a persistent
  failure cannot refire (and re-deliver) on every tick. Webhook
  fires stamp last_run and leave next_run alone.

Still out (machinery): proactive monitoring/heartbeat (programs are
authority the operator granted, woken by a clock or an event — not an
agent that wakes itself to decide whether to check things; ruled out
again 2026-09-26), cross-host schedulers, built-in mail/file
watchers (a script that curls the program's hook covers them),
run history/audit tables beyond last_run and the log.

## Delegation (other harnesses, via herdr)

On demand (2026-09-26): goblin hands work to other coding harnesses
(codex, claude, pi, devin, opencode, …) and gets on with the chat;
the result comes back to the topic it was delegated from. The AI SDK
wrappers for harnesses (`ai-sdk-provider-codex-cli`,
`…-claude-code`) were considered and rejected: they cover two
harnesses, run in-process (die on restart), and nobody can watch
them. Instead harnesses run **interactively in goblin's own herdr
session** — herdr is the terminal multiplexer already on the host,
it recognizes agents in panes and reports their state
(`idle|working|blocked|done|unknown`). The operator can `herdr
session attach goblin` at any time to watch or take over.

Rulings:

- **The herdr session is its own systemd user unit**
  (`deploy/goblin-herdr.service`: `herdr --session goblin server`),
  which `goblin.service` `Wants=`/`After=`. Not a child of goblin:
  systemd stops a unit's whole cgroup, so a spawned session would
  kill every running delegation on each goblin restart. Verified
  2026-09-26: a named headless session starts and drives agents
  under the service's stripped env (no `HERDR_ENV`, service PATH).
  `install.sh` installs both.
- **Only `src/herdr.ts` knows herdr** — a thin adapter over the CLI
  (`herdr --session <name> …`, JSON out, zod-parsed; CLI errors are
  JSON on stderr with exit 1 and propagate with context). Every call
  logs (verb, target, outcome, ms).
- **Harnesses are config, never guessed.** `delegation.harnesses`
  maps a name to a herdr agent `kind` plus native args — the
  operator's choice of full-auto flags and model live there.
  Goblin never picks a model for a harness; absent args mean the
  harness's own defaults. Absent `delegation` block = tool absent.
- **Agents run full-auto; goblin never answers approvals.** The
  operator's ruling: harnesses start in their no-approval mode (the
  configured args), so there is nothing to approve. This is not a
  new trust level — goblin already has `bash`. If an agent still
  stops (`blocked`, or ends its turn with a question), goblin relays
  it to the topic and types the operator's answer back; it never
  invents one. Startup dialogs are the known trap: herdr reported a
  codex trust-directory prompt as `idle` in the 2026-09-26 probe, and
  `--dangerously-bypass-approvals-and-sandbox` does not skip it
  (codex 0.155.1) — directory trust is harness config (codex:
  `[projects."<dir>"] trust_level` in `~/.codex/config.toml`). Panes
  run the operator's interactive shell, so shell aliases apply: args
  that duplicate an alias's flags make the harness refuse to start.
  Start relies on herdr's ready gate plus the watcher's stall rule,
  not on screen-scraping.
- **State is rows.** `delegations` table in `goblin.sqlite`
  (`src/delegations.ts`): name, harness, cwd, task, pinned address,
  herdr agent name + pane/workspace ids, status
  (`starting|running|needs_input|done|failed|stopped`), the herdr
  `state_change_seq` observed after prompting, the prompt time
  (captured *before* the prompt is sent), created/finished
  timestamps. Survives goblin restarts; the herdr unit keeps the
  panes alive meanwhile. `starting` is invisible to the watcher and
  flips to `running` in one write once the prompt landed; a
  `starting` row seen at watcher boot means goblin died mid-start →
  close its workspace, notify, `failed`. The cap counts
  starting+running+needs_input.
- **Watcher writes are compare-and-set; the notice lands first.**
  Every watcher transition applies only if status and prompt time
  still match what it read (a `send` or `stop` mid-poll wins), and
  only after its notice landed — an unsubmitted notice leaves the row
  as-is for the next tick. `stop` marks `stopped` only when the
  workspace closed, none was bound, or herdr confirms the agent is
  gone; otherwise the row stays watched and the tool reports it.
- **Start**: one herdr workspace per delegation (cwd = the task's
  directory, label = name), `agent start <name> --kind <kind> --pane
  <root> -- <args>`, then `agent prompt` with the task plus one
  appended instruction: write the final report to
  `$GOBLIN_HOME/state/delegations/<id>/report.md`. herdr's own guide
  treats file output as the fallback for results a screen can't
  hold; here it is the primary channel because a TUI screen is a
  lossy transport. Concurrency cap `delegation.maxRunning` (default
  3) — the tool refuses beyond it, naming what's running.
- **The watcher is an in-process ticker** (15 s), the scheduler's
  twin: for each `running`/`needs_input` row, `agent get`. Done =
  status `idle|done` **and** either `state_change_seq` advanced past
  the recorded one (a fresh prompt is idle before it's working) or a
  report file newer than the last prompt (catches an agent that
  finished before the baseline read; freshness keeps an old report
  from closing a follow-up). Blocked → `needs_input`, notify once.
  Idle with no seq advance 90 s after prompting → `needs_input`
  ("likely stuck on a startup dialog"). Parking re-baselines the seq;
  a parked row resumes on *any* seq advance, not a `working` glimpse
  — an operator answering through `herdr session attach` can finish
  the whole exchange between two polls. Agent gone (pane closed,
  process exited) → `failed`. Every transition submits one message
  into the pinned conversation, the same path as program fires:
  `[delegation: <name> · <done|needs input|failed>]` + the report
  file (capped at 16 KiB; beyond that, the path to read) or, absent a
  report, the screen tail (`recent-unwrapped`, last ~80 lines). The
  resulting turn tells the operator what happened, in goblin's
  voice.
- **Management is the `delegate` tool** (start/list/read/send/stop),
  bound per-turn to the running conversation like `program`.
  `read` peeks the screen tail; `send` prompts the agent (an answer,
  or a follow-up to a finished delegation — any status but
  `stopped`; it resets the seq baseline and flips the row back to
  `running`); `stop` interrupts and closes the workspace. Done
  delegations keep their workspace so the operator can inspect it;
  `stop` on a finished one is the cleanup.
- **Goblin may delegate on its own judgment** within a turn — long or
  coding-heavy work belongs in a harness, not in a lane-blocking
  `bash` call — and says that it did. `/stop` fences goblin's turn,
  not delegations: they aren't turns. `delegate stop` ends one.

Still out: subagent fleets inside goblin (a delegation is one
external agent per task, not an orchestrator), nesting, fan-out
tooling, ACP, the AI SDK harness wrappers.

## Long-term memory

**Implemented; live-verified 2026-09-24** on the homelab box against the
real Podman stack (0.10.0-slim). Verified by live traffic that day:
retention end-to-end (queued exchanges drained through submit → async
operation → completed), recall answering with real extracted facts,
installer start, and the watch timer firing on schedule. The 2026-09-25
reboot closed the boot-path gate in production: db and api units
auto-started within a minute of boot — the wants-symlink → generator
path survived contact with a real restart (`systemctl --user is-enabled
goblin-memory-api` reads `generated`; the symlink is the evidence, not
that command). Still never exercised: the watch's restart action on a
live `unhealthy`. The broader release gates from Operations and
verification — cross-topic recall, dated correction, restart-recovery
drills — remain operator exercises. First live finding: z.ai 429
"insufficient balance" during extraction blocks a single document for
operator reconciliation (the designed path, not a crash) — provider
credit is a live dependency of retention.
Slice 2 rulings (below) lock the turn-integration mechanisms.
Memory returns on explicit
operator demand. Hindsight is the selected memory service, not an agent
runtime: Goblin still owns history, tools, reasoning, and Telegram delivery.
No MCP, replacement turn loop, or generic multi-backend framework.

### Slice 2 rulings (locked)

1. **Config key: `memory`.** Optional `goblin.json5` block `{baseUrl,
   bankId, auth?, recallTimeoutMs?, maxTokens?, budget?}`; absent =
   exact current behavior. `auth` names an `auth.jsonl` secret for the
   Bearer token (loopback needs none). Recall defaults: 2000ms timeout,
   1024 max tokens, `low` budget — turns must not wait on memory.
2. **Exclusions: per-topic setting, command-first.** `memoryExcluded`
   boolean on the conversation (settings-command pattern: `/memory
   on|off|status`, epoch-bumped like `/voice`; mini-app toggle follows).
   Excluded topics send nothing and recall nothing — enforced in Goblin
   before any external request, for both automatic recall and the
   memory-search tool. No automatic ingestion until this control exists.
3. **Recall persistence: `memory_contexts` table, interleaved before
   the anchored user message.** Every recall outcome (results, empty,
   unavailable) is persisted verbatim keyed by `(conversation_id,
   anchor_seq)` before the model call; future turns reuse the persisted
   bytes, never regenerate. Materialize each block immediately before
   its triggering user message in the causal view, so turn N+1's request
   starts with turn N's request plus appended content. Enable/disable
   and forgetting are explicit logged cache boundaries (the prefix may reset
   there, nowhere else). Recall-context writes are working state, not
   completed-turn commits: a turn fenced after its recall may leave an
   orphan block, and its same-anchor retry replaces it under the logged
   turn-fenced boundary. Successful-turn prefixes are unaffected (a failed
   request is never anyone's prefix).
4. **Document ID: `exchange/{conversationId}/{anchorSeq}/{assistantId}`.**
   Stable per completed exchange, unique across retries; retries replay
   identical content (queue rejects same ID with different content).
5. **Degraded status: log + `/memory status`, not chat spam.** Every
   recall/worker outcome emits a structured line; `/memory status`
   reports disabled/healthy/degraded/pending with outbox counts. Model
   context distinguishes unavailable from empty via the persisted block;
   no Telegram notification per retry. Amendment (2026-09-24): the ruling
   covers per-retry spam, not silence — a retention chain that cannot
   drain for a continuous hour earns exactly ONE notice per episode,
   sent to the conversation whose exchange is stuck (episode state in
   SQLite, `memory_outage`; a failed send retries on the next worker
   failure; any successful advance clears the episode silently). The
   amendment exists because the stack's boot-enablement gap (below) left
   goblin retrying a dead port for a full day with no one the wiser.
   Amendment (2026-09-25): blocked retention is not an outage — the
   service answered — and it surfaced nowhere in chat while a 429 storm
   left a document stuck for hours. A document's first transition into
   `blocked` earns ONE notice per document (latch in SQLite,
   `memory_blocked_notices`), naming `/memory retry` and `/memory
   dismiss`; everything after the first notice is `/memory status`
   territory. The mini app's Memory tab renders the same status as a
   read-only card (`GET /api/memory-status`, same auth as every other
   endpoint, polled only while the tab is open) — the verbs stay in
   Telegram; the panel never mutates the queue. Retry mints a FRESH operation id — Hindsight holds the old
   op terminally failed server-side, so replaying it just re-reads the
   dead op's status (the live hand-requeue that failed); dismiss keeps
   the row as `dismissed` for audit, and `/forget delete` cancels
   blocked and dismissed rows too.
6. **Bank/mission: operator step, no auto-creation.** Goblin never
   creates banks or sets missions; `docs/memory.md` documents the manual
   `curl` with an example mission (preferences, decisions, commitments,
   people, ongoing work). Bank-level overrides stay out of Goblin.
7. **Forgetting: two commands, suppression survives everything.**
   `/forget <query>` resolves and shows affected sources;
   `/forget delete <documentId>` requires that go-ahead, then suppresses,
   cancels pending outbox rows, deletes the remote document, and redacts
   affected recall snapshots (global prefix reset, logged). Suppression
   lives in SQLite and is checked before every enqueue, so restarts and
   future backfills cannot resurrect forgotten sources.

### Deployment and configuration

Ship a portable, optional rootless Podman stack managed by Quadlet/systemd:
Hindsight plus PostgreSQL with the vector extension required by the pinned
Hindsight release. Use persistent storage, readiness checks, restart on
failure, and a private container network. PostgreSQL publishes no host port;
Hindsight's API binds to loopback. Use pinned images, not floating automatic
upgrades. Nothing assumes a particular hostname, operator home directory,
or existing database installation. The stack is boot-enabled
(`[Install]` + `WantedBy=default.target` on the API unit; the database
rides along via `Requires`/`After`) like goblin itself — the installer's
cost confirmation gates the first start, not every reboot. The original
"operator starts it explicitly" ruling died the first nightly shutdown:
the box went down, goblin came back with memory on, the stack did not,
and the bot quietly retried a dead port for a day. Health probes gate
startup (`Notify=healthy`) but are write-only after it —
`Restart=on-failure` only sees process death — so a systemd user timer
(`goblin-memory-watch`, 5 min) turns an `unhealthy` container report
into a unit restart; a stopped or absent stack is a deliberate operator
choice and stays stopped.

Goblin accepts a configured Hindsight base URL and bank identity; it can
use the supplied local stack or an existing service. Remote services require
an explicit operator choice and appropriate transport/authentication.
Omitting memory configuration preserves current behavior. Configuration is
validated at the boundary; credentials stay out of config examples, logs,
model context, and Goblin's inherited tool environment. Resolve Goblin-side
auth through the existing auth mechanism; keep service credentials scoped
to the containers rather than exporting them into Goblin.

Model selection belongs to the operator, not to an SDK's implicit defaults.
The requested initial setup is `glm-5.3-flash` for extraction/consolidation
and `voyageai/voyage-4-lite` for embeddings. These are requested identifiers,
not claims about Hindsight's accepted wire configuration: verify provider
support, endpoint, and exact model IDs before implementation or live calls.
Other installations select their own providers/models and credentials.
Reranking is **unresolved**: require an explicit choice or a verified
supported no-reranker mode; do not silently download or invoke a default
model. Choosing a different embedding model for an existing bank requires
an explicit compatibility/re-indexing procedure, not a hot config edit.
Self-hosted storage does not imply local processing: document which text
each configured external model service receives.

Setup is installer-driven (`deploy/memory/install.py`), overruling the
earlier "operator setup, not automatic" stance. An installer that *asks*
preserves the deliberation the manual flow was protecting: every provider,
model, and key choice is an explicit prompt (hidden input for secrets), the
launch guard validates the assembled configuration before anything is
written, the database password is generated locally and never printed, and
stack start carries its own cost warning. Deliberation lives in the
questions, not in copy-paste friction.

The TypeScript SDK is an HTTP client, not a requirement to run Node.
Basic retain/recall against a fake HTTP server passed with SDK 0.10.0 under
Bun 1.4.2 during planning. Real-server compatibility, cancellation,
timeouts, error handling, and document management remain release gates.
Use direct typed HTTP if necessary; do not add a Node sidecar.

### Retain: a durable projection of completed exchanges

One bank per Goblin installation/operator, shared across topics. Preserve
conversation identity, source event/message identifiers, timestamps, and
speaker attribution. An assistant suggestion is not an operator decision.
Banks are not public knowledge: an allowed Telegram sender is not proof
that everyone who can read a group is authorized to see recalled memories.
Memory-enabled delivery destinations must be operator-approved.

Start with new completed text exchanges only. No historical backfill,
attachment ingestion, raw tool output, hidden reasoning, or re-ingestion of
recall results. Bounded prior context may resolve references but must be
labelled as context rather than fresh independent evidence. Scheduled
housekeeping is not automatically a source of new personal memories.
Extraction instructions emphasize preferences, decisions, commitments,
people, and ongoing work; they guide quality, not privacy enforcement.

Commit the completed assistant event and a pending-retention record in one
SQLite transaction, under the turn's existing authority check. This is an
additive schema change and must preserve existing installations. A failed
or fenced turn cannot commit completed-turn memory. A committed exchange
is then independent background indexing work; a later epoch change does
not retroactively cancel it.

A bounded worker drains the durable queue, using a stable document ID per
exchange and replacement semantics for retries. Persist a client-generated
operation UUID before submitting asynchronous retention and reuse it after
a lost acknowledgement. Poll the operation to completion; an acknowledged
operation that disappears is blocked for operator reconciliation rather
than blindly resubmitted. Bind queued records to the original endpoint and
bank so a configuration change cannot redirect pending personal content.
Keep pending work through
restarts and retry transient failures with backoff. An HTTP acknowledgement
of asynchronous processing is not proof that retention completed: either
wait for completed retention or track the operation to its terminal state.
Permanent failures remain inspectable and reported, not silently dropped or
retried in a tight loop. Ordering must preserve source chronology where it
matters; never mutate the same document concurrently.

Indexing is eventually consistent. A turn immediately afterward in another
topic may run before the prior exchange becomes searchable. Do not delay
Telegram delivery for extraction or promise immediate cross-topic recall.

### Recall: evidence, not instructions

Before a model turn, build a bounded query from its admitted message
snapshot and recent conversational context. No additional query-generation
model initially. Recall has explicit time/search/output bounds and source
references. Also expose a validated memory-search tool for deeper searches.
Do not use Hindsight `reflect` initially: Goblin already reasons over the
evidence with its selected model.

Retrieved text is dated, potentially stale evidence, not system
instructions. Current operator statements outrank retrieved preferences;
inferred observations are not explicit requests. Keep source attribution
available for important claims rather than treating extraction as truth.

Preserve the cache invariant: store the exact bounded recall context used
by a turn and materialize it at a stable causal position near that turn's
input. Do not regenerate old recall blocks, shift them when new messages
arrive, inject changing results into the system prompt, or feed them back
to retain. Successful turns must preserve the request prefix across later
turns and process restarts; cancelled/failed-turn recovery follows the
existing logged cache-boundary rule. Memory enable/disable and intentional
forgetting are explicit logged boundaries, not accidental prefix drift.

An unavailable memory service must not stop ordinary conversation.
Distinguish unavailable recall from an empty result in model context and
operator-facing status. Log the failure, leave durable writes queued, and
report recovery without emitting a notification for every retry.

### Control, correction, and forgetting

Provide operator-facing exclusion controls before automatic ingestion is
enabled; enforce them before any external request, not through model
instructions. Topic exclusion governs both sending that topic's content
and whether shared memories may be recalled there. Enabling memory does
not silently backfill excluded or historical messages.

New dated corrections can be retained while preserving historical facts;
verify that recall distinguishes past from current state. Explicit
forgetting must first resolve and show the affected sources, then require
the operator's go-ahead before deletion. Persist source suppression, cancel
pending ingestion, and serialize against in-flight writes before deleting
remote documents and accounting for derived observations. Suppression must
survive restarts and any future backfill so forgotten sources cannot be
resurrected by retries.

Forgetting indexed knowledge is distinct from erasing original Telegram
messages or Goblin history. Explain that distinction. Stored recall
snapshots and tool results can also contain forgotten information; remove
or redact those projections and intentionally reset the affected request
prefix. Never claim complete erasure while originals, backups, or provider
retention still exist. Document that restoring an older backup can restore
forgotten data and requires suppression reconciliation before serving it.

### Operations and verification

Basic database maintenance only: leave PostgreSQL autovacuum enabled,
surface health/storage errors, and document upgrades and recovery. Backups,
retention schedules, encryption, off-machine storage, and restore drills
belong to the operator. Ship guidance on what to back up and how to restore,
not a backup scheduler. No automatic volume pruning or destructive cleanup.
Image rollback alone is not database rollback after a schema migration.

Every service boundary and queue mutation emits structured signals:
conversation/document IDs, operation, duration, result count, retry state,
and classified failures without credentials or raw memory contents.
Status must distinguish disabled, healthy, degraded, and pending work.

Tests fake external services, never invoke an unspecified model. Release
gates: cross-topic recall; dated correction; no duplicate documents on
retry; durable restart recovery; authority fencing; exclusions; forgetting
through in-flight writes and derived data; stable cached prefixes; outage
degradation; validation of a real Hindsight server under Bun. Live model
verification uses only explicitly configured models and credentials.

Borrowed mechanisms, not scope: OpenClaw's
`docs/reference/templates/AGENTS.md` supplies source-aware user directives
and supersede-in-place correction; keep USER.md for small deliberate
always-needed preferences, not a parallel automatic memory database.
Hermes' `AGENTS.md` and
`website/docs/user-guide/which-file-does-what.md` establish frozen past
context for prompt caching; apply that to persisted per-turn recall rather
than importing its session lifecycle. See also Hindsight's
[SDK](https://hindsight.vectorize.io/sdks/nodejs),
[installation](https://hindsight.vectorize.io/developer/installation),
[retain](https://hindsight.vectorize.io/developer/retain), and
[recall](https://hindsight.vectorize.io/developer/retrieval) documentation.

Implementation order: configuration/provider compatibility contract →
portable container assets and operations guidance → memory client, durable
queue, controls, and turn integration → boundary tests → explicitly
configured live verification. Reranker selection and exact provider
configuration must be resolved before the live-verification step.

## Auth

No secrets in env — the agent's `bash` tool inherits the process environment,
and env vars leak. Instead: `$GOBLIN_HOME/auth.jsonl`, mode `0600`, one record
per line:

```json
{"name": "openrouter", "value": "!pass show api/openrouter"}
```

A value is either a literal credential or `!<command>` — resolved by executing
the command and reading stdout, lazily at the point of use, in-process.
Resolved values never enter the tool environment, the model context, or logs.

## Telegram intake & delivery

- grammy long polling; the `allowedUsers` config key gates access first thing.
- **Coalescing buffer**: rapid-fire messages in one conversation merge into
  one turn. Real product value in v1 — but its 1.5s quiet window was
  inherited, never measured, and it is a flat latency tax on every
  single-message turn. Ruled 2026-09-25 from a live 7-chunk paste: worst
  inter-chunk gap 167ms ≈ one long-poll RTT to the public Telegram API
  (~185ms from this box) — poll-boundary straddles, not client pacing — so
  the window is **500ms** (3× observed worst) while polling the public API.
  RTT-sized gaps are structural there; 200–300ms becomes safe only when
  polling goes LAN-side (self-hosted bot-api). The 10s dribble ceiling
  stands.
- **Delivery**: `streamText` deltas → throttled message edits (~1/s), final
  flush on completion. Typing indicator while a turn runs. Errors post a short
  message and log structured detail.
- **TTS**: default-on — absent config means
  `tts: {kind: "edge", voice: "en-US-AriaNeural"}`; `tts: ""` is the
  explicit off (it parses to `false` so the mini app's whole-file
  rewrite can't silently lose it and reload as on). The service is the
  Edge read-aloud websocket (no auth, unofficial, it can break; failures
  surface as a warn + a short chat message, never a turn failure — the 🔊 tap is
  answered immediately because Telegram expires callback queries in
  seconds and synthesis outruns them, so an outcome can't ride the
  toast). Three doors into
  the same `synthesizeSpeech`: the `speak` tool (text or file path, sent
  in-stream via the sink — and, when `tts.voices` configures alternates, a
  per-call `voice` zod-validated against that allowlist; Edge derives the
  language from the voice name, so alternate voices are alternate
  languages), a 🔊 button stamped on a completed reply's
  last bubble, and `/voice` mode (below). Input over ~10k chars is
  chunked at sentence boundaries inside the module — the cap is a sanity
  guard, never a control-flow path the model must recover from. Button
  text is stripped of the tool-status tail, code blocks, long URLs, and
  markdown before synthesis (`speakable`); tool input is already authored
  for speech. Edge's supported
  WebM/Opus stream is remuxed losslessly through ffmpeg to ogg/opus — a real
  voice-note bubble, not an audio-file card. ffmpeg is probed at boot —
TTS is default-on, so always; a failed probe takes TTS down for the run
with a boot warning (install ffmpeg and restart to re-enable) instead of
failing message by message.
  `record_voice` chat action runs while synthesis is in flight. The
  button voices the *whole* reply, not the tapped bubble: delivery keeps
  a bounded in-memory map of its own recent sends (chat, message id →
  full reply text — one process, one operator, no schema change), and a
  miss (restart, old message) degrades to the tapped bubble's text,
  warn-logged. No button in voice mode — the reply is already audio.
  Every door speaks the reply's language: the `speak` tool picks its
  voice per call, and `/voice` mode and the 🔊 button sniff the
  speakable text and cast the matching voice from `voice` + `voices` —
  one cast list, three consumers; `voice` speaks when the language is
  unclear or no cast member matches.
- **Files**: `send_file` is the file-out twin of intake media: it
  *names*, it does not send. The tool hands a workspace path (+ optional
  caption) to the turn's delivery sink (`sink.onFile`), which owns the
  Telegram call — so "Telegram send is delivery, not a tool" stays true
  and file sends ride the same serialized chain and authority fencing
  as text: a `/stop`'d turn can't emit one. Delivery sniffs magic bytes
  (never the extension): images go as photo previews, everything else
  as documents — except that `as_file` forces the document path
  (sendPhoto re-encodes; a document is byte-exact) and GIFs always
  ride it (sendPhoto strips animation). The file travels from disk
  (no whole-file buffering), capped at the local bot-api's 2GB upload
  ceiling.
- **Voice mode**: `/voice` toggles voice-note replies per conversation —
  a settings command like `/memory on|off`, epoch bump and all, so a
  turn never switches medium mid-flight. When on, delivery skips
  streamed text entirely: typing indicator while the turn runs,
  `record_voice` while it synthesizes, then the final reply as voice
  notes. The mode changes delivery, not the record — history still
  stores the reply text, so toggling off loses nothing and "what did you
  say verbatim" stays answerable. Code blocks and long URLs aren't
  spoken; a reply carrying them sends them as a plain text message
  alongside the audio. Composes with topics: a voice-mode topic plus
  voice-note intake transcription is a fully ears-in-ears-out
  conversation.
- **Mini Apps**: the process serves an HTTP endpoint on localhost; the bot
  links pages via `web_app` buttons. Telegram requires HTTPS, and the page is
  fetched by the *client device* — so the door is a config knob (`publicUrl`)
  and nothing in the process assumes a public IP. Reference doors, all
  zero-open-port: `tailscale serve` (tailnet HTTPS, auto cert — works when
  operator devices are on the tailnet, the v1-on-lithium pattern), `tailscale
  funnel` (public HTTPS relayed through Tailscale's edge, for off-tailnet
  clients), or any reverse proxy with a cert. NAT-first by construction.
  The settings page ships as two static files the process serves verbatim —
  markup+css in `http/app.ts`, client script in `http/app.js`, no build step.
  tsc checks the client (`tsconfig.client.json`: checkJs, DOM lib scoped to
  that program only) against the server's own wire types, so schema drift is
  a typecheck failure, not a phone-only bug.
- **Commands** are few on purpose: `/voice` `/memory` `/forget` `/stop`
  `/compact`. `/model` and `/think` are retired — the mini app owns
  model and thinking settings (config lives where config lives), which
  keeps the chat surface small. No conversation-lifecycle commands —
  topics own that. The one exception is
  `/start`: clients fire it automatically on first open, so it gets a canned
  greeting (consumed before intake, never a model turn) and stays hidden
  from the advertised command menu.
- **Large files**: self-hosted `telegram-bot-api` on lithium, `--local` mode,
  grammy `apiRoot` → `http://127.0.0.1:8081`. Needs `api_id`/`api_hash` from a
  my.telegram.org app registration (operator's account, stored as secrets —
  "Little Goblin" app, api_id 955258, already minted for the v1 e2e harness,
  lives in `little-goblin/e2e/.env`). App-platform cred, not per-environment:
  all instances share it; dev/prod splits on bot token + server instance.
  No inbound ports — long-poll only, the server dials out to Telegram; its
  only client is goblin on the same box. `getFile` returns an absolute local
  path — intake reads the file off disk, no HTTP fetch. Uploads ≤2GB,
  `file://` URIs for sends. The server's working dir is a staging cache, not
  storage — Telegram still owns the files; periodic clean is safe (worst
  case = re-fetch via `file_id`). Deploy: static binary + systemd unit (no
  docker); build off-box, TDLib compile would crush lithium.

## State layout

```text
$GOBLIN_HOME/
├── goblin.json5            # providers, models, defaults
├── auth.jsonl              # secrets, mode 0600
├── workspace/              # the agent's home; every tool runs here
│   ├── SOUL.md             # required, template-created on first boot
│   ├── AGENTS.md           # stub-created on first boot, then agent-owned
│   ├── USER.md             # operator model — directive entries (observed
│   │                       # date, active/superseded), agent-grown
│   │                       #
│   │                       # Keep small deliberate preferences here;
│   │                       # automatic cross-topic memory belongs to the
│   │                       # approved Long-term memory design. Update the
│   │                       # prompt-shell "only memory" claim when wired.
│   ├── skills/             # the skill catalog — agent-authored, in cwd
│   └── attachments/
└── state/
    ├── goblin.sqlite       # Goblin state: conversation meta, event
    │                       # history (UIMessage JSON rows), bindings,
    │                       # memory outbox/contexts/suppressions,
    │                       # programs, delegations
    └── delegations/<id>/report.md   # a harness's final report
```

SQLite durability = WAL + transactions (`synchronous=NORMAL` minimum), not
tmp/fsync/rename — that ritual is for whole-file state only. Inspectability
is an export/query command, not a format property.

## Config

`goblin.json5`: provider registry, per-conversation default model/thinking,
optional `transcription` block, optional `search` block (absent =
search tool absent), optional `memory` block (absent = memory
disabled), optional `delegation` block (`session`, default
`"goblin"`; `maxRunning`, default 3; `harnesses`: name → `{ kind,
args? }` — absent = delegate tool absent). No secrets — those live in
`auth.jsonl`.

**Settings are operator-facing UI, not SSH.** The mini app is the
configuration surface: the process reads and writes `goblin.json5` itself, and
the operator changes settings from Telegram. Editing the file by hand always
works; it is never required.

## Module map

```text
src/
  index.ts          composition root: config → auth → conversations → bot → http
  config.ts         goblin.json5, zod-validated
  auth.ts           auth.jsonl reader + "!" command resolution
  log.ts            structured log; no console.log anywhere else
  tg/               grammy: intake, buffer, delivery, commands (only grammy-aware dir)
  conversation.ts   store: SQLite-backed resolve/load/append events, meta, epoch
  memory.ts         recall contexts, retention builders, status, worker timer
                    (wire client in hindsight.ts, outbox in memory-queue.ts,
                    outage episodes in memory-outage.ts)
  programs.ts       standing programs — rows in goblin.sqlite, cron
                    validated at the boundary, webhook token hashes
  scheduler.ts      ticker: due programs → turns in their pinned
                    conversation; fire() is shared with the webhook route
  herdr.ts          herdr CLI adapter (the only herdr-aware module)
  delegations.ts    delegation rows + watcher ticker: herdr state →
                    turns in the pinned conversation
  runtime.ts        per-conversation queue, turn loop, checkAuthority
  agent/
    providers.ts    registry: name → AI SDK provider
    models-dev.ts   input-modality catalog (fetch, cache, backoff) — two
                    catalog fetchers live here (models.dev, openrouter);
                    the next change to either extracts one
                    fetchCachedCatalog helper and migrates both. No third
                    copy.
    codex.ts        codex OAuth provider — credentials lifecycle, wire
                    conversion, LanguageModelV2; splits into
                    codex/auth.ts + codex/model.ts when next touched
                    (external-change pressure lands on one 770-line file)
    attachments.ts  data-attachment parts + per-turn materialization
    transcribe.ts   speech → text (groq whisper, more kinds later) —
                    intake + transcribe tool share it
    tts.ts          text or file → speech (edge read-aloud ws, opus out)
    prompt.ts       system prompt assembly (shell + SOUL.md + agent-owned
                    AGENTS.md/USER.md, each capped at 8k chars; re-read
                    every turn, edits live next message)
    skills.ts       catalog scan + frontmatter validation → ## skills section
    tools/          the twelve tools (read, write, edit, bash, speak,
                    transcribe, program, delegate, send_file,
                    memory_search, search, fetch)
  http/             mini-app serving + POST /hook/<token>
    app.ts          page markup+css (served as-is, no build step)
    app.js          page client — plain JS, tsc-checked (checkJs via
                    tsconfig.client.json); wire types imported from
                    mod.ts/config.ts so schema drift fails typecheck
```

Flat modules, one job each, tests colocated.

## Non-goals (v1 — return only on demand)

The list below is a record, not a law. The law, applied to any capability:

1. **Core** — what the turn loop's honesty depends on (ordering, authority,
   durability, delivery). Always in; defects here jump the queue.
2. **Chat-native** — a natural property of one operator talking to one agent
   in Telegram: text/voice/media intake, topics, settings commands, the
   soul. In scope by default; a missing piece here is a gap *against this
   doc*, not a deferral. (Voice notes are chat-native — the rewrite exists
   because pi couldn't do audio; if transcription is missing, that's a bug
   in the roadmap, not a choice.)
3. **Machinery** — a second system the loop must keep honest: memory stores,
   schedulers, subagent fleets, MCP brokers, skill catalogs, projects, inner
   life. Out until explicitly demanded; when demanded, designed here first.

If a capability can't be classified in one sentence, the classification is
   the design conversation — have it before building.

memory store (returned on demand — approved in `Long-term memory`) ·
scheduler (returned on demand — generalized into `Programs`;
heartbeat/proactive monitoring stays out) · web access (returned on
demand — designed in `Web access`; MCP and a native browser tool stay
out) · delegated work / external agents (returned on demand —
designed in `Delegation`) · conversation-lifecycle
commands · subagents · ACP · MCP ·
project environments · inner life · onboarding wizard · state
migrations (general framework; additive memory schema changes are in scope) ·
in-process embeddings (delegated to Hindsight for memory) · multi-user

## Test posture — the real change

v1 died of test-to-code ratio. New rule: **tests guard boundaries and
invariants, not implementations.** Worth a test: authority fencing, durable
write semantics, intake coalescing, auth command resolution. Not worth a test:
that a function calls its collaborator with the right arguments. Fakes at the
two external edges (model provider, Telegram API); no mock.module pyramids.
The suite should stay smaller than `src/` — if it isn't, that's a smell to
fix, not a badge.

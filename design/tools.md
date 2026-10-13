# Tools — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Tools (v1)

Hand-rolled, zod-validated, nineteen:

`read_file` `write_file` `edit_file` `bash` (timeout) `speak` `transcribe`
`vision` `generate_image` `program` `delegate` `mail` `send_file`
`memory_search` `search` `fetch` `history_search` `sandbox` `script` `ui`

All tools run in the deployment workspace — conversations have no cwd and
there is no `/cd`. Working elsewhere is the agent's own business (`cd x &&
…` inside `bash`), not conversation state.

The static bash description advertises `../doctor --json` for dependency
diagnosis, not repairs or restarts. This is an existing tool's discoverable
workspace utility, not a new native tool or per-turn prompt injection;
see [Doctor](doctor.md).

Tool input schemas are flat objects at the root; the per-action contract
is a discriminated union enforced inside `execute`. A root
`discriminatedUnion` serializes to root-level oneOf, which some providers
cannot generate arguments against — every call arrives as `{}` and fails
validation. That silently took out mail (Sep 28); program, delegate, and
history_search were found carrying the same shape and flattened too.
`programInputSchema` is the flattened-union pattern: a wide flat object
+ `superRefine` delegating to the per-action union.

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

`generate_image` is the outbound twin of `vision`: present only when the
`image` config block names a `<provider>/<model>` ref whose provider is
`openai-compatible` or `responses` (the kinds that carry `baseUrl` — the
call is the OpenAI images shape, `POST {baseUrl}/images/generations`,
auth riding the provider's auth.jsonl ref). Generated files land in the
attachment store like intake media — the returned path is a real file
`vision` can then inspect and `send_file` can resend — and the tool also
hands each one to the turn's delivery sink (`sink.onFile`), so Telegram
shows the photo inline while the saved path remains the durable artifact.
"Telegram send is delivery, not a tool" stays true; a `DeliveryUncertainError`
is reported, never retried. `size` defaults from the config block and `n`
caps at 4 per call. Guest channels exclude it like the other
provider-calling tools.

`program` manages standing programs (list/create/update/delete/toggle/
hook) — see `Programs`. `delegate` hands tasks to other harnesses —
see `Delegation`. Both are bound per-turn to the running conversation
so what they create is pinned to the chat/topic it was born in; the
model never handles chat ids.

**Tool results are text — except where the pipe verifiably carries
documents.** The SDK's `toModelOutput` media-parts hook exists, but
whether bytes survive depends on the provider's converter:
openai-compatible stringifies tool-result content and the codex
Responses shim filters it to text — an image sent as stringified JSON is
garbage, not vision. The exceptions are probe-verified (Web access,
above): z.ai's Responses endpoint parses `input_file` inside
`function_call_output`, and OpenRouter's normalizer maps tool-result
parts — which is why `carriesMedia` is position-aware, and why fetch's
`toModelOutput` may legitimately return a `file` part. Within that, the
tool-side rule stands: no image bytes in results. `read_file` sniffs
magic bytes and returns a structured note (type, dimensions when the
header carries them, size) naming the working channels in preference
order — the `vision` tool when its block is configured (the note knows
because tool registration and the note share makeTools), the operator
sending the image via Telegram otherwise (intake materializes it
natively for vision models), and always `bash`/`ffmpeg` for metadata
work.

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

External agents arrived as `delegate` (see `Delegation`); MCP arrived
as a skill over goblin's own mcporter (see `Web access`). Subagent
tools do not exist — they arrive with the feature that needs them,
designed then, not spec'd now. `script` composes the other tools inside
one call and is not a subagent — see `Scripting`.

## Scripting

On demand (ruling 2026-10-10). A `script` tool: the model writes one
JavaScript program that calls goblin's own tools in a loop and returns
only the digest. A 30-fetch research sweep otherwise costs 30 tool
results in context; the only escape was `delegate`, a whole second
harness. This is the cheap middle rung — context compression, not
autonomy: still goblin, still one turn. Mechanism from hermes'
`execute_code` (programmatic tool calling: allowlist ∩ enabled set,
call cap, bounded stdout with spill) and pi's codemode
(`@earendil-works/pi-codemode`: a QuickJS VM whose only capability is
the injected tools). Not taken: hermes' persistent kernel and remote
backends; pi's `store`/`load`, `models`, `searchTools`/deferred
exposure, `mode: only`, and Cloudflare sandboxes.

- **Scripts compose tools; they never reason.** A script is a
  deterministic composition of tool calls inside one tool call:
  in-process, no model calls, no state across calls, no endpoint. The
  moment any of those stops holding it is a subagent and the non-goals
  apply. The trade-off is stated, not hidden: no judgment between steps
  — scripts are for mechanical fan-out (fetch N URLs, run a command per
  file, filter a big result), not research where step 5 depends on
  reading step 3.
- **In-process VM, never a loopback RPC.** Hermes' shape (a child
  process calling back over a socket) was rejected: a bash-spawned
  process can background itself past `/stop` and the epoch fence, and a
  loopback port is ambient authority for every same-uid process —
  delegated harnesses included — an MCP broker in all but name. The
  QuickJS VM runs in a worker thread per call (~20 ms); it has no
  filesystem, network, timers or process, so its reach is exactly the
  injected tools. Its heap is capped at 256 MiB (`memoryLimitBytes`;
  the library default is wasm32's 4 GiB — a 2 GB accumulate loop
  completed unbounded in review): scripts are glue over already-bounded
  tool results, and g7 shares RAM with ollama and the memory stack.
  Over-allocation fails inside the script as `out of memory`. Measured
  on g7 (Bun 1.4.2): 30 parallel nested calls in 148 ms; a spinning
  `while (true) {}` stopped 203 ms after abort.
  This also keeps scripts orthogonal to the container sandbox
  (`design/sandbox.md`): no port punches through it.
- **Callable set = allowlist ∩ the turn's assembled set**, built after
  guest filtering, so every per-turn gate carries over (no search block,
  no `tools.search`; a personal guest turn's script can't reach
  `memory_search`). Allowed: `read_file` `write_file` `edit_file`
  `bash` `fetch` `search` `memory_search` `history_search` `transcribe`
  `sandbox`. Excluded: `speak` `send_file` `ui` (delivery rides the
  sink), `mail` (per-send human approval), `delegate` `program` (spawn
  agents / standing work), `vision` (a model call). Excluding writes
  would be theater — `bash` writes.
- **Nested calls are real calls.** Each one is zod-validated against
  the tool's own input schema (the SDK validates direct calls; nothing
  validates inside the VM), runs the tool's live `execute` — looked up
  at call time, so the runtime's authority fence wraps nested calls too
  — under the turn's abort signal, with call id `<parent>/<n>`. A call
  rejects inside the script when it throws, returns `{ error }`, or
  fails validation; `bash` resolves on non-zero exits. Capped per script
  (`maxCalls`, default 50) and in flight (8 concurrent). Calls that
  completed before a failure are not undone. Raw results, never
  `toModelOutput` — a fetched PDF is its `{ pdf: { url, path, size } }`
  ref.
- **Output is bounded, and tainted output rides fenced.** The result is
  a goblin-authored status line (completed/failed, error kind, wall
  time, call count) plus the script's `text()`/`console` items and
  return value, in fetch's head+tail window (15k chars) with the full
  text spilled to `state/scriptcache/<sha>.txt` and the footer naming
  the `read_file` call. When any nested `fetch` or `search` completed,
  the body rides in `fenceUntrusted("web", …)` — slicing a fenced
  result strips its fence, and the script's output may quote the page
  verbatim. Untainted output stays bare: fencing local data too would
  teach the model to ignore the fence. `bash` and `sandbox` output stay
  unfenced, as they are directly.
- **The description lists names, not declarations.** The callable tools
  are already declared directly; their arguments are identical inside
  the script, so the description names them and states the result
  shapes that differ from text (`bash`, `fetch`, `{ error }`
  rejection). It is a pure function of the assembled set, so it moves
  only when the tool list does. `script` sits before `ui` so the
  `Tools:` line's shared prefix holds.
- **Evidence and logging.** The stored output carries a bounded call
  record (tool, args ≤200 chars, ok, result ≤300 chars); the model sees
  only the text (`toModelOutput`). The stream expands that record into
  the reviewer's digest and tool-call list as `script.<tool>` entries,
  so the skill reviewer sees what ran. Loop detection treats the script
  as one call. Every nested call logs `tool call` / `tool execute
  failed` with `parent`; every script logs one `script done` line (ok,
  error kind, calls, ms, output bytes, truncated, fenced).
- **Config.** `scripting: { maxCalls?: 50 }` — absent means no tool,
  the same live per-turn gate as `vision`/`search`. Input: `code`, and
  `timeout_ms` (default 120 s, capped at bash's 10 min). The dependency
  is pinned exactly (`@earendil-works/pi-codemode` 1.0.4 — 1.0.1 and
  1.0.4 fix two ways a script crashed the host process).

## Vision

On demand (2026-10-06). A `vision` tool: query-driven image Q&A — the
agent asks a configured vision model a specific question about an
image file on disk, the answer comes back as text. Mechanism ported
from pi's vision extension
(`agent-extensions/pi-packages/bermudis-pi-goodies/vision.ts` +
`vision-core.ts`): targeted questions instead of one frozen generic
description, and follow-up threads keyed by absolute path + size +
mtime — a rewritten file starts a clean thread; a vision-model switch
drops every thread so a new model never "remembers" answers its
predecessor gave.

- **Why it exists despite the no-image-bytes rule.** The pipe rule
  above makes a disk image invisible to the conversation's model,
  vision-capable or not — intake materialization only covers media
  that arrived through a channel as history. Files the agent itself
  produces or meets (a browser-skill screenshot, an ffmpeg-extracted
  frame, a downloaded image) had exactly one consumer left: the
  operator's eyes. The vision tool is the second.
- **Registration is per-mode, live-read each turn** (ruling
  2026-10-05, replacing the always-on-when-configured draft). The
  block's `mode` field defaults to `"auto"`: the tool joins the set
  only while the conversation's chat model can't consume images —
  the same two gates attachment materialization applies, catalog
  modality AND the provider pipe (`inputModalitiesCached` +
  `carriesMedia`, user position). A cold catalog counts as blind — a
  spare tool beats a blind agent. `mode: "always"` keeps the original
  ruling available: registered for every conversation, because a file
  on disk is invisible to a vision-capable chat model too — pi's read
  tool could put an image in front of a vision model and goblin's
  cannot (tool results are text, above).
- **Config**: a `vision` block (`model` — a "<provider>/<model-id>"
  ref through the same registry as the daily driver, so auth rides
  the provider's own `auth.jsonl` ref; `maxTokens`, default 2000;
  `mode`, default `"auto"`). Absent or `""` = the tool is not in the
  set. The mini app gets a Vision row on the model-sheet pattern —
  the picker chooses the answering model, Off clears to `""`; `mode`
  stays a hand edit the page round-trips untouched. The ref is
  provider-validated in config `superRefine` like `model` and
  `titleModel`; it is deliberately not capability-gated at load
  time — input modalities are runtime catalog knowledge, and the
  provider fails loud on a text-only model.
- **Thinking pinned off** for the Q&A calls — a forced-thinking
  vision model answers in prose anyway and burns a reasoning
  round-trip per question.
- **The call**: one `generateText` per question — system prompt
  refuses instructions embedded in the image, prior turns replay as
  plain text with the image riding only the final user turn,
  `maxOutputTokens` capped, 120s timeout racing the turn's abort
  signal, wrapped in `observedModel` (purpose `vision`) and logged
  with the usage split (the title-call rule).
- **The answer rides fenced** — same rule as search results and
  delegate screens: a vision model's reading of arbitrary image
  content is remotely controlled text, and the fence keeps it from
  quoting goblin's own framing.
- **No resize.** Bytes go as-read under the shared 8 MiB per-item
  cap (`INLINE_ITEM_MAX_BYTES` — parity with inline attachments);
  an over-cap image errors with the ffmpeg downscale one-liner.
  Known limit, accepted: resize machinery arrives when a real image
  flow needs it, not before.
- **Threads are process-local, keyed by conversation + image**
  (conversation id + absolute path + size + mtime — the tool is
  per-turn bound to its conversation, delegate's rule): a follow-up
  never replays another conversation's Q&A about the same image, and
  a rewritten file starts clean. Capped (16 threads × 10 turns,
  LRU — per-conversation keying doubles the resident set a single
  conversation could claim, so the cap doubles with it; still O(1)
  memory), never persisted — a restart forgets them and a follow-up
  starts fresh, which the tool contract permits ("may remember", not
  "will remember").

## Chat search

On demand (2026-09-26, the first slice of "richer inner life"). A
`history_search` tool: full-text search over goblin's own conversation
history — "what did we decide about X last month?".

- **SQLite FTS5** over the text of user and assistant events, a
  contentless index kept by insert/delete/update triggers (an additive
  schema change — in scope; deletes stay honest through the delete
  trigger). Contentless, not external-content: events stores JSON
  envelopes, so there is no plain-text content column to point at —
  the indexed value is a text-parts projection. Tool-call payloads
  and system events are not indexed. Queries are plain terms, each
  quoted into an AND — no FTS syntax reaches MATCH.
- **Scope: every conversation except memory-excluded ones**, checked
  at query time against the live `memoryExcluded` flag — `/memory off`
  means off for search too, retroactively. Excluded topics also can't
  wield the tool: exclusion means a topic recalls nothing, the same
  rule as `memory_search`.
- Output: bounded list of topic title · date · role · snippet, plus
  the address/event id to page context around a hit.

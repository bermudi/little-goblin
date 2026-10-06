# Tools — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Tools (v1)

Hand-rolled, zod-validated, fourteen:

`read_file` `write_file` `edit_file` `bash` (timeout) `speak` `transcribe`
`program` `delegate` `mail` `send_file` `memory_search` `search` `fetch`
`history_search`

All tools run in the deployment workspace — conversations have no cwd and
there is no `/cd`. Working elsewhere is the agent's own business (`cd x &&
…` inside `bash`), not conversation state.

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
designed then, not spec'd now.

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
  operator's eyes. The vision tool is the second. It is therefore
  registered for every conversation when configured — no
  vision-capable self-hiding like pi's extension, because pi's read
  tool can put an image in front of a vision model and goblin's
  cannot (tool results are text, above).
- **Config**: a `vision` block (`model` — a "<provider>/<model-id>"
  ref through the same registry as the daily driver, so auth rides
  the provider's own `auth.jsonl` ref; `maxTokens`, default 2000).
  Absent = the tool is not in the set; hand-edited only, like
  `delegation` — the mini app does not get a surface. The ref is
  provider-validated in config `superRefine` like `model` and
  `titleModel`; it is deliberately not capability-gated at load
  time — input modalities are runtime catalog knowledge, and the
  provider fails loud on a text-only model.
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


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
header carries them, size) naming the two working channels — the operator
sending the image via Telegram (intake materializes it natively for vision
models) or `bash`/`ffmpeg` for metadata work.

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


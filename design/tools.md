# Tools — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Tools (v1)

`memory_reflect` is on-demand — not automatic recall or an autonomous turn
loop — and stays out of the script tool's callable set because it invokes a
model.

Working outside the conversation's cwd is the agent's own business (`cd x &&
…` inside `bash`). The bash description's doctor shim is diagnosis only —
never repairs or restarts ([Doctor](doctor.md)).

**Root schemas stay flat.** A root `discriminatedUnion` serializes to
root-level oneOf that some providers cannot generate arguments against —
every call arrives as `{}` and fails validation (it took out mail Sep 28);
the per-action contract is a discriminated union enforced inside `execute`.

**Tool-call repair is rule-based, never a model re-ask** (ruling
2026-10-24): `streamText`'s `repairToolCall` (`src/agent/tool-repair.ts`)
rewrites an invalid call only when a rule applies — JSON5-strict syntax
slips, and a top-level property whose schema type is object/array
(anyOf/oneOf included) holding a JSON string gets parsed into place.
`NoSuchToolError` and unparseable (truncated) input are declined; a
repair that still doesn't validate surfaces as the usual tool error.
Every attempt logs `tool call repaired`/`tool call not repaired` with
the fixes or the reason. Per-tool input repair (e.g. `ui`'s
`normalizeUiInput`) stays the tool's own validator concern.

`speak` synthesizes and hands the bytes to the turn's delivery sink — it
does not send; the sink owns the Telegram call, so "Telegram send is
delivery, not a tool" stays true and voice notes ride the same serialized
chain and authority fencing as text (a `/stop`'d turn can't emit one).

`generate_image` files land in the attachment store — the saved path stays
the durable artifact — and ride the turn's delivery sink; an uncertain
delivery (`DeliveryUncertainError`) is reported, never retried. Guest
channels exclude it like the other provider-calling tools.

`program` and `delegate` are bound per-turn to the running conversation, so
what they create is pinned to the chat/topic it was born in; the model never
handles chat ids. `herdr` reaches the operator's own `default` session by
pane ID; it mounts for every personal conversation with no config gate, and
guest surfaces lose it like `delegate`.

**Tool results are text — except where the pipe verifiably carries
documents.** openai-compatible stringifies tool-result content and the
codex Responses shim filters it to text; the exceptions are probe-verified
(Web access, above): z.ai's Responses endpoint parses `input_file` inside
`function_call_output`, and OpenRouter's normalizer maps tool-result parts.
The rule stands: no image bytes in results.

**Bash offloads, never truncates** (ruling 2026-10-14 — Deep Agents'
"large outputs are offloaded, not truncated"; the spill-and-name rule
fetch and script already follow): over-budget output becomes a tail-heavy
head+tail window and the full output lands content-addressed in the bash
cache, the footer naming the file and the `read_file` call that pages
through it. The old tail cut dropped the head for good, and a command with
side effects can't be re-run to see it. Overflowing the capture cap still
kills the process (the runaway guard); the output then says the saved file
is incomplete. The spill file is a recovery aid,
never replayed: the result string is fixed when the call returns (Cache
stability); like webcache, it is never pruned. `sandbox` keeps its tail cut
for now — container output is a separate surface. Special files (devices,
FIFOs, sockets) are refused before any I/O — `read_file` on `/dev/zero` is
a hang, not a read; `bash` (timeouts + output caps) is the sanctioned
channel for those.

## Scripting

On demand (ruling 2026-10-10). A `script` tool: the model writes one
JavaScript program that calls goblin's own tools in a loop and returns
only the digest — a 30-fetch research sweep otherwise costs 30 tool
results in context, and the only escape was `delegate`, a whole second
harness. The cheap middle rung: context compression, not autonomy — still
goblin, still one turn. Mechanism from hermes' `execute_code` and pi's
codemode (`@earendil-works/pi-codemode`: a QuickJS VM whose only
capability is the injected tools). Not taken: hermes'
persistent kernel and remote backends; pi's `store`/`load`, `models`,
`searchTools`/deferred exposure, `mode: only`, and Cloudflare sandboxes.

- **Scripts compose tools; they never reason.** A script is a
  deterministic composition of tool calls inside one tool call:
  in-process, no model calls, no state across calls, no endpoint. The
  moment any of those stops holding it is a subagent and the non-goals
  apply. No judgment between steps: scripts are for mechanical fan-out,
  not research where step 5 depends on reading step 3.
- **In-process VM, never a loopback RPC.** Hermes' shape (a child process
  calling back over a socket) is rejected: a bash-spawned process can
  background itself past `/stop` and the epoch fence, and a loopback port
  is ambient authority for every same-uid process — delegated harnesses
  included — an MCP broker in all but name. The QuickJS VM runs in a
  worker thread per call (~20 ms); it has no filesystem, network, timers
  or process, so its reach is exactly the injected tools. Its heap is
  capped — the wasm32 default is 4 GiB, and a 2 GB accumulate
  loop ran unbounded in review: scripts are glue over
  already-bounded tool results, and g7 shares RAM with ollama and the
  memory stack. Over-allocation fails inside the script as
  `out of memory`. Measured on g7 (Bun 1.4.2): 30 parallel nested calls
  in 148 ms; a spinning `while (true) {}` stopped 203 ms after abort.
  This also keeps scripts orthogonal to the container sandbox
  (`design/sandbox.md`): no port punches through it.
- **Callable set = allowlist ∩ the turn's assembled set**, built after
  guest filtering, so every per-turn gate carries over. Delivery rides the
  sink, `mail` needs per-send human approval, agent-spawning and
  model-calling tools are out, and prompting the operator's panes is
  deliberate per-call work, not scriptable fan-out. Excluding
  writes would be theater — `bash` writes.
- **Nested calls are real calls** — each runs the tool's live `execute`,
  so the runtime's authority fence wraps it, under the turn's abort
  signal. Calls that completed before a failure are not undone.
- **Nested calls don't produce SDK tool parts** — they run `execute`
  directly, so a presentation tool can't ride the allowlist alone
  (ruling 2026-10-21). `artifact` is the typed presentation seam: a
  nested call's `{artifact}` result is collected into
  `output.presentations` under the stable child call id
  (`<scriptCallId>/<n>`), kept out of the digest text so bytes never
  re-enter context, and rendered by the app through the same card path
  as a direct call. Completed presentations survive a script that fails
  afterwards — the no-rollback rule above.
- **The bounds live in the worker, before a call can post.** Upstream
  posts every call the VM makes; a cap checked only on the host would run
  after the port flooded and every args blob parsed. A local worker entry
  wraps the pinned upstream worker, bounding calls, argument sizes and
  posting before anything reaches the host. The first violation crashes
  the whole script (`kind: sandbox`) and trips the shared interrupt: the
  bound is a terminal contract, not a rejection a catch-and-retry loop can
  spin against. Queued calls are dropped when the script settles — an
  unawaited call can never execute afterwards; the host's own bounds stay
  as defense-in-depth.
- **Output is bounded, and tainted output rides fenced.** The raw output
  is windowed with the full text spilled and the footer naming the
  `read_file` call. Unlike webcache
  spills, a scriptcache spill is temporary — a later script's sweep may
  reclaim it, and the footer says so. When any nested `fetch` or `search`
  completed, the body rides in `fenceUntrusted("web", …)` — taint latches
  at dispatch, not on success, because a failed fetch still carries
  remotely shaped text where the script may quote it; slicing a fenced
  result strips its fence, and the script's output may quote the page
  verbatim. Untainted output stays bare: fencing local data too would
  teach the model to ignore the fence. `bash` and `sandbox` output stay
  unfenced, as they are directly.
- **The pi-codemode dependency is pinned exactly** — earlier upstream
  point releases each fixed a way a script crashed the host process.

## Vision

On demand (2026-10-06). A `vision` tool: query-driven image Q&A — the
agent asks a configured vision model a specific question about an image
file on disk, the answer comes back as text. Mechanism ported from pi's
vision extension
(`agent-extensions/pi-packages/bermudis-pi-goodies/vision.ts` +
`vision-core.ts`): targeted questions instead of one frozen generic
description, and follow-up threads keyed by absolute path + size + mtime —
a rewritten file starts a clean thread; a vision-model switch drops every
thread so a new model never "remembers" a predecessor's answers.

- **Why it exists despite the no-image-bytes rule.** The pipe rule makes a
  disk image invisible to the conversation's model, vision-capable or not —
  intake materialization covers only media that arrived through a channel.
  Files the agent produces or meets (a browser-skill screenshot, an
  ffmpeg-extracted frame, a downloaded image) had one consumer left: the
  operator's eyes. The vision tool is the second.
- **Registration is per-mode, live-read each turn** (ruling 2026-10-05).
  The block's `mode` field defaults to `"auto"`: the tool joins the set
  only while the conversation's chat model can't consume images — the same
  two gates attachment materialization applies, catalog modality AND the
  provider pipe. A cold catalog counts as blind — a spare tool beats a
  blind agent. `mode: "always"` registers for every conversation, because
  a file on disk is invisible to a vision-capable chat model too — pi's
  read tool could put an image in front of a vision model and goblin's
  cannot (tool results are text, above).
- **Config**: the model ref is provider-validated in config `superRefine`
  like `model` and `titleModel`, but deliberately not capability-gated at
  load time — input modalities are runtime catalog knowledge, and the
  provider fails loud on a text-only model.
- **Thinking pinned off** for the Q&A calls — a forced-thinking vision
  model answers in prose anyway and burns a reasoning round-trip per
  question.
- The call's system prompt refuses instructions embedded in the image,
  and **the answer rides fenced** — same rule as search results and
  delegate screens: a vision model's reading of arbitrary image content
  is remotely controlled text; the fence keeps it from quoting goblin's
  own framing.
- **No resize.** Bytes go as-read under the same per-item cap inline
  attachments use; an over-cap image errors with the ffmpeg downscale
  one-liner. Known limit, accepted: resize machinery arrives when a real
  image flow needs it, not before.
- **Threads are process-local, keyed by conversation + image**
  (absolute path + size + mtime — the tool is per-turn bound to its
  conversation, delegate's rule): a follow-up never replays
  another conversation's Q&A about the same image, and a rewritten file
  starts clean. LRU-capped, never persisted — a restart
  forgets them and a follow-up starts fresh, which the tool contract
  permits ("may remember", not "will remember").

## Chat search

On demand (2026-09-26). A `history_search` tool: full-text search over
goblin's own conversation history — "what did we decide about X last
month?".

- Queries are plain terms, each quoted into an
  AND — no FTS syntax ever reaches MATCH.
- **Scope: every conversation except memory-excluded ones**, checked at
  query time against the live `memoryExcluded` flag — `/memory off` means
  off for search too, retroactively. Excluded topics also can't wield the
  tool: exclusion means a topic recalls nothing, the same rule as
  `memory_search`. One exception (ruling 2026-10-14): `context` on the
  calling conversation's own id always works — reading your own transcript
  recalls nothing from another topic, and without it a compacted excluded
  topic could never get its folded span back. Search and `context` on any
  other id stay refused.
- Recovered content is rendered with the compaction serializer's
  projection — the tool evidence a compaction folded is exactly what
  recovery has to give back (Compaction, design/model.md) — windowed per
  event, then **fenced as historical data**: projection and windowing may
  have removed a tool result's original untrusted fence. `context` with
  `toolCallId` (and `offset`) switches to exact paging of one stored
  tool result — the recovery path pruning markers print (DESIGN.md → Cache
  stability).

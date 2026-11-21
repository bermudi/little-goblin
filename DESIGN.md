# Goblin design notes

**Code defines shipped behavior.** Tests pin what must not change.
[DIRECTION.md](DIRECTION.md) records operator intent;
[ROADMAP.md](ROADMAP.md) tracks unbuilt work and acceptance evidence.
These notes explain choices and trade-offs. [Docs](docs/) are for operating
Goblin.

| Looking for | Start with |
| --- | --- |
| Conversation identity, history, settings | [`conversation-address.ts`](src/conversation-address.ts), [`conversation.ts`](src/conversation.ts), [`config-schema.ts`](src/config-schema.ts) |
| Request lifecycle, persistence, recovery | [`runtime.ts`](src/runtime.ts), [`turn-journal.ts`](src/turn-journal.ts), [runtime rationale](design/runtime-turn.md) |
| Client and Telegram | [`app/src`](app/src/), [`src/http`](src/http/), [`src/tg`](src/tg/) |
| Scheduled work and division of work between agents | [`programs.ts`](src/programs.ts), [`responsibility-service.ts`](src/responsibility-service.ts), [`agent-children.ts`](src/agent-children.ts) |
| Memory and conversation summarization | [`src/memory`](src/memory/), [`compaction.ts`](src/agent/compaction.ts) |

Area notes live in [`design/`](design/). Non-obvious decisions with no
existing home get a short [architecture decision record](design/decisions/).

## Domain model

An address determines where an answer belongs; do not add aliases or mirror
conversations between channels. A Telegram DM may roll to a new conversation.
The deliberate crossing is a [spin-off](design/app.md#spin-off-ruling-2026-10-03):
copy work to an app conversation and ring in Telegram, not synchronize two
histories.

## The authority rule

### Epochs move only by cancellation

A turn captures its conversation's epoch at admission; a later epoch fences
it. Only a cancellation bumps the epoch — `/stop`, `/new` and navigation, a
guest persona change, a responsibility correction — and it ends the live
turn in the same call ([`Runtime.fence`](src/runtime.ts),
[`Runtime.stop`](src/runtime.ts)), on both engines. Settings such as
`/voice` and `/memory on|off` are flag writes: they apply to the next reply,
and a streaming reply finishes in the mode it started in (operator,
2026-11-20, #820). [`module-boundaries.test.ts`](src/module-boundaries.test.ts)
keeps bare store bumps out of every other production file.

### Authority at action time

State read before an asynchronous operation may no longer authorize an action.
Re-check at the effect, inside the transaction for writes. Test the race by
making the competing change while the first action is waiting, not just by
checking the end state. See the
[delivery](src/runtime.test.ts) and [queued work](src/responsibility-authority.test.ts)
regression tests.

A crashed call may already have acted. Preserve evidence, not permission to
retry. For an external effect, record intent before acting and outcome after.
The recovery policy depends on which failure is acceptable: an uncertain
[mail send](src/mail-approval.crash.test.ts) or
[send to a worker](src/responsibility-service.crash.test.ts) is not retried
automatically; a [restart notice](src/tg/turn-notice.crash.test.ts) may repeat
rather than disappear. See [the journal](design/runtime-turn.md#the-turn-journal).

## Cache stability

Reusing the prompt prefix saves money and time. Append new input; do not
re-render material already sent just because time passed, a workspace file
changed, or a new attachment arrived. The materialization and replay checks
live in [`attachments.test.ts`](src/agent/attachments.test.ts),
[`prompt.test.ts`](src/agent/prompt.test.ts) and [`runtime.test.ts`](src/runtime.test.ts).

Intentional rewrites are limited to context resets (such as compaction,
forgetting or a persona change), changes to model or attachment modality,
rebuilding an unanswered exchange, a corrupt-row repair, collapsing one-use
skill text, and the opt-in projection of old tool results. Changing how a
compaction marker renders is also a one-time rewrite. Do not extend this set
as a side effect of unrelated work. A prefix hash change measures a request
change, not what the provider actually cached; see
[`cache-observation.test.ts`](src/cache-observation.test.ts) and
[`cache-pruning.test.ts`](src/cache-pruning.test.ts).

## Config

Settings is the routine editing surface; direct edits are for bootstrap and
recovery. Do not build a second settings workflow around the file. See the
[operator guide](docs/configuration.md) and [write path](src/config.ts).

## Module map

Prefer the owning code to a module inventory. The
[import-boundary tests](src/module-boundaries.test.ts) and
[cycle test](src/import-cycles.test.ts) enforce the executable constraints.
Goblin owns persisted messages and tool definitions so a vendor change cannot
silently change stored data. See [`message.test.ts`](src/message.test.ts) and
[`tool.test.ts`](src/tool.test.ts).

Each engine translates vendor failures to Goblin's
[`ProviderError`](src/agent/provider-errors.ts) at its edge (#770). The
runtime makes one retry and fallback policy from that shared vocabulary.

Timers, deadlines and bounded waits go through [`timing.ts`](src/timing.ts),
and [`timers.test.ts`](src/timers.test.ts) stops new raw timers elsewhere
([decision](design/decisions/timing-owner.md), #738).

Auxiliary model calls use [`generate.ts`](src/agent/generate.ts). Two cases
need a different path: vision needs an idle timeout on a stream, and
summary generation sometimes needs the exact existing prompt prefix for
cache reuse (#759).

## Non-goals

One operator, one process, one app client and an optional Telegram channel.
Sandboxed Telegram guests do not make this a multi-user product. No onboarding
wizard, third channel, plugin SDK, native browser or MCP client, or Kubernetes
deployment. New background work does not acquire standing authority on its
own. Judge additions against [operator direction](DIRECTION.md), not an old
rollout plan.

## Test posture

### Memory net

A test stuck in synchronous code can keep allocating without yielding to
timeouts or cleanup on the main thread. The [test preload](src/test-memory-net.ts)
uses an independent [worker](src/test-memory-net.worker.ts) to report which
test or hook was running and stop the test process before the kernel kills
it. This is a backstop, not a reason to allow runaway tests. The
[subprocess tests](src/test-memory-net.test.ts) cover synchronous allocation,
printing a mounted DOM on failure, and parallel runs (#818).

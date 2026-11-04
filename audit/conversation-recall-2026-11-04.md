# Conversation recall denial, 2026-11-04

Read-only investigation of app conversation
`d72da150-348d-418c-9e2b-16b1fb1c61d2` ("Pure Insanity").
No service, configuration, prompt, or conversation changes were made.

## Evidence

Inspected the rendered conversation and its GET `/api/app/conversations/`
`d72da150-348d-418c-9e2b-16b1fb1c61d2/window` response through the app browser.
The latest capture was at `2026-11-04T08:32:27.988Z`, model
`zai/glm-5.3`, step 1, for the operator's subsequent quoted correction.
This endpoint stores the SDK model messages at prepareStep, before provider
wire conversion; it is not an HTTP request capture from Zhipu.

- Captured message index 17 (zero-based), role assistant, contains a text
  part: `The 2018 wave got 235. This has a shot at going through 240.`
- Index 19 contains the intervening assistant reply about Trump.
- Index 20 contains the operator's "Try 258" message.
- Index 23 contains two `history_search` calls with queries
  `House seats forecast 240 Democrats prediction midterm` and
  `election 2026 Senate House forecast prediction`.
- Both tool results at index 24 say `No past conversations match.`
- Index 25 contains the denial: `I can't find any record of me calling
  that, in memory or this chat's history`.
- Index 26 contains the operator's quoted correction. The captured history
  starts with the original user input, not a replacement compaction summary.

Call lineage supports continuity across the offending turn: its initial
main-model call `c8251bea-7c66-417b-b358-13e9eb1612a3` has prefix relation
`append`, sharedMessages 20; its next call
`bd2bb942-051b-4286-b87e-2a3a828ca1b4` shares 22; the denial's final call
`8c0452e0-9134-4894-aa4a-633283270780` shares 24; the subsequent correction
call `be1c884b-aa08-48a5-af09-cf493fbf3adc` shares 26. The original quote at
index 17 is inside that shared prefix.

## Interpretation

The quote was not removed from Goblin's prepared model history. GLM's
reasoning overlooks existing assistant replies, searches instead, and treats
empty search results as evidence the operator is mistaken. Its later
speculation about folded context is not evidence of compaction.

The search misses are consistent with the local search contract:
`toFtsQuery` quotes each whitespace-separated term and joins them with
spaces, producing an implicit AND in SQLite FTS. These are long conjunctive
queries, not semantic searches; the quoted reply does not contain every
requested term. An empty result cannot establish that no such remark exists.

This establishes an in-context recall failure at the prepared-input boundary,
not the provider-internal cause. The latest-only capture and lineage do not
show the exact historical HTTP payload or how Zhipu processed replay and
caching. Distinguishing model attention failure from provider/SDK replay
behavior would require separate wire-level evidence or a controlled replay.
At this initial stage, no such experiment had been run.

## Follow-up: direct session transcript and offline wire serialization

Read the live SQLite database using `bun:sqlite` with `readonly:true`, scoped
to `app/d72da150-348d-418c-9e2b-16b1fb1c61d2`. The stored events are version-1
message envelopes. Events 1 through 12 alternate user and assistant; all six
turn runs completed with the expected owning user seq. There are no rows in
`compactions` for this conversation.

The full stored reasoning adds evidence absent from the initial excerpts:

- Event 10: `my first two replies aren't shown to me in full`
- Event 10: `My visible replies: I only made vision calls and (presumably)
  short texts I can't see. The transcript shows my turns were tool calls
  only... Actually my turns would have included some text. But I don't see
  them, so I can't verify.`
- Event 12: `my replies are not shown to me in this transcript, but they
  happened`

These are model self-reports, not reliable instrumentation, but they
specifically describe missing assistant prose, not just failure to locate
one number.

The configured `zai` route is `kind: responses`, base URL
`https://api.z.ai/api/v1`. The inspected release is
`c63af11d38d1f95217b29739afe7e7bfd65aa110`, with `ai` 7.0.142 and
`@ai-sdk/openai` 4.0.95. Its Responses converter defaults its internal
`store` behavior to true and replaces assistant text carrying an OpenAI
`itemId` with `item_reference`. The wire `store` field can still be omitted.
Goblin's prepared-message capture precedes this conversion.

An offline fetch-intercepted serialization experiment used the deployed SDK
and the first 21 messages of the stored capture (through the "Try 258" input):

- Default options: no inline assistant messages; 11 item references;
  `going through 240` absent from the serialized input.
- With `providerOptions.openai.store: false`: four inline assistant
  messages; no item references; `going through 240` present.

The experiment used a dummy credential and a stub fetch returning a deliberate
400; no request reached Zhipu. Evidence is in
`/tmp/goblin-recall-wire-evidence-provider.txt`. The initial `generateText`
attempt failed high-level message-schema validation before fetch; the
successful experiment used `model.doGenerate` directly with the captured
message shapes. It proves the provider-converter behavior for these parts,
not the exact historical full request.

The concrete suspect is now Responses item-reference replay: the application
has the assistant text, but the SDK substitutes references and relies on the
provider to recover it. This closely matches the transcript's repeated
description of absent assistant prose. Whether Zhipu actually dropped or
failed to resolve those references remains unverified without a live
controlled comparison or historical wire evidence. The initial attribution
to model attention alone was premature; prepared context does not establish
what text survived provider-side replay.

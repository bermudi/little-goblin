# PDFs And Video Cannot Reach The Model Through The Pi-Routed Stack

## Status

accepted

## Context

The user's real workflow includes acting as a consultant (e.g.
`Desktop/Clients/recam-laser-international`) and sending documents — including
PDFs — to goblin via Telegram for analysis. Today this workflow is blocked at
the stack level: goblin's content path runs through pi-ai, which is the router
between goblin and the model providers. pi-ai's `UserMessage.content` type is
closed at `TextContent | ImageContent` — there is no document or video path.
PDFs must be extracted to text with `pdftotext` and fed as a string; the model
never sees the actual document.

Two changes were opened to solve this:

- `multimodal-native-pdf` (0/19, born 2026-05-04, frozen for ~8 weeks) proposes
  adding a `DocumentContent` type to pi-ai via `bun patch`, widening the content
  union, and wiring it through the Anthropic and OpenAI Responses providers.
- `migrate-to-ai-sdk` (0/32) proposes a complete replacement of the
  pi dependency stack (`pi-ai`, `pi-agent-core`, `pi-coding-agent`) with the
  Vercel AI SDK, which would give goblin direct ownership of the message array
  and make file attachments first-class.

Both have been researched and found **too costly to ship as currently scoped**:

- **Patching pi-ai is unmaintainable.** The `multimodal-native-pdf` approach
  requires coordinated `bun patch` surgery across pi-ai's closed content union
  and both provider adapters. pi-ai is an external, actively-versioned package;
  the patches would have to be re-applied and re-validated on every bump and
  would diverge from upstream. This is not a sustainable path for a single-user
  homelab.
- **Routing outside pi into separate context windows is heavy.** The
  alternative — bypassing pi's content path and managing a parallel context
  window for document/video turns — duplicates the session, event, and
  transcript machinery goblin already owns. It is a second agent runtime inside
  the first.
- **`migrate-to-ai-sdk` is a nuclear option.** It is a complete stack
  replacement touching 8 capabilities (agent, models, pi-host, subagents,
  beta-tools, memory, sessions, commands). It would solve the PDF problem as a
  side effect of owning the message array, but at the cost of rewriting the
  entire agent runtime. That is a justified migration only if independently
  motivated — not as the means to a single feature.

This is a **structural constraint of the chosen stack** (pi as the router), not
a task that is being avoided. Accepting it as a boundary is the decision.

## Decision

PDF and video delivery to the model is **a known limitation of the pi-routed
assistant** and is accepted as a constraint, not pursued through either
currently-scoped change.

Specifically:

- **`multimodal-native-pdf` is deferred** pending a pi-ai release that supports
  document/video content natively, or an equivalent upstream change. The
  `bun patch` approach is rejected as unmaintainable.
- **`migrate-to-ai-sdk` is deferred** as a nuclear option that is only
  justified if independently motivated (e.g. provider-native tools, direct
  message ownership), not as the path to PDF support.
- **The workaround remains**: PDFs are extracted to text (e.g. `pdftotext`) and
  fed to the model as a string; images continue to flow through the existing
  `ImageContent` path. Heavy content that genuinely requires native model
  ingestion is handled outside the goblin loop until the stack changes.
- This decision **does not preclude** a future stack change. If pi-ai adds
  native document support, or if goblin independently migrates off pi,
  `multimodal-native-pdf` can be reopened against the new foundation.

## Consequences

- The consultant-PDF workflow continues to operate on extracted text, with the
  known lossiness that implies. This is accepted.
- Two frozen changes (`multimodal-native-pdf`, `migrate-to-ai-sdk`) move from
  "0/N in-progress and haunting the queue" to "deferred pending a stack
  change." They are not abandoned; they are gated on a precondition that is not
  met today.
- No work is undertaken on either change until the precondition (native pi-ai
  document support, or an independently-motivated stack migration) is met.
- Image-only and text-only multimodal flows are unaffected and continue to be
  supported through the existing `ImageContent` path.

## Alternatives considered

- **Ship the `bun patch` for pi-ai.** Rejected as unmaintainable: re-applying
  coordinated patches across a closed union and two provider adapters on every
  pi-ai bump is not sustainable for a single-user homelab.
- **Build a parallel context window for document/video turns.** Rejected as
  heavy: it duplicates session, event, and transcript machinery and creates a
  second agent runtime inside the first.
- **Migrate to the Vercel AI SDK now, primarily for PDF support.** Rejected as
  disproportionate: a complete 8-capability stack rewrite is justified only by
  independent motivation, not as the means to a single feature.
- **Accept the constraint and write it down (chosen).** Captures the research,
  closes the open loops, and gates the work on a real precondition instead of
  leaving it frozen.

## Related

- `specs/changes/multimodal-native-pdf/` — deferred by this decision.
- `specs/changes/migrate-to-ai-sdk/` — deferred by this decision.
- `specs/research/pi-ai-dependency-analysis.md` — the dependency analysis
  underpinning the `migrate-to-ai-sdk` scope, retained for any future
  reconsideration.

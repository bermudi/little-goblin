---
name: nospec-curator
description: Use when durable records disagree, ownership of a lasting claim is unclear, or views may be stale after an authoritative record changes.
license: MIT
metadata:
  author: bermudi
  version: "1.0.0"
---

# Curator

Keep durable knowledge coherent by giving each class of claim one authority. This is not a generic documentation-writing skill.

## Artifact roles

- **Record** — owns a claim class: code/tests for current implemented behavior, project-designated contracts for assigned promises or required behavior, ADRs for rulings, a glossary for domain terms, operational context for repository practice, and skills for procedural knowledge.
- **View** — explains or combines records without becoming another authority, such as a README or guide.
- **Ledger** — append-only evidence of what happened.
- **Work state** — queues, handoffs, reviews, and scratch work specs consumed then deleted. A filename does not decide the role: a designated API schema or protocol definition is not work state.

A fact may appear in several places, but only one place owns it. Other appearances are projections that must defer to the record. Contract designation must be recoverable from operational context, an accepted ruling, or an established project metadata convention. `nospec: true` opts into structural checks only. If no owner is designated, leave the artifact unclassified and ask.

## Place and project

When lasting knowledge appears, ask which future question it answers and which record owns that answer. Do not invent a new artifact before the first real claim needs it.

When a record changes:

- update views that summarize the changed claim;
- move authoritative claims out of views;
- delete duplicated or obsolete explanations;
- retain historical ADRs when their decision history remains useful.

Git is the archive. Stale prose need not stay visible merely because it once helped.

## Find coherence failures

Passing tests do not prove records agree. Inspect likely relationships after a public interface, ruling, domain term, or operational instruction changes.

Examples:

- a guide describes behavior the code no longer has;
- a view presents a superseded ruling as current;
- a glossary definition conflicts with code and conversation;
- an instruction names a command that no longer exists;
- two records answer the same question differently.

A pin alert in `EVIDENCE.md` is a triage signal: scope from the changed document's diff and inspect records or views that depend on that claim. The alert itself is not a finding.

If installed, `nospec check` mechanically checks artifacts marked `nospec: true`, duplicate record ownership, and re-enumerated derived facts. It intentionally ignores ordinary Markdown and generic frontmatter. Mechanical checks cannot prove semantic coherence; apply judgment to the relationships above.

Use `nospec-rule` for accepted rulings and `nospec-lexicon` for domain terms. Curator routes ownership and repairs projections; it does not replace those records.

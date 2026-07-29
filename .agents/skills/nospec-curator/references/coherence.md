# Coherence

Read this when an authoritative record changed or durable claims may disagree. Green tests do not prove that code, rulings, terms, contracts, instructions, and their views tell the same story.

Inspect likely dependents after changing a public interface, ruling, domain term, or operational instruction. Typical failures are a guide describing removed behavior, a view presenting a superseded ruling as current, an instruction naming a dead command, or two records owning the same claim.

A pin alert in `EVIDENCE.md` is a triage signal, not a finding. Scope from the changed document's diff and inspect dependents. Pins catch direct provenance drift, not indirect semantic contradiction.

If the Nospec runner is installed, `nospec check` validates opted-in `nospec: true` metadata, duplicate ownership, and copied derived facts; `nospec spine` and `nospec adrs` derive ADR views. These commands intentionally ignore ordinary host Markdown. Mechanical checks cannot establish semantic coherence.

Repair the owning record first, then its projections. Never edit a view as though it were the authority.

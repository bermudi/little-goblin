---
name: nospec-curator
description: Use when a lasting claim needs an authoritative home — an accepted ruling, recurring domain term, repository practice, designated contract, or coherence repair.
license: MIT
metadata:
  author: bermudi
  version: "1.0.0"
---

# Curator

Preserve knowledge that should outlive the work. Diagnose the claim before choosing its record; ADR, glossary, and documentation are formats, not separate behavioral stances.

## Route by claim class

A claim has one authority; other appearances are projections:

- accepted consequential ruling → ADR; read [`references/adr.md`](references/adr.md);
- recurring ambiguous domain term → glossary; read [`references/glossary.md`](references/glossary.md);
- repository practice → operational-context record;
- designated promise → project-owned contract record;
- current behavior → code and tests;
- stale explanation → reconcile or remove the view.

Contract designation must be recoverable from project context, an accepted ruling, or an established metadata convention. `nospec: true` opts into structural checks only; it grants no authority. If ownership is unclear, leave the artifact unclassified and ask.

Records own claims. Views explain records. Ledgers append evidence. Work state—queues, handoffs, reviews, scratch plans—is consumed and deleted. A filename alone decides none of these roles.

## Authority before durability

Do not promote an observation or recommendation into an accepted record. Lasting claims need explicit owner acceptance, delegated authority, or an established project convention. In unattended work, a newly discovered consequential choice is a blocker.

Do not create an artifact before the first real claim needs it. Git is the archive; stale visible prose need not survive merely because it once helped.

When a record changes, update dependent views, move authority out of summaries, and remove obsolete duplication. If records or projections may disagree, read [`references/coherence.md`](references/coherence.md). Mechanical checks can identify structural drift, never semantic agreement.

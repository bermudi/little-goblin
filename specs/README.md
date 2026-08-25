# Litespec authority and frozen v1 records

This directory contains both active Litespec v2 authority and explicitly frozen historical input. Location alone does not make a historical record authoritative.

## Active v2 authority

- `product.md` defines the product boundary, authority map, and core flows.
- `glossary.md` owns canonical domain language.
- `decisions/` contains accepted architectural rulings in Litespec's decision format.
- Future load-bearing behavioral contracts may live at `specs/<feature>/spec.md` when a deliberately shaped change needs one. None were mechanically created during migration.
- `queues/` is reserved for Litespec's offline fallback when GitHub is unavailable. Labeled GitHub issues are the normal queue.

## Frozen v1 input

- `canon/` contains historical behavioral snapshots. Code/tests and explicitly designated contract records own current behavior.
- `changes/archive/` contains delivered-work history. Git remains the long-term archive.
- `parked/` contains unstarted historical proposals. When one graduates, scout current code and create a fresh Litespec issue; do not translate its tasks mechanically.
- `v1-decisions/` contains old records whose proposed, abandoned, missing, or mixed status made them unsafe to import as accepted rulings.
- `research/` contains historical research.

Do not update frozen records as part of active implementation. Extract still-valid behavior into code/tests, an explicitly designated contract, or a newly accepted v2 record before deleting or contradicting historical material.

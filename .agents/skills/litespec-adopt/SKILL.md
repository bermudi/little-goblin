---
name: litespec-adopt
description: Reverse-engineer specs from existing code. Use when the user provides a file or directory path to document, wants to spec existing code, or says "adopt".
---

Adopt reverse-engineers specs from existing code. You read code, understand what it does, and produce a change proposal that documents the discovered architecture and behavior.

**IMPORTANT: You are reading code, not changing it.** You must never modify the source code you are analyzing. Your output is litespec artifacts only.

---

## Setup

The user provides a file or directory path. Read it thoroughly — every file, every exported symbol, every meaningful behavior.

If the path is a directory, read its structure first to understand scope, then read each file.

---

## Analysis

Build a mental model of the code by answering:

- **What does it do?** — the purpose and responsibility of the code
- **What does it depend on?** — imports, external calls, shared state
- **What depends on it?** — who calls this code, what would break if it changed
- **What are its invariants?** — assumptions the code relies on (types, formats, protocols)
- **What are its edge cases?** — error handling, nil checks, boundary conditions

Do not skim. Read the actual implementation, not just signatures and comments.

---

## Create the Change

`litespec new <name>` to create the change directory. Use a name derived from what the code does (e.g., `adopt-auth-system`, `adopt-config-parser`).

Then create artifacts in dependency order:

### Specs

Generate specs that describe what the code does. Use ADDED Requirements markers — everything is new because you are documenting existing behavior.

Each capability discovered gets its own spec. Each requirement should be specific and verifiable:
- Describe *what the code does*, not *how it does it*
- Include observable behavior, inputs, outputs, and side effects
- Note error conditions and how they are handled
- Structure each requirement with `### Requirement:` heading, body text containing SHALL or MUST, and at least one `#### Scenario:` block describing expected behavior
- Use WHEN/THEN format for scenarios: - **WHEN** <condition> / - **THEN** <expected outcome>

### Proposal

Explain what was adopted and why. Cover:
- What code was analyzed (paths)
- What capabilities were discovered
- Why this code is worth spec'ing (stability, criticality, complexity)

### Design

Document the existing architecture discovered:
- Component structure and relationships
- Data flow and state management
- External dependencies and integration points
- Patterns and conventions used

Verify with `litespec status <name> --json` that all artifacts are created.

---

## Guardrails

- **Do not modify source code** — you are documenting, not refactoring
- **Do not idealize** — document what the code actually does, not what it should do
- **Do not skip edge cases** — if the code handles an error, that is a requirement
- **Do not over-spec** — focus on observable behavior, not implementation details
- **Do include non-obvious invariants** — type assumptions, format expectations, protocol details

---

## Ending

Report what was adopted:
- How many capabilities and requirements were discovered
- Which files were analyzed
- Any surprises or notable findings
- Suggest next steps: review (review the specs for accuracy), or use the specs as a baseline for future changes

---
name: litespec-research
description: Gather knowledge for a proposed change — APIs, schemas, library docs, auth flows. Use after proposing when the change involves external dependencies, unfamiliar libraries, or novel APIs. Produces research skills into .agents/skills/research-<topic>/. Triggers on "research this change", "gather docs for", "look up the API", "research phase", or when preparing to implement a change that references external systems.
---

Enter research mode. Your job is to close knowledge gaps before implementation begins.

---

## Setup

Ask the user which change to research. Then read all artifacts from disk:

```
specs/changes/<name>/proposal.md
specs/changes/<name>/design.md
specs/changes/<name>/tasks.md
specs/changes/<name>/specs/
```

You need full context to identify what you don't know.

---

## The Stance: Risk-Scoped

Not all knowledge is equal. Triage before researching:

**Skip** — things LLMs see constantly in training data:
- Basic HTTP, REST conventions, JSON schemas
- Well-known libraries you've seen thousands of times (express, react, standard lib)
- Common patterns (CRUD, auth basics, pagination)
- Anything you could implement correctly from memory with high confidence

**Go deep** — things that could bite during implementation:
- Novel or niche APIs with non-obvious behavior
- New libraries (released or updated recently)
- Authentication flows (OAuth scopes, token refresh, signature verification)
- Rate limits, pagination quirks, error handling contracts
- Schema definitions for endpoints you'll actually call
- Version-specific behavior differences
- Webhook payloads and verification

**The test**: if you'd need to check documentation to implement it correctly, research it. If you could write it from memory and be confident, skip it.

---

## The Process

1. **Read all artifacts** — proposal, design, specs, tasks. Understand the full scope.

2. **Enumerate external dependencies** — what APIs, libraries, services, protocols does this change touch? List them.

3. **Triage by risk** — for each dependency, assess: is this something I know cold, or something I need docs for? Be honest. Overconfidence here wastes time during apply.

4. **Gather** — for each knowledge gap, collect the actual documentation. Use available tools: read local docs, fetch API references, examine schemas, check library source code. Get the specifics — endpoint paths, request/response shapes, auth headers, error codes, version constraints.

5. **Write research skills** — package findings as agent skills using the skill-creator format conventions (YAML frontmatter with name and description, progressive disclosure, reference files for large docs). Save to `.agents/skills/research-<topic>/SKILL.md`.

---

## Writing Research Skills

Use the skill-creator conventions for structure — you know the format:

- **`name`**: `research-<topic>` (kebab-case)
- **`description`**: Include the change name and key trigger terms. Example: "Research for change `stripe-integration`. Reference docs for Stripe Charges API, Webhooks, and Authentication. Covers endpoints, request/response schemas, and error handling."
- **Body**: The actual reference material — structured, scannable, actionable
- **`references/`**: For large docs (schemas, full API references, long examples)
- **Keep under 500 lines** — split into multiple skills if needed

The description is critical — it's how the apply agent discovers and loads this skill during implementation. Include the change name, the domain, and the specific topics covered.

### One skill or many?

Agent decides. A single API integration might be one skill. A change touching Stripe + OAuth + webhooks might warrant three skills for better trigger accuracy and to stay under size guidelines. Split when the topics are distinct enough to benefit from separate descriptions.

### Eval/iteration?

Skip the eval and iteration loop from skill-creator. Research skills are reference material scoped to a change — not published skills that need adversarial trigger testing. The quality bar is "does the apply agent have enough context to implement correctly?" Only invest in evals if the skill encodes a complex multi-step pattern where correctness matters beyond reference accuracy.

---

## What You Are Doing

Turning "I think we need to call the Stripe API" into "here's exactly how to call it, what to send, what you'll get back, and what can go wrong." Forensic knowledge gathering — methodical, risk-prioritized, and packaged for consumption by the apply agent.

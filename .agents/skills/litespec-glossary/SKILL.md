---
name: litespec-glossary
description: Manage the project's ubiquitous language in specs/glossary.md. Use when the user wants to review, update, or seed the project glossary, or says "glossary".
---

You manage the project's ubiquitous language — `specs/glossary.md`.

---

## What You Do

1. **Read `specs/glossary.md`** to understand the current shared vocabulary
2. **Propose additions** when the user asks or when you encounter undefined concepts during other work
3. **Maintain consistent formatting** — every entry uses the `- **Term**: definition` format
4. **Include "not-that" where it matters** — when a term is commonly confused with something else, note what it explicitly does NOT mean

---

## Format

Every glossary entry follows this pattern:

```markdown
- **Term**: Concise definition. What it IS, not what it isn't.
- **AmbiguousTerm**: What it means in THIS project. Not to be confused with [common alternative meaning].
```

Rules:
- One line per term, starting with `- **`
- Bold the term, follow with a colon and a space, then the definition
- No headers within the term list — the file has one `# Glossary` header
- Keep definitions concise — the goal is shared vocabulary, not documentation
- Order terms alphabetically

---

## Seeding

If `specs/glossary.md` does not exist, offer to create it. Seed it with stable, shared, or ambiguous terms from the current conversation. Do not add every noun — only terms that:
- Have a specific meaning in this project (different from common usage)
- Are frequently used across conversations or artifacts
- Could be confused with something else

---

## Behavioral Guardrails

- **Propose, do not impose** — always ask before adding terms to the glossary
- **Do not auto-scan** — no NLP scanning of prose to find terms. Only add terms that surface naturally in conversation
- **Do not duplicate documentation** — the glossary defines terms, it does not explain architecture
- **Do not validate** — the glossary is prose. There is no structural validation beyond "is it valid markdown"
- **Do respect the single source of truth** — `specs/glossary.md` is the one glossary. No per-spec or per-change glossaries
